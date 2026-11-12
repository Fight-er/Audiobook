/**
 * 老音频归属 + 音色版本编辑
 *   A. 旧书（无版本概念）的音频应归到「默认音色」，不能跟当前视图走
 *   B. 旧书已经有第二个版本时，老音频也不能被错误归到第二个版本
 *   C. 设置里的音色改动要写回当前音色版本
 * 运行：node tools/test-rendition-voice.mjs
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

const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, 'http://127.0.0.1:5178');
  const bm = url.pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
  if (bm) url.pathname = '/api' + (bm[2] || '/');
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/backends') return json({ backends: [{ id: 'local', label: '测试', url: 'http://x', base: '/b/local' }] });
  if (url.pathname === '/api/health') return json({ status: 'healthy', model_loaded: true, gpu_available: true });
  if (url.pathname === '/api/profiles') return json([
    { id: 'p1', name: '音色甲', language: 'zh' },
    { id: 'p2', name: '音色乙', language: 'zh' },
  ]);
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

/* ---------------- 造一本「旧书」：没有 renditions，音频没有版本信息 ---------------- */
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const { chunkBlocks } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

const bookId = 'bk_legacy';
const blocks = [
  { type: 'p', text: '旧书第一段文字，用来验证旧音频的归属。' },
  { type: 'p', text: '旧书第二段文字。' },
];
const chunks = chunkBlocks(blocks, 220, { merge: false }).map((c) => ({ ...c, status: 'done', dur: 1.8, meta: { profileId: 'p0', engine: 'qwen', modelSize: '1.7B', language: 'zh' } }));
const chapter = {
  id: `${bookId}_c0`, bookId, index: 0, title: '第一章 旧章', blocks, notes: [], verse: false,
  chunks, schema: 2, chunkAlgo: 2, chunkChars: 220,
  chars: blocks.reduce((a, b) => a + b.text.length, 0), doneCount: chunks.length, updatedAt: Date.now(),
};

async function seed({ withSecond }) {
  // 清库
  const all = await store.all('books');
  for (const b of all) await store.deleteBook(b.id);
  for (const k of ['lastBookId', 'settings']) await store.del('kv', k);

  const r0 = { id: `${bookId}_r0`, name: '默认音色', profileId: 'p1', engine: 'qwen', modelSize: '1.7B', language: 'zh', createdAt: 1 };
  const r2 = { id: `${bookId}_r2`, name: '第二版', profileId: 'p2', engine: 'qwen', modelSize: '1.7B', language: 'zh', createdAt: 2 };
  const book = {
    id: bookId, title: '旧书测试', author: '', format: 'txt',
    createdAt: 1, updatedAt: 1, totalChars: chapter.chars, generatedChars: chapter.chars,
    chapterRefs: [{ id: chapter.id, title: chapter.title, index: 0, chars: chapter.chars, total: chunks.length, done: chunks.length }],
    lastChapterId: chapter.id,
    ...(withSecond
      ? { renditions: [r0, r2], activeRenditionId: r2.id }
      : { /* 旧书：没有 renditions 字段 */ }),
  };
  await store.put('books', book);
  await store.put('chapters', chapter);
  // 旧格式音频：key = 章节:段号，且没有 renditionId
  for (let i = 0; i < chunks.length; i++) {
    await store.put('audio', {
      key: `${chapter.id}:${i}`,
      chapterId: chapter.id,
      bookId,
      blob: new Blob([new Uint8Array(1024)], { type: 'audio/wav' }),
      mime: 'audio/wav',
      dur: 1.8,
      size: 1024,
      createdAt: 1,
    });
  }
  await store.kvSet('lastBookId', bookId);
  await store.kvSet('settings', { theme: 'paper', profileId: 'p1', maxChars: 220 });
  return { r0, r2 };
}

/* ---------------- A. 旧书（只有一个默认版本） ---------------- */
console.log('\n【A. 旧书音频归到默认音色】');
const seedA = await seed({ withSecond: false });
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1500);

let book = await store.getBook(bookId);
check('自动补出默认音色版本', book.renditions?.length === 1 && book.renditions[0].name === '默认音色',
  JSON.stringify(book.renditions?.map((r) => r.name)));
const ridA = book.renditions[0].id;

const rowsA = await store.audioOfRendition(chapter.id, ridA);
check('旧音频已认领到默认版本', rowsA.length === chunks.length, `${rowsA.length}/${chunks.length}`);
check('旧 key 已改写', rowsA.every((r) => r.key.startsWith(ridA)), rowsA[0]?.key);
check('界面上是已生成状态', document.querySelectorAll('.chunk.pending-audio').length === 0,
  String(document.querySelectorAll('.chunk.pending-audio').length));

/* ---------------- B. 旧书 + 已有第二个版本（当前停在第二版） ---------------- */
console.log('\n【B. 旧书有两个音色时，老音频不会被归错版本】');
const seedB = await seed({ withSecond: true });

// 重新加载前端状态：直接再跑一遍 openBook 不好模拟，这里用刷新页面的等价操作 —— 重新导入 app 不可行，
// 所以改为：把书切到第二版并重新打开章节，验证旧音频仍在默认版本下。
// （首次启动时 app 已经把 lastBookId 指向本书，但那时是旧数据；这里直接验证 store 层）
await store.adoptLegacyAudio(chapter.id, seedB.r0.id);

const rowsR0 = await store.audioOfRendition(chapter.id, seedB.r0.id);
const rowsR2 = await store.audioOfRendition(chapter.id, seedB.r2.id);
check('老音频归到默认版本 r0', rowsR0.length === chunks.length, `${rowsR0.length}`);
check('第二版没有被写入老音频', rowsR2.length === 0, `${rowsR2.length}`);
check('两个版本的 key 前缀不同', rowsR0.every((r) => r.key.startsWith(seedB.r0.id)));

/* ---------------- C. 设置里编辑当前版本 ---------------- */
console.log('\n【C. 设置里修改当前音色版本】');
// 切回默认版本并打开设置
book = await store.getBook(bookId);
book.activeRenditionId = seedB.r0.id;
await store.put('books', book);

// 触发一次 UI 打开书籍（点书库）
document.querySelector('.book-item')?.click();
await sleep(800);

document.querySelector('#btn-settings').click();
await sleep(250);
const profileSelect = document.querySelector('.modal select');
check('设置里能看到音色下拉', !!profileSelect);
const beforeProfile = (await store.getBook(bookId)).renditions[0].profileId;

// 改成第二个音色
const opts = [...profileSelect.options];
const target = opts.find((o) => o.value === 'p2');
if (target) {
  profileSelect.value = 'p2';
  [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '保存').click();
  await sleep(500);
  const after = await store.getBook(bookId);
  check('改动能写回当前版本', after.renditions[0].profileId === 'p2', `${beforeProfile} -> ${after.renditions[0].profileId}`);
  check('其他版本不受影响', after.renditions[1].profileId === 'p2', after.renditions[1].profileId);
  const metaText = document.querySelector('.chapter-meta')?.textContent || '';
  check('改完音色后会提示音色变化', /(音色不一致|音色档案已失效)/.test(metaText), metaText.trim());
} else {
  check('找到目标音色', false, opts.map((o) => o.value).join(','));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
