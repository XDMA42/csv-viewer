/**
 * CSV Lens 核心（不依赖 DOM）：CSV 解析、数据表、工具函数、插件匹配规则、图表 spec → ECharts option。
 * 页面（index.html）和插件检查器（.claude/skills/csv-lens-plugin/scripts/check_plugin.cjs）共用这一份代码，
 * 因此检查器对插件的判断与页面完全一致。
 */
(function (root) {
'use strict';

const TIME_NAME = /(^t$|^ts$|^ts_|_ts$|time|stamp|date|epoch|时间|日期|时刻)/i;
const LINEISH = new Set(['line', 'area', 'step']);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(v, digits) {
  if (v == null || v === '') return '—';
  if (typeof v !== 'number') return String(v);
  if (Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
  if (digits != null) return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const a = Math.abs(v);
  // 时间戳一类的大整数不加千分位
  if (Number.isInteger(v)) return a < 1e9 ? v.toLocaleString('en-US') : (a < 1e16 ? String(v) : v.toExponential(3));
  if (a >= 1e9 || a < 1e-4) return v.toExponential(3);
  if (a >= 1e4) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return String(+v.toPrecision(5));
}
function fmtAxis(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e12) return +(v / 1e12).toPrecision(4) + 'T';
  if (a >= 1e9) return +(v / 1e9).toPrecision(4) + 'B';
  if (a >= 1e6) return +(v / 1e6).toPrecision(4) + 'M';
  if (a >= 1e4) return +(v / 1e3).toPrecision(4) + 'K';
  return String(+v.toPrecision(4));
}
function fmtBytes(b) {
  if (!Number.isFinite(b)) return '—';
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return (b >= 100 ? b.toFixed(0) : b >= 10 ? b.toFixed(1) : b.toFixed(2)) + ' ' + u[i];
}
function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.abs(ms) / 1000;
  if (s < 1) return Math.round(Math.abs(ms)) + ' 毫秒';
  if (s < 60) return (s < 10 ? s.toFixed(2) : s.toFixed(1)) + ' 秒';
  if (s < 3600) { const t = Math.round(s); return Math.floor(t / 60) + ' 分 ' + (t % 60) + ' 秒'; }
  if (s < 86400) { const t = Math.round(s / 60); return Math.floor(t / 60) + ' 时 ' + (t % 60) + ' 分'; }
  const t = Math.round(s / 3600);
  return Math.floor(t / 24) + ' 天 ' + (t % 24) + ' 时';
}
function fmtDate(ms, withMs) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n, w) => String(n).padStart(w || 2, '0');
  let s = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  if (withMs !== false && d.getMilliseconds()) s += '.' + p(d.getMilliseconds(), 3);
  return s;
}
function fmtCell(v) {
  if (v == null) return '—';
  if (typeof v === 'number') return fmtNum(v);
  return String(v);
}

/* =====================================================================
 * CSV 解析核心 —— 这些函数会被序列化进 Web Worker，必须保持自包含
 * ===================================================================== */
function csvDecode(buf, partial) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: !!partial }), encoding: 'UTF-8' };
  } catch (e) {
    try { return { text: new TextDecoder('gb18030').decode(bytes, { stream: !!partial }), encoding: 'GB18030' }; }
    catch (e2) { return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8' }; }
  }
}

function csvDetectDelimiter(text) {
  const lines = [];
  let pos = 0;
  while (lines.length < 12 && pos < text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = text.length;
    const line = text.slice(pos, nl).replace(/\r$/, '');
    if (line.trim()) lines.push(line);
    pos = nl + 1;
  }
  if (!lines.length) return ',';
  let best = ',', bestScore = -1;
  for (const d of [',', '\t', ';', '|']) {
    const counts = lines.map((l) => {
      let c = 0, q = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i];
        if (ch === '"') q = !q;
        else if (ch === d && !q) c++;
      }
      return c;
    });
    if (!counts[0]) continue;
    const same = counts.filter((c) => c === counts[0]).length / counts.length;
    const score = counts[0] * same * same;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** 逐行解析，支持引号、转义引号、引号内换行、CRLF。返回停止时的字符位置。 */
function csvParseRows(text, delim, maxRows, onRow) {
  const D = delim.charCodeAt(0), Q = 34, CR = 13, LF = 10;
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let row = [], rows = 0;
  while (i < n) {
    let c = text.charCodeAt(i), field;
    if (c === Q) {
      let j = i + 1, s = '';
      for (;;) {
        const k = text.indexOf('"', j);
        if (k === -1) { s += text.slice(j); i = n; break; }
        s += text.slice(j, k);
        if (text.charCodeAt(k + 1) === Q) { s += '"'; j = k + 2; }
        else { i = k + 1; break; }
      }
      while (i < n) {
        c = text.charCodeAt(i);
        if (c === D || c === LF || c === CR) break;
        s += text[i]; i++;
      }
      field = s;
    } else {
      let j = i;
      while (j < n) {
        c = text.charCodeAt(j);
        if (c === D || c === LF || c === CR) break;
        j++;
      }
      field = text.slice(i, j);
      i = j;
    }
    row.push(field);
    if (i >= n) { onRow(row); rows++; break; }
    c = text.charCodeAt(i);
    if (c === D) {
      i++;
      if (i >= n) { row.push(''); onRow(row); rows++; }
      continue;
    }
    if (c === CR && text.charCodeAt(i + 1) === LF) i += 2; else i++;
    onRow(row); rows++;
    row = [];
    if (maxRows && rows >= maxRows) return i;
  }
  return n;
}

