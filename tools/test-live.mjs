/**
 * 真机联调测试：驱动真实前端代码，对接**真实 Voicebox 服务**，跑通
 * 「导入 -> 分块 -> 生成语音 -> 存 IndexedDB -> 播放装载」。
 *
 * 为了耗时可控，使用只有一句话的迷你书（1 个朗读块）。
 * 运行：node tools/test-live.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = 'http://127.0.0.1:5178';

let pass = 0;
let fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e); } };

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: APP + '/', pretendToBeVisual: true });
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
URL.createObjectURL = () => 'blob:live/' + Math.random().toString(36).slice(2);
URL.revokeObjectURL = () => {};

const audioInstances = [];
class FakeAudio extends EventTarget {
  constructor() {
    super();
    this._src = ''; this.paused = true; this.currentTime = 0; this.duration = NaN;
    this.readyState = 0; this.playbackRate = 1; this.defaultPlaybackRate = 1; this.volume = 1;
    this.preload = 'auto'; this.crossOrigin = null; this.preservesPitch = true;
    audioInstances.push(this);
  }
  get src() { return this._src; }
  set src(v) {
    this._src = v; this.readyState = 0; this.currentTime = 0;
    setTimeout(() => { this.readyState = 4; this.duration = 3; this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('durationchange')); }, 5);
  }
  load() {}
  removeAttribute() { this._src = ''; }
  play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}
globalThis.Audio = FakeAudio;
window.Audio = FakeAudio;

// 真实网络：相对路径补全到本地应用服务器
const nodeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' && input.startsWith('/') ? APP + input : input;
  return nodeFetch(url, init);
};

console.log('\n【启动（真实服务）】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1500);
const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
check('前端已启动', !!document.querySelector('.empty-state'));
check('已连接真实 Voicebox', /在线|就绪/.test(text('#chip-voicebox')), text('#chip-voicebox'));

console.log('\n【导入迷你书】');
document.querySelector('#btn-import').click();
await sleep(100);
[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '粘贴文本').click();
await sleep(50);
const ta = document.querySelector('.modal textarea');
ta.value = '真实联调测试\n\n第一章 测试\n\n晚安，明天见。';
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '导入').click();
await sleep(800);
const total = document.querySelectorAll('.chunk').length;
check('导入并渲染出朗读块', total >= 1, String(total));

console.log('\n【真实生成（调用本机 TTS，可能需要 1-3 分钟）】');
const t0 = Date.now();
document.querySelector('#btn-generate-chapter').click();

let waited = 0;
for (;;) {
  await sleep(3000);
  waited = (Date.now() - t0) / 1000;
  const left = document.querySelectorAll('.chunk.pending-audio').length;
  if (waited % 15 < 3) console.log(`    …已等待 ${Math.round(waited)}s，剩余未生成 ${left} 段`);
  if (left === 0) break;
  if (waited > 420) { console.log('    超时'); break; }
}
console.log(`    生成耗时 ${Math.round(waited)}s`);

check('所有段落都生成了真实音频', document.querySelectorAll('.chunk.pending-audio').length === 0);
check('生成面板完成', /完成/.test(text('#gen-title')), text('#gen-title'));

const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const books = await store.listBooks();
const chapters = await store.chaptersOf(books[0].id);
const audios = await store.audioOf(chapters[0].id);
check('音频记录已入库', audios.length >= 1, String(audios.length));
check('音频带真实时长', audios.every((a) => a.dur > 0.5), JSON.stringify(audios.map((a) => a.dur)));

// 校验落库音频：可能是原始 WAV，也可能是压缩后的 WebM/Opus
const bytes = new Uint8Array(await audios[0].blob.arrayBuffer());
const tag = String.fromCharCode(...bytes.slice(0, 4)) + '/' + String.fromCharCode(...bytes.slice(8, 12));
const isWav = tag === 'RIFF/WAVE';
const isWebm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
check('落库音频格式有效（WAV 或 WebM/Opus）', isWav || isWebm, tag);
if (isWav) {
  check('采样率为 24kHz', new DataView(bytes.buffer).getUint32(24, true) === 24000, String(new DataView(bytes.buffer).getUint32(24, true)));
}
console.log('    落库格式:', isWav ? 'WAV' : 'WebM/Opus', ' 大小:', bytes.length, 'B');
if (isWav) check('音频体积合理（>50KB）', bytes.length > 50000, `${bytes.length} B`);
else check('压缩后体积合理（1KB~50KB）', bytes.length > 1000 && bytes.length < 50000, `${bytes.length} B`);

console.log('\n【播放装载】');
document.querySelector('#pb-play').click();
await sleep(600);
check('播放器装载了真实音轨', audioInstances.length > 0 && audioInstances.some((a) => !a.paused), String(audioInstances.length));
check('有段落被高亮', document.querySelectorAll('.chunk.speaking').length === 1);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
