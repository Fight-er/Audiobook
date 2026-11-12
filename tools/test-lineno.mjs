/**
 * 已导入书籍里的行号标注：打开章节时自动清理
 * 运行：node tools/test-lineno.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e); } };

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:5178/', pretendToBeVisual: true });
const { window } = dom;
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
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, 'http://127.0.0.1:5178');
  const bm = url.pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
  if (bm) url.pathname = '/api' + (bm[2] || '/');
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/capabilities') return json({ transcode: false });
  if (url.pathname === '/backends') return json({ backends: [{ id: 'local', label: '测试', url: 'http://x', base: '/b/local' }] });
  if (url.pathname === '/api/health') return json({ status: 'healthy', model_loaded: true, gpu_available: true });
  if (url.pathname === '/api/profiles') return json([{ id: 'p1', name: '测试', language: 'zh' }]);
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

/* 造一本「已经导入、但带行号」的旧书 */
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const { chunkBlocks, looksLikeVerse } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

const bookId = 'bk_lines';
const rid = `${bookId}_r0`;
const texts = [
  '他这样说，众人一片沉默， 5',
  '过了很久，年迈的国王开口， 10',
  '望着眼前这位女神般的女子， 15',
  '心中翻涌着说不出的滋味。 20',
  '最后一段没有行号。',
];
const blocks = texts.map((t) => ({ type: 'p', text: t }));
const verse = looksLikeVerse(blocks);
const chunks = chunkBlocks(blocks, 220, { merge: verse });
const chapter = {
  id: `${bookId}_c0`, bookId, index: 0, title: '第一卷', blocks, notes: [], verse,
  chunks, schema: 2, chunkAlgo: 2, chunkChars: 220,
  chars: blocks.reduce((a, b) => a + b.text.length, 0), doneCount: 0, updatedAt: Date.now(),
};
const book = {
  id: bookId, title: '行号测试书', author: '', format: 'epub',
  createdAt: Date.now(), updatedAt: Date.now(), totalChars: chapter.chars, generatedChars: 0,
  chapterRefs: [{ id: chapter.id, title: chapter.title, index: 0, chars: chapter.chars, total: chunks.length, done: 0 }],
  lastChapterId: chapter.id,
  renditions: [{ id: rid, name: '默认音色', profileId: 'p1', engine: 'qwen', modelSize: '1.7B', language: 'zh', createdAt: 1 }],
  activeRenditionId: rid,
};
await store.put('books', book);
await store.put('chapters', chapter);
await store.kvSet('lastBookId', bookId);
await store.kvSet('settings', { theme: 'paper', profileId: 'p1', maxChars: 220 });

console.log('\n【打开旧章节时自动清理行号】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1500);

const ch = await store.getChapter(chapter.id);
check('标题里没有行号', ch.blocks.every((b) => !/[ \t]\d{1,4}$/.test(b.text)),
  ch.blocks.map((b) => b.text).join(' | '));
check('行号被记录到 block 上', ch.blocks[3].lineNo === 20, String(ch.blocks[3].lineNo));
check('已标记检查过', ch.lineNoChecked === true);
check('分段文本里也没有行号', ch.chunks.every((c) => !/[ \t]\d{1,4}$/.test(c.text.trim())),
  ch.chunks.map((c) => c.text).join(' | '));

const lns = [...document.querySelectorAll('.read-body sup.ln')];
check('行号在正文里显示出来', lns.length === 4, String(lns.length));
check('行号数值正确', lns.map((n) => n.textContent).join(',') === '5,10,15,20', lns.map((n) => n.textContent).join(','));
check('行号带原书行数提示', lns[0]?.getAttribute('title') === '原书第 5 行', lns[0]?.getAttribute('title'));

const toastText = document.querySelector('#toast-wrap')?.textContent || '';
check('提示已识别行号', toastText.includes('行号'), toastText.trim());

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
