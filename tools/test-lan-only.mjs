/**
 * 本机 Voicebox 没开、但局域网有节点时，仍然要能生成
 * 运行：node tools/test-lan-only.mjs
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

let lanGenerateCalls = 0;
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, 'http://127.0.0.1:5178');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

  // 本机 Voicebox：完全离线
  if (url.pathname.startsWith('/api/')) return json({ detail: 'connect ECONNREFUSED' }, 503);

  // 节点代理
  if (url.pathname === '/backends') {
    return json({ backends: [{ id: 'lan', label: '局域网 · 192.168.18.33', url: 'http://192.168.18.33:17493', base: '/b/lan' }] });
  }
  const bm = url.pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
  if (bm) {
    const sub = bm[2] || '/';
    if (sub === '/health') return json({ status: 'healthy', model_loaded: true, gpu_available: true });
    if (sub === '/profiles') return json([{ id: 'p-lan', name: '1', language: 'zh' }]);
    if (sub === '/generate') { lanGenerateCalls++; return json({ id: 'j' + lanGenerateCalls }); }
    if (sub.startsWith('/history/')) return json({ status: 'completed', duration: 1.3 });
    if (sub.startsWith('/audio/')) return new Response(new Uint8Array(3000), { status: 200, headers: { 'content-type': 'audio/wav' } });
    return json({});
  }
  if (url.pathname === '/capabilities') return json({ transcode: false });
  return nodeFetch(url.href, init);
};

/* 预置一本书：版本里记着本机的 profile id（本机没开时匹配不到，应自动回落到节点音色） */
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const { chunkBlocks } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

const bookId = 'bk_lan';
const rid = `${bookId}_r0`;
const blocks = [
  { type: 'p', text: '局域网生成本地测试第一段。' },
  { type: 'p', text: '局域网生成本地测试第二段。' },
];
const chunks = chunkBlocks(blocks, 220, { merge: false });
const chapter = {
  id: `${bookId}_c0`, bookId, index: 0, title: '第一章', blocks, notes: [], verse: false,
  chunks, schema: 2, chunkAlgo: 2, chunkChars: 220,
  chars: blocks.reduce((a, b) => a + b.text.length, 0), doneCount: 0, updatedAt: Date.now(),
};
const book = {
  id: bookId, title: '局域网测试书', author: '', format: 'txt',
  createdAt: Date.now(), updatedAt: Date.now(), totalChars: chapter.chars, generatedChars: 0,
  chapterRefs: [{ id: chapter.id, title: chapter.title, index: 0, chars: chapter.chars, total: chunks.length, done: 0 }],
  lastChapterId: chapter.id,
  renditions: [{ id: rid, name: '默认音色', profileId: 'p-local', engine: 'qwen', modelSize: '1.7B', language: 'zh', createdAt: 1 }],
  activeRenditionId: rid,
};
await store.put('books', book);
await store.put('chapters', chapter);
await store.kvSet('lastBookId', bookId);
await store.kvSet('settings', { theme: 'paper', profileId: 'p-local', maxChars: 220 });

console.log('\n【本机离线，只有局域网节点】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(2200);

const chip = document.querySelector('#chip-voicebox');
check('状态栏不再显示离线', !/离线/.test(chip.textContent), chip.textContent.trim());
check('状态栏显示局域网节点', /局域网/.test(chip.textContent), chip.textContent.trim());
check('离线横幅已隐藏', document.querySelector('#offline-banner').classList.contains('hidden'),
  document.querySelector('#offline-banner').className);

console.log('\n【点击生成本章】');
document.querySelector('#btn-generate-chapter').click();
const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  await sleep(300);
  const ch = await store.getChapter(chapter.id);
  if (ch.chunks.every((c) => c.audio?.[rid]?.status === 'done')) break;
}
await sleep(400);

const toastText = document.querySelector('#toast-wrap').textContent || '';
check('没有报「无法生成」', !toastText.includes('无法生成'), toastText.trim().slice(0, 100));
check('走了局域网节点生成', lanGenerateCalls === 2, String(lanGenerateCalls));

const ch = await store.getChapter(chapter.id);
check('音频已入库', ch.chunks.every((c) => c.audio?.[rid]?.status === 'done'),
  ch.chunks.map((c) => c.audio?.[rid]?.status).join(','));
check('记录了节点实际音色', ch.chunks.every((c) => c.audio?.[rid]?.meta?.backendProfileId === 'p-lan'),
  ch.chunks.map((c) => c.audio?.[rid]?.meta?.backendProfileId).join(','));
check('版本音色标记保持不变（不会误报音色不一致）', ch.chunks.every((c) => c.audio?.[rid]?.meta?.profileId === 'p-local'),
  ch.chunks.map((c) => c.audio?.[rid]?.meta?.profileId).join(','));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
