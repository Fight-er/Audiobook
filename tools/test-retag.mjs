/**
 * 音色档案被重建（id 变了）时：不该要求重新合成，而应支持「只更新标记」
 * 运行：node tools/test-retag.mjs
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

const nodeFetch = globalThis.fetch;
const PROFILES = [{ id: 'p-new', name: '1', language: 'zh' }];   // 重建后的新档案
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, 'http://127.0.0.1:5178');
  const bm = url.pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
  if (bm) url.pathname = '/api' + (bm[2] || '/');
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/capabilities') return json({ transcode: false });
  if (url.pathname === '/backends') return json({ backends: [{ id: 'local', label: '测试', url: 'http://x', base: '/b/local' }] });
  if (url.pathname === '/api/health') return json({ status: 'healthy', model_loaded: true, gpu_available: true });
  if (url.pathname === '/api/profiles') return json(PROFILES);
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

/* 预置：音频是旧档案 p-old 生成的，而 Voicebox 里现在只有 p-new */
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const { chunkBlocks } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

const bookId = 'bk_retag';
const rid = `${bookId}_r0`;
const blocks = [
  { type: 'p', text: '第一段文字，用来说明情况。' },
  { type: 'p', text: '第二段文字，同样有音频。' },
  { type: 'p', text: '第三段文字。' },
];
const chunks = chunkBlocks(blocks, 220, { merge: false }).map((c) => ({
  ...c,
  audio: { [rid]: { status: 'done', dur: 1.5, meta: { profileId: 'p-old', backendProfileId: 'p-old', engine: 'qwen', modelSize: '1.7B', language: 'zh' } } },
}));
const chapter = {
  id: `${bookId}_c0`, bookId, index: 0, title: '第一章', blocks, notes: [], verse: false,
  chunks, schema: 2, chunkAlgo: 2, chunkChars: 220,
  chars: blocks.reduce((a, b) => a + b.text.length, 0), doneCount: chunks.length, updatedAt: Date.now(),
};
const book = {
  id: bookId, title: '重标记测试', author: '', format: 'txt',
  createdAt: Date.now(), updatedAt: Date.now(), totalChars: chapter.chars, generatedChars: chapter.chars,
  chapterRefs: [{ id: chapter.id, title: chapter.title, index: 0, chars: chapter.chars, total: chunks.length, done: chunks.length }],
  lastChapterId: chapter.id,
  renditions: [{ id: rid, name: '默认音色', profileId: 'p-new', engine: 'qwen', modelSize: '1.7B', language: 'zh', createdAt: 1 }],
  activeRenditionId: rid,
};
await store.put('books', book);
await store.put('chapters', chapter);
for (let i = 0; i < chunks.length; i++) {
  await store.putAudio(rid, chapter.id, bookId, i, new Blob([new Uint8Array(2048)], { type: 'audio/webm' }), 1.5);
}
await store.kvSet('lastBookId', bookId);
await store.kvSet('settings', { theme: 'paper', profileId: 'p-new', maxChars: 220 });

console.log('\n【识别为「档案失效」而不是「音色不一致」】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1400);

const meta = document.querySelector('.chapter-meta')?.textContent || '';
check('提示文案是「音色档案已失效」', meta.includes('音色档案已失效'), meta.trim());
check('没有误报成「音色不一致」', !meta.includes('音色不一致'), meta.trim());
check('提示里包含「定位」', meta.includes('定位'), meta.trim());

console.log('\n【点击定位：标记所有问题段落】');
const chip = [...document.querySelectorAll('.chapter-meta .chip')].find((n) => n.textContent.includes('定位'));
check('找到提示按钮', !!chip);
chip.click();
await sleep(400);

const marked = [...document.querySelectorAll('.read-body .chunk.voice-issue')];
check('所有问题段落被标记', marked.length === 3, String(marked.length));
check('每段带序号角标', marked.every((n) => n.querySelector('sup.issue-badge')), String(marked.filter((n) => n.querySelector('sup.issue-badge')).length));

const bar = document.getElementById('issue-bar');
check('出现巡检条', !!bar && !bar.classList.contains('hidden'));
check('巡检条显示进度', (bar?.textContent || '').includes('1/3'), bar?.textContent?.trim());

document.getElementById('issue-next').click();
await sleep(300);
check('可以翻到下一处', (bar.textContent || '').includes('2/3'), bar.textContent.trim());
document.getElementById('issue-prev').click();
await sleep(300);
check('可以回到上一处', (bar.textContent || '').includes('1/3'), bar.textContent.trim());

console.log('\n【一键重标记】');
document.getElementById('issue-retag').click();
await sleep(700);

const ch = await store.getChapter(chapter.id);
check('所有段落的 profileId 已更新', ch.chunks.every((c) => c.audio[rid].meta.profileId === 'p-new'),
  [...new Set(ch.chunks.map((c) => c.audio[rid].meta.profileId))].join(','));
check('音频条数没变（没有重新合成）', (await store.audioOfRendition(chapter.id, rid)).length === 3);
check('提示消失', !(document.querySelector('.chapter-meta')?.textContent || '').includes('音色档案已失效'),
  document.querySelector('.chapter-meta')?.textContent?.trim());
check('巡检条自动收起', document.getElementById('issue-bar')?.classList.contains('hidden'));
check('段落标记已清除', document.querySelectorAll('.read-body .chunk.voice-issue').length === 0,
  String(document.querySelectorAll('.read-body .chunk.voice-issue').length));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
