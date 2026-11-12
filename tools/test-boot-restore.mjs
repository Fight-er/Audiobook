/**
 * 回归测试：恢复上次阅读进度时，即使本章还没有音频也不能崩。
 * 背景：boot() 里 player.seek(lastTime) 在空音轨时会取 tracks[-1].start 抛 TypeError，
 *      并且因为发生在 refreshHealth() 之前，状态栏会一直停在「检测中」。
 *
 * 运行：node tools/test-boot-restore.mjs
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

const rejections = [];
process.on('unhandledRejection', (err) => rejections.push(err));
const appErrors = [];

/* ---------------- 环境 ---------------- */
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
globalThis.DOMParser = window.DOMParser;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
try { globalThis.navigator = window.navigator; } catch { /* noop */ }
window.Element.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
window.__showAppError__ = (title, detail) => appErrors.push({ title, detail });
URL.createObjectURL = () => 'blob:x/' + Math.random().toString(36).slice(2);
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
  // 多后端：/b/<id>/xxx 等价于该节点的 /xxx
  const bm = url.pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
  if (bm) url.pathname = '/api' + (bm[2] || '/');
  if (url.pathname === '/backends') {
    return new Response(JSON.stringify({ backends: [{ id: 'local', label: '测试节点', url: 'http://127.0.0.1:17493', base: '/b/local' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/api/health') return json({ status: 'healthy', model_loaded: true, gpu_available: true, gpu_type: 'Fake' });
  if (url.pathname === '/api/profiles') return json([{ id: 'p1', name: '测试音色', language: 'zh' }]);
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

/* ---------------- 预置数据：有进度、无音频 ---------------- */
console.log('\n【预置「上次读到一半但没有音频」的书籍】');
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const { chunkBlocks } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

const bookId = 'bk_test_restore';
const blocks = [
  { type: 'p', text: '第一段文字，用来测试恢复进度。' },
  { type: 'p', text: '第二段文字，同样没有生成音频。' },
];
const chunks = chunkBlocks(blocks, 220, { merge: false });
const chapter = {
  id: `${bookId}_c0`, bookId, index: 0, title: '第一章 测试',
  blocks, notes: [], verse: false, chunks, schema: 2, chunkChars: 220,
  chars: blocks.reduce((a, b) => a + b.text.length, 0), doneCount: 0, updatedAt: Date.now(),
};
const book = {
  id: bookId, title: '恢复进度测试书', author: '', format: 'txt',
  createdAt: Date.now(), updatedAt: Date.now(), totalChars: chapter.chars, generatedChars: 0,
  chapterRefs: [{ id: chapter.id, title: chapter.title, index: 0, chars: chapter.chars, total: chunks.length, done: 0 }],
  lastChapterId: chapter.id,
  lastChunk: 1,
  lastTime: 12.5,          // ← 关键：有保存的播放位置，但本章没有任何音频
};
await store.put('books', book);
await store.put('chapters', chapter);
await store.kvSet('lastBookId', bookId);
await store.kvSet('settings', { theme: 'paper', profileId: 'p1', maxChars: 220 });
check('预置数据写入完成', !!(await store.getBook(bookId)));

/* ---------------- 启动应用 ---------------- */
console.log('\n【启动应用（会触发恢复上次进度）】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1600);

const chip = document.querySelector('#chip-voicebox')?.textContent?.trim() || '';
check('应用已启动', window.__APP_BOOTED__ === true);
check('没有触发致命错误面板', appErrors.length === 0, JSON.stringify(appErrors[0] || '').slice(0, 200));
check('状态栏已更新（不再是「检测中」）', chip !== '检测中…' && /在线|就绪/.test(chip), chip);
check('没有未处理的 Promise 拒绝', rejections.length === 0, String(rejections[0] || ''));
check('书籍已自动打开', (document.querySelector('#top-title')?.textContent || '').includes('恢复进度测试书'),
  document.querySelector('#top-title')?.textContent);
check('正文已渲染', document.querySelectorAll('.read-body .chunk').length >= 2,
  String(document.querySelectorAll('.read-body .chunk').length));
check('没有音频时不报错、保持可读', document.querySelectorAll('.chunk.pending-audio').length === 2,
  String(document.querySelectorAll('.chunk.pending-audio').length));
check('播放器提示为空状态', (document.querySelector('#pb-title')?.textContent || '').includes('未在播放'),
  document.querySelector('#pb-title')?.textContent);

/* ---------------- Player.seek 直接调用 ---------------- */
console.log('\n【Player.seek 空音轨保护】');
const { Player } = await import(pathToFileURL(path.join(ROOT, 'public/js/player.js')).href);
const p = new Player();
let seekErr = null;
try {
  await p.seek(42);
  await p.seek(0);
  p.skip(15);
} catch (err) {
  seekErr = err;
}
check('空音轨时 seek/skip 不抛异常', seekErr === null, seekErr?.message);
check('空音轨时 duration 为 0', p.duration === 0, String(p.duration));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
