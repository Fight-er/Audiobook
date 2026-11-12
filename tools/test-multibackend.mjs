/**
 * 多后端并行 + 多音色版本 的端到端测试
 * 运行：node tools/test-multibackend.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitIdle(timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (document.querySelectorAll('.chunk.pending-audio').length === 0) { await sleep(150); return true; }
    await sleep(150);
  }
  return false;
}

let pass = 0;
let fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e); } };

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

/* ---------------- 双后端 mock ---------------- */
const perBackend = { local: 0, lan: 0 };
const sentProfiles = {};
const jobsByBackend = new Map();
let jobSeq = 0;
const BACKENDS = [
  { id: 'local', label: '本机', url: 'http://127.0.0.1:17493', base: '/b/local' },
  { id: 'lan', label: '局域网', url: 'http://192.168.18.33:17493', base: '/b/lan' },
];

const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, 'http://127.0.0.1:5178');
  const original = url.pathname;
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

  if (original === '/backends') return json({ backends: BACKENDS });

  // /b/<id>/... -> 该后端的 /api/...
  const bm = original.match(/^\/b\/([^/]+)(\/.*)?$/);
  let backend = null;
  if (bm) {
    backend = bm[1];
    url.pathname = '/api' + (bm[2] || '/');
  }

  if (url.pathname === '/api/health') {
    return json({ status: 'healthy', model_loaded: true, gpu_available: true, gpu_type: backend === 'lan' ? 'RTX 2060' : 'RTX 4060 Ti' });
  }
  if (url.pathname === '/api/profiles') {
    // 模拟真实情况：两台机器的音色同名但 ID 不同
    return backend === 'lan'
      ? json([{ id: 'p-lan', name: '测试音色', language: 'zh' }])
      : json([{ id: 'p-local', name: '测试音色', language: 'zh' }]);
  }

  if (url.pathname === '/api/generate') {
    await sleep(15); // 制造一点延迟，让两个 worker 交替取任务
    const body = JSON.parse(init.body);
    const id = `job-${++jobSeq}`;
    const b = backend || 'local';
    perBackend[b] = (perBackend[b] || 0) + 1;
    sentProfiles[b] = sentProfiles[b] || new Set();
    sentProfiles[b].add(body.profile_id);
    jobsByBackend.set(id, { status: 'completed', duration: 1.2, text: body.text, backend: b });
    return json({ id, status: 'generating' });
  }
  if (url.pathname.startsWith('/api/history/')) {
    const job = jobsByBackend.get(url.pathname.split('/').pop());
    return job ? json(job) : json({ detail: 'not found' }, 404);
  }
  if (url.pathname.startsWith('/api/audio/')) {
    return new Response(new Uint8Array(2048), { status: 200, headers: { 'content-type': 'audio/wav' } });
  }
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