function csvParseDate(s) {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(s);
  if (m) {
    const mo = +m[2], d = +m[3], hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 60) return NaN;
    const ms = m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0;
    if (m[8]) {
      let off = 0;
      if (m[8].toUpperCase() !== 'Z') {
        const z = m[8].replace(':', '');
        off = (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + (z.length >= 5 ? +z.slice(3, 5) : 0));
      }
      return Date.UTC(+m[1], mo - 1, d, hh, mi, ss, ms) - off * 60000;
    }
    return new Date(+m[1], mo - 1, d, hh, mi, ss, ms).getTime();
  }
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?$/.exec(s);
  if (t && +t[1] < 24 && +t[2] < 60) {
    return new Date(1970, 0, 1, +t[1], +t[2], +(t[3] || 0), t[4] ? Math.round(Number('0.' + t[4]) * 1000) : 0).getTime();
  }
  return NaN;
}

/** 推断列类型：number（≥95% 可解析为数字）、datetime、string、empty */
function csvInferColumn(name, raw) {
  const MISSING = { '': 1, na: 1, 'n/a': 1, nan: 1, null: 1, none: 1, nil: 1, '-': 1, '--': 1, '#n/a': 1, undefined: 1, '?': 1 };
  const n = raw.length;
  const num = new Float64Array(n);
  let nonMissing = 0, numeric = 0;
  for (let i = 0; i < n; i++) {
    const s = raw[i];
    if (s.length === 0) { num[i] = NaN; continue; }
    const v = +s;
    if (v === v) {
      if (v === 0 && !s.trim()) { num[i] = NaN; continue; }
      num[i] = v; numeric++; nonMissing++;
    } else {
      num[i] = NaN;
      if (!MISSING[s.trim().toLowerCase()]) nonMissing++;
    }
  }
  if (nonMissing === 0) return { name, type: 'empty', values: num, missing: n, invalid: 0 };
  if (numeric / nonMissing >= 0.95) return { name, type: 'number', values: num, missing: n - nonMissing, invalid: nonMissing - numeric };
  let tried = 0, ok = 0;
  for (let i = 0; i < n && tried < 200; i++) {
    const s = raw[i].trim();
    if (!s || MISSING[s.toLowerCase()]) continue;
    tried++;
    if (csvParseDate(s) === csvParseDate(s)) ok++;
  }
  if (tried && ok / tried >= 0.9) {
    let miss = 0, inv = 0;
    for (let i = 0; i < n; i++) {
      const s = raw[i].trim();
      if (!s || MISSING[s.toLowerCase()]) { num[i] = NaN; miss++; continue; }
      const t = csvParseDate(s);
      num[i] = t;
      if (t !== t) inv++;
    }
    return { name, type: 'datetime', values: num, raw, missing: miss, invalid: inv };
  }
  let miss = 0;
  for (let i = 0; i < n; i++) { const s = raw[i]; if (!s || MISSING[s.trim().toLowerCase()]) miss++; }
  return { name, type: 'string', values: raw, missing: miss, invalid: 0 };
}

function csvBuildTable(text, opts) {
  opts = opts || {};
  const delimiter = opts.delimiter || csvDetectDelimiter(text);
  let header = null, rows = 0;
  const cols = [];
  const pos = csvParseRows(text, delimiter, opts.maxRows || 0, function (row) {
    if (row.length === 1 && row[0].trim() === '') return;
    if (header === null) { header = row.slice(); for (let k = 0; k < row.length; k++) cols.push([]); return; }
    if (row.length > cols.length) {
      for (let k = cols.length; k < row.length; k++) { header.push(''); cols.push(new Array(rows).fill('')); }
    }
    for (let k = 0; k < cols.length; k++) cols[k].push(k < row.length ? row[k] : '');
    rows++;
  });
  const complete = pos >= text.length && !opts.dropLast;
  if (opts.dropLast && rows > 1) { for (const c of cols) c.pop(); rows--; }
  if (header === null) header = [];
  const headerless = header.length > 0 && header.every((s) => s.trim() !== '' && Number.isFinite(+s));
  if (headerless) {
    for (let k = 0; k < cols.length; k++) cols[k].unshift(header[k]);
    rows++;
    header = header.map(() => '');
  }
  const seen = {};
  const names = header.map((s, k) => {
    let nm = String(s).replace(/^﻿/, '').trim() || 'col' + (k + 1);
    if (seen[nm.toLowerCase()]) {
      let j = 2;
      while (seen[(nm + '_' + j).toLowerCase()]) j++;
      nm = nm + '_' + j;
    }
    seen[nm.toLowerCase()] = 1;
    return nm;
  });
  const columns = names.map((nm, k) => csvInferColumn(nm, cols[k]));
  return { delimiter, rowCount: rows, columns, headerless, consumed: pos, complete };
}

/* =====================================================================
 * 数据表：插件拿到的 t 就是它
 * ===================================================================== */
