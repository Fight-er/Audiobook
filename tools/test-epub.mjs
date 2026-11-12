/**
 * EPUB 解析测试：解析 tools/make-sample-epub.mjs 生成的示例 EPUB
 * 运行：node tools/test-epub.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.DOMParser = dom.window.DOMParser;
globalThis.document = dom.window.document;

// Node 的 DecompressionStream 不支持 deflate-raw（浏览器支持），这里补一个仅供测试的 shim
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

let pass = 0;
let fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e); } };

const { parseEpub } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

const file = path.join(ROOT, 'samples/星海拾遗.epub');
console.log(`\n【EPUB 解析】${path.basename(file)}`);
check('示例 EPUB 存在', fs.existsSync(file));

const buf = fs.readFileSync(file);
const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const book = await parseEpub(arrayBuffer, '兜底书名');

check('书名解析正确', book.title === '星海拾遗', book.title);
check('作者解析正确', book.author === '示例作者', book.author);
check('章节数 = 3', book.chapters.length === 3, String(book.chapters.length));
check('章节标题正确', book.chapters[0].title === '第一章 灯塔', book.chapters[0]?.title);

const blocks = book.chapters[0].blocks;
check('段落被正确提取', blocks.filter((b) => b.type === 'p').length >= 3, String(blocks.filter((b) => b.type === 'p').length));
check('正文内容完整', blocks.some((b) => b.text.includes('木卫三')), blocks[0]?.text?.slice(0, 30));
check('首段中文未被截断', blocks.find((b) => b.type === 'p')?.text.endsWith('。') ?? false);

const totalChars = book.chapters.reduce((a, c) => a + c.blocks.reduce((x, b) => x + b.text.length, 0), 0);
check('总字数合理（>600）', totalChars > 600, String(totalChars));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
