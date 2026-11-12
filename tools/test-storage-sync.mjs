/**
 * 回归测试：生成完成后界面必须与数据库一致（曾经整本生成后界面一直显示「未生成」）
 * 运行：node tools/test-storage-sync.mjs
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

const sentTexts = [];
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, 'http://127.0.0.1:5178');
  const bm = url.pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
  if (bm) url.pathname = '/api' + (bm[2] || '/');
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/backends') return json({ backends: [{ id: 'local', label: '测试节点', url: 'http://x', base: '/b/local' }] });
  if (url.pathname === '/api/health') return json({ status: 'healthy', model_loaded: true, gpu_available: true });
  if (url.pathname === '/api/profiles') return json([{ id: 'p1', name: '测试音色', language: 'zh' }]);
  if (url.pathname === '/api/generate') {
    const body = JSON.parse(init.body);
    sentTexts.push(body.text);
    return json({ id: 'j' + sentTexts.length });
  }
  if (url.pathname.startsWith('/api/history/')) return json({ status: 'completed', duration: 1.4 });
  if (url.pathname.startsWith('/api/audio/')) return new Response(new Uint8Array(3000), { status: 200, headers: { 'content-type': 'audio/wav' } });
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

console.log('\n【启动 + 导入两章的书】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1000);

document.querySelector('#btn-import').click();
await sleep(100);
[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '粘贴文本').click();
await sleep(40);
document.querySelector('.modal textarea').value = `同步测试

第一章 甲

第一段文字。第二句话。

第二段文字。再来一句。

第二章 乙

另一章第一段。附带一句。

另一章第二段。结束。`;
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '导入').click();
await sleep(800);
check('导入 2 章', document.querySelectorAll('#pane-toc .toc-item').length === 2);

console.log('\n【整本生成】');
document.querySelector('#btn-more').click();
await sleep(120);
[...document.querySelectorAll('#ctx-menu .ctx-item')].find((n) => n.textContent.includes('生成整本')).click();
await sleep(250);
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '开始生成').click();

// 等生成结束（面板隐藏或标题变「完成」）
const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  await sleep(300);
  const title = document.querySelector('#gen-title')?.textContent || '';
  if (title.includes('完成') || title.includes('已停止')) break;
}
await sleep(1500); // 等回读刷新

const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const books = await store.listBooks();
const rid = books[0].activeRenditionId;
const chapters = await store.chaptersOf(books[0].id);

console.log('\n【数据库 vs 界面】');
let dbDone = 0;
let dbTotal = 0;
for (const ch of chapters) {
  dbTotal += ch.chunks.length;
  dbDone += ch.chunks.filter((c) => c.audio?.[rid]?.status === 'done').length;
}
check('数据库里全部段落已完成', dbDone === dbTotal && dbTotal > 0, `${dbDone}/${dbTotal}`);
check('音频行已落库', (await store.audioOfRendition(chapters[0].id, rid)).length === chapters[0].chunks.length);

check('界面不再显示 pending', document.querySelectorAll('.chunk.pending-audio').length === 0,
  String(document.querySelectorAll('.chunk.pending-audio').length));
const meta = document.querySelector('.chapter-meta')?.textContent || '';
check('章节头显示已配音 N/N', /已配音(\d+)\/\1/.test(meta.replace(/\s/g, '')), meta.trim());
check('目录圆点全部 ready', [...document.querySelectorAll('#pane-toc .dot')].every((d) => d.className.includes('ready')),
  [...document.querySelectorAll('#pane-toc .dot')].map((d) => d.className).join(' | '));
check('没有误报「音色不一致」', !meta.includes('音色不一致'), meta.trim());

// 切到第二章也要是已生成状态
const toc = [...document.querySelectorAll('#pane-toc .toc-item')];
toc[1].click();
await sleep(600);
check('第二章同样显示已生成', document.querySelectorAll('.chunk.pending-audio').length === 0,
  String(document.querySelectorAll('.chunk.pending-audio').length));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
