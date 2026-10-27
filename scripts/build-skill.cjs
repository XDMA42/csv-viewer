#!/usr/bin/env node
/**
 * 由插件 API 参考生成页面与 skill 需要的文件：
 *
 *   node scripts/build-skill.cjs           生成 lib/plugin-guide.js（页面「AI 提示词」用）
 *   node scripts/build-skill.cjs --zip     另外打包 dist/csv-lens-plugin.zip（可安装的 Claude skill）
 *   node scripts/build-skill.cjs --check   检查 lib/plugin-guide.js 是否与源文件一致（CI 用）
 *
 * 源文件：.claude/skills/csv-lens-plugin/（SKILL.md、reference.md、scripts/check_plugin.cjs）、
 *         plugins/*.js（示例）、lib/core.js（检查器使用的核心代码）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, '.claude', 'skills', 'csv-lens-plugin');
const GUIDE_OUT = path.join(ROOT, 'lib', 'plugin-guide.js');
const ZIP_OUT = path.join(ROOT, 'dist', 'csv-lens-plugin.zip');
const read = (...p) => fs.readFileSync(path.join(...p));

function guideSource() {
  const guide = {
    reference: read(SKILL, 'reference.md').toString('utf8'),
    example: { name: 'plugins/ranging.js', source: read(ROOT, 'plugins', 'ranging.js').toString('utf8') },
  };
  return '// 由 scripts/build-skill.cjs 生成，请勿手动修改。\n' +
    '// 源文件：.claude/skills/csv-lens-plugin/reference.md、plugins/ranging.js\n' +
    'window.CSVLensPluginGuide = ' + JSON.stringify(guide, null, 2) + ';\n';
}

// ---------- 最小的 ZIP 写入（deflate），只依赖 Node 标准库 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 固定时间，便于重复构建得到相同文件
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(8, 8);      // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + comp.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

function sampleCsv() {
  // 示例数据：取测距样例的前 300 行，供检查器试运行
  const lines = read(ROOT, 'samples', 'ranging', '2026-10-20', 'anchor01_walk.csv').toString('utf8').split('\n');
  return Buffer.from(lines.slice(0, 301).join('\n') + '\n', 'utf8');
}

function skillEntries() {
  const base = 'csv-lens-plugin/';
  const entries = [
    { name: base + 'SKILL.md', data: read(SKILL, 'SKILL.md') },
    { name: base + 'reference.md', data: read(SKILL, 'reference.md') },
    { name: base + 'scripts/check_plugin.cjs', data: read(SKILL, 'scripts', 'check_plugin.cjs') },
    { name: base + 'scripts/core.js', data: read(ROOT, 'lib', 'core.js') },
    { name: base + 'examples/ranging_sample.csv', data: sampleCsv() },
  ];
  for (const f of ['ranging.js', 'timeseries.js', 'generic-stats.js', '_template.js']) {
    entries.push({ name: base + 'examples/' + f, data: read(ROOT, 'plugins', f) });
  }
  return entries;
}

const args = process.argv.slice(2);
const src = guideSource();
if (args.includes('--check')) {
  const cur = fs.existsSync(GUIDE_OUT) ? fs.readFileSync(GUIDE_OUT, 'utf8') : '';
  if (cur !== src) {
    console.error('lib/plugin-guide.js 已过期：请运行 node scripts/build-skill.cjs 并提交结果');
    process.exit(1);
  }
  console.log('lib/plugin-guide.js 是最新的');
  process.exit(0);
}
fs.writeFileSync(GUIDE_OUT, src);
console.log('wrote', path.relative(ROOT, GUIDE_OUT));
if (args.includes('--zip')) {
  fs.mkdirSync(path.dirname(ZIP_OUT), { recursive: true });
  const entries = skillEntries();
  fs.writeFileSync(ZIP_OUT, zip(entries));
  console.log('wrote', path.relative(ROOT, ZIP_OUT), `(${entries.length} files)`);
}
