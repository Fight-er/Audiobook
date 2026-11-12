/**
 * 用本机真实的《荷马史诗》EPUB 验证：分行合并 + 脚注抽取。
 * 找不到该文件时自动跳过（不会失败）。
 * 运行：node tools/verify-iliad.mjs [epub路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT = 'C:\\Users\\lixia\\Downloads\\荷马史诗：伊利亚特·奥德赛（套装上下册） (〔古希腊〕荷马) (z-library.sk, 1lib.sk, z-lib.sk).epub';
const file = process.argv[2] || DEFAULT;

if (!fs.existsSync(file)) {
  console.log(`\n跳过：未找到 ${file}\n`);
  process.exit(0);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.DOMParser = dom.window.DOMParser;
globalThis.document = dom.window.document;
globalThis.DecompressionStream = class DecompressionStreamShim {
  constructor(format) {
    if (format !== 'deflate-raw') throw new TypeError(`unsupported format: ${format}`);
    const parts = [];
    const ts = new TransformStream({
      transform(chunk) { parts.push(Buffer.from(chunk)); },
      flush(controller) { controller.enqueue(new Uint8Array(zlib.inflateRawSync(Buffer.concat(parts)))); },
    });
    this.readable = ts.readable;
    this.writable = ts.writable;
  }
};

const { parseEpub, extractNotes, chunkBlocks, looksLikeVerse, endsSentence } = await import(
  pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

let pass = 0;
let fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e); } };

console.log(`\n【解析真实 EPUB】${path.basename(file)}`);
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const book = await parseEpub(ab);
console.log(`  书名：${book.title} / 作者：${book.author} / 章节：${book.chapters.length}`);
check('解析出多个章节', book.chapters.length > 10, String(book.chapters.length));

// 找第二个有大量短行的章节（通常是有脚注的正文卷）
let target = null;
for (const ch of book.chapters.slice(0, 20)) {
  const ps = ch.blocks.filter((b) => b.type === 'p');
  if (ps.length > 100) { target = ch; break; }
}
check('找到正文卷（段落数 > 100）', !!target, target?.title);
if (!target) { console.log('\n无法继续验证'); process.exit(1); }

const rawBlocks = target.blocks;
console.log(`  章节「${target.title}」原始块 ${rawBlocks.length}（其中 <p> ${rawBlocks.filter((b) => b.type === 'p').length}，诗节分隔 ${rawBlocks.filter((b) => b.type === 'br').length}）`);

check('保留诗节分隔块', rawBlocks.some((b) => b.type === 'br'));

const { blocks, notes } = extractNotes(rawBlocks);
console.log(`  抽取脚注 ${notes.length} 条；清理后块数 ${blocks.length}`);
check('抽取到脚注', notes.length >= 3, String(notes.length));
check('脚注编号从 1 开始', notes[0]?.n === 1, JSON.stringify(notes[0]?.n));
check('脚注正文不含序号括号', !/^[\[［]\d/.test(notes[0]?.text || ''), notes[0]?.text?.slice(0, 20));
check('正文块中已无 [n] 标记', !blocks.some((b) => b.text && /[\[［]\d{1,3}[\]］]/.test(b.text)),
  blocks.find((b) => /[\[［]\d/.test(b.text))?.text);

check('识别为分行排版', looksLikeVerse(blocks));

for (const limit of [180, 220, 300]) {
  const chunks = chunkBlocks(blocks, limit, { merge: true });
  const lens = chunks.map((c) => c.text.length);
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const ended = chunks.filter((c) => endsSentence(c.text)).length;
  const max = Math.max(...lens);
  console.log(`  limit=${limit}: ${chunks.length} 块，平均 ${avg.toFixed(0)} 字，最长 ${max}，句末收尾 ${ended}/${chunks.length}`);
  check(`limit=${limit} 无超长块`, max <= limit, String(max));
  check(`limit=${limit} 平均长度 ≥ 90 字（不再一行一读）`, avg >= 90, avg.toFixed(0));
  check(`limit=${limit} 多数块在句末断开`, ended / chunks.length >= 0.7, `${ended}/${chunks.length}`);
  check(`limit=${limit} 块数远少于行数`, chunks.length < blocks.filter((b) => b.type === 'p').length / 3,
    `${chunks.length} vs ${blocks.filter((b) => b.type === 'p').length}`);
  check(`limit=${limit} 朗读文本无脚注序号`, chunks.every((c) => !/[\[［]\d{1,3}[\]］]/.test(c.text)),
    chunks.find((c) => /[\[［]\d/.test(c.text))?.text);
}

const chunks = chunkBlocks(blocks, 220, { merge: true });
console.log('\n  示例块（前 2 块）：');
chunks.slice(0, 2).forEach((c, i) => console.log(`   [${i}] (${c.text.length}字, 覆盖块 ${c.b0}-${c.b1}, 注释 ${c.notes || '无'}) ${c.text.slice(0, 70)}…`));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
