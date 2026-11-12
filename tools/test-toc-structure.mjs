/**
 * 目录结构测试：
 *   A. 用真实《双城记》EPUB 验证「一个文件多章」按锚点拆分 + 按部归类
 *   B. 前端目录面板是否按「部」分组、编号是否连续
 * 运行：node tools/test-toc-structure.mjs [epub路径]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT = 'C:\\Users\\lixia\\Downloads\\双城记 (（英）狄更斯（Dickens，C.）著；宋兆霖译 [双城记（英）狄更斯]) (z-library.sk, 1lib.sk, z-lib.sk).epub';
const file = process.argv[2] || DEFAULT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e); } };

/* 解析器需要 DOM + 解压 */
const parseDom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.DOMParser = parseDom.window.DOMParser;
globalThis.document = parseDom.window.document;
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

const { parseEpub } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

console.log('\n【A. 真实 EPUB 的章节结构】');
if (!fs.existsSync(file)) {
  console.log(`  （跳过：未找到 ${path.basename(file)}）`);
} else {
  const buf = fs.readFileSync(file);
  const book = await parseEpub(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  console.log(`  书名 ${book.title}｜章节 ${book.chapters.length}`);
  check('章节数量合理（> 40）', book.chapters.length > 40, String(book.chapters.length));

  const withPart = book.chapters.filter((c) => c.part);
  check('有「部」信息', withPart.length > 20, String(withPart.length));

  const titles = book.chapters.map((c) => c.title);
  check('没有把「部」标题页当成章节', !titles.includes('第一部 复活'), titles.slice(0, 8).join(' / '));

  const ch1 = book.chapters.find((c) => c.title === '第一章 时代');
  const ch2 = book.chapters.find((c) => c.title === '第一章 五年以后');
  check('第一章 时代 归到第一部', ch1?.part === '第一部 复活', JSON.stringify(ch1?.part));
  check('第一章 五年以后 归到第二部', ch2?.part === '第二部 金线', JSON.stringify(ch2?.part));
  check('同名章节可分（部不同）', ch1 && ch2 && ch1.part !== ch2.part);

  const firstPart = book.chapters.filter((c) => c.part === '第一部 复活').map((c) => c.title);
  check('第一部包含 6 章', firstPart.length === 6, firstPart.join(' / '));
  check('第一部章节顺序正确', firstPart[0] === '第一章 时代' && firstPart[5] === '第六章 鞋匠', firstPart.join(' / '));

  const emptyChapters = book.chapters.filter((c) => c.blocks.filter((b) => b.type === 'p').length === 0);
  check('没有完全空的章节', emptyChapters.length === 0, emptyChapters.map((c) => c.title).join(' / '));
  const shortParted = book.chapters.filter((c) => /^第.+部/.test(c.part || '') && c.blocks.filter((b) => b.type === 'p').length < 3);
  check('正文卷里没有被截断的碎章', shortParted.length === 0, shortParted.map((c) => c.title).join(' / '));
}

/* ---------------- B. 目录面板 ---------------- */
console.log('\n【B. 目录面板分组】');
const uiDom = new JSDOM(
  fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, ''),
  { url: 'http://127.0.0.1:5178/', pretendToBeVisual: true }
);
const { window } = uiDom;
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) { super(type); this.detail = init.detail; }
  };
}
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
try { globalThis.navigator = window.navigator; } catch { /* noop */ }
window.Element.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
window.__showAppError__ = () => {};
URL.createObjectURL = () => 'blob:x';
URL.revokeObjectURL = () => {};
class FakeAudio extends EventTarget {
  constructor() {
    super();
    this._src = ''; this.paused = true; this.currentTime = 0; this.duration = NaN; this.readyState = 0;
    this.playbackRate = 1; this.defaultPlaybackRate = 1; this.volume = 1; this.preload = 'auto';
    this.crossOrigin = null; this.preservesPitch = true;
  }
  get src() { return this._src; }
  set src(v) { this._src = v; setTimeout(() => { this.readyState = 4; this.duration = 2; this.dispatchEvent(new Event('loadedmetadata')); }, 1); }
  load() {}
  removeAttribute() { this._src = ''; }
  play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}
globalThis.Audio = FakeAudio;
window.Audio = FakeAudio;

const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, 'http://127.0.0.1:5178');
  if (url.pathname === '/backends') {
    return new Response(JSON.stringify({ backends: [{ id: 'local', label: '测试', url: 'http://x', base: '/b/local' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.pathname === '/api/health') return new Response(JSON.stringify({ status: 'healthy', model_loaded: true, gpu_available: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/api/profiles') return new Response(JSON.stringify([{ id: 'p1', name: '测试', language: 'zh' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname.startsWith('/api/')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  return nodeFetch(url.href, init);
};

const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const { chunkBlocks } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

const bookId = 'bk_parts';
const parts = [
  { part: '第一部 复活', titles: ['第一章 时代', '第二章 邮车'] },
  { part: '第二部 金线', titles: ['第一章 五年以后', '第二章 看热闹'] },
];
const chapters = [];
let gi = 0;
for (const p of parts) {
  for (const t of p.titles) {
    const blocks = [
      { type: 'p', text: `${t}的第一段内容，用来占位并检查渲染。` },
      { type: 'p', text: `${t}的第二段内容。` },
    ];
    chapters.push({
      id: `${bookId}_c${gi}`, bookId, index: gi, title: t, part: p.part,
      blocks, notes: [], verse: false, chunks: chunkBlocks(blocks, 220, { merge: false }),
      schema: 2, chunkAlgo: 2, chunkChars: 220,
      chars: blocks.reduce((a, b) => a + b.text.length, 0), doneCount: 0, updatedAt: Date.now(),
    });
    gi++;
  }
}
const book = {
  id: bookId, title: '分部测试书', author: '', format: 'epub',
  createdAt: Date.now(), updatedAt: Date.now(), totalChars: 0, generatedChars: 0,
  chapterRefs: chapters.map((c) => ({ id: c.id, title: c.title, part: c.part, index: c.index, chars: c.chars, total: c.chunks.length, done: 0 })),
  lastChapterId: chapters[0].id,
  renditions: [{ id: `${bookId}_r0`, name: '默认音色', profileId: 'p1', engine: 'qwen', modelSize: '1.7B', language: 'zh', createdAt: Date.now() }],
  activeRenditionId: `${bookId}_r0`,
};
await store.put('books', book);
for (const c of chapters) await store.put('chapters', c);
await store.kvSet('lastBookId', bookId);
await store.kvSet('settings', { theme: 'paper', profileId: 'p1', maxChars: 220 });

await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1200);

const partHeaders = [...document.querySelectorAll('#pane-toc .toc-part')].map((n) => n.textContent.trim());
check('目录渲染出「部」分组', partHeaders.length === 2, partHeaders.join(' | '));
check('分组名称正确', partHeaders[0] === '第一部 复活' && partHeaders[1] === '第二部 金线', partHeaders.join(' | '));

const idxLabels = [...document.querySelectorAll('#pane-toc .toc-item .idx')].map((n) => n.textContent);
check('章节编号连续', idxLabels.join(',') === '01,02,03,04', idxLabels.join(','));
check('章节标题正确', [...document.querySelectorAll('#pane-toc .toc-item .t-title')].map((n) => n.textContent).join('|')
  === '第一章 时代|第二章 邮车|第一章 五年以后|第二章 看热闹');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