class DataTable {
  constructor(parsed, meta) {
    meta = meta || {};
    this.name = meta.name || '';
    this.path = meta.path || '';
    this.file = { name: this.name, path: this.path, size: meta.size || 0 };
    this.rowCount = parsed.rowCount;
    this.delimiter = parsed.delimiter;
    this.encoding = parsed.encoding;
    this.parseMs = parsed.parseMs;
    this._cols = [];
    this._exact = new Map();
    this._lower = new Map();
    this._stats = new Map();
    for (const c of parsed.columns) this._push(Object.assign({ derived: false, source: null }, c));
  }
  static fromRows(rows, meta) {
    const keys = [];
    const seen = new Set();
    for (const r of rows) for (const k in r) if (!k.startsWith('__') && !seen.has(k)) { seen.add(k); keys.push(k); }
    const columns = keys.map((k) => {
      const vals = rows.map((r) => r[k]);
      const numeric = vals.every((v) => v == null || typeof v === 'number' || typeof v === 'boolean');
      if (numeric) {
        const f = new Float64Array(vals.length);
        vals.forEach((v, i) => { f[i] = v == null ? NaN : +v; });
        return { name: k, type: 'number', values: f, missing: vals.filter((v) => v == null || Number.isNaN(+v)).length };
      }
      return { name: k, type: 'string', values: vals.map((v) => (v == null ? '' : String(v))), missing: vals.filter((v) => v == null || v === '').length };
    });
    return new DataTable({ rowCount: rows.length, columns }, meta);
  }
  _push(c) {
    this._cols.push(c);
    this._exact.set(c.name, c);
    const lk = c.name.trim().toLowerCase();
    if (!this._lower.has(lk)) this._lower.set(lk, c);
  }
  _reindex() {
    this._exact = new Map();
    this._lower = new Map();
    const cols = this._cols;
    this._cols = [];
    for (const c of cols) this._push(c);
  }
  get columns() { return this._cols.map((c) => c.name); }
  get numericColumns() { return this._cols.filter((c) => c.type === 'number').map((c) => c.name); }
  getColumn(name) {
    if (name == null) return null;
    if (Array.isArray(name)) {
      for (const n of name) { const c = this.getColumn(n); if (c) return c; }
      return null;
    }
    return this._exact.get(name) || this._lower.get(String(name).trim().toLowerCase()) || null;
  }
  col(name) { const c = this.getColumn(name); return c ? c.values : undefined; }
  find(name) { const c = this.getColumn(name); return c ? c.name : null; }
  has(...names) { return names.every((n) => !!this.getColumn(n)); }
  type(name) { const c = this.getColumn(name); return c ? c.type : null; }
  isNumeric(name) { return this.type(name) === 'number'; }
  addColumn(name, values, meta) {
    meta = meta || {};
    name = String(name);
    if (!values || values.length !== this.rowCount) {
      throw new Error('特征 "' + name + '" 的长度为 ' + (values ? values.length : 0) + '，应与行数 ' + this.rowCount + ' 相同');
    }
    let type = meta.type;
    if (!type) {
      if (ArrayBuffer.isView(values)) type = 'number';
      else {
        type = 'number';
        for (let i = 0; i < values.length; i++) {
          const v = values[i];
          if (v != null && typeof v !== 'number' && typeof v !== 'boolean') { type = 'string'; break; }
        }
      }
    }
    let vals;
    if (type === 'number' || type === 'datetime') {
      vals = values instanceof Float64Array ? values : Float64Array.from(values, (v) => (v == null ? NaN : +v));
    } else vals = Array.from(values, (v) => (v == null ? '' : String(v)));
    const existing = this.getColumn(name);
    if (existing && !existing.derived) throw new Error('特征名 "' + name + '" 与原始列 "' + existing.name + '" 冲突');
    if (existing) { this._cols.splice(this._cols.indexOf(existing), 1); this._reindex(); }
    let missing = 0;
    for (let i = 0; i < vals.length; i++) { const v = vals[i]; if (v === '' || (typeof v === 'number' && !Number.isFinite(v))) missing++; }
    const col = { name, type, values: vals, derived: true, source: meta.source || null, label: meta.label || '', unit: meta.unit || '', description: meta.description || '', missing, invalid: 0 };
    this._push(col);
    this._stats.delete(name);
    return col;
  }
  removeDerived(source) {
    const keep = this._cols.filter((c) => !c.derived || (source !== undefined && c.source !== source));
    if (keep.length === this._cols.length) return;
    for (const c of this._cols) if (!keep.includes(c)) this._stats.delete(c.name);
    this._cols = keep;
    this._reindex();
  }
  map(names, fn) {
    names = Array.isArray(names) ? names : [names];
    const cols = names.map((nm) => {
      const v = this.col(nm);
      if (!v) throw new Error('列不存在: ' + nm);
      return v;
    });
    const n = this.rowCount, k = cols.length, out = new Float64Array(n), args = new Array(k + 1);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < k; j++) args[j] = cols[j][i];
      args[k] = i;
      const v = fn.apply(null, args);
      out[i] = v == null ? NaN : v;
    }
    return out;
  }
  row(i) {
    const o = {};
    for (const c of this._cols) o[c.name] = c.values[i];
    return o;
  }
  stats(name) {
    const c = this.getColumn(name);
    if (!c) return null;
    if (this._stats.has(c.name)) return this._stats.get(c.name);
    let s;
    const v = c.values;
    if (c.type === 'string' || c.type === 'empty' && !(v instanceof Float64Array)) {
      const m = new Map();
      let miss = 0;
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (x === '' || x == null) { miss++; continue; }
        if (m.size < 50000 || m.has(x)) m.set(x, (m.get(x) || 0) + 1);
      }
      const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      s = { kind: 'string', count: v.length - miss, missing: miss, distinct: m.size, capped: m.size >= 50000, top };
    } else {
      let n = 0, mean = 0, m2 = 0, mn = Infinity, mx = -Infinity;
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (!Number.isFinite(x)) continue;
        n++;
        const d = x - mean;
        mean += d / n;
        m2 += d * (x - mean);
        if (x < mn) mn = x;
        if (x > mx) mx = x;
      }
      const bins = 24, hist = new Array(bins).fill(0);
      if (n && mx > mn) {
        const w = (mx - mn) / bins;
        for (let i = 0; i < v.length; i++) { const x = v[i]; if (Number.isFinite(x)) hist[Math.min(bins - 1, Math.floor((x - mn) / w))]++; }
      } else if (n) hist[Math.floor(bins / 2)] = n;
      s = { kind: c.type, count: n, missing: v.length - n, min: n ? mn : NaN, max: n ? mx : NaN, mean: n ? mean : NaN, std: n > 1 ? Math.sqrt(m2 / (n - 1)) : NaN, hist };
    }
    this._stats.set(c.name, s);
    return s;
  }
  /** 单元格文本。display=true 时去掉衍生特征的浮点噪声（导出时保留完整精度） */
  cellText(c, i, display) {
    const v = c.values[i];
    if (c.type === 'string') return v;
    if (c.type === 'datetime') return c.raw ? c.raw[i] : (Number.isFinite(v) ? fmtDate(v) : '');
    if (!Number.isFinite(v)) return '';
    if (display && c.derived && !Number.isInteger(v)) return String(Math.abs(v) >= 1e5 ? +v.toFixed(3) : +v.toPrecision(6));
    return String(v);
  }
  toCSV() {
    const q = (s) => (/[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    const cols = this._cols;
    const lines = [cols.map((c) => q(c.name)).join(',')];
    for (let i = 0; i < this.rowCount; i++) lines.push(cols.map((c) => q(this.cellText(c, i))).join(','));
    return lines.join('\r\n');
  }
}

/* =====================================================================
 * 工具函数（插件中通过 ctx.utils / CSVViewer.utils 使用）
 * ===================================================================== */
const EPOCH_RANGES = [
  [1e-6, 9.46e17, 4.2e18], // 纳秒
  [1e-3, 9.46e14, 4.2e15], // 微秒
  [1, 9.46e11, 4.2e12],    // 毫秒
  [1000, 9.46e8, 4.2e9],   // 秒
];
/** 若数值看起来是 2000–2100 年间的 Unix 时间戳，返回换算到毫秒的倍数，否则 null */
function epochScale(values) {
  if (!values || !values.length) return null;
  let lo = Infinity, hi = -Infinity, n = 0;
  const step = Math.max(1, Math.floor(values.length / 4000));
  for (let i = 0; i < values.length; i += step) {
    const v = values[i];
    if (typeof v === 'number' && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; n++; }
  }
  const last = values[values.length - 1];
  if (typeof last === 'number' && Number.isFinite(last)) { if (last < lo) lo = last; if (last > hi) hi = last; }
  if (!n) return null;
  for (const [scale, a, b] of EPOCH_RANGES) if (lo >= a && hi <= b) return scale;
  return null;
}
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

const U = {
  fmt: fmtNum, fmtBytes, fmtDuration, fmtDate,
  isNum,
  finite(a) { const o = []; for (let i = 0; i < a.length; i++) if (isNum(a[i])) o.push(a[i]); return o; },
  count(a) { let n = 0; if (a) for (let i = 0; i < a.length; i++) if (isNum(a[i])) n++; return n; },
  sum(a) { let s = 0; if (a) for (let i = 0; i < a.length; i++) if (isNum(a[i])) s += a[i]; return s; },
  mean(a) { let s = 0, n = 0; if (a) for (let i = 0; i < a.length; i++) if (isNum(a[i])) { s += a[i]; n++; } return n ? s / n : NaN; },
  variance(a) {
    let n = 0, m = 0, m2 = 0;
    if (a) for (let i = 0; i < a.length; i++) { const x = a[i]; if (!isNum(x)) continue; n++; const d = x - m; m += d / n; m2 += d * (x - m); }
    return n > 1 ? m2 / (n - 1) : NaN;
  },
  std(a) { return Math.sqrt(U.variance(a)); },
  min(a) { let m = Infinity; if (a) for (let i = 0; i < a.length; i++) if (isNum(a[i]) && a[i] < m) m = a[i]; return m === Infinity ? NaN : m; },
  max(a) { let m = -Infinity; if (a) for (let i = 0; i < a.length; i++) if (isNum(a[i]) && a[i] > m) m = a[i]; return m === -Infinity ? NaN : m; },
  extent(a) { return [U.min(a), U.max(a)]; },
  rms(a) { let s = 0, n = 0; if (a) for (let i = 0; i < a.length; i++) if (isNum(a[i])) { s += a[i] * a[i]; n++; } return n ? Math.sqrt(s / n) : NaN; },
  quantile(a, q) {
    const f = Float64Array.from(U.finite(a || [])).sort();
    if (!f.length) return NaN;
    const pos = (f.length - 1) * Math.min(1, Math.max(0, q)), lo = Math.floor(pos), hi = Math.ceil(pos);
    return f[lo] + (f[hi] - f[lo]) * (pos - lo);
  },
  median(a) { return U.quantile(a, 0.5); },
  diff(a) { const o = new Float64Array(a.length); if (a.length) o[0] = NaN; for (let i = 1; i < a.length; i++) o[i] = a[i] - a[i - 1]; return o; },
  cumsum(a) { const o = new Float64Array(a.length); let s = 0; for (let i = 0; i < a.length; i++) { if (isNum(a[i])) s += a[i]; o[i] = s; } return o; },
  /** 滑动平均（忽略 NaN）。center=true 时窗口居中 */
  movingAverage(a, w, center) {
    w = Math.max(1, Math.round(w || 5));
    const n = a.length, ps = new Float64Array(n + 1), pc = new Float64Array(n + 1), o = new Float64Array(n);
    for (let i = 0; i < n; i++) { const ok = isNum(a[i]); ps[i + 1] = ps[i] + (ok ? a[i] : 0); pc[i + 1] = pc[i] + (ok ? 1 : 0); }
    const back = center ? Math.floor((w - 1) / 2) : w - 1, fwd = center ? w - 1 - back : 0;
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - back), hi = Math.min(n, i + fwd + 1), c = pc[hi] - pc[lo];
      o[i] = c ? (ps[hi] - ps[lo]) / c : NaN;
    }
    return o;
  },
  ema(a, alpha) {
    alpha = alpha == null ? 0.2 : alpha;
    const o = new Float64Array(a.length);
    let prev = NaN;
    for (let i = 0; i < a.length; i++) { const v = a[i]; if (isNum(v)) prev = prev === prev ? alpha * v + (1 - alpha) * prev : v; o[i] = prev; }
    return o;
  },
  zscore(a) { const m = U.mean(a), s = U.std(a); return Float64Array.from(a, (v) => (isNum(v) && s ? (v - m) / s : NaN)); },
  histogram(a, bins, range) {
    bins = bins || 30;
    let [lo, hi] = range || U.extent(a);
    if (!Number.isFinite(lo)) return { edges: [], counts: [], centers: [] };
    if (hi === lo) { lo -= 0.5; hi += 0.5; }
    const w = (hi - lo) / bins, counts = new Array(bins).fill(0);
    for (let i = 0; i < a.length; i++) { const v = a[i]; if (isNum(v) && v >= lo && v <= hi) counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++; }
    const edges = Array.from({ length: bins + 1 }, (_, k) => lo + k * w);
    return { edges, counts, centers: edges.slice(0, -1).map((e) => e + w / 2), binWidth: w };
  },
  corr(a, b) {
    let n = 0, ma = 0, mb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) if (isNum(a[i]) && isNum(b[i])) { n++; ma += a[i]; mb += b[i]; }
    if (n < 3) return NaN;
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < len; i++) if (isNum(a[i]) && isNum(b[i])) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN;
  },
  linreg(x, y) {
    let n = 0, mx = 0, my = 0;
    const len = Math.min(x.length, y.length);
    for (let i = 0; i < len; i++) if (isNum(x[i]) && isNum(y[i])) { n++; mx += x[i]; my += y[i]; }
    if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN, n };
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < len; i++) if (isNum(x[i]) && isNum(y[i])) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    const slope = sxy / sxx;
    return { slope, intercept: my - slope * mx, r2: syy ? (sxy * sxy) / (sxx * syy) : NaN, n };
  },
  epochScale,
  isTimeName: (name) => TIME_NAME.test(String(name || '')),
  /** 在表（或表头信息）里找时间列：优先 ts/timestamp/time 等常见名，其次日期字符串列 */
  timeColumn(t) {
    for (const p of ['ts', 'timestamp', 'time', 'datetime', 'date', 't']) {
      const c = t.find(p);
      if (c && (t.type(c) === 'number' || t.type(c) === 'datetime')) return c;
    }
    const cols = t.columns;
    return cols.find((c) => t.type(c) === 'datetime') || cols.find((c) => t.type(c) === 'number' && TIME_NAME.test(c)) || null;
  },
  /** 时长。unit: 'auto'（自动识别时间戳）| 's' | 'ms' | 'us' | 'ns' */
  duration(values, unit) {
    const lo = U.min(values || []), hi = U.max(values || []);
    if (!Number.isFinite(lo)) return { seconds: null, span: NaN, text: '—' };
    const scales = { s: 1000, ms: 1, us: 1e-3, ns: 1e-6 };
    const sc = !unit || unit === 'auto' ? epochScale(values) : scales[unit];
    if (sc == null) return { seconds: null, span: hi - lo, text: fmtNum(hi - lo) + '（原始单位）' };
    const ms = (hi - lo) * sc;
    return { seconds: ms / 1000, span: hi - lo, text: fmtDuration(ms) };
  },
  map(n, fn) { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = fn(i); return o; },
};

