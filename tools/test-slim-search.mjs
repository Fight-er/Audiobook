/**
 * 搜索可退出 + 旧音频瘦身
 * 运行：node tools/test-slim-search.mjs
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

let transcodeCalls = 0;
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, 'http://127.0.0.1:5178');
  const bm = url.pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
  if (bm) url.pathname = '/api' + (bm[2] || '/');
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/capabilities') return json({ transcode: true, codec: 'opus' });
  if (url.pathname === '/backends') return json({ backends: [{ id: 'local', label: '测试', url: 'http://x', base: '/b/local' }] });
  if (url.pathname === '/api/health') return json({ status: 'healthy', model_loaded: true, gpu_available: true });
  if (url.pathname === '/api/profiles') return json([{ id: 'p1', name: '测试', language: 'zh' }]);
  if (url.pathname.startsWith('/api/')) return json({});
  if (url.pathname === '/transcode') {
    transcodeCalls++;
    return new Response(new Uint8Array(500), { status: 200, headers: { 'content-type': 'audio/webm' } });
  }
  return nodeFetch(url.href, init);
};

console.log('\n【启动 + 导入】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1000);

document.querySelector('#btn-import').click();
await sleep(100);
[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '粘贴文本').click();
await sleep(40);
document.querySelector('.modal textarea').value = `搜索测试

第一章 灯塔

海风从窗口吹进来，带着咸味。灯塔的光在远处一圈一圈地转。

他把信折好，放进上衣口袋。

第二章 远行

火车穿过平原。灯塔已经看不见了。`;
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '导入').click();
await sleep(900);

/* ---------------- 搜索 ---------------- */
console.log('\n【搜索：可继续输入、可退出】');
[...document.querySelectorAll('.side-tab')].find((t) => t.dataset.tab === 'toc').click();
await sleep(200);

let input = document.querySelector('#pane-toc .search-input');
check('有搜索框', !!input);

// 逐字输入，模拟真实打字（每次 input 都会触发防抖）
input.value = '灯';
input.dispatchEvent(new window.Event('input'));
await sleep(120);
input.value = '灯塔';
input.dispatchEvent(new window.Event('input'));
await sleep(600);

const inputAfterTyping = document.querySelector('#pane-toc .search-input');
check('输入框在搜索后仍然是同一个元素（不会被打断）', inputAfterTyping === input);
check('输入内容保留', inputAfterTyping?.value === '灯塔', inputAfterTyping?.value);
check('出现了清除按钮', !!document.querySelector('#pane-toc .search-clear') &&
  !document.querySelector('#pane-toc .search-clear').classList.contains('hidden'));
check('搜索出结果', document.querySelectorAll('#pane-toc .search-result').length >= 2,
  String(document.querySelectorAll('#pane-toc .search-result').length));

// 点一条结果，不应把搜索框弄丢
document.querySelectorAll('#pane-toc .search-result')[1].click();
await sleep(600);
check('点结果后搜索框还在', !!document.querySelector('#pane-toc .search-input'));
check('点结果后仍显示搜索结果', document.querySelectorAll('#pane-toc .search-result').length >= 2,
  String(document.querySelectorAll('#pane-toc .search-result').length));

// 清除按钮
document.querySelector('#pane-toc .search-clear').click();
await sleep(400);
check('清除后回到章节列表', document.querySelectorAll('#pane-toc .toc-item').length === 2,
  String(document.querySelectorAll('#pane-toc .toc-item').length));
check('清除后搜索框为空', document.querySelector('#pane-toc .search-input')?.value === '',
  document.querySelector('#pane-toc .search-input')?.value);

// Esc 清除
input = document.querySelector('#pane-toc .search-input');
input.value = '火车';
input.dispatchEvent(new window.Event('input'));
await sleep(600);
check('再次搜索有结果', document.querySelectorAll('#pane-toc .search-result').length >= 1);
input = document.querySelector('#pane-toc .search-input');
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(400);
check('Esc 也能退出搜索', document.querySelectorAll('#pane-toc .toc-item').length === 2,
  String(document.querySelectorAll('#pane-toc .toc-item').length));

/* ---------------- 旧音频瘦身 ---------------- */
console.log('\n【旧音频瘦身】');
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const book = (await store.listBooks())[0];
const rid = book.activeRenditionId;
const chapters = await store.chaptersOf(book.id);

// 造 3 段「旧格式」WAV 音频
for (let i = 0; i < 3; i++) {
  await store.put('audio', {
    key: `${rid}:${chapters[0].id}:${100 + i}`,
    renditionId: rid,
    chapterId: chapters[0].id,
    bookId: book.id,
    index: 100 + i,
    blob: new Blob([new Uint8Array(6000)], { type: 'audio/wav' }),
    mime: 'audio/wav',
    dur: 2,
    size: 6000,
    createdAt: Date.now(),
  });
}
let rows = (await store.audioOfRendition(chapters[0].id, rid)).filter((r) => r.index >= 100);
check('预置了 3 段 WAV', rows.length === 3 && rows.every((r) => r.mime === 'audio/wav'), String(rows.length));

document.querySelector('#btn-settings').click();
await sleep(250);
const slimBtn = document.getElementById('btn-compress-audio');
check('设置里有「压缩已有音频」', !!slimBtn);
slimBtn.click();
await sleep(300);
const confirmBtn = [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '开始压缩');
check('弹出压缩确认', !!confirmBtn);
confirmBtn.click();
await sleep(2500);

rows = (await store.audioOfRendition(chapters[0].id, rid)).filter((r) => r.index >= 100);
check('旧音频已转成 Opus', rows.length === 3 && rows.every((r) => r.mime === 'audio/webm'),
  rows.map((r) => r.mime).join(','));
check('体积明显变小', rows.every((r) => r.size === 500), rows.map((r) => r.size).join(','));
check('index 与 key 未被改动', rows.map((r) => r.index).sort((a, b) => a - b).join(',') === '100,101,102',
  rows.map((r) => r.index).join(','));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
