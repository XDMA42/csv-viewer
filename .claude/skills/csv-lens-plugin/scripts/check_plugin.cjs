#!/usr/bin/env node
/**
 * CSV Lens 插件检查器
 *
 *   node check_plugin.cjs <plugin.js> [data.csv ...] [--params '{"key":1}'] [--force]
 *
 * 用与页面相同的核心代码（core.js）解析 CSV，依次运行插件的 match → features → metrics → charts →
 * summarize（多个 CSV 时再运行 aggregate），并把每张图转换成 ECharts option。
 * 有错误（✗）时退出码为 1；⚠ 为需要人工判断的提示。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BUILTIN_IDS = ['ranging', 'timeseries', 'generic-stats'];
const CHART_TYPES = new Set(['line', 'area', 'step', 'scatter', 'bar', 'histogram', 'heatmap']);
const LINE_TYPES = new Set(['line', 'area', 'step']);
const DEF_KEYS = new Set(['id', 'name', 'version', 'description', 'priority', 'fallback', 'general', 'collapsed',
  'match', 'params', 'features', 'metrics', 'charts', 'render', 'summarize', 'aggregate']);
const MATCH_KEYS = new Set(['columns', 'anyColumns', 'numericColumns', 'path', 'minColumns', 'test']);
const SPEC_KEYS = new Set(['type', 'x', 'y', 'series', 'title', 'subtitle', 'height', 'span', 'xType', 'xLabel', 'yLabel',
  'yZero', 'yMin', 'yMax', 'markLines', 'horizontal', 'labels', 'bins', 'range', 'xCategories', 'yCategories', 'data',
  'min', 'max', 'diverging', 'group', 'option', 'echarts']);
const PARAM_TYPES = new Set(['number', 'select', 'checkbox', 'boolean', 'text']);
// 检查器用的固定配色（只影响生成的 option，不影响检查结果）
const THEME = {
  dark: false, font: 'sans-serif', surface: '#fcfcfb', text: '#0b0b0b', text2: '#52514e', muted: '#898781',
  grid: '#e1e0d9', axis: '#c3c2b7', border: 'rgba(11,11,11,0.16)', accent: '#2a78d6',
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  divNeg: '#2a78d6', divMid: '#f0efec', divPos: '#e34948', seq: ['#cde2fb', '#104281'],
};

let errors = 0, warnings = 0;
const out = (s) => console.log(s);
const ok = (m) => out('  ✓ ' + m);
const note = (m) => out('    ' + m);
const warn = (m) => { warnings++; out('  ⚠ ' + m); };
const fail = (m) => { errors++; out('  ✗ ' + m); };
const errText = (e) => (e && e.message) || String(e);

function usage() {
  out('用法：node check_plugin.cjs <plugin.js> [data.csv ...] [--params \'{"key":1}\'] [--force]');
  process.exit(2);
}

// ---------- 参数 ----------
const argv = process.argv.slice(2);
let pluginFile = null, paramOverride = {}, force = false;
const csvFiles = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-h' || a === '--help') usage();
  else if (a === '--force') force = true;
  else if (a === '--params') {
    try { paramOverride = JSON.parse(argv[++i]); } catch (e) { out('--params 不是合法的 JSON'); process.exit(2); }
  } else if (!pluginFile) pluginFile = a;
  else csvFiles.push(a);
}
if (!pluginFile) usage();

// ---------- 加载核心代码 ----------
function findCore() {
  const list = [];
  if (process.env.CSVLENS_CORE) list.push(process.env.CSVLENS_CORE);
  // 在 CSV Lens 仓库中：向上查找 lib/core.js；单独使用本 skill 时：scripts/core.js
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    list.push(path.join(dir, 'lib', 'core.js'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  list.push(path.join(__dirname, 'core.js'));
  return list.find((p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('CSVLensCore'));
}
const corePath = findCore();
if (!corePath) { out('找不到 CSV Lens 的 core.js（应位于本脚本同目录或仓库的 lib/ 下）'); process.exit(2); }
vm.runInThisContext(fs.readFileSync(corePath, 'utf8'), { filename: corePath });
const C = globalThis.CSVLensCore;

// ---------- 最小的 DOM 替身（供 render / ctx.h 使用） ----------
function stubEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(), children: [], style: {}, dataset: {}, className: '', textContent: '',
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; },
    prepend(...c) { this.children.unshift(...c); }, replaceChildren(...c) { this.children = c; }, remove() {},
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    getBoundingClientRect() { return { width: 600, height: 300, top: 0, left: 0 }; },
  };
}
function stubH(tag, props, ...children) {
  const el = stubEl(tag);
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false && c !== true));
  return el;
}

// ---------- 加载插件 ----------
const registered = [];
globalThis.window = globalThis;
globalThis.CSVViewer = {
  version: 'check',
  registerPlugin(def) { registered.push(def); return def; },
  loadScripts() { return Promise.resolve([]); },
  utils: C.U,
  h: stubH,
  DataTable: C.DataTable,
};

out(`插件：${pluginFile}`);
out(`核心：${path.relative(process.cwd(), corePath) || corePath}`);
let source;
try { source = fs.readFileSync(pluginFile, 'utf8'); } catch (e) { out('无法读取插件文件：' + errText(e)); process.exit(2); }

out('\n[结构]');
let script;
try {
  script = new vm.Script(source, { filename: path.resolve(pluginFile) });
} catch (e) {
  fail('语法错误：' + errText(e));
  finish();
}
const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));
try { script.runInThisContext(); } catch (e) { fail('执行插件文件出错：' + errText(e)); }
const leaked = Object.getOwnPropertyNames(globalThis).filter((k) => !globalsBefore.has(k));
if (leaked.length) warn('在全局作用域声明了 ' + leaked.join(', ') + '：请把整个文件包在 (() => { ... })(); 中，避免与其他插件冲突');
// 顶层 let / const / class：同一文件被加载两次（如内置版本 + 插件文件夹中的副本）时会报「已声明」
const n0 = registered.length;
try { script.runInThisContext(); } catch (e) {
  if (/already been declared/.test(errText(e))) fail('文件顶层有 let / const / class 声明，同一文件加载两次时会报错：请把整个文件包在 (() => { ... })(); 中');
}
registered.length = n0;

if (!registered.length) { fail('没有调用 CSVViewer.registerPlugin(...)'); finish(); }
registered.forEach(checkDef);

const plugins = registered
  .map((def, i) => ({ def, i }))
  .filter(({ def }) => def && typeof def === 'object' && def.id)
  .sort((a, b) => (Number(b.def.priority) || 0) - (Number(a.def.priority) || 0) || a.i - b.i)
  .map(({ def }) => def);
const matchers = new Map();
for (const def of plugins) {
  try { matchers.set(def, C.compileMatcher(def.match)); } catch (e) { fail(`插件 ${def.id}：match 无效：${errText(e)}`); }
}

function checkDef(def) {
  if (!def || typeof def !== 'object') return fail('registerPlugin 的参数不是对象');
  const id = def.id;
  if (!id || typeof id !== 'string') fail('缺少字符串 id');
  else {
    ok(`注册插件 ${id}（${def.name || '未命名'}）` + (def.general ? '，通用插件' : def.fallback ? '，兜底插件' : '，专用插件'));
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) warn(`id「${id}」建议只用小写字母、数字和连字符`);
    if (BUILTIN_IDS.includes(id)) warn(`id「${id}」与内置插件相同，加载后会覆盖内置版本`);
  }
  if (!def.name) warn('缺少 name（界面上会显示 id）');
  if (def.fallback && def.general) warn('fallback 与 general 同时为 true：按兜底插件处理，general 不起作用');
  const unknown = Object.keys(def).filter((k) => !DEF_KEYS.has(k));
  if (unknown.length) warn('未知字段（会被忽略）：' + unknown.join(', '));
  if (def.match != null && typeof def.match !== 'function') {
    if (typeof def.match !== 'object') fail('match 必须是对象或函数');
    else {
      const mk = Object.keys(def.match).filter((k) => !MATCH_KEYS.has(k));
      if (mk.length) warn('match 中的未知字段：' + mk.join(', '));
      for (const k of ['columns', 'anyColumns', 'numericColumns']) {
        if (def.match[k] != null && !Array.isArray(def.match[k])) fail(`match.${k} 应为数组`);
      }
    }
  }
  if (def.match == null) warn('没有 match：插件会匹配所有 CSV');
  for (const k of ['metrics', 'charts', 'render', 'summarize', 'aggregate']) {
    if (def[k] != null && typeof def[k] !== 'function') fail(`${k} 应为函数`);
  }
  if (def.aggregate && !def.summarize) warn('有 aggregate 但没有 summarize：aggregate 不会被调用');
  if (def.params != null && !Array.isArray(def.params)) fail('params 应为数组');
  for (const p of Array.isArray(def.params) ? def.params : []) {
    if (!p || !p.key) { fail('参数缺少 key'); continue; }
    if (p.type && !PARAM_TYPES.has(p.type)) warn(`参数 ${p.key}：未知 type「${p.type}」（会按文本框处理）`);
    if (p.type === 'select' && !Array.isArray(p.options)) fail(`参数 ${p.key}：select 需要 options 数组`);
    if (p.type === 'number' && p.default != null && typeof p.default !== 'number') warn(`参数 ${p.key}：number 的 default 应为数字`);
  }
  if (def.features != null && !Array.isArray(def.features)) fail('features 应为数组');
  for (const f of Array.isArray(def.features) ? def.features : []) {
    if (!f || !f.name || typeof f.compute !== 'function') fail('特征需要 name 和 compute 函数');
  }
  const hasOutput = (Array.isArray(def.features) && def.features.length) || def.metrics || def.charts || def.render || def.summarize;
  if (!hasOutput) warn('插件没有任何输出（features / metrics / charts / render / summarize 都为空）');
}

// ---------- 与页面相同的表头信息（前 64KB、前 200 行推断列类型） ----------
function headerInfo(buf, name, rel, delimiter) {
  const CHUNK = 64 * 1024;
  const truncated = buf.length > CHUNK;
  const dec = C.csvDecode(buf.subarray(0, CHUNK), truncated);
  const res = C.csvBuildTable(dec.text, { maxRows: 201, dropLast: truncated, delimiter });
  const cols = res.columns.map((c) => c.name);
  const types = new Map(res.columns.map((c) => [c.name, c.type]));
  const lower = new Map();
  cols.forEach((c) => { const k = c.trim().toLowerCase(); if (!lower.has(k)) lower.set(k, c); });
  const find = (n) => {
    if (Array.isArray(n)) { for (const x of n) { const c = find(x); if (c) return c; } return null; }
    if (n == null) return null;
    return types.has(n) ? n : lower.get(String(n).trim().toLowerCase()) || null;
  };
  return {
    name, path: rel, dir: path.dirname(rel) === '.' ? '' : path.dirname(rel), size: buf.length,
    columns: cols.slice(),
    numericColumns: cols.filter((c) => types.get(c) === 'number'),
    find,
    has: (...names) => names.every((n) => !!find(n)),
    type: (n) => { const c = find(n); return c ? types.get(c) : null; },
    isNumeric: (n) => { const c = find(n); return !!c && types.get(c) === 'number'; },
  };
}

function explainNoMatch(def, info) {
  const m = def.match;
  if (typeof m === 'function') return 'match 函数返回 false';
  if (!m || typeof m !== 'object') return '';
  const names = (list) => list.map((c) => (Array.isArray(c) ? c.join('/') : c)).join(', ');
  const why = [];
  if (m.columns) { const miss = m.columns.filter((c) => !info.find(c)); if (miss.length) why.push('缺少列 ' + names(miss)); }
  if (m.anyColumns && !m.anyColumns.some((c) => info.find(c))) why.push('anyColumns 中的列一个都没有（' + names(m.anyColumns) + '）');
  if (m.numericColumns) { const bad = m.numericColumns.filter((c) => !info.isNumeric(info.find(c))); if (bad.length) why.push('不是数值列：' + names(bad)); }
  if (m.minColumns && info.columns.length < m.minColumns) why.push(`列数 ${info.columns.length} < ${m.minColumns}`);
  if (m.path != null) why.push('（或路径不匹配 ' + String(m.path) + '）');
  if (m.test) why.push('（或 test() 返回 false）');
  return why.join('；');
}

function paramsFor(def) {
  const outp = {};
  for (const p of Array.isArray(def.params) ? def.params : []) if (p && p.key) outp[p.key] = p.default;
  return Object.assign(outp, paramOverride);
}

function makeCtx(def, table, fileMeta) {
  return {
    plugin: { id: def.id, name: def.name, version: def.version || '' },
    file: fileMeta, params: paramsFor(def), utils: C.U, fmt: C.fmtNum, h: stubH, echarts: undefined, theme: THEME,
    renderChart: (el, spec) => checkSpec(spec, table, 'render 中的图'),
  };
}

function checkMetrics(list, where) {
  if (!Array.isArray(list)) return fail(`${where} 应返回数组`);
  const shown = [];
  for (const m of list.filter(Boolean)) {
    if (typeof m !== 'object' || m.label == null) { fail(`${where}：有一项不是 { label, value } 对象`); continue; }
    const v = m.value;
    if (typeof v === 'number' && !Number.isFinite(v)) warn(`指标「${m.label}」的值为 ${v}（显示为「—」）`);
    else if (v != null && typeof v !== 'number' && typeof v !== 'string') warn(`指标「${m.label}」的值类型为 ${typeof v}，应为数字或字符串`);
    shown.push(`${m.label}=${typeof v === 'number' ? C.fmtNum(v, m.digits) : v == null ? '—' : v}${m.unit ? ' ' + m.unit : ''}`);
  }
  ok(`${where}：${shown.length} 项` + (shown.length ? '  ' + shown.join(' · ') : ''));
}

function checkSpec(spec, table, where) {
  if (!spec || typeof spec !== 'object') return fail(`${where}：不是对象`);
  const title = spec.title ? `「${spec.title}」` : '（无标题）';
  const type = spec.type || 'line';
  if (!spec.echarts && !CHART_TYPES.has(type)) return fail(`图${title}：未知的 type「${type}」`);
  const unknown = Object.keys(spec).filter((k) => !SPEC_KEYS.has(k));
  if (unknown.length) warn(`图${title}：未知字段 ${unknown.join(', ')}（会被忽略）`);
  if (!spec.title) warn(`${where}：有一张图没有 title`);
  let opt;
  try { opt = C.specToOption(spec, table, THEME); } catch (e) { return fail(`图${title}：${errText(e)}`); }
  const series = C.toList(opt.series);
  const points = series.reduce((n, s) => n + (Array.isArray(s.data) ? s.data.length : 0), 0);
  if (!spec.echarts && points === 0) warn(`图${title}：没有可绘制的数据点（列全是缺失值？）`);
  if (LINE_TYPES.has(type) && series.length > 4) warn(`图${title}：${series.length} 条线，建议不超过 4 条`);
  if (Array.isArray(opt.yAxis) && opt.yAxis.length > 1) warn(`图${title}：使用了多个纵轴，量纲不同的列建议分成多张图`);
  ok(`图${title}：${spec.echarts ? 'echarts' : type}，${series.length} 条序列，${points} 个数据点`);
}

function runFeatures(def, table, ctx) {
  for (const f of Array.isArray(def.features) ? def.features : []) {
    if (!f || !f.name || typeof f.compute !== 'function') continue;
    if (f.requires) {
      const miss = C.toList(f.requires).filter((c) => !table.getColumn(c));
      if (miss.length) { note(`- 特征 ${f.name}：缺少 ${miss.map((c) => (Array.isArray(c) ? c.join('/') : c)).join(', ')}，按 requires 跳过`); continue; }
    }
    try {
      const vals = f.compute(table, ctx);
      if (vals == null) { note(`- 特征 ${f.name}：compute 返回空，已跳过`); continue; }
      const col = table.addColumn(f.name, vals, { source: def.id, label: f.label, unit: f.unit, description: f.description, type: f.type });
      const valid = col.values.length - col.missing;
      if (valid === 0) warn(`特征 ${f.name}：全部是缺失值`);
      else ok(`特征 ${f.name}（${col.type}，有效值 ${valid}/${table.rowCount}）`);
    } catch (e) {
      fail(`特征 ${f.name}：${errText(e)}`);
    }
  }
}

function shortLabels(rows) {
  const parts = rows.map((r) => r.path.replace(/\.(csv|tsv)$/i, '').split(/[\\/]/));
  rows.forEach((r, i) => {
    for (let k = 1; ; k++) {
      const label = parts[i].slice(-k).join('/');
      if (!parts.some((p, j) => j !== i && p.slice(-k).join('/') === label) || k >= parts[i].length) { r.file = label; break; }
    }
  });
}

// ---------- 逐个 CSV 运行 ----------
const summaries = new Map(plugins.map((d) => [d, []]));
if (!csvFiles.length) {
  out('\n（没有提供 CSV：只检查了语法和结构。提供一个或多个 CSV 可运行完整检查。）');
}
for (const file of csvFiles) {
  out(`\n[${file}]`);
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { fail('无法读取：' + errText(e)); continue; }
  const rel = path.relative(process.cwd(), file) || path.basename(file);
  const name = path.basename(file);
  const delimiter = /\.tsv$/i.test(name) ? '\t' : null;
  const info = headerInfo(buf, name, rel, delimiter);
  const dec = C.csvDecode(buf, false);
  const parsed = C.csvBuildTable(dec.text, { delimiter });
  parsed.encoding = dec.encoding;
  const table = new C.DataTable(parsed, { name, path: rel, size: buf.length });
  note(`${table.rowCount} 行 · 编码 ${dec.encoding} · 分隔符 ${JSON.stringify(parsed.delimiter)} · 列：` +
    table.columns.map((c) => `${c}(${table.type(c)})`).join(', '));
  table.removeDerived();
  for (const def of plugins) {
    const matcher = matchers.get(def);
    if (!matcher) continue;
    let matched = false;
    try { matched = !!matcher(info); } catch (e) { fail(`插件 ${def.id}：match 出错：${errText(e)}`); }
    if (!matched) {
      out(`  · 插件 ${def.id} 不匹配此文件` + (explainNoMatch(def, info) ? '：' + explainNoMatch(def, info) : ''));
      if (!force) continue;
      note('（--force：继续运行各钩子）');
    } else ok(`插件 ${def.id} 匹配此文件`);
    const ctx = makeCtx(def, table, { name, path: rel, dir: info.dir, size: buf.length });
    runFeatures(def, table, ctx);
    if (typeof def.metrics === 'function') {
      try { checkMetrics(def.metrics(table, ctx), 'metrics()'); } catch (e) { fail('metrics() 出错：' + errText(e)); }
    }
    if (typeof def.charts === 'function') {
      try {
        const specs = def.charts(table, ctx);
        if (!Array.isArray(specs)) fail('charts() 应返回数组');
        else {
          const list = specs.filter(Boolean);
          if (!list.length) warn('charts() 对此文件没有返回任何图');
          list.forEach((s) => checkSpec(s, table, 'charts()'));
        }
      } catch (e) { fail('charts() 出错：' + errText(e)); }
    }
    if (typeof def.render === 'function') {
      try { def.render(stubEl('div'), table, ctx); ok('render() 已调用（显示效果请在页面中确认）'); }
      catch (e) { warn('render() 在检查器中出错（它依赖浏览器 DOM，请在页面中确认）：' + errText(e)); }
    }
    if (typeof def.summarize === 'function') {
      try {
        const r = def.summarize(table, ctx);
        if (r == null || typeof r !== 'object' || Array.isArray(r)) fail('summarize() 应返回对象');
        else {
          const row = { file: name, path: rel };
          for (const [k, v] of Object.entries(r)) {
            if (v === undefined) continue;
            if (v !== null && !['number', 'string', 'boolean'].includes(typeof v)) warn(`summarize() 的「${k}」是 ${typeof v}，应为数字或字符串`);
            row[k] = v;
          }
          row.path = rel;
          summaries.get(def).push(row);
          ok('summarize()：' + Object.keys(row).filter((k) => k !== 'file' && k !== 'path').join(', '));
        }
      } catch (e) { fail('summarize() 出错：' + errText(e)); }
    }
  }
}

// ---------- 跨文件汇总 ----------
for (const def of plugins) {
  const rows = summaries.get(def);
  if (typeof def.aggregate !== 'function' || !rows.length) continue;
  out(`\n[aggregate · ${def.id} · ${rows.length} 个文件]`);
  shortLabels(rows);
  const s = C.DataTable.fromRows(rows, { name: def.id + '_summary', path: '' });
  try {
    const res = def.aggregate(s, makeCtx(def, s, null)) || {};
    if (res.metrics) checkMetrics(res.metrics, 'aggregate().metrics');
    if (res.charts) {
      if (!Array.isArray(res.charts)) fail('aggregate().charts 应为数组');
      else res.charts.filter(Boolean).forEach((spec) => checkSpec(spec, s, 'aggregate().charts'));
    }
  } catch (e) { fail('aggregate() 出错：' + errText(e)); }
}

finish();

function finish() {
  out(`\n结果：${errors} 个错误，${warnings} 个提示`);
  process.exit(errors ? 1 : 0);
}