function compileMatcher(m) {
  if (m == null) return () => true;
  if (typeof m === 'function') return m;
  if (typeof m !== 'object') throw new Error('match 必须是对象或函数');
  const pathRe = m.path == null ? null : m.path instanceof RegExp ? m.path : globToRegExp(String(m.path));
  const byName = pathRe && !(m.path instanceof RegExp) && !String(m.path).includes('/');
  return (info) => {
    if (m.columns && !m.columns.every((c) => info.find(c))) return false;
    if (m.anyColumns && !m.anyColumns.some((c) => info.find(c))) return false;
    if (m.numericColumns && !m.numericColumns.every((c) => info.isNumeric(info.find(c)))) return false;
    if (pathRe && !pathRe.test(byName ? info.name : info.path)) return false;
    if (m.minColumns && info.columns.length < m.minColumns) return false;
    if (typeof m.test === 'function' && !m.test(info)) return false;
    return true;
  };
}
function globToRegExp(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function isPlain(o) { return !!o && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype; }
function mergeDeep(a, b) {
  if (b === undefined) return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    return b.map((v, i) => (isPlain(v) && isPlain(a[i]) ? mergeDeep(a[i], v) : v)).concat(a.slice(b.length));
  }
  if (isPlain(a) && isPlain(b)) {
    const out = Object.assign({}, a);
    for (const k in b) out[k] = k in a ? mergeDeep(a[k], b[k]) : b[k];
    return out;
  }
  return b;
}
const toList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const isVec = (v) => typeof v === 'string' || Array.isArray(v) || ArrayBuffer.isView(v) || !!(v && v.values);
/** y 既可以是列名 / 列名数组（多条序列），也可以直接是一个数值数组（一条序列） */
function yList(y) {
  if (y == null) return [];
  if (Array.isArray(y) && y.length && y.every(isVec)) return y;
  return [y];
}

