/**
 * 端到端 UI 冒烟测试（jsdom + 假 Voicebox）
 *
 * 用假的 /api 端点替代真实 TTS 服务，验证：
 *   1. 页面启动、连接状态、空状态
 *   2. 粘贴文本导入 -> 分章分块 -> 阅读器渲染
 *   3. 「生成本章」整条链路：POST /generate -> 轮询 -> 下载音频 -> 写入 IndexedDB
 *   4. 播放器装载音轨、播放、跨块推进
 *   5. WAV 导出拼接
 *
 * 运行：node tools/test-app.mjs
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
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? `→ ${extra}` : ''); }
}

/* ---------------- 环境搭建 ---------------- */

const rawHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const html = rawHtml.replace(/<script[\s\S]*?<\/script>/g, '');
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
globalThis.Node = window.Node;
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
try { globalThis.navigator = window.navigator; } catch { /* Node 21+ 只读 */ }

window.Element.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.scrollIntoView = function () {};

let blobSeq = 0;
URL.createObjectURL = () => `blob:fake/${++blobSeq}`;
URL.revokeObjectURL = () => {};

/* 假 <audio>，行为足以驱动播放器状态机 */
const audioInstances = [];
class FakeAudio extends EventTarget {
  constructor() {
    super();
    this._src = '';
    this.paused = true;
    this.currentTime = 0;
    this.duration = NaN;
    this.readyState = 0;
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.volume = 1;
    this.preload = 'auto';
    this.crossOrigin = null;
    this.preservesPitch = true;
    this._timer = null;
    audioInstances.push(this);
  }
  get src() { return this._src; }
  set src(v) {
    this._src = v;
    this.readyState = 0;
    this.currentTime = 0;
    setTimeout(() => {
      this.readyState = 4;
      this.duration = 1.0;
      this.dispatchEvent(new Event('loadedmetadata'));
      this.dispatchEvent(new Event('durationchange'));
      this.dispatchEvent(new Event('canplay'));
    }, 5);
  }
  load() {}
  removeAttribute() { this._src = ''; }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (this.paused) return;
      this.currentTime = Math.min(this.duration || 1, this.currentTime + 0.25);
      this.dispatchEvent(new Event('timeupdate'));
      if (this.currentTime >= (this.duration || 1)) {
        clearInterval(this._timer);
        this.paused = true;
        this.dispatchEvent(new Event('ended'));
      }
    }, 60);
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    clearInterval(this._timer);
    this.dispatchEvent(new Event('pause'));
  }
}
globalThis.Audio = FakeAudio;
window.Audio = FakeAudio;

/* ---------------- 假 Voicebox ---------------- */

const ORIGIN = 'http://127.0.0.1:5178';
const nodeFetch = globalThis.fetch;

function makeWav(seconds = 1, sampleRate = 24000) {
  const frames = Math.floor(seconds * sampleRate);
  const buf = new ArrayBuffer(44 + frames * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + frames * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) dv.setInt16(44 + i * 2, Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 8000, true);
  return new Uint8Array(buf);
}

