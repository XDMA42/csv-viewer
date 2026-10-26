// 由 icon.svg 生成多尺寸的 icon.ico（≤128px 用 32 位 BMP，256px 用 PNG）。
// 只在修改图标时需要运行：node cmd/csvlens/winres/render_icon.js（需要 playwright）
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const svgTpl = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');

function bmpFrame(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const buf = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8); // XOR + AND
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  let o = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[o++] = rgba[i + 2]; buf[o++] = rgba[i + 1]; buf[o++] = rgba[i]; buf[o++] = rgba[i + 3];
    }
  }
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] === 0) buf[o + (x >> 3)] |= 0x80 >> (x & 7);
    }
    o += maskRow;
  }
  return buf;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const frames = [];
  for (const size of SIZES) {
    // 小尺寸加粗线条，保证 16px 下仍清晰
    const stroke = Math.max(24, (1.8 * 256) / size);
    const dot = size <= 24 ? 0 : Math.max(16, (1.5 * 256) / size); // 太小时去掉圆点，避免与折线粘连
    const svg = svgTpl.replace('STROKE', stroke.toFixed(1)).replace('DOT', dot.toFixed(1));
    const res = await page.evaluate(async ({ svg, size }) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + btoa(svg);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      let bin = '';
      for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
      return { rgba: btoa(bin), png: c.toDataURL('image/png').split(',')[1] };
    }, { svg, size });
    const data = size >= 256 ? Buffer.from(res.png, 'base64') : bmpFrame(size, Buffer.from(res.rgba, 'base64'));
    frames.push({ size, data });
    if (size === 256) fs.writeFileSync(path.join(__dirname, 'icon-256.png'), data);
  }
  await browser.close();
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((f, i) => {
    const e = 6 + i * 16;
    header[e] = f.size >= 256 ? 0 : f.size;
    header[e + 1] = f.size >= 256 ? 0 : f.size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(f.data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += f.data.length;
  });
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([header, ...frames.map((f) => f.data)]));
  console.log('icon.ico:', frames.map((f) => f.size + 'px').join(' '));
})();
