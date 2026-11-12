/**
 * 回归测试：老书籍（诗体 + 逐行分段）应该能改成整句合并。
 *   A. 没音频 → 打开章节时自动重排
 *   B. 有音频 → 出现「分段：逐行」提示，确认后重排并清掉旧音频
 *
 * 运行：node tools/test-rechunk.mjs
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
const appErrors = [];
window.__showAppError__ = (t, d) => appErrors.push({ t, d });
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
let generateCalls = 0;
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
  if (url.pathname === '/api/generate') { generateCalls++; return json({ id: 'j' + generateCalls }); }
  if (url.pathname.startsWith('/api/history/')) return json({ status: 'completed', duration: 1.5 });
  if (url.pathname.startsWith('/api/audio/')) return new Response(new Uint8Array(1000), { status: 200, headers: { 'content-type': 'audio/wav' } });
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

/* ---------------- 造一本「诗体 + 逐行分段」的老书 ---------------- */
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const { chunkBlocks, looksLikeVerse, extractNotes } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

const LINES = [
  '所有的神和驾驭战车的凡人都已', '酣睡整夜，但睡眠的香甜却不曾', '合上宙斯的双眼，心里谋划着',
  '如何使阿基琉斯获得荣誉，', '把成群的阿开亚人杀死在海船边。', '眼下，他以为最好的办法',
  '是派遣险恶的梦幻，', '给阿特柔斯之子阿伽门农传送令言。',
  '', '他对着梦幻大叫，', '长了翅膀的话语飞向后者的耳畔：',
  '“去吧，险恶的梦幻，', '速往阿开亚人的快船，', '行至阿特柔斯之子阿伽门农的营棚，',
  '把我的指令原原本本地对他告传。', '命他即刻行动，', '把长发的阿开亚人武装。',
];

const bookId = 'bk_verse_legacy';
const blocks = LINES.map((t) => (t ? { type: 'p', text: t } : { type: 'br', text: '' }));
const ps = blocks.filter((b) => b.type === 'p');

// 老版本：一行一段（每块一个 chunk，没有 segs 字段）
const legacyChunks = ps.map((b) => ({ b: blocks.indexOf(b), text: b.text }));

async function makeBook({ withAudio }) {
  const chapter = {
    id: `${bookId}_c0`, bookId, index: 0, title: '第一卷',
    blocks, notes: [], verse: true, chunks: legacyChunks.map((c) => ({ ...c })),
    schema: 2, chunkChars: 220, chars: ps.reduce((a, b) => a + b.text.length, 0),
    doneCount: 0, updatedAt: Date.now(),
  };
  const book = {
    id: bookId, title: '诗体老书', author: '', format: 'epub',
    createdAt: Date.now(), updatedAt: Date.now(), totalChars: chapter.chars, generatedChars: 0,
    chapterRefs: [{ id: chapter.id, title: chapter.title, index: 0, chars: chapter.chars, total: chapter.chunks.length, done: 0 }],
    lastChapterId: chapter.id,
  };
  await store.put('books', book);
  await store.put('chapters', chapter);
  await store.kvSet('lastBookId', bookId);
  await store.kvSet('settings', { theme: 'paper', profileId: 'p1', maxChars: 220 });
  if (withAudio) {
    const ch = await store.getChapter(chapter.id);
    for (let i = 0; i < ch.chunks.length; i++) {
      await store.putAudio(ch.id, bookId, i, new Blob([new Uint8Array(500)], { type: 'audio/wav' }), 1.5);
      ch.chunks[i].status = 'done';
      ch.chunks[i].dur = 1.5;
    }
    ch.doneCount = ch.chunks.filter((c) => c.status === 'done').length;
    await store.put('chapters', ch);
  }
  return { book, chapter };
}

console.log('\n【A. 诗体 + 逐行分段 + 没有音频 → 自动重排】');
const a = await makeBook({ withAudio: false });
check('预置为逐行分段', a.chapter.chunks.length === ps.length, `${a.chapter.chunks.length} / ${ps.length}`);

await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1600);

const { store: store2 } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const chA = await store2.getChapter(a.chapter.id);
check('打开后已自动合并成整句', chA.chunks.length < ps.length / 2, `${chA.chunks.length} 段 / ${ps.length} 行`);
check('识别为诗体', chA.verse === true);
check('合并后的块覆盖多行', chA.chunks.some((c) => (c.segs || []).length > 1), JSON.stringify(chA.chunks[0]?.segs));
check('界面显示分段方式', document.querySelector('.chapter-meta')?.textContent.includes('整句合并'),
  document.querySelector('.chapter-meta')?.textContent);
check('没有触发错误面板', appErrors.length === 0, JSON.stringify(appErrors[0] || '').slice(0, 160));

/* ---- B 场景需要重开一次进程级状态，这里用「重新写入老数据 + 重新打开章节」模拟 ---- */
console.log('\n【B. 诗体 + 逐行分段 + 已有音频 → 提示并可重排】');
const b = await makeBook({ withAudio: true });
// 通过目录点击重新打开（app 内部会重新读库）
const tocItem = document.querySelector('#pane-toc .toc-item') || document.querySelector('.book-item');
tocItem?.click();
await sleep(1200);

const chip = [...document.querySelectorAll('.chapter-meta .chip')].find((c) => c.textContent.includes('逐行'));
check('出现「分段：逐行」提示', !!chip, [...document.querySelectorAll('.chapter-meta .chip')].map((c) => c.textContent).join(' | '));

if (chip) {
  const before = await store2.audioOf(b.chapter.id);
  chip.click();
  await sleep(300);
  const confirm = [...document.querySelectorAll('.modal-foot .btn')].find((x) => x.textContent.includes('重新分段'));
  check('弹出确认对话框', !!confirm, [...document.querySelectorAll('.modal-foot .btn')].map((x) => x.textContent.trim()).join(' | '));
  if (confirm) {
    confirm.click();
    await sleep(900);
    const chB = await store2.getChapter(b.chapter.id);
    const after = await store2.audioOf(b.chapter.id);
    check('已按整句重排', chB.chunks.length < ps.length / 2, `${chB.chunks.length} 段 / ${ps.length} 行`);
    check('旧音频已清除', after.length === 0, `${before.length} -> ${after.length}`);
    check('提示消失', !chB.staleChunks);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