/* ---------------- 启动 ---------------- */
console.log('\n【启动 + 发现两个节点】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1200);
check('页面已启动', window.__APP_BOOTED__ === true);
const chip = document.querySelector('#chip-voicebox')?.textContent || '';
check('状态栏在线', /在线|就绪/.test(chip), chip);

console.log('\n【导入一本书】');
document.querySelector('#btn-import').click();
await sleep(100);
[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '粘贴文本').click();
await sleep(40);
document.querySelector('.modal textarea').value = `并行测试书

第一章 甲

第一段话说得比较长一些，用来占位。第二句话也在这一段里，同样是占位用的文字。

第二段继续占位，凑够多个段落，方便观察并行效果。

第三段也来一句。

第四段。

第五段稍微长一点，让每个段落都有独立的文字内容。

第六段收尾。

第二章 乙

另一段文字，同样用来测试并行生成。这里再来一句，凑够字数。

第三章 丙

第三段内容。又一句。再加一句凑数。`;

[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '导入').click();
await sleep(900);
check('书籍已导入', document.querySelectorAll('.book-item').length === 1);

/* ---------------- 并行生成 ---------------- */
console.log('\n【并行生成：两个节点同时干活】');
const genBtn = document.querySelector('#btn-generate-chapter');
genBtn.click();
await waitIdle();

const total = Object.values(perBackend).reduce((a, b) => a + b, 0);
check('两节点都参与了生成', perBackend.local > 0 && perBackend.lan > 0, JSON.stringify(perBackend));
check('每个段落只生成一次（合计=段落数）', total === document.querySelectorAll('.chunk').length, `${total} 次 / ${document.querySelectorAll('.chunk').length} 段`);
check('全部段落完成', document.querySelectorAll('.chunk.pending-audio').length === 0);
check('局域网节点收到的是它自己的音色 ID', [...(sentProfiles.lan || [])].every((id) => id === 'p-lan'), JSON.stringify([...(sentProfiles.lan || [])]));
check('本机节点用的是本机音色 ID', [...(sentProfiles.local || [])].every((id) => id === 'p-local'), JSON.stringify([...(sentProfiles.local || [])]));

/* ---------------- 多音色版本 ---------------- */
console.log('\n【多音色版本】');
const renditionBtn = document.querySelector('#btn-rendition');
check('顶栏有音色版本按钮', !!renditionBtn && !renditionBtn.disabled);

// 打开菜单 -> 新建版本
renditionBtn.click();
await sleep(150);
let menu = document.querySelector('#ctx-menu');
check('音色版本菜单打开', !!menu, document.querySelector('.ctx-menu') ? 'ctx-menu' : 'none');
const newItem = [...(menu?.querySelectorAll('.ctx-item') || [])].find((n) => n.textContent.includes('新建音色版本'));
check('菜单含「新建音色版本」', !!newItem);
newItem.click();
await sleep(250);

const nameInput = document.querySelector('.modal .input');
check('新建版本弹窗打开', !!nameInput);
nameInput.value = '第二版 · 另一种声音';
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '创建').click();
await sleep(700);

const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const books = await store.listBooks();
const book = books[0];
check('书籍有 2 个音色版本', book.renditions.length === 2, String(book.renditions?.length));
check('已切换到新版本', book.activeRenditionId === book.renditions[1].id, book.activeRenditionId);
check('新版本没有音频（界面回到未生成状态）', document.querySelectorAll('.chunk.pending-audio').length > 0,
  String(document.querySelectorAll('.chunk.pending-audio').length));

const chapters = await store.chaptersOf(book.id);
const r1 = book.renditions[0].id;
const r2 = book.renditions[1].id;
const rowsR1 = await store.audioOfRendition(chapters[0].id, r1);
const rowsR2 = await store.audioOfRendition(chapters[0].id, r2);
check('第一版音频还在', rowsR1.length > 0, String(rowsR1.length));
check('第二版音频为空', rowsR2.length === 0, String(rowsR2.length));
check('不同版本的音频互不覆盖', rowsR1.every((r) => r.renditionId === r1));

// 在新版本下生成
const before = { ...perBackend };
document.querySelector('#btn-generate-chapter').click();
await waitIdle();
const rowsR2b = await store.audioOfRendition(chapters[0].id, r2);
check('第二版已生成独立音频', rowsR2b.length === rowsR1.length, `${rowsR2b.length} vs ${rowsR1.length}`);
check('两版音频的 key 不同', rowsR2b.every((r) => r.key.startsWith(r2)), rowsR2b[0]?.key);
check('生成仍然并行', (perBackend.local - before.local > 0) && (perBackend.lan - before.lan > 0), JSON.stringify(perBackend));

// 通过 UI 菜单切回第一版
const btn2 = document.querySelector('#btn-rendition');
btn2.click();
await sleep(150);
const items = [...document.querySelectorAll('#ctx-menu .ctx-item')];
const first = items.find((n) => n.textContent.includes(book.renditions[0].name));
check('菜单里能看到两个版本', items.filter((n) => n.textContent.includes('版本') || n.textContent.includes('默认') || n.textContent.includes('第二版')).length >= 2,
  items.map((n) => n.textContent.trim()).join(' | '));
if (first) {
  first.click();
  await sleep(600);
  const b2 = await store.getBook(book.id);
  check('切换回第一版', b2.activeRenditionId === r1, b2.activeRenditionId);
  check('第一版音频可播放（装载了音轨）', document.querySelectorAll('.chunk.pending-audio').length === 0,
    String(document.querySelectorAll('.chunk.pending-audio').length));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
