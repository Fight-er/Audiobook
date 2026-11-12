/**
 * 数据迁移：导出 zip 备份 → 清库 → 从备份恢复
 * 运行：node tools/test-backup.mjs
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

let lastBlob = null;
URL.createObjectURL = (blob) => { lastBlob = blob; return 'blob:test/' + Math.random().toString(36).slice(2); };
URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { /* 拦截下载 */ };

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
  if (url.pathname === '/capabilities') return json({ transcode: false });
  if (url.pathname === '/api/health') return json({ status: 'healthy', model_loaded: true, gpu_available: true });
  if (url.pathname === '/api/profiles') return json([{ id: 'p1', name: '测试', language: 'zh' }]);
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

/* ---------------- 预置数据 ---------------- */
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const { chunkBlocks } = await import(pathToFileURL(path.join(ROOT, 'public/js/parser.js')).href);

const bookId = 'bk_backup';
const blocks = [
  { type: 'p', text: '备份测试第一段。' },
  { type: 'p', text: '备份测试第二段。' },
];
const chunks = chunkBlocks(blocks, 220, { merge: false });
const rid = `${bookId}_r0`;
const chapter = {
  id: `${bookId}_c0`, bookId, index: 0, title: '第一章', blocks, notes: [], verse: false,
  chunks: chunks.map((c) => ({ ...c, audio: { [rid]: { status: 'done', dur: 1.5, meta: { profileId: 'p1', engine: 'qwen', modelSize: '1.7B', language: 'zh' } } } })),
  schema: 2, chunkAlgo: 2, chunkChars: 220,
  chars: blocks.reduce((a, b) => a + b.text.length, 0), doneCount: chunks.length, updatedAt: Date.now(),
};
const book = {
  id: bookId, title: '备份测试书', author: '', format: 'txt',
  createdAt: Date.now(), updatedAt: Date.now(), totalChars: chapter.chars, generatedChars: chapter.chars,
  chapterRefs: [{ id: chapter.id, title: chapter.title, index: 0, chars: chapter.chars, total: chunks.length, done: chunks.length }],
  lastChapterId: chapter.id,
  renditions: [{ id: rid, name: '默认音色', profileId: 'p1', engine: 'qwen', modelSize: '1.7B', language: 'zh', createdAt: Date.now() }],
  activeRenditionId: rid,
};
await store.put('books', book);
await store.put('chapters', chapter);
for (let i = 0; i < chunks.length; i++) {
  await store.putAudio(rid, chapter.id, bookId, i, new Blob([new Uint8Array(2048)], { type: 'audio/webm' }), 1.5);
}
await store.kvSet('lastBookId', bookId);
await store.kvSet('settings', { theme: 'paper', profileId: 'p1', maxChars: 220 });

console.log('\n【启动并导出】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1200);

document.querySelector('#btn-settings').click();
await sleep(250);
const exportBtn = document.getElementById('btn-export-library');
check('设置里有「导出备份」', !!exportBtn);
exportBtn.click();
await sleep(200);
const confirm = [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '开始导出');
check('弹出导出确认', !!confirm);
confirm.click();
await sleep(1200);

check('生成了 zip Blob', !!lastBlob && lastBlob.size > 100, String(lastBlob?.size));

const zipBuf = await lastBlob.arrayBuffer();
const { readZipEntries, readZipEntry } = await import(pathToFileURL(path.join(ROOT, 'public/js/zip.js')).href);
const zip = readZipEntries(zipBuf);
check('zip 里有 manifest.json', zip.entries.has('manifest.json'));
check('zip 里有音频条目', [...zip.entries.keys()].filter((k) => k.startsWith('audio/')).length === 2,
  [...zip.entries.keys()].join(','));

const manifest = JSON.parse(new TextDecoder().decode(await readZipEntry(zip, zip.entries.get('manifest.json'))));
check('manifest 记录了书籍', manifest.books?.length === 1 && manifest.books[0].title === '备份测试书');
check('manifest 记录了章节与音频', manifest.chapters?.length === 1 && manifest.audio?.length === 2);

const firstAudio = await readZipEntry(zip, zip.entries.get(manifest.audio[0].file));
check('音频字节完整', firstAudio.length === 2048, String(firstAudio.length));

/* ---------------- 清库后恢复 ---------------- */
console.log('\n【清库 → 导入备份】');
for (const b of await store.listBooks()) await store.deleteBook(b.id);
check('已清空书库', (await store.listBooks()).length === 0);

const fakeFile = { name: 'backup.zip', arrayBuffer: async () => zipBuf };
const input = document.getElementById('import-file');
Object.defineProperty(input, 'files', { value: [fakeFile], configurable: true });
input.dispatchEvent(new window.Event('change'));
await sleep(300);
const importConfirm = [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '开始导入');
check('弹出导入确认', !!importConfirm);
if (importConfirm) importConfirm.click();
await sleep(1500);

const restoredBooks = await store.listBooks();
check('书籍已恢复', restoredBooks.length === 1 && restoredBooks[0].title === '备份测试书',
  JSON.stringify(restoredBooks.map((b) => b.title)));
const restoredCh = await store.getChapter(chapter.id);
check('章节已恢复', !!restoredCh && restoredCh.chunks.length === 2);
const restoredAudio = await store.audioOfRendition(chapter.id, rid);
check('音频已恢复', restoredAudio.length === 2, String(restoredAudio.length));
check('音频类型保持', restoredAudio[0]?.mime === 'audio/webm', restoredAudio[0]?.mime);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
