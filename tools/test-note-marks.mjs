/**
 * 注释角标：旧数据（先抽注释后剥行号）导致位置越界时仍要显示、可跳转
 * 运行：node tools/test-note-marks.mjs
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
window.Element.prototype.scrollIntoView = function () { this.dataset.scrolled = '1'; };
window.HTMLElement.prototype.scrollIntoView = function () { this.dataset.scrolled = '1'; };
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
  if (url.pathname === '/api/health') return json({ status: 'healthy', model_loaded: true });
  if (url.pathname === '/api/profiles') return json([{ id: 'p1', name: '1', language: 'zh' }]);
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

/* 模拟旧数据：文本已经剥掉行号，但注释位置还停在原来的（越界） */
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const { chunkBlocks } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

const bookId = 'bk_notes';
const rid = `${bookId}_r0`;
const blocks = [
  { type: 'p', text: '是另外一种人，他勇敢坚忍，心雄如狮，' },
  // 关键：长度 13，注释位置却是 14（剥行号前算的）
  { type: 'p', text: '曾经为了夺取拉奥墨冬的马，', marks: [{ n: 14, at: 14 }] },
  { type: 'p', text: '带着六艘船和不多的士兵来到这里，' },
  { type: 'p', text: '攻下伊利昂城，使街道荒凉无人迹。' },
];
const chunks = chunkBlocks(blocks, 220, { merge: false });
// 让第 0 段带上注释 14 的引用记录（模拟正常情况）
chunks[1].notes = [14];

const notes = [
  { n: 14, text: '有一个海怪在特洛亚为害，国王拉奥墨冬为了平息海怪的忿怒……' },
  { n: 15, text: '这一条在正文里没有标记，用来测试兜底跳转。' },
];
chunks[3].notes = [15];

const chapter = {
  id: `${bookId}_c0`, bookId, index: 0, title: '第五卷', blocks, notes, verse: true,
  chunks, schema: 2, chunkAlgo: 2, chunkChars: 220, lineNoChecked: true,
  chars: blocks.reduce((a, b) => a + b.text.length, 0), doneCount: 0, updatedAt: Date.now(),
};
const book = {
  id: bookId, title: '注释测试', author: '', format: 'epub',
  createdAt: Date.now(), updatedAt: Date.now(), totalChars: chapter.chars, generatedChars: 0,
  chapterRefs: [{ id: chapter.id, title: chapter.title, index: 0, chars: chapter.chars, total: chunks.length, done: 0 }],
  lastChapterId: chapter.id,
  renditions: [{ id: rid, name: '默认', profileId: 'p1', engine: 'qwen', modelSize: '1.7B', language: 'zh', createdAt: 1 }],
  activeRenditionId: rid,
};
await store.put('books', book);
await store.put('chapters', chapter);
await store.kvSet('lastBookId', bookId);
await store.kvSet('settings', { theme: 'paper', profileId: 'p1', maxChars: 220, showNotes: true });

console.log('\n【越界的注释位置】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1500);

const ref14 = document.querySelector('.fnref[data-n="14"]');
check('角标仍然渲染出来', !!ref14, ref14 ? 'ok' : '(缺失)');
check('角标文字是 14', ref14?.textContent === '14', ref14?.textContent);
check('角标挂在正确的段落里', ref14?.closest('p')?.textContent?.startsWith('曾经为了夺取拉奥墨冬的马，'),
  ref14?.closest('p')?.textContent?.slice(0, 30));

console.log('\n【右侧点击跳转】');
const item14 = document.querySelector('.note-item[data-n="14"]');
check('右侧有注释 14', !!item14);
item14.click();
await sleep(300);
check('跳转后角标高亮', ref14.classList.contains('flash'), ref14.className);
check('注释条目变成选中态', item14.classList.contains('active'), item14.className);

console.log('\n【没有角标时的兜底跳转】');
const item15 = document.querySelector('.note-item[data-n="15"]');
check('右侧有注释 15', !!item15);
item15.click();
await sleep(300);
check('兜底跳到引用它的段落', document.querySelectorAll('.read-body .chunk.flash').length >= 1,
  String(document.querySelectorAll('.read-body .chunk.flash').length));
check('兜底后注释条目也变选中', item15.classList.contains('active'), item15.className);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
