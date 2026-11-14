/**
 * 目录多选批量生成 + 生成队列
 * 运行：node tools/test-batch-queue.mjs
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

const genCalls = [];
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, 'http://127.0.0.1:5178');
  const bm = url.pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
  if (bm) url.pathname = '/api' + (bm[2] || '/');
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/backends') return json({ backends: [{ id: 'local', label: '测试', url: 'http://x', base: '/b/local' }] });
  if (url.pathname === '/api/health') return json({ status: 'healthy', model_loaded: true, gpu_available: true });
  if (url.pathname === '/api/profiles') return json([{ id: 'p1', name: '测试', language: 'zh' }]);
  if (url.pathname === '/api/generate') {
    await sleep(250); // 让生成慢一点，便于测试队列
    const body = JSON.parse(init.body);
    genCalls.push(body.text.slice(0, 12));
    return json({ id: 'j' + genCalls.length });
  }
  if (url.pathname.startsWith('/api/history/')) return json({ status: 'completed', duration: 1.2 });
  if (url.pathname.startsWith('/api/audio/')) return new Response(new Uint8Array(2048), { status: 200, headers: { 'content-type': 'audio/wav' } });
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

console.log('\n【启动 + 导入三章的书】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1000);

document.querySelector('#btn-import').click();
await sleep(100);
[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '粘贴文本').click();
await sleep(40);
document.querySelector('.modal textarea').value = `批量测试

第一章 甲

第一段话。第二句。

第二段。再来。

第三段。继续。

第四段。还有。

第五段。快好了。

第六段。结束。

第二章 乙

另一章第一段。再来一句。

第二段。继续。

第三段。还有。

第四段。快好了。

第五段。结束。

第三章 丙

第三章第一段。再来。

第二段。继续。

第三段。还有。

第四段。结束。`;
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '导入').click();
await sleep(900);

// 切到目录标签
[...document.querySelectorAll('.side-tab')].find((t) => t.dataset.tab === 'toc').click();
await sleep(200);
check('目录有 3 章', document.querySelectorAll('#pane-toc .toc-item').length === 3,
  String(document.querySelectorAll('#pane-toc .toc-item').length));

/* ---------------- 多选 ---------------- */
console.log('\n【目录多选】');
[...document.querySelectorAll('#pane-toc .toc-head .btn')].find((b) => b.textContent.trim() === '多选').click();
await sleep(150);
check('进入多选模式后出现复选框', document.querySelectorAll('#pane-toc .toc-check').length === 3,
  String(document.querySelectorAll('#pane-toc .toc-check').length));
check('出现底部操作条', !!document.querySelector('.toc-select-bar'));

const rows = [...document.querySelectorAll('#pane-toc .toc-item')];
rows[0].click();
await sleep(80);
rows[2].click();
await sleep(80);
let barText = document.querySelector('.toc-select-bar .tsb-info')?.textContent || '';
check('选中 2 章', barText.includes('已选 2 章'), barText);
// 只留第 1 章，方便后面测试队列
rows[2].click();
await sleep(80);
barText = document.querySelector('.toc-select-bar .tsb-info')?.textContent || '';
check('取消选择后只剩 1 章', barText.includes('已选 1 章'), barText);
check('显示待生成段数', /\d+ 段待生成/.test(barText), barText);

console.log('\n【生成选中】');
[...document.querySelectorAll('.toc-select-bar .btn')].find((b) => b.textContent.trim() === '生成选中').click();

// 等生成结束
const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  await sleep(300);
  if (document.querySelectorAll('.chunk.pending-audio').length === 0 && Date.now() - t0 > 1200) break;
}
await sleep(800);

const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const books = await store.listBooks();
const rid = books[0].activeRenditionId;
const chapters = await store.chaptersOf(books[0].id);
const doneOf = async (ch) => (await store.audioOfRendition(ch.id, rid)).length;

check('第 1 章已生成', (await doneOf(chapters[0])) > 0, String(await doneOf(chapters[0])));
check('第 2 章未生成（没被选中）', (await doneOf(chapters[1])) === 0, String(await doneOf(chapters[1])));
check('第 3 章未生成（已取消选择）', (await doneOf(chapters[2])) === 0, String(await doneOf(chapters[2])));
check('退出多选模式', !document.querySelector('.toc-select-bar'));

/* ---------------- 队列 ---------------- */
console.log('\n【生成队列】');
// 打开第 2 章，开始生成
[...document.querySelectorAll('#pane-toc .toc-item')][1].click();
await sleep(500);
document.querySelector('#btn-generate-chapter').click();
await sleep(120);

// 生成中再点一次（换到第 3 章），应该进队列而不是报错
[...document.querySelectorAll('#pane-toc .toc-item')][2].click();
await sleep(400);
const before = genCalls.length;
document.querySelector('#btn-generate-chapter').click();
await sleep(300);

const toast = document.querySelector('#toast-wrap')?.textContent || '';
check('生成中再次请求会进队列', toast.includes('已加入队列') || document.querySelector('#gen-queue:not(.hidden)'),
  toast.trim().slice(0, 80));
const queuedShown = !!document.querySelector('#gen-queue:not(.hidden)');
check('面板显示队列状态', queuedShown, String(queuedShown));

/* 队列展开 */
const gqItems = [...document.querySelectorAll('#gen-queue-list .gq-item')];
check('队列默认展开并列出章节', gqItems.length >= 1, String(gqItems.length));
check('队列项显示章节名', (gqItems[0]?.textContent || '').includes('第三章'), gqItems[0]?.textContent?.trim());
check('队列项显示待生成段数', /\d+\s*段/.test(gqItems[0]?.textContent || ''), gqItems[0]?.textContent?.trim());
check('计数显示章数', (document.getElementById('gen-queue-count')?.textContent || '').includes('章'),
  document.getElementById('gen-queue-count')?.textContent);

document.getElementById('gen-queue-toggle').click();
await sleep(80);
check('可以折叠', !document.getElementById('gen-queue').classList.contains('open'));
document.getElementById('gen-queue-toggle').click();
await sleep(80);
check('可以再展开', document.getElementById('gen-queue').classList.contains('open'));

/* 移除某一章，再加回来，保持后续流程 */
document.querySelector('#gen-queue-list .gq-del').click();
await sleep(120);
check('可以把章节移出队列', document.querySelectorAll('#gen-queue-list .gq-item').length === 0,
  String(document.querySelectorAll('#gen-queue-list .gq-item').length));
document.querySelector('#btn-generate-chapter').click();
await sleep(200);
check('重新排队后又出现了', document.querySelectorAll('#gen-queue-list .gq-item').length >= 1,
  String(document.querySelectorAll('#gen-queue-list .gq-item').length));

// 等两个任务都跑完
const t1 = Date.now();
while (Date.now() - t1 < 40000) {
  await sleep(300);
  const q = document.querySelector('#gen-queue');
  const busy = q && !q.classList.contains('hidden');
  if (!busy && Date.now() - t1 > 2000) break;
}
await sleep(1200);

const callsAfter = genCalls.length;
check('队列里的任务最终也执行了', callsAfter > before, `${before} -> ${callsAfter}`);
const ch2Rows = await doneOf(chapters[1]);
const ch3Rows = await doneOf(chapters[2]);
check('两个章节都已生成音频', ch2Rows > 0 && ch3Rows > 0, `ch2=${ch2Rows} ch3=${ch3Rows}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
