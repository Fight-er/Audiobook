/**
 * 巡检条上的「重新生成」只重做音色不一致的段落
 * 运行：node tools/test-issue-regen.mjs
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

let genCalls = 0;
const generated = [];
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, 'http://127.0.0.1:5178');
  const bm = url.pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
  if (bm) url.pathname = '/api' + (bm[2] || '/');
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/capabilities') return json({ transcode: false });
  if (url.pathname === '/backends') return json({ backends: [{ id: 'local', label: '测试', url: 'http://x', base: '/b/local' }] });
  if (url.pathname === '/api/health') return json({ status: 'healthy', model_loaded: true, gpu_available: true });
  if (url.pathname === '/api/profiles') return json([{ id: 'p-new', name: '1', language: 'zh' }]);
  if (url.pathname === '/api/generate') {
    genCalls++;
    const body = JSON.parse(init.body);
    generated.push(body.text.slice(0, 12));
    return json({ id: 'j' + genCalls });
  }
  if (url.pathname.startsWith('/api/history/')) return json({ status: 'completed', duration: 1.1 });
  if (url.pathname.startsWith('/api/audio/')) return new Response(new Uint8Array(1200), { status: 200, headers: { 'content-type': 'audio/wav' } });
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

/* 3 段：前两段是旧档案，第三段已经和当前音色一致 */
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const { chunkBlocks } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

const bookId = 'bk_regen';
const rid = `${bookId}_r0`;
const blocks = [
  { type: 'p', text: '第一段：这段的音色是旧的。' },
  { type: 'p', text: '第二段：这段的音色也是旧的。' },
  { type: 'p', text: '第三段：这段本来就正确。' },
];
const chunks = chunkBlocks(blocks, 220, { merge: false }).map((c, i) => ({
  ...c,
  audio: {
    [rid]: {
      status: 'done',
      dur: 1.5,
      meta: {
        profileId: i < 2 ? 'p-old' : 'p-new',
        backendProfileId: i < 2 ? 'p-old' : 'p-new',
        engine: 'qwen',
        modelSize: '1.7B',
        language: 'zh',
      },
    },
  },
}));
const chapter = {
  id: `${bookId}_c0`, bookId, index: 0, title: '第一章', blocks, notes: [], verse: false,
  chunks, schema: 2, chunkAlgo: 2, chunkChars: 220,
  chars: blocks.reduce((a, b) => a + b.text.length, 0), doneCount: chunks.length, updatedAt: Date.now(),
};
const book = {
  id: bookId, title: '选择性重生成', author: '', format: 'txt',
  createdAt: Date.now(), updatedAt: Date.now(), totalChars: chapter.chars, generatedChars: chapter.chars,
  chapterRefs: [{ id: chapter.id, title: chapter.title, index: 0, chars: chapter.chars, total: chunks.length, done: chunks.length }],
  lastChapterId: chapter.id,
  renditions: [{ id: rid, name: '默认音色', profileId: 'p-new', engine: 'qwen', modelSize: '1.7B', language: 'zh', createdAt: 1 }],
  activeRenditionId: rid,
};
await store.put('books', book);
await store.put('chapters', chapter);
for (let i = 0; i < chunks.length; i++) {
  await store.putAudio(rid, chapter.id, bookId, i, new Blob([new Uint8Array(1000 + i)], { type: 'audio/wav' }), 1.5);
}
await store.kvSet('lastBookId', bookId);
await store.kvSet('settings', { theme: 'paper', profileId: 'p-new', maxChars: 220 });

console.log('\n【只有 2 段不一致】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1400);

const meta = document.querySelector('.chapter-meta')?.textContent || '';
check('提示显示 2 段', meta.includes('2 段'), meta.trim());

const before = await store.audioOfRendition(chapter.id, rid);
const keepRow = before.find((r) => r.index === 2);
check('第三段原本是 1002 字节', keepRow?.size === 1002, String(keepRow?.size));

document.querySelector('.chapter-meta .chip.action')?.click();
await sleep(400);
check('标记了 2 段', document.querySelectorAll('.read-body .chunk.voice-issue').length === 2,
  String(document.querySelectorAll('.read-body .chunk.voice-issue').length));

console.log('\n【重新生成：只做这 2 段】');
document.getElementById('issue-regen').click();
await sleep(300);
const confirmBtn = [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '重新生成');
check('弹出确认框', !!confirmBtn);
check('确认框说明只重做 2 段', (document.querySelector('.modal')?.textContent || '').includes('2 段'),
  document.querySelector('.modal')?.textContent?.replace(/\s+/g, ' ').slice(0, 90));
confirmBtn.click();

const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  await sleep(400);
  const fresh = await store.getChapter(chapter.id);
  if (fresh.chunks.every((c) => c.audio[rid].meta.profileId === 'p-new')) break;
}
await sleep(600);

check('只调用了 2 次生成接口', genCalls === 2, String(genCalls));
check('生成的正是那两段文本', generated.every((t) => !t.includes('第三段')), generated.join(' | '));

const after = await store.audioOfRendition(chapter.id, rid);
const untouched = after.find((r) => r.index === 2);
check('第三段的音频没被动过', untouched?.size === 1002, String(untouched?.size));
const regenerated = after.filter((r) => r.index !== 2);
check('另两段是新生成的', regenerated.every((r) => r.size === 1200), regenerated.map((r) => r.size).join(','));

const ch = await store.getChapter(chapter.id);
check('三段音色标记都正确了', ch.chunks.every((c) => c.audio[rid].meta.profileId === 'p-new'),
  ch.chunks.map((c) => c.audio[rid].meta.profileId).join(','));
check('巡检条已收起', document.getElementById('issue-bar')?.classList.contains('hidden'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
