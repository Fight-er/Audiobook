/**
 * 用示例文本生成一个规范的 EPUB（mimetype 不压缩、其余 deflate），
 * 既给用户当测试素材，也用来验证 parser.js 的 EPUB 解析路径。
 *
 * 运行：node tools/make-sample-epub.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { splitChapters, normalizeText } from '../public/js/parser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'samples/星海拾遗.txt');
const OUT = path.join(ROOT, 'samples/星海拾遗.epub');

/* ---- CRC32 ---- */
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

function dosTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** 组装 zip：[{ name, data:Buffer, store:bool }] */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosTime();

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = f.data;
    const compressed = f.store ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const method = f.store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, compressed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const raw = fs.readFileSync(SRC, 'utf8');
const normalized = normalizeText(raw);
const title = normalized.split('\n', 1)[0].trim();
const chapters = splitChapters(normalized.slice(normalized.indexOf('\n') + 1));

const files = [
  { name: 'mimetype', data: Buffer.from('application/epub+zip'), store: true },
  {
    name: 'META-INF/container.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`),
  },
];

chapters.forEach((ch, i) => {
  const body = ch.blocks
    .map((b) => (b.type === 'h' ? `<h2>${esc(b.text)}</h2>` : `<p>${esc(b.text)}</p>`))
    .join('\n    ');
  files.push({
    name: `OEBPS/ch${String(i + 1).padStart(2, '0')}.xhtml`,
    data: Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
  <head><meta charset="utf-8"/><title>${esc(ch.title)}</title></head>
  <body>
    <h1>${esc(ch.title)}</h1>
    ${body}
  </body>
</html>`),
  });
});

const manifest = chapters
  .map((_, i) => `    <item id="ch${i + 1}" href="ch${String(i + 1).padStart(2, '0')}.xhtml" media-type="application/xhtml+xml"/>`)
  .join('\n');
const spine = chapters.map((_, i) => `    <itemref idref="ch${i + 1}"/>`).join('\n');

files.push({
  name: 'OEBPS/content.opf',
  data: Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:sample-xinghai-0001</dc:identifier>
    <dc:title>${esc(title)}</dc:title>
    <dc:creator>示例作者</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>`),
});

files.push({
  name: 'OEBPS/nav.xhtml',
  data: Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
  <head><meta charset="utf-8"/><title>目录</title></head>
  <body><nav epub:type="toc"><ol>
${chapters.map((c, i) => `    <li><a href="ch${String(i + 1).padStart(2, '0')}.xhtml">${esc(c.title)}</a></li>`).join('\n')}
  </ol></nav></body>
</html>`),
});

fs.writeFileSync(OUT, buildZip(files));
console.log(`已生成 ${path.relative(ROOT, OUT)}（${chapters.length} 章，${(fs.statSync(OUT).size / 1024).toFixed(1)} KB）`);
console.log('章节：', chapters.map((c) => c.title).join(' / '));