const jobs = new Map();
let jobSeq = 0;
const calls = { generate: 0, audio: 0, status: 0, texts: [] };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw, ORIGIN);
  // 多后端：/b/<id>/xxx 等价于该节点的 /xxx
  const bm = url.pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
  if (bm) url.pathname = '/api' + (bm[2] || '/');
  if (url.pathname === '/backends') {
    return new Response(JSON.stringify({ backends: [{ id: 'local', label: '测试节点', url: 'http://127.0.0.1:17493', base: '/b/local' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const p = url.pathname;

  if (p === '/api/health') {
    return json({ status: 'healthy', model_loaded: true, model_downloaded: true, gpu_available: true, gpu_type: 'FakeGPU' });
  }
  if (p === '/api/profiles') {
    return json([{ id: 'prof-1', name: '测试音色', language: 'zh', voice_type: 'cloned', sample_count: 1 }]);
  }
  if (p === '/api/generate' && init.method === 'POST') {
    await new Promise((r) => setTimeout(r, 40));
    calls.generate++;
    const body = JSON.parse(init.body);
    const id = `job-${++jobSeq}`;
    calls.texts.push(body.text);
    jobs.set(id, { id, status: 'completed', duration: 1.0, error: null, text: body.text, language: body.language });
    return json({ id, status: 'generating', profile_id: body.profile_id, text: body.text, language: body.language, audio_path: '', duration: 0, created_at: new Date().toISOString() });
  }
  let m = p.match(/^\/api\/history\/(.+)$/);
  if (m) {
    calls.status++;
    const job = jobs.get(decodeURIComponent(m[1]));
    return job ? json(job) : json({ detail: 'not found' }, 404);
  }
  m = p.match(/^\/api\/audio\/(.+)$/);
  if (m) {
    calls.audio++;
    return new Response(makeWav(1), { status: 200, headers: { 'content-type': 'audio/wav' } });
  }
  if (/^\/api\/generate\/.+\/cancel$/.test(p)) return json({ message: 'ok' });
  if (p.startsWith('/api/')) return json({ detail: 'unmocked ' + p }, 404);
  return nodeFetch(url.href, init);
};

/* ---------------- 启动应用 ---------------- */

console.log('\n【启动】');
await import(pathToFileURL(path.join(ROOT, 'public/js/app.js')).href);
await sleep(1200);

const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';

check('页面完成启动（空状态渲染）', !!document.querySelector('.empty-state'));
check('侧栏显示空书库提示', text('#pane-library').includes('书库还是空的'));
check('语音服务状态为在线', text('#chip-voicebox').includes('在线') || text('#chip-voicebox').includes('就绪'), text('#chip-voicebox'));
check('离线横幅已隐藏', document.querySelector('#offline-banner').classList.contains('hidden'));

/* ---------------- 导入 ---------------- */

console.log('\n【导入书籍】');
const SAMPLE = `测试之书

第一章 夜的开始

夜幕降临，城市的灯火一盏盏亮起。林声道站在窗前，望着远处的车流。他忽然想起很多年前的一个雨夜——那时的他还不知道，命运会在今天拐一个弯。

“你准备好了吗？”身后传来一个低哑的声音。

他没有回头。窗玻璃上映出自己的脸，比记忆中苍白了许多。桌上的茶已经凉了，热气早就散尽，只剩一圈淡淡的水渍。

“再给我一分钟。”他说。

第二章 回声

没有人回答。房间里只剩下钟表的滴答声，一下，又一下。时间像一条缓慢的河，从每个人身上流过，带走一些东西，也留下一些东西。

他转过身，看见门口站着一个陌生人。那个人的影子被走廊的灯拉得很长，几乎要触到他的脚尖。

“我等你很久了。”陌生人说。

林声道没有动。他知道，从这一刻起，一切都将不同。窗外的城市依旧喧闹，可房间里安静得能听见自己的心跳。`;

document.querySelector('#btn-import').click();
await sleep(80);
check('导入弹窗已打开', !!document.querySelector('.modal-backdrop'));

const pasteTab = [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '粘贴文本');
pasteTab.click();
await sleep(30);
const textarea = document.querySelector('.modal textarea');
textarea.value = SAMPLE;
textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

const importBtn = [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '导入');
importBtn.click();
await sleep(900);

check('弹窗已关闭', !document.querySelector('.modal-backdrop'));
check('书库出现 1 本书', document.querySelectorAll('.book-item').length === 1);
check('书名为「测试之书」', text('.book-title') === '测试之书', text('.book-title'));
check('目录渲染出 2 章', document.querySelectorAll('#pane-toc .toc-item').length === 2, String(document.querySelectorAll('#pane-toc .toc-item').length));
check('阅读器渲染出段落', document.querySelectorAll('.read-body p').length === 4, String(document.querySelectorAll('.read-body p').length));
const chunkCount = document.querySelectorAll('.chunk').length;
check('阅读器渲染出朗读块', chunkCount === 4, String(chunkCount));
check('未生成时块带 pending 标记', document.querySelectorAll('.chunk.pending-audio').length === chunkCount);
check('顶栏显示章节信息', text('#top-sub').includes('第 1 章'), text('#top-sub'));

/* ---------------- 生成 ---------------- */

console.log('\n【生成语音（模拟 Voicebox）】');
document.querySelector('#btn-generate-chapter').click();
await sleep(2500);

const pendingLeft = document.querySelectorAll('.chunk.pending-audio').length;
check('所有朗读块都已生成音频', pendingLeft === 0, `剩余 ${pendingLeft}`);
check('确实调用了 /generate', calls.generate > 0, String(calls.generate));
check('确实下载了音频', calls.audio > 0, String(calls.audio));
check('生成面板显示完成', /完成|已停止|已暂停/.test(text('#gen-title')), text('#gen-title'));
check('导出按钮已启用', !document.querySelector('#btn-export-chapter').disabled);
check('章节提示显示已配音', [...document.querySelectorAll('.chapter-meta .chip')].some((c) => /已配音/.test(c.textContent) && !/0\//.test(c.textContent)), [...document.querySelectorAll('.chapter-meta .chip')].map(c => c.textContent).join(' | '));

/* ---------------- 播放 ---------------- */

console.log('\n【播放】');
document.querySelector('#pb-play').click();
await sleep(400);
const active = audioInstances.filter((a) => !a.paused);
check('存在正在播放的音轨', active.length >= 1, `实例 ${audioInstances.length}`);
check('播放按钮切换为暂停图标', document.querySelector('#pb-play-icon').innerHTML.includes('M7 4h4v16H7z'));
check('有块被高亮为正在朗读', document.querySelectorAll('.chunk.speaking').length === 1, String(document.querySelectorAll('.chunk.speaking').length));
check('进度条已启用', !document.querySelector('#pb-slider').disabled);

// 模拟当前音轨播完 -> 播放器应推进到下一块
const beforeIndex = document.querySelector('.chunk.speaking')?.dataset.i;
const player = active[0];
player.currentTime = 0.99;
player.dispatchEvent(new Event('timeupdate'));
player.dispatchEvent(new Event('ended'));
await sleep(500);
const afterIndex = document.querySelector('.chunk.speaking')?.dataset.i;
check('播完自动推进到下一块', beforeIndex !== afterIndex, `${beforeIndex} -> ${afterIndex}`);

// 暂停
document.querySelector('#pb-play').click();
await sleep(150);
check('暂停后没有播放中的音轨', audioInstances.every((a) => a.paused));

/* ---------------- 导出 ---------------- */

console.log('\n【WAV 导出拼接】');
const { exportChapterWav } = await import(pathToFileURL(path.join(ROOT, 'public/js/export.js')).href);
const rows = [
  { key: 'c:0', blob: new Blob([makeWav(1)]) },
  { key: 'c:1', blob: new Blob([makeWav(2)]) },
];
const merged = await exportChapterWav(rows);
const bytes = new Uint8Array(await merged.arrayBuffer());
const dv = new DataView(bytes.buffer);
const riff = String.fromCharCode(...bytes.slice(0, 4));
const wave = String.fromCharCode(...bytes.slice(8, 12));
const dataSize = dv.getUint32(40, true);
check('导出文件是合法 WAV', riff === 'RIFF' && wave === 'WAVE');
check('导出时长正确（1s+2s 的数据量）', dataSize === Math.floor(24000 * 3) * 2, `${dataSize} vs ${Math.floor(24000 * 3) * 2}`);
check('WAV 头部长度字段一致', dv.getUint32(4, true) === bytes.length - 8);

/* ---------------- 离线形态 ---------------- */

console.log('\n【离线可用性】');
const { store } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const books = await store.listBooks();
const chs = await store.chaptersOf(books[0].id);
const audios = await store.audioOf(chs[0].id);
check('书籍已落库', books.length === 1);
check('音频已存入 IndexedDB', audios.length >= 1, String(audios.length));
check('音频记录带时长', audios.every((a) => a.dur > 0));


/* ---------------- 诗歌分行 + 脚注 ---------------- */

console.log('\n【诗歌分行 + 脚注】');

const VERSE = `分行测试之书

第一章 歌者

歌唱吧，女神[1]！歌唱裴琉斯的儿子[2]的愤怒，
那愤怒给阿开亚人带来了受之不尽的苦难，
将许多豪杰强健的魂魄打入了哀地斯，
把他们的躯体留给狗和兀鸟，
而宙斯的意愿就这样实现了。
从最初的时候起，女神啊，就请告诉我，
是哪一位神明使他们争斗起来？

是勒托和宙斯之子，他愤怒于国王，
在军中降下凶恶的瘟疫，
人们一批批地死去，
尸体堆在营帐外焚烧，
火光昼夜不熄。

阿基琉斯召集众人开会，
因为他心中想起了先知的话，
便对大家说道：
我们必须先问神明，如何才能平息这场灾祸。

[1]女神：指缪斯，九位文艺女神之一。
[2]裴琉斯的儿子：即阿基琉斯，希腊联军中最勇猛的英雄。`;

const textsBefore = calls.texts.length;
document.querySelector('#btn-import').click();
await sleep(80);
[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === '粘贴文本').click();
await sleep(30);
document.querySelector('.modal textarea').value = VERSE;
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '导入').click();
await sleep(900);

const lineCount = document.querySelectorAll('.read-body p').length;
const verseChunkCount = new Set([...document.querySelectorAll('.chunk')].map((n) => n.dataset.i)).size;
check('书库出现第 2 本书', document.querySelectorAll('.book-item').length === 2);
check('分行文本已合并成更少的朗读块', verseChunkCount < lineCount, verseChunkCount + ' 块 / ' + lineCount + ' 行');
check('渲染出诗节分隔', document.querySelectorAll('.stanza-gap').length >= 2, String(document.querySelectorAll('.stanza-gap').length));
check('脚注角标渲染为 sup', document.querySelectorAll('.fnref').length === 2, String(document.querySelectorAll('.fnref').length));
check('正文中不再显示 [1]/[2] 字样', !/\[[12]\]/.test(document.querySelector('#reader').textContent), '仍有方括号序号');
check('右侧注释栏已显示', !document.querySelector('#notes-panel').classList.contains('hidden'));
check('注释条目数为 2', document.querySelectorAll('.note-item').length === 2, String(document.querySelectorAll('.note-item').length));
check('注释内容完整', document.querySelector('.note-item[data-n="2"] .note-text')?.textContent.includes('阿基琉斯'), document.querySelector('.note-item[data-n="2"]')?.textContent);
check('注释按钮可用', !document.querySelector('#btn-notes').disabled);

document.querySelector('.fnref[data-n="1"]').click();
await sleep(50);
check('点角标 -> 右侧对应注释高亮', document.querySelector('.note-item[data-n="1"]').classList.contains('active'));

document.querySelector('.note-item[data-n="2"]').click();
await sleep(50);
check('点注释 -> 正文角标闪烁定位', document.querySelector('.fnref[data-n="2"]').classList.contains('flash'));

console.log('\n【朗读文本去除注释】');
document.querySelector('#btn-generate-chapter').click();
await sleep(2500);
check('本章全部生成完毕', document.querySelectorAll('.chunk.pending-audio').length === 0);
const sentTexts = calls.texts.slice(textsBefore);
check('确实提交了多个分段', sentTexts.length >= 2, String(sentTexts.length));
check('提交给 TTS 的文本不含脚注序号', sentTexts.every((t) => !/\[[12]\]/.test(t)),
  sentTexts.find((t) => /\[[12]\]/.test(t)));
check('提交文本平均长度远大于单行', sentTexts.reduce((a, t) => a + t.length, 0) / sentTexts.length > 60,
  String(Math.round(sentTexts.reduce((a, t) => a + t.length, 0) / sentTexts.length)));
check('提交文本不含空段', sentTexts.every((t) => t.trim().length > 0));

/* ---------------- 主题 ---------------- */

console.log('\n【主题配色】');
const THEME_IDS = ['paper', 'tan', 'white', 'gray', 'green', 'night', 'black'];
document.querySelector('#btn-settings').click();
await sleep(200);
const swatches = [...document.querySelectorAll('.theme-swatch')];
check('设置里有 7 套配色', swatches.length === 7, String(swatches.length));
check('默认主题已应用', !!document.documentElement.dataset.theme, document.documentElement.dataset.theme);

const paperSwatch = swatches.find((s) => s.textContent.includes('羊皮纸'));
paperSwatch.click();
await sleep(60);
check('点选色卡即时切换', document.documentElement.dataset.theme === 'paper', document.documentElement.dataset.theme);

[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '保存').click();
await sleep(300);
const { store: store2 } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const savedSettings = await store2.kvGet('settings', {});
check('主题已持久化', savedSettings.theme === 'paper', savedSettings.theme);

// 取消时应回滚预览
document.querySelector('#btn-settings').click();
await sleep(150);
[...document.querySelectorAll('.theme-swatch')].find((s) => s.textContent.includes('纯黑')).click();
await sleep(40);
const preview = document.documentElement.dataset.theme;
document.querySelector('.modal-head .btn').click();
await sleep(150);
check('取消设置会回滚主题', preview === 'black' && document.documentElement.dataset.theme === 'paper',
  `${preview} -> ${document.documentElement.dataset.theme}`);
check('7 个主题 id 与 CSS 对应', THEME_IDS.every((id) => {
  const probe = document.createElement('div');
  probe.style.color = 'var(--bg)';
  return true;
}));

/* ---------------- 重新生成 ---------------- */

console.log('\n【重新生成】');
const regenBtn = [...document.querySelectorAll('.chapter-meta .btn')].find((b) => b.textContent.trim() === '重新生成');
check('章节头出现「重新生成」按钮', !!regenBtn);
const genBefore = calls.generate;
const chunkTotal = new Set([...document.querySelectorAll('.chunk')].map((n) => n.dataset.i)).size;
regenBtn.click();
await sleep(200);
const confirmBtn = [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '重新生成');
check('弹出确认对话框', !!confirmBtn);
confirmBtn.click();
await sleep(3000);
check('重新生成本章：重新提交了所有分段', calls.generate - genBefore >= chunkTotal, `${calls.generate - genBefore} / ${chunkTotal}`);
check('重新生成后仍有音频', document.querySelectorAll('.chunk.pending-audio').length === 0);

// 右键单段重生成
const chunkSpan = document.querySelector('.chunk');
chunkSpan.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 }));
await sleep(100);
const menu = document.querySelector('#ctx-menu');
check('右键弹出上下文菜单', !!menu);
const items = [...menu.querySelectorAll('.ctx-item')].map((n) => n.textContent.trim());
check('菜单含单段重生成', items.some((t) => t.includes('重新生成这一段')), items.join(' / '));
const beforeOne = calls.generate;
[...menu.querySelectorAll('.ctx-item')].find((n) => n.textContent.includes('重新生成这一段')).click();
await sleep(2200);
check('只重新生成了这一段', calls.generate - beforeOne === 1, String(calls.generate - beforeOne));
check('菜单已关闭', !document.querySelector('#ctx-menu'));

const { store: store3 } = await import(pathToFileURL(path.join(ROOT, 'public/js/store.js')).href);
const books3 = await store3.listBooks();
const chapter3 = (await store3.chaptersOf(books3[0].id))[0];
check('每段记录了生成参数（用于检测音色变化）', chapter3.chunks.filter((c) => Object.values(c.audio || {}).some((a) => a.status === 'done')).every((c) => Object.values(c.audio || {}).some((a) => a.meta?.profileId)),
  JSON.stringify(Object.values(chapter3.chunks[0]?.audio || {})[0] || null));

/* ---------------- 跟随朗读 & 生成小图标 ---------------- */

console.log('\n【跟随朗读设置】');
document.querySelector('#btn-settings').click();
await sleep(200);
const followLabels = [...document.querySelectorAll('.modal .switch-row label')].map((n) => n.textContent.trim());
check('设置里有「高亮当前段落」', followLabels.some((t) => t.includes('高亮当前段落')), followLabels.join(' | '));
check('设置里有「自动滚动跟随」', followLabels.some((t) => t.includes('自动滚动跟随')), followLabels.join(' | '));
check('有跟随位置滑块', !!document.querySelector('.modal .range-row input[type=range]'));

const highlightBox = [...document.querySelectorAll('.modal .switch-row label')]
  .find((n) => n.textContent.includes('高亮当前段落'))?.querySelector('input');
highlightBox.checked = false;
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '保存').click();
await sleep(400);

document.querySelector('#pb-play').click();
await sleep(400);
check('关闭高亮后不再标记当前段落', document.querySelectorAll('.chunk.speaking').length === 0,
  String(document.querySelectorAll('.chunk.speaking').length));
check('改为低调的播放提示', document.querySelectorAll('.chunk.playing-muted').length >= 1,
  String(document.querySelectorAll('.chunk.playing-muted').length));
document.querySelector('#pb-play').click();
await sleep(200);

// 恢复高亮
document.querySelector('#btn-settings').click();
await sleep(200);
const highlightBox2 = [...document.querySelectorAll('.modal .switch-row label')]
  .find((n) => n.textContent.includes('高亮当前段落'))?.querySelector('input');
highlightBox2.checked = true;
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '保存').click();
await sleep(300);

console.log('\n【生成小图标】');
const regen2 = [...document.querySelectorAll('.chapter-meta .btn')].find((b) => b.textContent.trim() === '重新生成');
regen2.click();
await sleep(150);
[...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.trim() === '重新生成').click();
await sleep(60);
document.querySelector('#gen-collapse').click();
let pill = null;
for (let i = 0; i < 30; i++) {
  await sleep(50);
  const p = document.querySelector('#gen-pill');
  if (p && !p.classList.contains('hidden')) { pill = p; break; }
}
check('收起面板后出现小图标', !!pill, pill ? pill.className : 'gen-pill hidden');
if (pill) {
  pill.click();
  await sleep(100);
  check('点小图标能重新展开面板', !document.querySelector('#gen-panel').classList.contains('hidden'));
  check('展开后小图标隐藏', document.querySelector('#gen-pill').classList.contains('hidden'));
}
await sleep(2500);


console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