/** 把 x / y 解析成 {name, values, type}：列名、数组或 {name, values} 对象 */
function resolveVec(v, table) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const c = table && table.getColumn(v);
    if (!c) throw new Error('列不存在：' + v);
    return { name: c.name, values: c.values, type: c.type };
  }
  if (ArrayBuffer.isView(v)) return { name: '', values: v, type: 'number' };
  if (Array.isArray(v)) return { name: '', values: v, type: v.some((x) => typeof x === 'string') ? 'string' : 'number' };
  if (v && v.values) return { name: v.name || '', values: v.values, type: v.type || (ArrayBuffer.isView(v.values) ? 'number' : Array.from(v.values).some((x) => typeof x === 'string') ? 'string' : 'number') };
  throw new Error('无法识别的数据：' + String(v));
}
function resolveXAxis(kind, xv) {
  if (!xv) return { type: 'value', scale: 1, label: '行号' };
  const label = xv.name || '';
  if (kind === 'category' || xv.type === 'string') return { type: 'category', scale: 1, label };
  if (xv.type === 'datetime') return { type: kind === 'value' ? 'value' : 'time', scale: 1, label };
  if (kind === 'time') return { type: 'time', scale: epochScale(xv.values) || 1, label };
  if (kind === 'value') return { type: 'value', scale: 1, label };
  if (label && TIME_NAME.test(label)) {
    const sc = epochScale(xv.values);
    if (sc) return { type: 'time', scale: sc, label };
  }
  return { type: 'value', scale: 1, label };
}

