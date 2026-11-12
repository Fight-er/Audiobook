/**
 * 用真实的《荷马史诗》EPUB 跑一遍前端：导入 -> 渲染 -> 脚注栏。
 * 找不到文件时自动跳过。
 * 运行：node tools/test-iliad-ui.mjs [epub路径]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT = 'C:\\Users\\lixia\\Downloads\\荷马史诗：伊利亚特·奥德赛（套装上下册） (〔古希腊〕荷马) (z-library.sk, 1lib.sk, z-lib.sk).epub';
const file = process.argv[2] || DEFAULT;
if (!fs.existsSync(file)) { console.log(`\n跳过：未找到 ${file}\n`); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e); } };

// Node 的 DecompressionStream 不支持 deflate-raw（浏览器支持），补一个仅测试用的 shim
globalThis.DecompressionStream = class DecompressionStreamShim {
  constructor(format) {
    if (format !== 'deflate-raw') throw new TypeError(`unsupported format: ${format}`);
    const parts = [];
    const ts = new TransformStream({
      transform(chunk) { parts.push(Buffer.from(chunk)); },
      flush(controller) { controller.enqueue(new Uint8Array(zlib.inflateRawSync(Buffer.concat(parts)))); },
    });
    this.readable = ts.readable;
    this.writable = ts.writable;
  }
};

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
globalThis.DOMParser = window.DOMParser;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
try { globalThis.navigator = window.navigator; } catch { /* noop */ }
window.Element.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
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
globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, 'http://127.0.0.1:5178');
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/api/health') return json({ status: 'healthy', model_loaded: true, gpu_available: true, gpu_type: 'Fake' });
  if (url.pathname === '/api/profiles') return json([{ id: 'p1', name: '测试音色', language: 'zh' }]);
  if (url.pathname.startsWith('/api/')) return json({});
  return nodeFetch(url.href, init);
};

console.log('\n【导入真实 EPUB】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(900);

const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const fakeFile = { name: path.basename(file), arrayBuffer: async () => ab };

document.querySelector('#btn-import').click();
await sleep(100);
const fileInput = document.querySelector('.modal input[type=file]');
check('导入弹窗打开', !!fileInput);

// 走真实的「选择文件」路径
Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
fileInput.dispatchEvent(new window.Event('change'));

let waited = 0;
while (waited < 60000 && document.querySelectorAll('.book-item').length === 0) {
  await sleep(500);
  waited += 500;
}
console.log(`  导入耗时约 ${(waited / 1000).toFixed(1)}s`);
check('书籍已导入并出现在书库', document.querySelectorAll('.book-item').length === 1);

const tocItems = [...document.querySelectorAll('#pane-toc .toc-item')];
check('目录渲染出全部章节', tocItems.length > 50, String(tocItems.length));

let targetIdx = -1;
for (let i = 0; i < Math.min(tocItems.length, 20); i++) {
  const t = tocItems[i].querySelector('.t-title')?.textContent || '';
  if (/^第[一二三四五六七八九十]+卷$/.test(t.trim())) { targetIdx = i; break; }
}
check('找到正文卷', targetIdx >= 0, String(targetIdx));

tocItems[targetIdx].click();
await sleep(900);

const reader = document.querySelector('#reader');
const lineCount = reader.querySelectorAll('.read-body p').length;
const chunkIds = new Set([...reader.querySelectorAll('.read-body .chunk')].map((n) => n.dataset.i));
const stanzaGaps = reader.querySelectorAll('.stanza-gap').length;
const refs = reader.querySelectorAll('.fnref').length;
const noteItems = document.querySelectorAll('.note-item').length;

console.log(`  「${tocItems[targetIdx].querySelector('.t-title').textContent}」：${lineCount} 行 -> ${chunkIds.size} 段，诗节 ${stanzaGaps}，角标 ${refs}，注释 ${noteItems} 条`);
check('渲染出正文行', lineCount > 200, String(lineCount));
check('跨行合并生效（块数远少于行数）', chunkIds.size < lineCount / 3, `${chunkIds.size} / ${lineCount}`);
check('渲染出诗节分隔', stanzaGaps > 5, String(stanzaGaps));
check('渲染出脚注角标', refs > 3, String(refs));
check('正文不含 [n] 序号', !/\[\d{1,3}\]/.test(reader.textContent));
check('注释栏已自动展开', !document.querySelector('#notes-panel').classList.contains('hidden'));
check('注释条目与角标数量一致', noteItems === refs, `${noteItems} vs ${refs}`);

const firstRef = reader.querySelector('.fnref');
const n = firstRef.dataset.n;
firstRef.click();
await sleep(60);
check('点角标高亮对应注释', document.querySelector(`.note-item[data-n="${n}"]`)?.classList.contains('active'));
document.querySelector(`.note-item[data-n="${n}"]`).click();
await sleep(60);
check('点注释让正文角标闪烁', document.querySelector(`.fnref[data-n="${n}"]`).classList.contains('flash'));

console.log('\n  渲染片段示例：');
const sample = reader.querySelectorAll('.read-body p');
console.log('  ' + (sample[1]?.innerHTML || '').slice(0, 200).replace(/\s+/g, ' '));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
