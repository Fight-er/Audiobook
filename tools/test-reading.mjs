/**
 * 阅读侧：行距段距 / 自动夜间 / 全文搜索 / 书签批注 + 音频压缩链路
 * 运行：node tools/test-reading.mjs
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
  if (url.pathname === '/api/generate') return json({ id: 'j1' });
  if (url.pathname.startsWith('/api/history/')) return json({ status: 'completed', duration: 1.2 });
  if (url.pathname.startsWith('/api/audio/')) return new Response(new Uint8Array(5000), { status: 200, headers: { 'content-type': 'audio/wav' } });
  if (url.pathname === '/transcode') {
    transcodeCalls++;
    return new Response(new Uint8Array(600), { status: 200, headers: { 'content-type': 'audio/webm' } });
  }
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

console.log('\n【启动 + 导入】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1000);

document.querySelector('#btn-import').click();
await sleep(100);
[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '粘贴文本').click();
await sleep(40);
document.querySelector('.modal textarea').value = `阅读测试

第一章 起点

海风从窗口吹进来，带着咸味。灯塔的光在远处一圈一圈地转。

他把信折好，放进上衣口袋。那是一个没有寄件人的信封。

第二章 远行

火车穿过平原，夜色浓得像墨。他想起母亲做的那碗面。

灯塔已经看不见了。`;
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '导入').click();
await sleep(900);

/* ---------------- 设置项 ---------------- */
console.log('\n【行距 / 段距 / 自动夜间】');
document.querySelector('#btn-settings').click();
await sleep(250);
const rows = [...document.querySelectorAll('.modal .range-row')];
check('设置里有行距滑块', rows.length >= 3, String(rows.length));
check('设置里有自动夜间开关', [...document.querySelectorAll('.modal .switch-row label')].some((n) => n.textContent.includes('自动切换夜读')),
  [...document.querySelectorAll('.modal .switch-row label')].map((n) => n.textContent).join('|'));

const lineInput = rows.find((r) => r.textContent.includes('行距'))?.querySelector('input');
if (lineInput) {
  lineInput.value = '2.4';
  lineInput.dispatchEvent(new window.Event('input'));
  const lh = document.documentElement.style.getPropertyValue('--reader-line-height');
  check('行距即时生效', lh === '2.4', lh || '(空)');
}
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '保存').click();
await sleep(400);
check('行距已持久化', document.documentElement.style.getPropertyValue('--reader-line-height') === '2.4',
  document.documentElement.style.getPropertyValue('--reader-line-height'));

/* ---------------- 全文搜索 ---------------- */
console.log('\n【全文搜索】');
[...document.querySelectorAll('.side-tab')].find((t) => t.dataset.tab === 'toc').click();
await sleep(200);
const searchInput = document.querySelector('#pane-toc .search-input');
check('目录里有搜索框', !!searchInput);
searchInput.value = '灯塔';
searchInput.dispatchEvent(new window.Event('input'));
await sleep(600);

const results = [...document.querySelectorAll('#pane-toc .search-result')];
check('搜到了结果', results.length >= 2, String(results.length));
check('结果里有高亮标记', !!results[0]?.querySelector('mark'), results[0]?.textContent?.slice(0, 30));
results[1].click();
await sleep(700);
check('点结果跳到对应章节', (document.querySelector('#top-sub')?.textContent || '').includes('第 2 章'),
  document.querySelector('#top-sub')?.textContent);

/* ---------------- 书签与批注 ---------------- */
console.log('\n【书签与批注】');
const chunk = document.querySelector('.read-body .chunk');
chunk.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 200 }));
await sleep(150);
const menu = document.querySelector('#ctx-menu');
const items = [...(menu?.querySelectorAll('.ctx-item') || [])].map((n) => n.textContent.trim());
check('右键菜单有「添加书签」', items.some((t) => t.includes('添加书签')), items.join('/'));
check('右键菜单有「写批注」', items.some((t) => t.includes('写批注')), items.join('/'));

[...menu.querySelectorAll('.ctx-item')].find((n) => n.textContent.includes('添加书签')).click();
await sleep(500);
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
let book = (await store.listBooks())[0];
check('书签已存进书籍', (book.marks || []).length === 1 && book.marks[0].kind === 'bookmark',
  JSON.stringify(book.marks || []));
check('正文里出现标记样式', !!document.querySelector('.read-body .chunk.marked'));

// 批注
document.querySelector('.read-body .chunk').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 200 }));
await sleep(120);
[...document.querySelectorAll('#ctx-menu .ctx-item')].find((n) => n.textContent.includes('写批注')).click();
await sleep(250);
const noteArea = document.querySelector('.modal textarea');
check('弹出批注编辑框', !!noteArea);
noteArea.value = '这段写得好';
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '保存').click();
await sleep(500);

book = (await store.listBooks())[0];
check('批注已存进书籍', (book.marks || []).some((m) => m.kind === 'note' && m.note === '这段写得好'),
  JSON.stringify((book.marks || []).map((m) => m.kind)));

// 笔记面板
const tabs = [...document.querySelectorAll('.notes-tab')];
check('右侧有「笔记」分页', tabs.some((t) => t.textContent.includes('笔记')), tabs.map((t) => t.textContent).join('|'));
tabs.find((t) => t.textContent.includes('笔记')).click();
await sleep(200);
const markItems = [...document.querySelectorAll('.mark-item')];
check('笔记面板列出书签与批注', markItems.length === 2, String(markItems.length));
check('批注内容可见', markItems.some((n) => n.textContent.includes('这段写得好')));

/* ---------------- 音频压缩链路 ---------------- */
console.log('\n【音频压缩】');
[...document.querySelectorAll('.side-tab')].find((t) => t.dataset.tab === 'library').click();
await sleep(150);
document.querySelector('#btn-generate-chapter').click();
await sleep(2500);

const bk = (await store.listBooks())[0];
const rid = bk.activeRenditionId;
const chapters = await store.chaptersOf(bk.id);
let rowsAudio = [];
for (const ch of chapters) rowsAudio = rowsAudio.concat(await store.audioOfRendition(ch.id, rid));
check('调用了转码接口', transcodeCalls > 0, String(transcodeCalls));
check('存下来的是压缩后的音频', rowsAudio.length > 0 && rowsAudio.every((r) => r.mime === 'audio/webm'),
  `${rowsAudio.length} 段 / ${[...new Set(rowsAudio.map((r) => r.mime))].join(',')}`);
check('体积是压缩后的大小', rowsAudio.length > 0 && rowsAudio.every((r) => r.size === 600),
  [...new Set(rowsAudio.map((r) => r.size))].join(','));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