function baseOption(T, o) {
  o = o || {};
  const opt = {
    backgroundColor: 'transparent',
    animation: !o.big,
    animationDuration: 300,
    color: T.series,
    textStyle: { fontFamily: T.font, color: T.text2 },
    grid: { left: 6, right: 16, top: o.legend ? 36 : 30, bottom: o.xName ? 24 : 6, containLabel: true },
    tooltip: {
      trigger: o.trigger || 'axis',
      confine: true,
      backgroundColor: T.surface,
      borderColor: T.border,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: T.text, fontSize: 12, fontFamily: T.font },
      extraCssText: 'border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.14);',
      axisPointer: { type: 'line', lineStyle: { color: T.muted, width: 1, type: 'solid' } },
      valueFormatter: (v) => fmtNum(v),
    },
    toolbox: {
      right: 2, top: 0, itemSize: 13, itemGap: 9,
      iconStyle: { borderColor: T.muted },
      emphasis: { iconStyle: { borderColor: T.text, textFill: T.text } },
      feature: Object.assign(
        o.zoom === false ? {} : { dataZoom: { yAxisIndex: 'none', title: { zoom: '框选缩放', back: '撤销缩放' } }, restore: { title: '还原' } },
        { saveAsImage: { title: '保存为图片', pixelRatio: 2, backgroundColor: T.surface, name: o.name || 'chart' } }
      ),
    },
    dataZoom: o.zoom === false ? [] : [{ type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, moveOnMouseMove: true }],
  };
  if (o.legend) {
    const line = o.legendIcon === 'line';
    opt.legend = {
      type: 'scroll', top: 0, left: 0, right: 90,
      icon: line ? 'rect' : o.legendIcon || 'roundRect',
      itemWidth: line ? 16 : 10, itemHeight: line ? 3 : 10, itemGap: 14,
      textStyle: { color: T.text2, fontSize: 12 },
      pageIconColor: T.text2, pageIconInactiveColor: T.axis, pageTextStyle: { color: T.muted },
    };
  }
  return opt;
}
function xAxisStyle(T) {
  return {
    axisLine: { onZero: false, lineStyle: { color: T.axis } },
    axisTick: { show: false },
    axisLabel: { color: T.muted, fontSize: 11, hideOverlap: true },
    splitLine: { show: false },
    nameTextStyle: { color: T.muted, fontSize: 11 },
  };
}
function yAxisStyle(T) {
  return {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: T.muted, fontSize: 11, formatter: fmtAxis },
    splitLine: { lineStyle: { color: T.grid, width: 1, type: 'solid' } },
    nameTextStyle: { color: T.muted, fontSize: 11 },
  };
}

function specToOption(spec, table, T) {
  const type = spec.type || 'line';
  let opt;
  if (spec.echarts) opt = mergeDeep(baseOption(T, {}), typeof spec.echarts === 'function' ? spec.echarts(T, table) : spec.echarts);
  else if (type === 'histogram') opt = histogramOption(spec, table, T);
  else if (type === 'heatmap') opt = heatmapOption(spec, table, T);
  else opt = xyOption(spec, table, T, type);
  if (spec.option) opt = mergeDeep(opt, spec.option);
  return opt;
}

function xyOption(spec, table, T, type) {
  const defs = spec.series ? toList(spec.series) : yList(spec.y).map((y) => ({ y }));
  if (!defs.length) throw new Error('图表缺少 y');
  const resolved = defs.map((s, i) => {
    const xv = resolveVec(s.x !== undefined ? s.x : spec.x, table);
    const yv = resolveVec(s.y, table);
    if (!yv) throw new Error('系列缺少 y');
    if (yv.type === 'string') throw new Error('列 "' + yv.name + '" 不是数值列');
    return { def: s, xv, yv, type: s.type || type, name: s.name || yv.name || '系列 ' + (i + 1) };
  });
  const ax = resolveXAxis(spec.xType || 'auto', resolved[0].xv);
  const horizontal = !!spec.horizontal;
  const allScatter = resolved.every((r) => r.type === 'scatter');
  const allBar = resolved.every((r) => r.type === 'bar');
  let total = 0;
  const series = resolved.map((r, i) => {
    const s = buildSeries(r, ax, T, i, resolved.length, spec, horizontal);
    total += s.data.length;
    return s;
  });
  const xName = spec.xLabel !== undefined ? spec.xLabel : ax.label;
  const opt = baseOption(T, {
    legend: series.length > 1,
    trigger: allScatter || allBar ? 'item' : 'axis',
    legendIcon: allScatter ? 'circle' : allBar ? 'roundRect' : 'line',
    big: total > 20000,
    xName: !!xName && !horizontal,
    name: spec.title,
  });
  const xAxis = Object.assign(xAxisStyle(T), {
    type: ax.type,
    name: xName || '',
    nameLocation: 'middle',
    nameGap: 24,
    boundaryGap: ax.type === 'category',
  });
  if (ax.type === 'value' || ax.type === 'time') { xAxis.min = 'dataMin'; xAxis.max = 'dataMax'; }
  if (ax.type === 'value') xAxis.axisLabel.formatter = fmtAxis;
  if (ax.type === 'category') Object.assign(xAxis.axisLabel, { width: horizontal ? 150 : 90, overflow: 'truncate' });
  const yAxis = Object.assign(yAxisStyle(T), { type: 'value', scale: !spec.yZero && !allBar, name: '' });
  if (spec.yMin != null) yAxis.min = spec.yMin;
  if (spec.yMax != null) yAxis.max = spec.yMax;
  if (allBar && spec.labels) {
    // 给条形末端的数值标签留出空间（ECharts 按数据跨度计算留白，这里换算成以 0 为基线的跨度）
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const d of s.data) { const v = (d.value || d)[horizontal ? 0 : 1]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (Number.isFinite(lo)) {
      const span = Math.max(hi, 0) - Math.min(lo, 0) || 1;
      const dataSpan = hi - lo || Math.abs(hi) || 1;
      const gap = ((0.18 * span) / dataSpan * 100).toFixed(1) + '%';
      yAxis.boundaryGap = [lo < 0 ? gap : 0, hi > 0 ? gap : 0];
    }
  }
  if (horizontal) {
    // 横向条形图：类别在 y 轴，数值在 x 轴
    Object.assign(xAxis, { inverse: true, axisLine: { show: false }, splitLine: { show: false } });
    opt.xAxis = Object.assign(yAxisStyle(T), { type: 'value', scale: yAxis.scale, boundaryGap: yAxis.boundaryGap, splitLine: { lineStyle: { color: T.grid } } });
    opt.yAxis = Object.assign(xAxis, { name: '', axisLine: { onZero: false, lineStyle: { color: T.axis } } });
    opt.dataZoom = [];
    opt.grid.right = 40;
  } else {
    opt.xAxis = xAxis;
    opt.yAxis = yAxis;
  }
  if (allScatter || allBar) {
    const xn = xName || 'x';
    opt.tooltip.formatter = (p) => {
      const v = p.value || [];
      const xVal = horizontal ? v[1] : v[0], yVal = horizontal ? v[0] : v[1];
      const xs = ax.type === 'time' ? fmtDate(xVal) : typeof xVal === 'number' ? fmtNum(xVal) : xVal;
      let s = '<div style="font-weight:600;font-size:13px">' + esc(fmtNum(yVal)) + '</div>';
      s += '<div style="color:' + T.text2 + '">' + esc(p.seriesName) + '</div>';
      s += '<div style="color:' + T.muted + '">' + esc(xn) + '：' + esc(xs) + '</div>';
      return s;
    };
  }
  for (const ml of toList(spec.markLines)) {
    const s = series[0];
    s.markLine = s.markLine || { symbol: 'none', silent: true, animation: false, lineStyle: { color: T.muted, width: 1, type: 'solid' }, label: { color: T.text2, fontSize: 11 }, data: [] };
    if (ml.y != null) s.markLine.data.push({ yAxis: ml.y, name: ml.label || '', label: { formatter: ml.label || String(ml.y), position: 'insideEndTop' } });
    if (ml.x != null) s.markLine.data.push({ xAxis: ml.x * ax.scale, name: ml.label || '', label: { formatter: ml.label || '', position: 'insideEndTop' } });
  }
  opt.series = series;
  return opt;
}

function buildSeries(r, ax, T, i, total, spec, horizontal) {
  const color = r.def.color || T.series[(r.def.colorIndex != null ? r.def.colorIndex : i) % T.series.length];
  const ys = r.yv.values, xs = r.xv ? r.xv.values : null, n = ys.length;
  const cat = ax.type === 'category', sc = ax.scale;
  const data = [];
  let sorted = true, last = -Infinity;
  for (let k = 0; k < n; k++) {
    const y = ys[k];
    if (typeof y !== 'number' || !Number.isFinite(y)) continue;
    let x = k;
    if (xs) {
      x = xs[k];
      if (cat) { if (x == null || x === '') continue; x = String(x); }
      else {
        if (typeof x !== 'number' || !Number.isFinite(x)) continue;
        x *= sc;
        if (x < last) sorted = false;
        last = x;
      }
    }
    data.push(horizontal ? [y, x] : [x, y]);
  }
  const t = r.type;
  if (!sorted && LINEISH.has(t)) data.sort((a, b) => a[0] - b[0]);
  const base = { name: r.name, data, emphasis: { focus: total > 1 ? 'series' : 'none' } };
  if (t === 'scatter') {
    const big = data.length > 5000, mid = data.length > 1200;
    return Object.assign(base, {
      type: 'scatter',
      symbolSize: big ? 4 : mid ? 6 : 8,
      large: big, largeThreshold: 5000,
      itemStyle: { color, opacity: big ? 0.5 : mid ? 0.7 : 0.9, borderColor: T.surface, borderWidth: mid ? 0 : 2 },
      emphasis: { scale: 1.5, focus: total > 1 ? 'series' : 'none' },
    });
  }
  if (t === 'bar') {
    // 负值条形：圆角与数值标签放到数据端
    const negEnd = { borderRadius: horizontal ? [4, 0, 0, 4] : [0, 0, 4, 4] };
    const negLabel = spec.labels ? { position: horizontal ? 'left' : 'bottom' } : undefined;
    base.data = data.map((d) => ((horizontal ? d[0] : d[1]) < 0 ? { value: d, itemStyle: negEnd, label: negLabel } : d));
    return Object.assign(base, {
      type: 'bar',
      barMaxWidth: 24,
      itemStyle: { color, borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
      large: data.length > 3000,
      label: spec.labels ? {
        show: true, position: horizontal ? 'right' : 'top', color: T.text2, fontSize: 11,
        formatter: (p) => fmtNum(horizontal ? p.value[0] : p.value[1]),
      } : undefined,
    });
  }
  return Object.assign(base, {
    type: 'line',
    showSymbol: data.length <= 40,
    symbol: 'circle',
    symbolSize: 8,
    sampling: 'lttb',
    step: t === 'step' ? 'end' : false,
    lineStyle: { width: 2, color, cap: 'round', join: 'round' },
    itemStyle: { color, borderColor: T.surface, borderWidth: 2 },
    areaStyle: t === 'area' ? { color, opacity: 0.1 } : undefined,
    connectNulls: false,
    emphasis: { focus: total > 1 ? 'series' : 'none', lineStyle: { width: 2 } },
  });
}

function histogramOption(spec, table, T) {
  const ys = yList(spec.y).map((y) => resolveVec(y, table)).filter(Boolean);
  if (!ys.length) throw new Error('直方图缺少 y');
  const bins = Math.max(2, Math.min(200, Math.round(spec.bins || 30)));
  let lo = Infinity, hi = -Infinity;
  for (const yv of ys) for (let i = 0; i < yv.values.length; i++) { const v = yv.values[i]; if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (spec.range) [lo, hi] = spec.range;
  if (!Number.isFinite(lo)) throw new Error('没有可用的数值');
  if (hi === lo) { lo -= 0.5; hi += 0.5; }
  const w = (hi - lo) / bins;
  const labels = Array.from({ length: bins }, (_, k) => fmtAxis(lo + w * (k + 0.5)));
  const series = ys.map((yv, i) => {
    const counts = new Array(bins).fill(0);
    for (let k = 0; k < yv.values.length; k++) {
      const v = yv.values[k];
      if (isNum(v) && v >= lo && v <= hi) counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
    }
    return {
      type: 'bar', name: yv.name || '系列 ' + (i + 1), data: counts,
      barCategoryGap: ys.length > 1 ? '20%' : 2,
      itemStyle: { color: T.series[i % 8], borderRadius: [3, 3, 0, 0] },
      emphasis: { itemStyle: { opacity: 0.8 } },
    };
  });
  const xName = spec.xLabel !== undefined ? spec.xLabel : ys.length === 1 ? ys[0].name : '';
  const opt = baseOption(T, { legend: ys.length > 1, trigger: 'item', legendIcon: 'roundRect', xName: !!xName, name: spec.title });
  opt.xAxis = Object.assign(xAxisStyle(T), { type: 'category', data: labels, name: xName, nameLocation: 'middle', nameGap: 24 });
  opt.yAxis = Object.assign(yAxisStyle(T), { type: 'value', minInterval: 1 });
  opt.tooltip.formatter = (p) =>
    '<div style="font-weight:600;font-size:13px">' + p.value + ' 条</div>' +
    '<div style="color:' + T.muted + '">' + esc(fmtNum(lo + w * p.dataIndex)) + ' – ' + esc(fmtNum(lo + w * (p.dataIndex + 1))) + '</div>' +
    (ys.length > 1 ? '<div style="color:' + T.text2 + '">' + esc(p.seriesName) + '</div>' : '');
  opt.series = series;
  return opt;
}

function heatmapOption(spec, table, T) {
  const xc = (spec.xCategories || []).map(String), yc = (spec.yCategories || []).map(String);
  const raw = spec.data || [];
  const finite = raw.map((d) => d[2]).filter(isNum);
  const min = spec.min != null ? spec.min : finite.length ? Math.min(...finite) : 0;
  const max = spec.max != null ? spec.max : finite.length ? Math.max(...finite) : 1;
  const diverging = spec.diverging != null ? spec.diverging : min < 0 && max > 0;
  const showLabel = spec.labels != null ? spec.labels : xc.length <= 10 && yc.length <= 10;
  const mid = (min + max) / 2, half = (max - min) / 2 || 1;
  const data = raw.map(([i, j, v]) => {
    const ok = isNum(v);
    const strong = ok && (diverging ? Math.abs(v - mid) / half > 0.55 : (v - min) / (max - min || 1) > 0.55);
    return { value: [i, j, ok ? v : '-'], label: { color: strong ? '#ffffff' : T.text } };
  });
  const opt = baseOption(T, { trigger: 'item', zoom: false, name: spec.title });
  opt.grid = { left: 6, right: 16, top: 30, bottom: 44, containLabel: true };
  opt.xAxis = { type: 'category', data: xc, axisLine: { show: false }, axisTick: { show: false }, splitArea: { show: false }, axisLabel: { color: T.muted, fontSize: 11, interval: 0, rotate: xc.length > 6 ? 35 : 0, width: 96, overflow: 'truncate' } };
  opt.yAxis = { type: 'category', data: yc, inverse: true, axisLine: { show: false }, axisTick: { show: false }, splitArea: { show: false }, axisLabel: { color: T.muted, fontSize: 11, interval: 0, width: 120, overflow: 'truncate' } };
  opt.visualMap = {
    min, max, calculable: false, orient: 'horizontal', left: 'center', bottom: 0,
    itemWidth: 10, itemHeight: 160, precision: 2,
    textStyle: { color: T.muted, fontSize: 11 },
    inRange: { color: diverging ? [T.divNeg, T.divMid, T.divPos] : T.seq },
  };
  opt.series = [{
    type: 'heatmap', data,
    label: { show: showLabel, fontSize: 11, formatter: (p) => (typeof p.value[2] === 'number' ? p.value[2].toFixed(2) : '') },
    itemStyle: { borderColor: T.surface, borderWidth: 2, borderRadius: 4 },
    emphasis: { itemStyle: { borderColor: T.text, borderWidth: 1.5 } },
  }];
  opt.tooltip.formatter = (p) =>
    '<div style="font-weight:600;font-size:13px">' + (typeof p.value[2] === 'number' ? esc(fmtNum(p.value[2])) : '—') + '</div>' +
    '<div style="color:' + T.muted + '">' + esc(xc[p.value[0]]) + ' × ' + esc(yc[p.value[1]]) + '</div>';
  return opt;
}

root.CSVLensCore = {
  TIME_NAME,
  LINEISH,
  esc,
  fmtNum,
  fmtAxis,
  fmtBytes,
  fmtDuration,
  fmtDate,
  fmtCell,
  csvDecode,
  csvDetectDelimiter,
  csvParseRows,
  csvParseDate,
  csvInferColumn,
  csvBuildTable,
  DataTable,
  EPOCH_RANGES,
  epochScale,
  isNum,
  U,
  compileMatcher,
  globToRegExp,
  isPlain,
  mergeDeep,
  toList,
  isVec,
  yList,
  resolveVec,
  resolveXAxis,
  baseOption,
  xAxisStyle,
  yAxisStyle,
  specToOption,
  xyOption,
  buildSeries,
  histogramOption,
  heatmapOption,
};
})(typeof window !== 'undefined' ? window : globalThis);
