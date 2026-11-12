/**
 * 有声书阅读器 —— 主应用
 */

import { api, ENGINES, LANGUAGES, createClient, fetchBackends, saveBackends } from './api.js';
import { ensureRenditions, activeRendition, renditionById, chunkState, markChunk, isChunkDone, chapterDoneCount, migrateChunkStates } from './model.js';
import { store, newId } from './store.js';
import { parseFile, parsePlainText, chunkBlocks, detectLanguage, extractNotes, looksLikeVerse } from './parser.js';
import { Player } from './player.js';
import { Generator } from './generator.js';
import { exportChapterWav, exportBookWav, downloadBlob, safeFilename } from './export.js';

const APP_VERSION = '2026-11-12.13';
window.__APP_VERSION__ = APP_VERSION;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 当前音色版本 id */
function ridNow() {
  return state.renditionId || activeRendition(state.book)?.id || null;
}

/** 当前音色版本的语音参数（生成时使用） */
function voiceOfRendition(rendition) {
  const r = rendition || activeRendition(state.book) || {};
  return {
    profileId: r.profileId || state.settings.profileId,
    engine: r.engine || state.settings.engine,
    modelSize: r.modelSize || state.settings.modelSize,
    language: r.language || state.settings.language,
  };
}

/** 清空某章在某个音色版本下的所有音频状态 */
function resetRenditionChunks(chapter, rid) {
  for (const c of chapter.chunks || []) {
    if (c.audio) delete c.audio[rid];
    delete c.status;
    delete c.dur;
    delete c.meta;
    delete c.genId;
    delete c.err;
  }
  chapter.doneCount = 0;
}

/** 可用的语音服务节点（设置里勾选的 + 在线） */
function activeBackends() {
  const enabled = state.settings.backends || {};
  return state.backends.filter((b) => enabled[b.id] !== false && b.online !== false);
}


const state = {
  books: [],
  book: null,
  chapter: null,
  chapterRows: [],
  profiles: [],
  health: null,
  online: null,
  generating: false,
  importing: false,
  renditionId: null,
  backends: [],
  genQueue: [],
  tocSelect: false,
  tocSelected: new Set(),
  settings: {
    profileId: '',
    engine: 'qwen',
    modelSize: '1.7B',
    language: 'auto',
    maxChars: 220,
    instruct: '',
    theme: 'dark',
    fontSize: 19,
    autoNext: true,
    rate: 1,
    sleepMinutes: 0,
    showNotes: true,
  },
};

const player = new Player();
const generator = new Generator();
let sleepTimer = null;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtEta(ms) {
  if (!ms || !Number.isFinite(ms)) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.ceil((total % 3600) / 60);
  if (h > 0) return `约剩 ${h} 小时 ${m} 分`;
  if (m > 0) return `约剩 ${m} 分钟`;
  return '即将完成';
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

let toastTimer = null;
function toast(message, type = '') {
  const wrap = $('#toast-wrap');
  const node = el('div', { class: `toast ${type}` }, message);
  wrap.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(-8px)';
    node.style.transition = 'all .25s';
    setTimeout(() => node.remove(), 260);
  }, type === 'err' ? 5200 : 3000);
  clearTimeout(toastTimer);
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

async function saveSettings() {
  await store.kvSet('settings', state.settings);
}

const THEMES = [
  { id: 'paper', label: '羊皮纸', bg: '#efe3cc', fg: '#362b1c', desc: '暖黄纸纤维' },
  { id: 'tan', label: '牛皮纸', bg: '#e2d2b4', fg: '#33291a', desc: '更深一档的米棕' },
  { id: 'white', label: '纸白', bg: '#fbfaf7', fg: '#1e2024', desc: '接近实体书白页' },
  { id: 'gray', label: '浅灰', bg: '#e8e8e5', fg: '#23252a', desc: '中性，不偏色' },
  { id: 'green', label: '护眼绿', bg: '#cfe0cd', fg: '#1f2c22', desc: '豆沙绿，久看不累' },
  { id: 'night', label: '夜读', bg: '#101317', fg: '#e7e9ee', desc: '暗色，睡前不刺眼' },
  { id: 'black', label: '纯黑', bg: '#000000', fg: '#cfd2d8', desc: 'OLED 省电' },
];
const THEME_ALIAS = { dark: 'night', light: 'white', sepia: 'paper' };

function applyTheme() {
  const raw = state.settings.theme || 'night';
  const id = THEME_ALIAS[raw] || (THEMES.some((t) => t.id === raw) ? raw : 'night');
  state.settings.theme = id;
  document.documentElement.dataset.theme = id;
  const theme = THEMES.find((t) => t.id === id) || THEMES[5];
  $('meta[name="theme-color"]')?.setAttribute('content', theme.bg);
}

function applyFontSize() {
  document.documentElement.style.setProperty('--reader-size', `${state.settings.fontSize || 19}px`);
}

/* ------------------------------------------------------------------ */
/* 语音服务状态                                                        */
/* ------------------------------------------------------------------ */

async function refreshHealth({ silent = true } = {}) {
  const chip = $('#chip-voicebox');
  try {
    const h = await api.health();
    state.health = h;
    state.online = true;
    chip.className = 'chip ok';
    chip.textContent = h.model_loaded ? '语音服务就绪' : '语音服务在线';
    chip.title = `GPU: ${h.gpu_type || '未检测到'} · 模型已加载: ${h.model_loaded ? '是' : '否'}`;
    $('#offline-banner').classList.add('hidden');
    if (!silent) toast('已连接 Voicebox');
  } catch (err) {
    state.online = false;
    state.health = null;
    chip.className = 'chip bad';
    chip.textContent = '语音服务离线';
    chip.title = err.message;
    $('#offline-banner').classList.remove('hidden');
  }
  updateChapterButtons();
}

async function loadProfiles() {
  try {
    state.profiles = await api.profiles();
  } catch {
    state.profiles = [];
  }
  if (!state.settings.profileId && state.profiles.length) {
    state.settings.profileId = state.profiles[0].id;
    await saveSettings();
  }
  if (state.settings.profileId && !state.profiles.some((p) => p.id === state.settings.profileId) && state.profiles.length) {
    state.settings.profileId = state.profiles[0].id;
    await saveSettings();
  }
}

function profileName(id) {
  return state.profiles.find((p) => p.id === id)?.name || '未选择音色';
}

/* ------------------------------------------------------------------ */
/* 侧栏：书库 / 目录                                                    */
/* ------------------------------------------------------------------ */

function renderLibrary() {
  const pane = $('#pane-library');
  pane.innerHTML = '';
  if (!state.books.length) {
    pane.append(el('div', { class: 'muted', style: 'padding:8px;font-size:12.5px;line-height:1.8' },
      '书库还是空的。点击下方「导入书籍」，支持 .txt / .md / .epub，或直接粘贴文本。'));
    return;
  }
  for (const book of state.books) {
    const pct = book.totalChars ? Math.min(100, Math.round(((book.generatedChars || 0) / book.totalChars) * 100)) : 0;
    const item = el('div', {
      class: 'book-item' + (state.book?.id === book.id ? ' active' : ''),
      onclick: () => openBook(book),
    },
      el('div', { class: 'book-cover' }, (book.title || '书').trim().slice(0, 1)),
      el('div', { class: 'book-meta' },
        el('div', { class: 'book-title' }, book.title || '未命名'),
        el('div', { class: 'book-sub' },
          el('span', {}, `${(book.chapterRefs || []).length} 章`),
          el('span', {}, '·'),
          el('span', {}, pct >= 100 ? '已全部配音' : `${pct}% 已配音`),
        )
      )
    );
    pane.append(item);
  }
}

function chapterStatus(ref) {
  if (!ref.total) return 'none';
  if ((ref.done || 0) >= ref.total) return 'ready';
  if ((ref.done || 0) > 0) return 'partial';
  return 'none';
}

function renderToc() {
  const pane = $('#pane-toc');
  pane.innerHTML = '';
  if (!state.book) {
    pane.append(el('div', { class: 'muted', style: 'padding:8px;font-size:12.5px' }, '尚未打开书籍'));
    return;
  }
  const selectMode = state.tocSelect;
  const selected = state.tocSelected;
  const pendingOf = (ref) => Math.max(0, (ref.total || 0) - (ref.done || 0));
  const selectedPending = (state.book.chapterRefs || [])
    .filter((r) => selected.has(r.id))
    .reduce((a, r) => a + pendingOf(r), 0);

  const head = el('div', { class: 'toc-head' },
    el('h2', {}, selectMode ? `已选 ${selected.size} 章` : (state.book.title || '目录')),
    selectMode
      ? el('button', {
        class: 'btn ghost sm',
        onclick: () => { state.tocSelect = false; state.tocSelected.clear(); renderToc(); },
      }, '完成')
      : el('button', {
        class: 'btn ghost sm',
        title: '勾选多个章节批量生成',
        onclick: () => { state.tocSelect = true; renderToc(); },
      }, '多选'),
    el('button', {
      class: 'btn ghost sm',
      title: '为整本书生成语音（离线、本机合成）',
      onclick: () => generateBook(),
    }, '整本生成')
  );
  pane.append(head);

  let lastPart = null;
  (state.book.chapterRefs || []).forEach((ref) => {
    if (ref.part && ref.part !== lastPart) {
      pane.append(el('div', { class: 'toc-part' }, ref.part));
      lastPart = ref.part;
    } else if (!ref.part) {
      lastPart = null;
    }
    const status = chapterStatus(ref);
    const isSel = selected.has(ref.id);
    const row = el('div', {
      class: 'toc-item' + (state.chapter?.id === ref.id ? ' active' : '') + (isSel ? ' selected' : ''),
      onclick: () => {
        if (state.tocSelect) {
          if (selected.has(ref.id)) selected.delete(ref.id);
          else selected.add(ref.id);
          renderToc();
          return;
        }
        openChapter(ref.id, { pause: true });
      },
    },
      selectMode
        ? el('input', {
          type: 'checkbox',
          class: 'toc-check',
          checked: isSel,
          onclick: (e) => e.stopPropagation(),
          onchange: (e) => {
            if (e.target.checked) selected.add(ref.id);
            else selected.delete(ref.id);
            renderToc();
          },
        })
        : null,
      el('span', { class: 'idx' }, String(ref.index + 1).padStart(2, '0')),
      el('span', { class: 't-title', title: ref.title }, ref.title),
      el('span', { class: 'toc-pending' }, status === 'ready' ? '' : `${pendingOf(ref)}`),
      el('span', { class: `dot ${status}`, title: { ready: '已生成音频', partial: '部分生成', none: '尚未生成' }[status] })
    );
    pane.append(row);
  });

  if (selectMode) {
    pane.append(el('div', { class: 'toc-select-bar' },
      el('div', { class: 'tsb-info' },
        selected.size
          ? `已选 ${selected.size} 章 · ${selectedPending} 段待生成`
          : '勾选要生成的章节'),
      el('div', { class: 'tsb-actions' },
        el('button', {
          class: 'btn sm',
          onclick: () => {
            for (const r of state.book.chapterRefs || []) {
              if (pendingOf(r) > 0) selected.add(r.id);
            }
            renderToc();
          },
        }, '选未生成'),
        el('button', {
          class: 'btn sm primary',
          disabled: !selected.size,
          onclick: () => generateSelectedChapters(),
        }, '生成选中'),
      )
    ));
  }
}

function syncChapterRef(chapter) {
  if (!state.book) return;
  const ref = (state.book.chapterRefs || []).find((r) => r.id === chapter.id);
  if (!ref) return;
  ref.total = chapter.chunks.length;
  ref.done = chapter.chunks.filter((c) => isChunkDone(c, ridNow())).length;
  ref.chars = chapter.blocks.reduce((a, b) => a + b.text.length, 0);
  state.book.generatedChars = (state.book.chapterRefs || []).reduce(
    (a, r) => a + (r.total ? Math.round((r.chars || 0) * ((r.done || 0) / r.total)) : 0), 0);
  store.put('books', state.book).catch(() => {});
  renderLibrary();
  if ($('#pane-toc').classList.contains('hidden') === false) renderToc();
}

/* ------------------------------------------------------------------ */
/* 阅读器                                                              */
/* ------------------------------------------------------------------ */

const CHAPTER_SCHEMA = 2;
/** 分块算法版本：只在「本章没有音频」时自动按新算法重排 */
const CHUNK_ALGO = 2;

let migrationNoticeShown = false;

/** 判断分块是否还是「一行一段」的旧结构（诗歌类书籍常见） */
function isLinePerChunk(chapter) {
  const ps = (chapter.blocks || []).filter((b) => b.type === 'p' && b.text.length > 2);
  const chunks = chapter.chunks || [];
  if (ps.length < 8 || !chunks.length) return false;
  const single = chunks.filter((c) => !c.segs || c.segs.length === 1).length;
  return single >= chunks.length * 0.9 && chunks.length >= ps.length * 0.8;
}

/** 诗体排版 + 逐行分块 = 需要按整句重新分块 */
function needsRechunk(chapter) {
  if (!chapter) return false;
  return looksLikeVerse(chapter.blocks || []) && isLinePerChunk(chapter);
}

/**
 * 按当前策略重新分段，并清空本章音频（分段一变，旧音频的下标就对不上了）。
 * 只应在「用户明确要重做」或「本章本来就没有音频」时调用。
 */
async function rechunkChapter(chapter) {
  const verse = looksLikeVerse(chapter.blocks || []);
  chapter.verse = verse;
  chapter.chunks = chunkBlocks(chapter.blocks, state.settings.maxChars, { merge: verse });
  chapter.chunkChars = state.settings.maxChars;
  for (const c of chapter.chunks) {
    delete c.status;
    delete c.dur;
    delete c.meta;
    delete c.genId;
    delete c.err;
  }
  chapter.doneCount = 0;
  chapter.schema = CHAPTER_SCHEMA;
  chapter.chunkAlgo = CHUNK_ALGO;
  chapter.staleChunks = false;
  await store.deleteChapterAudio(chapter.id, ridNow());
  await store.put('chapters', chapter);
  return chapter;
}

/** 章节数据升级 / 重新分块 */
async function ensureChunks(chapter, maxChars) {
  const rid0 = ridNow();
  if (rid0 && migrateChunkStates(chapter, rid0)) store.put('chapters', chapter).catch(() => {});

  // 上次生成被中断（关页面/断网）会留下 generating/queued 状态，这里复位成待生成
  if (rid0) {
    let fixed = false;
    for (const c of chapter.chunks || []) {
      const st = c.audio?.[rid0];
      if (st && (st.status === 'generating' || st.status === 'queued')) {
        st.status = 'pending';
        fixed = true;
      }
    }
    if (fixed) store.put('chapters', chapter).catch(() => {});
  }

  if (chapter.schema !== CHAPTER_SCHEMA) {
    await migrateChapter(chapter, maxChars);
    if (!migrationNoticeShown && (chapter.notes?.length || chapter.verse)) {
      migrationNoticeShown = true;
      toast('已按新版规则重新分段并抽取脚注');
    }
    return chapter.chunks;
  }

  const hasAudio = (chapter.chunks || []).some((c) => isChunkDone(c, ridNow())) ||
    chapterDoneCount(chapter, ridNow()) > 0;

  // 还没音频的章节：静默升级到最新的分块算法（断句点回退）
  if (!hasAudio && chapter.chunkAlgo !== CHUNK_ALGO) {
    await rechunkChapter(chapter);
    return chapter.chunks;
  }
  // 诗体书但仍是逐行分块：没音频就静默重排；有音频则先标记，交给界面提示
  if (needsRechunk(chapter)) {
    if (!hasAudio) {
      await rechunkChapter(chapter);
      return chapter.chunks;
    }
    if (!chapter.staleChunks) {
      chapter.staleChunks = true;
      store.put('chapters', chapter).catch(() => {});
    }
    return chapter.chunks;
  }

  const need = !chapter.chunks || !chapter.chunks.length ||
    (chapter.chunkChars !== maxChars && !hasAudio);
  if (need) {
    // 每次都用最新文本重新判定，避免旧的 verse 标记把合并关掉
    const verse = looksLikeVerse(chapter.blocks || []);
    chapter.verse = verse;
    chapter.chunks = chunkBlocks(chapter.blocks, maxChars, { merge: verse });
    chapter.chunkChars = maxChars;
    chapter.chunkAlgo = CHUNK_ALGO;
    chapter.doneCount = chapter.chunks.filter((c) => isChunkDone(c, ridNow())).length;
    store.put('chapters', chapter).catch(() => {});
  }
  return chapter.chunks;
}

/**
 * 旧版本导入的章节：补做脚注抽取，并按新版规则重新分块。
 * 若该章已有音频，则保持原有块结构（避免音频错位），只清理文字。
 */
async function migrateChapter(chapter, maxChars) {
  const hasAudio = (chapter.chunks || []).some((c) => isChunkDone(c, ridNow()));
  const { blocks, notes } = extractNotes(chapter.blocks || [], { keepPlaceholders: hasAudio });
  chapter.blocks = blocks;
  chapter.notes = notes;
  chapter.verse = looksLikeVerse(blocks);
  if (!hasAudio) {
    chapter.chunks = chunkBlocks(blocks, maxChars, { merge: chapter.verse });
    chapter.chunkChars = maxChars;
    chapter.doneCount = 0;
  }
  chapter.schema = CHAPTER_SCHEMA;
  chapter.chunkAlgo = CHUNK_ALGO;
  if (hasAudio && chapter.verse && isLinePerChunk(chapter)) chapter.staleChunks = true;
  await store.put('chapters', chapter);
  return chapter.chunks;
}

/** 提示：这一章仍是「一行一段」，是否改成整句 */
async function promptStaleChunks(chapter, { force = false } = {}) {
  if (!chapter || !chapter.staleChunks) return;
  if (!force && chapter.stalePrompted) return;
  chapter.stalePrompted = true;
  await store.put('chapters', chapter).catch(() => {});

  const done = chapter.chunks.filter((c) => isChunkDone(c, ridNow())).length;
  const merged = Math.max(1, Math.round(chapter.chunks.length / 2.5));
  const ok = await confirmDialog({
    title: '这一章还是「一行一段」',
    message: `检测到本章是分行的诗体排版，但分块仍是一行一段（共 ${chapter.chunks.length} 段），逐行合成听起来会一顿一顿的。\n\n按整句合并后约 ${merged} 段，朗读更连贯自然。\n\n${done > 0 ? `注意：将删除已生成的 ${done} 段旧音频。` : '本章目前没有音频，重排不会丢失任何内容。'}`,
    confirmText: done > 0 ? '重新分段并清除音频' : '重新分段',
    danger: done > 0,
  });
  if (!ok) return;

  await rechunkChapter(chapter);
  state.chapterRows = [];
  syncChapterRef(chapter);
  if (state.chapter?.id === chapter.id) {
    player.clear();
    updateNowPlayingEmpty();
    renderReader();
  }
  updateChapterButtons();
  toast(done > 0 ? '已按整句分段，点「生成本章」重新合成' : '已按整句分段');
}

function showEmptyReader() {
  const reader = $('#reader');
  reader.innerHTML = '';
  reader.append(el('div', { class: 'empty-state' },
    el('div', { class: 'icon-big', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>' }),
    el('h2', {}, '开始你的第一本有声书'),
    el('p', {}, '导入 txt / epub（或直接粘贴文字），阅读器会把正文切成适合朗读的段块。点「生成本章」，Voicebox 会在本机 GPU 上逐段合成语音并存进浏览器，之后即使断网也能继续听。'),
    el('div', { class: 'empty-actions' },
      el('button', { class: 'btn primary', onclick: () => openImportModal() }, '导入书籍'),
      el('button', { class: 'btn', onclick: () => openSettingsModal() }, '配置语音')
    )
  ));
}

function renderReader() {
  const chapter = state.chapter;
  const reader = $('#reader');
  if (!chapter) { showEmptyReader(); return; }
  reader.innerHTML = '';

  const done = chapter.chunks.filter((c) => isChunkDone(c, ridNow())).length;
  const totalDur = state.chapterRows.reduce((a, r) => a + (r.dur || 0), 0);
  const chars = chapter.blocks.reduce((a, b) => a + b.text.length, 0);
  const mismatch = chapterMismatchCount(chapter);

  reader.append(el('div', { class: 'chapter-head' },
    el('div', { class: 'chapter-kicker' }, `${state.book?.title || ''} · 第 ${chapter.index + 1} 章`),
    el('h1', { class: 'chapter-title' }, chapter.title),
    el('div', { class: 'chapter-meta' },
      el('span', { class: 'chip' }, `${chars.toLocaleString()} 字`),
      el('span', { class: 'chip' }, `${chapter.chunks.length} 段`),
      el('span', { class: `chip ${done === chapter.chunks.length ? 'ok' : done > 0 ? 'warn' : ''}` }, `已配音 ${done}/${chapter.chunks.length}`),
      totalDur ? el('span', { class: 'chip' }, `时长 ${fmtTime(totalDur)}`) : null,
      mismatch ? el('button', {
        class: 'chip action warn',
        title: '这些段落是用别的音色 / 引擎生成的，点此重新生成本章',
        onclick: () => regenerateChapter(chapter),
      }, `${mismatch} 段音色不一致 · 重新生成`) : null,
      chapter.staleChunks
        ? el('button', {
          class: 'chip action warn',
          title: '当前是「一行一段」的分块，点此按整句重排（会清除本章旧音频）',
          onclick: () => promptStaleChunks(chapter, { force: true }),
        }, '分段：逐行 · 改为整句')
        : (chapter.verse ? el('span', { class: 'chip', title: '诗体排版已跨行合并成整句朗读' }, '分段：整句合并') : null),
      el('button', { class: 'btn sm', onclick: () => playChapter(0) }, '从头播放'),
      done < chapter.chunks.length ? el('button', { class: 'btn sm primary', onclick: () => generateChapter(state.chapter) }, '生成语音') : null,
      done > 0 ? el('button', { class: 'btn sm', onclick: () => regenerateChapter(chapter) }, '重新生成') : null
    )
  ));

  const body = el('div', { class: 'read-body' });
  const byBlock = new Map();
  chapter.chunks.forEach((c, ci) => {
    const segs = c.segs || [{ b: c.b ?? 0, from: 0, to: (chapter.blocks[c.b ?? 0]?.text || '').length }];
    for (const s of segs) {
      if (!byBlock.has(s.b)) byBlock.set(s.b, []);
      byBlock.get(s.b).push({ ci, seg: s });
    }
  });

  chapter.blocks.forEach((block, bi) => {
    if (block.type === 'note') return;
    if (block.type === 'br') {
      body.append(el('div', { class: 'stanza-gap' }));
      return;
    }
    if (block.type === 'h') {
      body.append(el('h3', { class: 'block-h' }, block.text));
      return;
    }
    const p = el('p');
    if (/^[「『“"（(]/.test(block.text.trim())) p.classList.add('no-indent');
    const segs = byBlock.get(bi) || [];
    if (!segs.length) {
      p.textContent = block.text;
      p.classList.add('no-audio-block');
    } else {
      for (const { ci, seg } of segs) {
        const chunk = chapter.chunks[ci];
        const span = el('span', {
          class: 'chunk' + (isChunkDone(chunk, ridNow()) ? '' : ' pending-audio'),
          dataset: { i: String(ci) },
          title: isChunkDone(chunk, ridNow()) ? '点击从这里播放（右键更多操作）' : '这一段还没有音频（右键可单独生成）',
          onclick: () => onChunkClick(ci),
          oncontextmenu: (e) => {
            e.preventDefault();
            openChunkMenu(e.clientX, e.clientY, ci);
          },
        });
        fillSpanWithMarks(span, block, seg);
        p.append(span);
      }
    }
    body.append(p);
  });

  reader.append(body);
}

/** 把一段原文写进 span，并在脚注位置插入可点击的角标 */
function fillSpanWithMarks(span, block, seg) {  const marks = (block.marks || []).filter((m) => m.at >= seg.from && m.at <= seg.to);
  if (!marks.length) {
    span.textContent = block.text.slice(seg.from, seg.to);
    return;
  }
  let last = seg.from;
  for (const m of marks) {
    if (m.at > last) span.append(document.createTextNode(block.text.slice(last, m.at)));
    span.append(el('sup', {
      class: 'fnref',
      dataset: { n: String(m.n) },
      title: `注释 ${m.n}`,
      onclick: (e) => { e.stopPropagation(); focusNote(m.n); },
    }, String(m.n)));
    last = m.at;
  }
  span.append(document.createTextNode(block.text.slice(last, seg.to)));
}


/* ------------------------------------------------------------------ */
/* 右侧注释栏                                                          */
/* ------------------------------------------------------------------ */

function setNotesOpen(open, { persist = true } = {}) {
  state.notesOpen = open;
  if (persist) state.settings.showNotes = open;
  document.body.classList.toggle('notes-open', open);
  $('#notes-panel').classList.toggle('hidden', !open);
  $('#btn-notes').classList.toggle('active', open);
  if (persist) saveSettings();
}

function toggleNotes() {
  setNotesOpen(!state.notesOpen);
}

function renderNotes() {
  const body = $('#notes-body');
  if (!body) return;
  const notes = state.chapter?.notes || [];
  body.innerHTML = '';
  $('#notes-count').textContent = notes.length ? `${notes.length}` : '0';
  $('#btn-notes').disabled = !notes.length;

  if (!notes.length) {
    body.append(el('div', { class: 'notes-empty' }, '本章没有注释'));
    setNotesOpen(false, { persist: false });
    return;
  }

  for (const note of notes) {
    body.append(el('div', {
      class: 'note-item',
      dataset: { n: String(note.n) },
      title: '点击定位到正文位置',
      onclick: () => focusRef(note.n),
    },
      el('span', { class: 'note-n' }, String(note.n)),
      el('div', { class: 'note-text' }, note.text)
    ));
  }

  if (state.settings.showNotes !== false) setNotesOpen(true, { persist: false });
  else setNotesOpen(false, { persist: false });
}

/** 点击正文角标：定位右侧注释 */
function focusNote(n) {
  setNotesOpen(true);
  const item = $(`.note-item[data-n="${n}"]`);
  if (!item) return;
  $$('.note-item.active').forEach((x) => x.classList.remove('active'));
  item.classList.add('active');
  item.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** 点击右侧注释：定位正文角标 */
function focusRef(n) {
  const ref = $(`.fnref[data-n="${n}"]`);
  if (!ref) return;
  ref.scrollIntoView({ block: 'center', behavior: 'smooth' });
  ref.classList.add('flash');
  setTimeout(() => ref.classList.remove('flash'), 1400);
  $$('.note-item.active').forEach((x) => x.classList.remove('active'));
  $(`.note-item[data-n="${n}"]`)?.classList.add('active');
}

/** 播放到某块时，高亮该块引用到的注释 */
function highlightNotesForChunk(chunkIndex) {
  if (!state.chapter?.notes?.length) return;
  const nums = state.chapter.chunks[chunkIndex]?.notes || [];
  $$('.note-item').forEach((item) => {
    item.classList.toggle('active', nums.includes(Number(item.dataset.n)));
  });
  if (nums.length && state.settings.showNotes) {
    const first = $(`.note-item[data-n="${nums[0]}"]`);
    first?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function openChunkMenu(x, y, ci) {
  const chapter = state.chapter;
  const chunk = chapter?.chunks?.[ci];
  if (!chunk) return;
  const hasAudio = isChunkDone(chunk, ridNow());
  showContextMenu(x, y, [
    { label: '从这一段播放', action: () => onChunkClick(ci) },
    '-',
    { label: hasAudio ? '重新生成这一段' : '生成这一段', action: () => regenerateChunk(ci) },
    { label: '从这一段开始补齐后续', action: () => generateFrom(ci) },
    '-',
    { label: '重新生成本章', action: () => regenerateChapter(chapter) },
    { label: '清除本章音频', danger: true, action: () => clearChapterAudio() },
  ]);
}

/** 从指定段开始补齐本章剩余音频 */
async function generateFrom(startChunk) {
  const chapter = state.chapter;
  if (!canGenerate({ allowBusy: true }) || !chapter) return;
  const pending = new Set();
  for (let i = startChunk; i < chapter.chunks.length; i++) {
    if (chapter.chunks[i].status !== 'done') pending.add(i);
  }
  if (!pending.size) { toast('这一段之后都已生成完毕'); return; }
  syncChapterRef(chapter);
  await queueOrRun([{ book: state.book, chapter, only: pending }], chapter.title);
}

function onChunkClick(i) {
  const hasAudio = state.chapterRows.some((r) => Number(r.key.split(':').pop()) === i);
  if (!hasAudio) {
    toast('这一段还没有音频，先点「生成本章」');
    return;
  }
  if (player.chapter?.id !== state.chapter.id) {
    playChapter(i);
    return;
  }
  player.goToChunk(i, true);
}

function highlightChunk(chunkIndex) {
  $$('.chunk.speaking').forEach((n) => n.classList.remove('speaking'));
  if (state.settings.highlightFollow !== false) {
    $$(`.chunk[data-i="${chunkIndex}"]`).forEach((n) => n.classList.add('speaking'));
  } else {
    $$(`.chunk[data-i="${chunkIndex}"]`).forEach((n) => n.classList.add('playing-muted'));
  }
  highlightNotesForChunk(chunkIndex);

  if (state.settings.autoScroll === false) return;
  const node = $(`.chunk[data-i="${chunkIndex}"]`);
  if (!node) return;

  const scroll = $('#reader-scroll');
  const box = scroll.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  if (!box.height) return;
  // 目标：当前段落的第一行落在视口 80%（可调）的位置
  const pct = Math.min(0.9, Math.max(0.15, (Number(state.settings.followPosition) || 80) / 100));
  const relTop = (rect.top - box.top) / box.height;
  if (relTop < pct - 0.22 || relTop > pct + 0.14) {
    const target = scroll.scrollTop + (rect.top - box.top) - box.height * pct;
    scroll.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
}

/* ------------------------------------------------------------------ */
/* 打开书籍 / 章节                                                      */
/* ------------------------------------------------------------------ */

async function openBook(book, opts = {}) {
  const full = await store.getBook(book.id);
  if (!full) return;
  state.book = full;
  state.book.chapterRefs = full.chapterRefs || [];

  // 老书没有音色版本：按当前设置补一个默认版本
  const before = JSON.stringify({ r: full.renditions, a: full.activeRenditionId });
  ensureRenditions(full, voiceOfRendition(null));
  if (JSON.stringify({ r: full.renditions, a: full.activeRenditionId }) !== before) {
    await store.put('books', full).catch(() => {});
  }
  state.renditionId = full.activeRenditionId;

  renderLibrary();
  renderRenditionButton();
  renderToc();
  const targetId = opts.chapterId || full.lastChapterId || full.chapterRefs?.[0]?.id;
  if (targetId) {
    await openChapter(targetId, { chunk: opts.chunk, pause: true });
  } else {
    showEmptyReader();
  }
  await store.kvSet('lastBookId', full.id);
  renderTopbar();
}

async function openChapter(chapterId, opts = {}) {
  const chapter = await store.getChapter(chapterId);
  if (!chapter) return;
  await ensureChunks(chapter, state.settings.maxChars);
  state.chapter = chapter;
  state.chapterRows = await store.audioOfRendition(chapter.id, ridNow());
  syncChapterRef(chapter);
  renderReader();
  renderNotes();
  renderToc();
  renderTopbar();
  updateChapterButtons();

  $('#reader-scroll').scrollTop = 0;

  const startChunk = opts.chunk ?? 0;
  if (state.chapterRows.length) {
    await player.loadChapter({
      book: state.book,
      chapter,
      renditionId: ridNow(),
        audioRows: state.chapterRows,
      startChunkIndex: startChunk,
      autoplay: !!opts.autoplay,
    });
  } else {
    player.clear();
    updateNowPlayingEmpty();
  }
  if (state.book) {
    state.book.lastChapterId = chapter.id;
    store.put('books', state.book).catch(() => {});
  }
  updateChapterButtons();

  // 诗体书仍是逐行分块时，主动问一次是否改成整句
  if (chapter.staleChunks && !chapter.stalePrompted && !opts.autoplay) {
    setTimeout(() => { promptStaleChunks(chapter).catch(() => {}); }, 700);
  }
}

function playChapter(fromChunk = 0) {
  if (!state.chapter) return;
  if (!state.chapterRows.length) {
    toast('本章还没有音频，先点「生成语音」');
    return;
  }
  if (player.chapter?.id === state.chapter.id) {
    player.goToChunk(state.chapter.chunks[fromChunk] ? fromChunk : 0, true);
  } else {
    player.loadChapter({ book: state.book, chapter: state.chapter, audioRows: state.chapterRows, renditionId: ridNow(), startChunkIndex: fromChunk, autoplay: true });
  }
}

/** 确保播放器已装载当前章节（生成完成后再点播放时用） */
async function togglePlayback() {
  if (!state.chapter) { toast('请先选择章节'); return; }
  if (!state.chapterRows.length) { toast('本章还没有音频，先点「生成语音」'); return; }
  if (player.chapter?.id !== state.chapter.id) {
    await player.loadChapter({
      book: state.book,
      chapter: state.chapter,
      renditionId: ridNow(),
        audioRows: state.chapterRows,
      startChunkIndex: player.chapter?.id === state.chapter.id ? (player.currentTrack?.i ?? 0) : 0,
      autoplay: true,
    });
    return;
  }
  player.toggle();
  if (player.currentTrack) highlightChunk(player.currentTrack.i);
}

async function goNextChapter(play = true) {
  if (!state.book) return;
  const refs = state.book.chapterRefs || [];
  const idx = refs.findIndex((r) => r.id === state.chapter?.id);
  if (idx < 0 || idx + 1 >= refs.length) {
    toast('已经是最后一章');
    return;
  }
  await openChapter(refs[idx + 1].id, { autoplay: play });
}

async function goPrevChapter(play = true) {
  if (!state.book) return;
  const refs = state.book.chapterRefs || [];
  const idx = refs.findIndex((r) => r.id === state.chapter?.id);
  if (idx <= 0) { toast('已经是第一章'); return; }
  await openChapter(refs[idx - 1].id, { autoplay: play });
}

/* ------------------------------------------------------------------ */
/* 顶栏 & 播放器 UI                                                     */
/* ------------------------------------------------------------------ */

function renderTopbar() {
  $('#top-title').textContent = state.book?.title || '未打开书籍';
  const rendition = activeRendition(state.book);
  const sub = state.chapter
    ? `第 ${state.chapter.index + 1} 章 · ${state.chapter.title} · 音色：${rendition ? rendition.name : profileName(state.settings.profileId)}`
    : (state.book ? '选择左侧章节开始' : '导入一本 txt 或 epub 开始');
  $('#top-sub').textContent = sub;
}

function updateChapterButtons() {
  const has = !!state.chapter;
  // 生成中不再禁用，而是变成「加入队列」
  const genBtn = $('#btn-generate-chapter');
  if (genBtn) {
    genBtn.disabled = !has;
    genBtn.title = state.generating ? '生成中：点击把本章加入队列' : '生成当前章节的语音书';
  }
  const label = $('#gen-btn-label');
  if (label) label.textContent = state.generating ? '加入队列' : '生成本章';
  $('#btn-export-chapter').disabled = !has || !state.chapterRows.length;
  const btn = $('#btn-rendition');
  if (btn) btn.disabled = !state.book;
}

function updateNowPlayingEmpty() {
  $('#pb-title').textContent = '未在播放';
  $('#pb-sub').textContent = state.chapter ? '本章还没有音频' : '选择章节后点击播放';
  $('#pb-cover').textContent = (state.book?.title || '书').trim().slice(0, 1);
  $('#pb-time').textContent = '0:00 / 0:00';
  $('#pb-slider').value = '0';
  $('#pb-slider').disabled = true;
}

function updateNowPlaying() {
  const track = player.currentTrack;
  if (!track || !state.chapter) { updateNowPlayingEmpty(); return; }
  $('#pb-title').textContent = state.chapter.title;
  $('#pb-sub').textContent = `${state.book?.title || ''} · ${track.text.slice(0, 48)}${track.text.length > 48 ? '…' : ''}`;
  $('#pb-cover').textContent = (state.book?.title || '书').trim().slice(0, 1);
  $('#pb-slider').disabled = false;
}

let lastTimeUi = 0;
function updateTimeUI() {
  const now = performance.now();
  const dur = player.duration || 0;
  const cur = player.currentTime || 0;
  if (now - lastTimeUi < 120) return;
  lastTimeUi = now;
  const slider = $('#pb-slider');
  if (document.activeElement !== slider) {
    slider.value = dur ? String(Math.round((cur / dur) * 1000)) : '0';
  }
  $('#pb-time').textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
}

function updatePlayIcon() {
  const playing = player.state === 'playing' || player.state === 'loading';
  $('#pb-play-icon').innerHTML = playing
    ? '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>'
    : '<path d="M7 4.5v15l13-7.5-13-7.5z"/>';
  $('#pb-play').title = playing ? '暂停 (空格)' : '播放 (空格)';
}

/* ------------------------------------------------------------------ */
/* 生成                                                                */
/* ------------------------------------------------------------------ */

async function generateChapter(chapter) {
  if (!canGenerate({ allowBusy: true })) return;
  await ensureChunks(chapter, state.settings.maxChars);
  await queueOrRun([{ book: state.book, chapter }], chapter.title);
}

async function generateBook() {
  if (!canGenerate({ allowBusy: true })) return;
  if (!state.book) return;

  const chapters = await store.chaptersOf(state.book.id);
  if (!chapters.length) return;
  for (const c of chapters) await ensureChunks(c, state.settings.maxChars);
  const pending = chapters.filter((c) => Generator.pendingChars(c, ridNow()) > 0);
  if (!pending.length) { toast('整本书都已生成完毕，可用「⋯ → 重新生成整本」'); return; }

  const chars = pending.reduce((a, c) => a + Generator.pendingChars(c, ridNow()), 0);
  const ok = await confirmDialog({
    title: '生成整本语音书',
    message: `将为 ${pending.length} 个章节、约 ${chars.toLocaleString()} 字生成语音。\n全部在本机 GPU 上合成，可随时暂停。开始后请保持页面打开。`,
    confirmText: '开始生成',
  });
  if (!ok) return;

  await queueOrRun(pending.map((chapter) => ({ book: state.book, chapter })), state.book.title);
}

/* ---------------- 重新生成 ---------------- */

/** 判断当前设置与某段音频的生成参数是否一致 */
function voiceKey(s = {}) {
  return [s.profileId || '', s.engine || '', s.modelSize || '', s.language || ''].join('|');
}

function chapterMismatchCount(chapter) {
  const cur = voiceOfRendition(null);
  const rid = ridNow();
  return (chapter?.chunks || []).filter((c) => {
    if (!isChunkDone(c, rid)) return false;
    const meta = chunkState(c, rid).meta;
    if (!meta) return false;
    if ((meta.profileId || '') !== (cur.profileId || '')) return true;
    if ((meta.engine || '') !== (cur.engine || '')) return true;
    if ((meta.modelSize || '') !== (cur.modelSize || '')) return true;
    const a = meta.language || 'auto';
    const b = cur.language || 'auto';
    if (a === 'auto' || b === 'auto') return false;   // 「自动检测」不参与比较
    return a !== b;
  }).length;
}

function resetChunk(chunk, rid = ridNow()) {
  if (chunk.audio) delete chunk.audio[rid];
  delete chunk.status;
  delete chunk.dur;
  delete chunk.err;
  delete chunk.genId;
  delete chunk.meta;
}

/** 重新生成本章：清空已生成音频后整章重来 */
async function regenerateChapter(chapter = state.chapter) {
  if (!canGenerate() || !chapter) return;
  await ensureChunks(chapter, state.settings.maxChars);
  const done = chapter.chunks.filter((c) => isChunkDone(c, ridNow())).length;
  if (!done) { toast('本章还没有音频，直接点「生成本章」即可'); return; }

  const stale = needsRechunk(chapter);
  const ok = await confirmDialog({
    title: '重新生成本章',
    message: stale
      ? `检测到本章是分行的诗体排版，但现有分块是「一行一段」。这次会先按整句重新分段（${chapter.chunks.length} 段 → 约 ${Math.round(chapter.chunks.length / 2.5)} 段），朗读会连贯很多。\n\n将删除本章已生成的 ${done} 段音频并用当前音色重新合成。`
      : `将删除本章已生成的 ${done} 段音频，并用当前音色（${profileName(state.settings.profileId)}）重新合成。\n已保存的阅读进度不变。`,
    confirmText: '重新生成',
    danger: true,
  });
  if (!ok) return;

  // 反正要清空音频，顺手按当前策略重排分段（诗体书会把逐行合并成整句）
  await rechunkChapter(chapter);

  state.chapterRows = [];
  syncChapterRef(chapter);
  if (state.chapter?.id === chapter.id) {
    renderReader();
    player.clear();
    updateNowPlayingEmpty();
  }
  updateChapterButtons();
  await queueOrRun([{ book: state.book, chapter }], chapter.title);
}

/** 重新生成某一段 */
async function regenerateChunk(chunkIndex) {
  const chapter = state.chapter;
  if (!canGenerate() || !chapter) return;
  const chunk = chapter.chunks[chunkIndex];
  if (!chunk) return;

  await store.deleteChunkAudio(chapter.id, ridNow(), chunkIndex);
  resetChunk(chunk, ridNow());
  await store.put('chapters', chapter);
  state.chapterRows = await store.audioOfRendition(chapter.id, ridNow());
  syncChapterRef(chapter);
  renderReader();

  if (player.currentTrack?.i === chunkIndex) {
    if (player.state === 'playing') player.pause();
  }
  updateChapterButtons();
  await runGeneration([{ book: state.book, chapter, only: new Set([chunkIndex]) }], `重生成第 ${chunkIndex + 1} 段`);
}

/** 重新生成整本 */
async function regenerateBook() {
  if (!canGenerate() || !state.book) return;
  const chapters = await store.chaptersOf(state.book.id);
  const done = chapters.reduce((a, c) => a + c.chunks.filter((x) => isChunkDone(x, ridNow())).length, 0);
  if (!done) { toast('整本书还没有音频'); return; }

  const ok = await confirmDialog({
    title: '重新生成整本',
    message: `将删除全书已生成的 ${done} 段音频（${chapters.length} 章），并用当前音色重新合成。\n这是一件耗时的事，可以随时暂停、断点续传。`,
    confirmText: '全部重新生成',
    danger: true,
  });
  if (!ok) return;

  for (const chapter of chapters) {
    // 清空音频的同时按最新策略重排分段
    await rechunkChapter(chapter);
  }
  state.chapterRows = [];
  if (state.chapter) { syncChapterRef(state.chapter); renderReader(); }
  player.clear();
  updateNowPlayingEmpty();
  updateChapterButtons();
  await runGeneration(chapters.map((chapter) => ({ book: state.book, chapter })), state.book.title);
}

/** 仅清除本章音频，不重新生成 */
async function clearChapterAudio() {
  const chapter = state.chapter;
  if (!chapter) return;
  const done = chapter.chunks.filter((c) => isChunkDone(c, ridNow())).length;
  if (!done) { toast('本章还没有音频'); return; }
  const ok = await confirmDialog({
    title: '清除本章音频',
    message: `将删除本章的 ${done} 段音频以释放本地空间，书籍文字不受影响。`,
    confirmText: '清除',
    danger: true,
  });
  if (!ok) return;
  await rechunkChapter(chapter);
  state.chapterRows = [];
  syncChapterRef(chapter);
  renderReader();
  player.clear();
  updateNowPlayingEmpty();
  updateChapterButtons();
  toast('已清除本章音频' + (chapter.verse ? '，并按整句重新分了段' : ''));
}

/** 全书重排分段（诗体书：逐行 → 整句） */
async function rechunkBook() {
  if (!state.book) return;
  if (state.generating) { toast('已有生成任务在进行中'); return; }
  const chapters = await store.chaptersOf(state.book.id);
  const targets = chapters.filter((c) => needsRechunk(c));
  if (!targets.length) { toast('全书分段已是整句合并，无需重排'); return; }

  const done = targets.reduce((a, c) => a + (c.chunks || []).filter((x) => isChunkDone(x, ridNow())).length, 0);
  const ok = await confirmDialog({
    title: '按整句重新分段',
    message: `检测到 ${targets.length} 个章节仍是「一行一段」。\n将按整句合并重排（朗读更连贯）。${done > 0 ? `\n\n注意：会删除这些章节中已生成的 ${done} 段音频。` : ''}`,
    confirmText: '开始重排',
    danger: done > 0,
  });
  if (!ok) return;

  for (const chapter of targets) await rechunkChapter(chapter);
  state.chapterRows = [];
  if (state.chapter) {
    const fresh = await store.getChapter(state.chapter.id);
    if (fresh) { state.chapter = fresh; syncChapterRef(fresh); }
    player.clear();
    updateNowPlayingEmpty();
    renderReader();
    renderNotes();
  }
  renderToc();
  updateChapterButtons();
  toast(`已重排 ${targets.length} 个章节`);
}

/** 统一的生成入口：负责状态、面板、错误处理 */
async function runGeneration(targets, title) {
  if (state.generating) { toast('已有生成任务在进行中'); return; }
  if (!generator || typeof generator.start !== 'function') {
    toast('生成模块未就绪', 'err');
    window.__showAppError?.(
      '语音生成模块未初始化',
      '页面里的 generator 对象不存在，通常意味着浏览器缓存了旧版本脚本（或模块加载失败）。点下面的按钮清除缓存后重载即可。'
    );
    return;
  }
  state.generating = true;
  updateChapterButtons();
  showGenPanel(title);
  setGenState('running');
  try {
    const rendition = activeRendition(state.book);
    const voice = voiceOfRendition(rendition);
    if (!Object.keys(state.backendProfiles || {}).length) {
      await refreshBackendProfiles();
    }
    const { list: backends, skipped, remapped } = resolveBackendsForRun();
    if (!backends.length) {
      toast(skipped.length
        ? `节点缺少可用音色，已跳过：${skipped.join('、')}`
        : '没有可用的语音服务节点，请到「设置 → 语音服务节点」勾选', 'err');
      return;
    }
    if (skipped.length) toast(`跳过无音色的节点：${skipped.join('、')}`, 'err');
    else if (remapped.length) toast(`节点音色已自动对应：${remapped.join('，')}`);
    if (backends.length > 1) toast(`并行节点 ${backends.length} 个，开始分发任务`);
    const res = await generator.start(targets, {
      ...state.settings,
      ...voice,
      renditionId: rendition?.id || ridNow(),
      backends: backends.map((b) => ({ id: b.id, label: b.label, base: b.base, url: b.url, profileId: b.profileId, profileName: b.profileName })),
    });
    if (res?.skipped) {
      $('#gen-panel').classList.add('hidden');
      toast('这些段落都已经有音频了');
    }
  } catch (err) {
    toast('生成失败：' + err.message, 'err');
  } finally {
    state.generating = false;
    updateChapterButtons();
    updateGenQueueUI();
    await refreshHealth().catch(() => {});
    // 队列里还有任务就接着做
    if (state.genQueue.length) {
      const next = state.genQueue.shift();
      setTimeout(() => {
        if (!state.generating) runGeneration(next.targets, next.title);
      }, 600);
    }
  }
}

/* ---------------- 生成队列 ---------------- */

/** 空闲就立刻跑，忙就先排队 */
async function queueOrRun(targets, title) {
  if (!targets || !targets.length) return;
  if (state.generating) {
    state.genQueue.push({ targets, title, at: Date.now() });
    updateGenQueueUI();
    toast('已加入队列：' + title + '（前面还有 ' + state.genQueue.length + ' 个任务）');
    return;
  }
  await runGeneration(targets, title);
}

function updateGenQueueUI() {
  const n = state.genQueue.length;
  const box = document.getElementById('gen-queue');
  if (box) {
    box.classList.toggle('hidden', n === 0);
    const label = box.querySelector('span');
    if (label) label.textContent = '队列中还有 ' + n + ' 个任务';
  }
  const btn = document.getElementById('gen-queue-clear');
  if (btn) btn.disabled = n === 0;
}

function clearGenQueue() {
  const n = state.genQueue.length;
  state.genQueue = [];
  updateGenQueueUI();
  if (n) toast('已清空 ' + n + ' 个排队任务');
}

/** 目录多选：只生成选中章节里还没生成的部分 */
async function generateSelectedChapters() {
  if (!state.book) return;
  const ids = [...state.tocSelected];
  if (!ids.length) { toast('先选择章节'); return; }
  if (!canGenerate({ allowBusy: true })) return;

  const chapters = await store.chaptersOf(state.book.id);
  const picked = chapters.filter((c) => ids.includes(c.id));
  for (const c of picked) await ensureChunks(c, state.settings.maxChars);

  const pending = picked.filter((c) => Generator.pendingChars(c, ridNow()) > 0);
  if (!pending.length) {
    toast('选中的章节都已经生成过了');
    return;
  }
  const skip = picked.length - pending.length;
  state.tocSelect = false;
  state.tocSelected.clear();
  renderToc();
  await queueOrRun(
    pending.map((chapter) => ({ book: state.book, chapter })),
    pending.length + ' 章' + (skip ? '（跳过 ' + skip + ' 章已生成）' : '')
  );
}

function canGenerate({ allowBusy = false } = {}) {
  if (state.generating && !allowBusy) { toast('已有生成任务在进行中'); return false; }
  if (!state.online) { toast('语音服务未连接，无法生成', 'err'); return false; }
  if (!state.settings.profileId) { toast('请先在设置里选择音色', 'err'); openSettingsModal(); return false; }
  return true;
}

let genStartedAt = 0;

function updateGenPill(text, active) {
  const pill = $('#gen-pill');
  if (!pill) return;
  const panelHidden = $('#gen-panel').classList.contains('hidden');
  const running = active === undefined ? state.generating : active;
  pill.classList.toggle('hidden', !(panelHidden && running));
  if (text) $('#gen-pill-text').textContent = text;
}

function showGenPanel(title) {
  const panel = $('#gen-panel');
  panel.classList.remove('hidden');
  updateGenPill('', false);
  genStartedAt = Date.now();
  $('#gen-title').textContent = title || '正在生成本地语音';
  $('#gen-bar-fill').style.width = '0%';
  $('#gen-progress').textContent = '0 / 0';
  $('#gen-eta').textContent = '';
  $('#gen-current').textContent = '准备中…';
  $('#gen-pause').textContent = '暂停';
  $('#gen-pause').disabled = false;
  $('#gen-stop').disabled = false;
}

function setGenState(mode) {
  const pauseBtn = $('#gen-pause');
  if (mode === 'paused') {
    pauseBtn.textContent = '继续';
    $('#gen-current').textContent = '已暂停，点击「继续」接着生成';
  } else if (mode === 'running') {
    pauseBtn.textContent = '暂停';
  } else if (mode === 'done') {
    pauseBtn.disabled = true;
    $('#gen-stop').disabled = true;
  }
}

function updateGenPanel(d) {
  const pct = d.total ? (d.done / d.total) * 100 : 0;
  $('#gen-bar-fill').style.width = `${Math.min(100, pct).toFixed(1)}%`;
  $('#gen-progress').textContent = `${d.done} / ${d.total} 段`;
  $('#gen-eta').textContent = fmtEta(d.etaMs);
  if (d.queueTotal > 1) {
    $('#gen-title').textContent = `${d.chapterTitle}（${d.queueIndex + 1}/${d.queueTotal} 章）`;
  }
  const pillText = `生成中 ${d.done}/${d.total}`;
  updateGenPill(state.genQueue.length ? pillText + ' · 队列 ' + state.genQueue.length : pillText, state.generating);
  const statusText = {
    queued: '排队中：',
    generating: '合成中：',
    loading_model: '',
    retry: '',
    done: '✓ ',
  }[d.status] || '';
  if (d.status === 'loading_model') {
    const waited = Math.round((Date.now() - genStartedAt) / 1000);
    const tip = waited > 90
      ? '（首次加载需把模型读进显存；若显存被其他程序占用会明显变慢，可在「设置 → 模型规模」改用 0.6B）'
      : '（首次约需 1–3 分钟）';
    $('#gen-current').textContent = `⏳ 正在加载语音模型…已等待 ${waited} 秒${tip}`;
  } else if (d.message) {
    $('#gen-current').textContent = statusText + d.message;
  }
}

async function onChunkDone(detail) {
  if (state.chapter?.id === detail.chapterId) {
    syncChapterRef(state.chapter);
    state.chapterRows = await store.audioOfRendition(state.chapter.id, ridNow());
    $$(`.chunk[data-i="${detail.chunkIndex}"]`).forEach((n) => n.classList.remove('pending-audio'));
    if (player.chapter?.id === state.chapter.id) await refreshPlayerTimeline();
    updateChapterButtons();
  } else {
    const ch = await store.getChapter(detail.chapterId);
    if (ch) syncChapterRef(ch);
  }
}

async function refreshPlayerTimeline() {
  if (!state.chapter || player.chapter?.id !== state.chapter.id) return;
  const rows = await store.audioOfRendition(state.chapter.id, ridNow());
  state.chapterRows = rows;
  if (!rows.length) return;
  const chunkIdx = player.currentTrack?.i ?? 0;
  const wasPlaying = player.state === 'playing';
  const pos = player.currentTime;
  await player.loadChapter({
    book: state.book,
    chapter: state.chapter,
    renditionId: ridNow(),
        audioRows: rows,
    startChunkIndex: chunkIdx,
    autoplay: wasPlaying,
  });
  await player.seek(pos);
}

/**
 * 生成用的是从数据库重新加载的章节对象，阅读器手里可能是另一份旧对象，
 * 所以生成过程中/结束后必须回读，否则界面会一直显示「未生成」。
 */
let refreshPending = false;
function scheduleActiveRefresh() {
  if (refreshPending) return;
  refreshPending = true;
  setTimeout(async () => {
    refreshPending = false;
    try { await refreshActiveChapterFromDb(); } catch { /* noop */ }
  }, 1200);
}

async function refreshActiveChapterFromDb() {
  if (!state.chapter) return;
  const fresh = await store.getChapter(state.chapter.id);
  if (!fresh) return;
  const rid = ridNow();
  const prevCount = state.chapterRows.length;
  const curIdx = player.currentTrack?.i ?? 0;
  const wasPlaying = player.state === 'playing';
  const pos = player.currentTime;

  state.chapter = fresh;
  state.chapterRows = await store.audioOfRendition(fresh.id, rid);
  renderReader();
  renderNotes();
  updateChapterButtons();
  syncChapterRef(fresh);

  if (player.currentTrack) highlightChunk(player.currentTrack.i);

  // 音轨数量变了（新段落生成好）才重载播放器，避免打断正在播放的位置
  if (player.chapter?.id === fresh.id && state.chapterRows.length !== prevCount) {
    await player.loadChapter({
      book: state.book,
      chapter: fresh,
      audioRows: state.chapterRows,
      renditionId: rid,
      startChunkIndex: curIdx,
      autoplay: wasPlaying,
    });
    if (pos > 0) await player.seek(pos);
  }
}

/** 重新统计全书每章的已配音进度（目录圆点、书库百分比） */
async function refreshAllChapterRefs() {
  if (!state.book) return;
  const rid = ridNow();
  const chapters = await store.chaptersOf(state.book.id);
  const refs = state.book.chapterRefs || [];
  let genChars = 0;
  for (const ch of chapters) {
    const ref = refs.find((r) => r.id === ch.id);
    const done = chapterDoneCount(ch, rid);
    const total = ch.chunks.length;
    if (ref) { ref.done = done; ref.total = total; }
    genChars += ch.chunks.reduce((a, c) => a + (isChunkDone(c, rid) ? c.text.length : 0), 0);
  }
  state.book.generatedChars = genChars;
  await store.put('books', state.book).catch(() => {});
  renderLibrary();
  renderToc();
}

async function onGenFinish(detail) {
  setGenState('done');
  $('#gen-title').textContent = detail.stopped ? '已停止生成' : detail.paused ? '已暂停' : '生成完成';
  if (detail.paused) setGenState('paused');
  if (detail.done && !detail.warnings?.length) toast('语音生成完成 ✓', 'ok');
  if (detail.warnings?.length) toast(`完成，但有 ${detail.warnings.length} 段失败（可再次点击生成重试）`, 'err');
  if (state.chapter) {
    await refreshActiveChapterFromDb();
    await refreshAllChapterRefs();
    updateChapterButtons();
    if (player.chapter?.id === state.chapter.id) await refreshPlayerTimeline();
    else if (state.chapterRows.length) {
      await player.loadChapter({
        book: state.book,
        chapter: state.chapter,
        renditionId: ridNow(),
        audioRows: state.chapterRows,
        startChunkIndex: 0,
        autoplay: false,
      });
    }
    highlightChunk(player.currentTrack?.i ?? 0);
  }
  setTimeout(() => {
    if (!state.generating) $('#gen-panel').classList.add('hidden');
  }, 6000);
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

async function importParsed(parsed, meta = {}) {
  if (!parsed.chapters?.length) throw new Error('没有解析出章节');
  const bookId = newId('bk');
  const maxChars = state.settings.maxChars;
  const now = Date.now();

  const chapterRecords = parsed.chapters
    .map((c) => {
      const raw = c.blocks.filter((b) => b.type === 'br' || (b.text && b.text.trim()));
      const { blocks, notes } = extractNotes(raw);
      const verse = looksLikeVerse(blocks);
      const chunks = chunkBlocks(blocks, maxChars, { merge: verse });
      return {
        title: (c.title || '').trim(),
        part: (c.part || '').trim(),
        blocks,
        notes,
        verse,
        chunks,
        schema: CHAPTER_SCHEMA,
        chunkAlgo: CHUNK_ALGO,
        chunkChars: maxChars,
        chars: blocks.filter((b) => b.type === 'p').reduce((a, b) => a + b.text.length, 0),
      };
    })
    // 先过滤掉没有正文的页，再统一编号，避免目录里出现空号
    .filter((c) => c.blocks.some((b) => b.type === 'p'))
    .map((c, i) => ({
      ...c,
      id: `${bookId}_c${i}`,
      bookId,
      index: i,
      title: c.title || `第 ${i + 1} 节`,
      doneCount: 0,
      updatedAt: now,
    }));

  const totalChars = chapterRecords.reduce((a, c) => a + c.chars, 0);
  const defaultRendition = {
    id: `${bookId}_r0`,
    name: '默认音色',
    ...voiceOfRendition(null),
    createdAt: now,
  };
  const book = {
    id: bookId,
    renditions: [defaultRendition],
    activeRenditionId: defaultRendition.id,
    title: parsed.title || meta.title || '未命名书籍',
    author: parsed.author || meta.author || '',
    format: parsed.format || 'txt',
    fileName: parsed.fileName || '',
    createdAt: now,
    updatedAt: now,
    totalChars,
    generatedChars: 0,
    chapterRefs: chapterRecords.map((c) => ({ id: c.id, title: c.title, part: c.part, index: c.index, chars: c.chars, total: c.chunks.length, done: 0 })),
    lastChapterId: chapterRecords[0]?.id || null,
  };

  await store.put('books', book);
  for (const c of chapterRecords) await store.put('chapters', c);

  state.books = [book, ...state.books];
  renderLibrary();
  await openBook(book);
  toast(`已导入《${book.title}》，共 ${book.chapterRefs.length} 章`, 'ok');
}

function openImportModal() {
  const fileInput = el('input', { type: 'file', accept: '.txt,.md,.markdown,.epub,.text', style: 'display:none' });
  const titleInput = el('input', { class: 'input', placeholder: '书名（可留空自动识别）' });
  const textArea = el('textarea', { class: 'textarea', placeholder: '把书的内容粘贴到这里…\n\n支持「第X章」这类标题自动分章；没有标题时会按字数自动切分。' });
  const status = el('div', { class: 'hint' }, '');

  const tabFile = el('button', { class: 'btn primary' }, '选择文件');
  const tabPaste = el('button', { class: 'btn' }, '粘贴文本');

  const filePane = el('div', { class: 'field' },
    el('div', {
      class: 'dropzone',
      onclick: () => fileInput.click(),
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('dragover'); },
      ondragleave: (e) => e.currentTarget.classList.remove('dragover'),
      ondrop: (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('dragover');
        const f = e.dataTransfer?.files?.[0];
        if (f) doFile(f);
      },
    },
      el('strong', {}, '点击选择，或把文件拖到这里'),
      el('span', {}, '支持 .txt / .md / .epub（EPUB 自动读取书脊顺序）')
    ),
    fileInput,
    status
  );

  const pastePane = el('div', { class: 'field hidden' },
    el('label', {}, '书名'),
    titleInput,
    el('label', {}, '正文'),
    textArea,
    status.cloneNode(true)
  );

  const switchTab = (which) => {
    const isFile = which === 'file';
    tabFile.className = isFile ? 'btn primary' : 'btn';
    tabPaste.className = isFile ? 'btn' : 'btn primary';
    filePane.classList.toggle('hidden', !isFile);
    pastePane.classList.toggle('hidden', isFile);
  };
  tabFile.onclick = () => switchTab('file');
  tabPaste.onclick = () => switchTab('paste');

  async function doFile(file) {
    if (state.importing) return;
    state.importing = true;
    status.textContent = `正在解析 ${file.name}…`;
    try {
      const parsed = await parseFile(file);
      status.textContent = `解析完成：${parsed.chapters.length} 章，正在写入本地…`;
      await importParsed(parsed);
      modal.close();
    } catch (err) {
      status.textContent = '解析失败：' + err.message;
      toast('导入失败：' + err.message, 'err');
    } finally {
      state.importing = false;
    }
  }

  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (f) doFile(f);
  };

  const body = el('div', { class: 'modal-body' },
    el('div', { style: 'display:flex;gap:8px' }, tabFile, tabPaste),
    filePane,
    pastePane
  );

  const modal = showModal({
    title: '导入书籍',
    body,
    footer: [
      el('button', { class: 'btn', onclick: () => modal.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          if (pastePane.classList.contains('hidden')) { fileInput.click(); return; }
          const text = textArea.value.trim();
          if (!text) { status.textContent = '请先粘贴文本'; return; }
          try {
            state.importing = true;
            const parsed = parsePlainText(text, titleInput.value.trim() || '未命名书籍');
            if (titleInput.value.trim()) parsed.title = titleInput.value.trim();
            await importParsed(parsed);
            modal.close();
          } catch (err) {
            status.textContent = '解析失败：' + err.message;
          } finally {
            state.importing = false;
          }
        },
      }, '导入'),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 设置面板                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 设置里的「语音服务节点」                                            */
/* ------------------------------------------------------------------ */

function renderBackendsEditor() {
  const wrap = el('div', { class: 'backend-list' });
  const urlInput = el('input', { class: 'input', placeholder: 'http://192.168.18.33:17493', style: 'flex:1;min-width:0' });

  const repaint = () => {
    wrap.innerHTML = '';
    const enabled = (state.settings.backends = state.settings.backends || {});
    if (!state.backends.length) {
      wrap.append(el('div', { class: 'hint' }, '没有获取到节点配置（/backends 不可用）'));
    }
    for (const b of state.backends) {
      const on = enabled[b.id] !== false;
      const info = nodeProfileFor(b.id);
      const profSelect = el('select', {
        class: 'select mini-select',
        title: '这台机器上使用哪个音色',
        onchange: (e) => {
          state.settings.nodeProfiles = state.settings.nodeProfiles || {};
          state.settings.nodeProfiles[b.id] = e.target.value;
          saveSettings();
          repaint();
        },
      },
        ...(info.profs.length
          ? info.profs.map((p) => el('option', { value: p.id, selected: info.prof?.id === p.id }, p.name))
          : [el('option', { value: '' }, '（无音色）')])
      );

      const row = el('div', { class: 'backend-item' + (b.online ? '' : ' offline') },
        el('label', { class: 'b-check' },
          el('input', {
            type: 'checkbox',
            checked: on,
            onchange: (e) => {
              enabled[b.id] = e.target.checked;
              saveSettings();
              renderRenditionButton();
            },
          }),
          el('span', { class: 'b-label' }, b.label)
        ),
        el('span', { class: 'b-url' }, b.url),
        el('span', { class: `chip ${b.online ? 'ok' : 'bad'}` }, b.online ? `${b.ms}ms` : '离线'),
        profSelect
      );
      wrap.append(row);
    }
    const anyProfiles = Object.keys(state.backendProfiles || {}).length;
    wrap.append(el('div', { class: 'hint' },
      anyProfiles
        ? '每台机器有自己的音色库（同名不同 ID），上面列出的是该节点上实际可用的音色，已自动对应同名音色'
        : '正在读取各节点的音色…'));

    const addBtn = el('button', {
      class: 'btn sm',
      onclick: async () => {
        const url = urlInput.value.trim().replace(/\/+$/, '');
        if (!/^https?:\/\//.test(url)) { toast('请填写 http:// 或 https:// 开头的地址', 'err'); return; }
        if (state.backends.some((b) => b.url === url)) { toast('这个节点已经存在'); return; }
        const next = [...state.backends.map((b) => ({ id: b.id, label: b.label, url: b.url })), { id: `n${Date.now().toString(36)}`, label: `节点 ${url.replace(/^https?:\/\//, '')}`, url }];
        try {
          const saved = await saveBackends(next);
          state.backends = saved.map((b) => ({ ...b, online: null }));
          urlInput.value = '';
          await refreshBackends();
          repaint();
          toast('已添加节点');
        } catch (err) {
          toast('添加失败：' + err.message, 'err');
        }
      },
    }, '添加');

    const refreshBtn = el('button', {
      class: 'btn sm',
      onclick: async () => {
        refreshBtn.textContent = '检测中…';
        await refreshBackends();
        repaint();
        toast('节点状态已刷新');
      },
    }, '重新检测');

    wrap.append(el('div', { class: 'backend-add' }, urlInput, addBtn, refreshBtn));
  };

  repaint();
  return wrap;
}

function openSettingsModal() {
  const profileOptions = state.profiles.length
    ? state.profiles.map((p) => el('option', { value: p.id, selected: p.id === state.settings.profileId }, `${p.name}${p.language ? ' · ' + p.language : ''}`))
    : [el('option', { value: '' }, '（语音服务未连接）')];

  const engineOptions = ENGINES.map((e) => el('option', { value: e.id, selected: e.id === state.settings.engine }, e.label));
  const sizeOptions = (ENGINES.find((e) => e.id === state.settings.engine)?.sizes || ['1.7B']).map(
    (s) => el('option', { value: s, selected: s === state.settings.modelSize }, s));
  const langOptions = LANGUAGES.map(([v, label]) => el('option', { value: v, selected: v === state.settings.language }, v === 'auto' ? '自动检测' : label));

  const engineSelect = el('select', { class: 'select' }, ...engineOptions);
  const sizeSelect = el('select', { class: 'select' }, ...sizeOptions);
  const profileSelect = el('select', { class: 'select' }, ...profileOptions);
  const langSelect = el('select', { class: 'select' }, ...langOptions);
  const maxCharsInput = el('input', { class: 'input', type: 'number', min: '100', max: '800', step: '10', value: String(state.settings.maxChars) });
  const instructInput = el('input', { class: 'input', value: state.settings.instruct || '', placeholder: '例如：用温柔低沉的旁白语气朗读（可留空）' });
  const fontInput = el('input', { type: 'range', min: '15', max: '26', step: '1', value: String(state.settings.fontSize) });
  const followHighlightInput = el('input', { type: 'checkbox', checked: state.settings.highlightFollow !== false });
  const autoScrollInput = el('input', { type: 'checkbox', checked: state.settings.autoScroll !== false });
  const followPosInput = el('input', { type: 'range', min: '30', max: '90', step: '5', value: String(state.settings.followPosition ?? 80), style: 'flex:1;min-width:0' });
  const followPosLabel = el('span', { class: 'hint', style: 'min-width:38px;text-align:right' }, `${state.settings.followPosition ?? 80}%`);
  followPosInput.oninput = () => { followPosLabel.textContent = `${followPosInput.value}%`; };

  // 主题：色卡选择，点选即时预览
  let pendingTheme = state.settings.theme;
  const themeGrid = el('div', { class: 'theme-grid' });
  const paintThemes = () => {
    themeGrid.innerHTML = '';
    for (const t of THEMES) {
      themeGrid.append(el('button', {
        type: 'button',
        class: 'theme-swatch' + (t.id === pendingTheme ? ' active' : ''),
        title: t.desc,
        onclick: () => {
          pendingTheme = t.id;
          document.documentElement.dataset.theme = t.id;
          paintThemes();
        },
      },
        el('span', { class: 'sw', style: `background:${t.bg};color:${t.fg}` }, 'Aa'),
        el('span', { class: 'sw-label' }, t.label)
      ));
    }
  };
  paintThemes();

  engineSelect.onchange = () => {
    const sizes = ENGINES.find((e) => e.id === engineSelect.value)?.sizes || [];
    sizeSelect.innerHTML = '';
    for (const s of sizes) sizeSelect.append(el('option', { value: s }, s));
    if (!sizes.length) sizeSelect.append(el('option', { value: '' }, '（引擎默认）'));
  };

  const usage = el('div', { class: 'hint' }, '正在统计本地占用…');
  store.estimateUsage().then((u) => {
    if (!u) { usage.textContent = ''; return; }
    usage.textContent = `本地音频与书籍已占用 ${fmtBytes(u.usage)}${u.quota ? ` / 可用 ${fmtBytes(u.quota)}` : ''}`;
  });

  let saved = false;
  const voiceBefore = voiceKey(state.settings);
  const body = el('div', { class: 'modal-body' },
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', {}, '音色（Voicebox 语音档案）'), profileSelect,
        el('div', { class: 'hint' }, state.profiles.length ? `共 ${state.profiles.length} 个音色可用` : '请先启动 Voicebox 桌面应用')),
      el('div', { class: 'field' }, el('label', {}, '朗读语言'), langSelect,
        el('div', { class: 'hint' }, '「自动检测」会按章节文本判断中/英文')),
    ),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', {}, 'TTS 引擎'), engineSelect),
      el('div', { class: 'field' }, el('label', {}, '模型规模'), sizeSelect),
    ),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', {}, '每段字数'), maxCharsInput,
        el('div', { class: 'hint' }, '段落越长越连贯，但出错时重试成本更高；建议 180–300')),
      el('div', { class: 'field' }, el('label', {}, '风格提示（可选）'), instructInput),
    ),
    el('div', { class: 'field' }, el('label', {}, '语音服务节点（可多台并行）'), renderBackendsEditor(),
      el('div', { class: 'hint' }, '勾选的节点会同时参与生成：任务按段落分发，谁空闲谁取，两台机器基本能快一倍')),
    el('div', { class: 'field' }, el('label', {}, '阅读主题'), themeGrid),
    el('div', { class: 'field' }, el('label', {}, '正文字号'), fontInput,
      el('div', { class: 'hint' }, '拖动后立即生效，保存后会记住')),
    el('div', { class: 'field' }, el('label', {}, '跟随朗读'),
      el('div', { class: 'switch-row' },
        el('label', {}, followHighlightInput, el('span', {}, '高亮当前段落')),
        el('label', {}, autoScrollInput, el('span', {}, '自动滚动跟随')),
      ),
      el('div', { class: 'range-row' },
        el('span', { class: 'hint', style: 'white-space:nowrap' }, '段落首行落在视口'),
        followPosInput,
        followPosLabel,
      ),
      el('div', { class: 'hint' }, '关掉「高亮」就只朗读、不标记；关掉「自动滚动」则完全由你自己滚动页面')),
    el('div', { class: 'hint', style: 'border-top:1px solid var(--border-soft);padding-top:12px' }, usage),
  );

  const modal = showModal({
    title: '设置',
    body,
    onClose: () => { if (!saved) applyTheme(); },
    footer: [
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!state.book) return;
          const ok = await confirmDialog({
            title: '删除本书',
            message: `将删除《${state.book.title}》及其全部已生成音频，且不可恢复。`,
            confirmText: '删除',
            danger: true,
          });
          if (!ok) return;
          await store.deleteBook(state.book.id);
          state.books = state.books.filter((b) => b.id !== state.book.id);
          state.book = null;
          state.chapter = null;
          player.clear();
          renderLibrary(); renderToc(); showEmptyReader(); renderTopbar(); updateChapterButtons();
          modal.close();
          toast('已删除');
        },
      }, '删除本书'),
      el('div', { style: 'flex:1' }),
      el('button', { class: 'btn', onclick: () => modal.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          state.settings.profileId = profileSelect.value;
          state.settings.engine = engineSelect.value;
          state.settings.modelSize = sizeSelect.value === '' ? state.settings.modelSize : sizeSelect.value;
          state.settings.language = langSelect.value;
          state.settings.maxChars = Math.max(100, Math.min(800, Number(maxCharsInput.value) || 220));
          state.settings.instruct = instructInput.value.trim();
          state.settings.theme = pendingTheme;
          state.settings.fontSize = Number(fontInput.value) || 19;
          state.settings.highlightFollow = followHighlightInput.checked;
          state.settings.autoScroll = autoScrollInput.checked;
          state.settings.followPosition = Number(followPosInput.value) || 80;
          saved = true;
          await saveSettings();
          applyTheme(); applyFontSize(); renderTopbar();
          if (state.chapter) { state.chapterRows = await store.audioOfRendition(state.chapter.id, ridNow()); renderReader(); }
          modal.close();
          toast('设置已保存', 'ok');
          if (voiceKey(state.settings) !== voiceBefore) {
            const changed = state.chapter ? chapterMismatchCount(state.chapter) : 0;
            if (changed) {
              toast(`音色/引擎已变更，本章有 ${changed} 段仍是旧参数生成，可在「⋯ → 重新生成本章」更新`, 'err');
            } else {
              toast('音色/引擎已变更，下次生成的段落会使用新设置');
            }
          }
        },
      }, '保存'),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 弹窗基础件                                                          */
/* ------------------------------------------------------------------ */

function showModal({ title, body, footer = [], wide = false, onClose }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: wide ? 'width:min(880px,100%)' : '' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKey, true);

  modal.append(
    el('div', { class: 'modal-head' },
      el('h2', {}, title),
      el('button', { class: 'btn ghost sm', onclick: close }, '✕')
    ),
    body,
    footer.length ? el('div', { class: 'modal-foot' }, ...footer) : null
  );
  backdrop.append(modal);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  return { close, modal };
}

/* ---------------- 右键菜单 ---------------- */

function closeContextMenu() {
  const menu = document.getElementById('ctx-menu');
  if (menu) {
    menu._cleanup?.();
    menu.remove();
  }
}

function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = el('div', { class: 'ctx-menu', id: 'ctx-menu' });
  for (const item of items) {
    if (item === '-') { menu.append(el('div', { class: 'ctx-sep' })); continue; }
    menu.append(el('div', {
      class: 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : ''),
      onclick: () => {
        if (item.disabled) return;
        closeContextMenu();
        item.action();
      },
    }, item.label));
  }
  menu.style.left = '-9999px';
  menu.style.top = '0px';
  document.body.append(menu);

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 10))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 10))}px`;

  const onDoc = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
  const onEsc = (e) => { if (e.key === 'Escape') closeContextMenu(); };
  setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
  document.addEventListener('keydown', onEsc, true);
  menu._cleanup = () => {
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onEsc, true);
  };
}

function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const modal = showModal({
      title,
      body: el('div', { class: 'modal-body' }, el('p', { style: 'margin:0;line-height:1.8;white-space:pre-wrap' }, message)),
      footer: [
        el('button', { class: 'btn', onclick: () => { modal.close(); resolve(false); } }, '取消'),
        el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { modal.close(); resolve(true); } }, confirmText),
      ],
    });
  });
}

function openHelpModal() {
  const rows = [
    ['空格', '播放 / 暂停'],
    ['← / →', '后退 / 前进 15 秒（Shift 为 60 秒）'],
    ['↑ / ↓', '上一章 / 下一章'],
    ['J / L', '后退 / 前进 30 秒'],
    ['+ / -', '加速 / 减速（0.25 步进）'],
    ['Shift + R', '重新生成当前章节'],
    ['右键段落', '单独重生成 / 清除音频'],
    ['Esc', '关闭弹窗'],
  ];
  showModal({
    title: '快捷键与说明',
    body: el('div', { class: 'modal-body' },
      el('div', { class: 'hint' },
        '所有语音都由本机 Voicebox 模型合成，音频保存到浏览器 IndexedDB：一次生成，永久离线可听。' +
        '导出的 WAV 可以直接拷走，或用任意播放器转成 MP3。'),
      el('div', { class: 'hint' },
        '脚注：正文中的 [1] 这类序号不会朗读出来，而是显示为可点击的角标；点角标右侧注释栏会定位到对应条目，点注释条目则会跳回正文位置。' +
        '史诗、诗歌这类一行一行的排版会自动合并成整句朗读，避免「一行一停」的碎读感。'),
      el('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:8px 18px;font-size:12.5px' },
        ...rows.flatMap(([k, v]) => [el('kbd', { style: 'background:var(--bg-elev-2);padding:2px 7px;border-radius:5px;border:1px solid var(--border);justify-self:start' }, k), el('span', { class: 'muted' }, v)])
      ),
      el('div', { class: 'hint' },
        '离线能力：Service Worker 缓存了界面本身，已生成的音频存在本地数据库，' +
        '所以断网、以及关掉 Voicebox 之后，已配音的章节依然可以朗读播放并继续跟读高亮。'),
      el('div', { class: 'hint', style: 'font-family:ui-monospace,monospace;opacity:.7' },
        `前端版本 ${APP_VERSION}｜界面提示异常时多半缓存了旧版本，按 Ctrl+Shift+R 强制刷新`)
    ),
    footer: [el('button', { class: 'btn primary', onclick: () => $$('.modal-backdrop').forEach((n) => n.remove()) }, '知道了')],
  });
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

async function exportCurrentChapter() {
  if (!state.chapter || !state.chapterRows.length) { toast('本章还没有音频'); return; }
  const btn = $('#btn-export-chapter');
  btn.disabled = true;
  const original = btn.textContent;
  try {
    btn.textContent = '导出中…';
    const rows = await store.audioOfRendition(state.chapter.id, ridNow());
    const blob = await exportChapterWav(rows, {
      onProgress: (i, n) => { btn.textContent = `${Math.round((i / n) * 100)}%`; },
    });
    const name = `${safeFilename(state.book?.title)}-${String(state.chapter.index + 1).padStart(3, '0')}-${safeFilename(state.chapter.title)}.wav`;
    downloadBlob(blob, name);
    toast(`已导出 ${fmtBytes(blob.size)} 的 WAV`, 'ok');
  } catch (err) {
    toast('导出失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ------------------------------------------------------------------ */
/* 定时停止                                                            */
/* ------------------------------------------------------------------ */

function cycleSleepTimer() {
  const options = [0, 15, 30, 45, 60];
  const cur = state.settings.sleepMinutes || 0;
  const next = options[(options.indexOf(cur) + 1) % options.length];
  state.settings.sleepMinutes = next;
  saveSettings();
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
  const btn = $('#pb-sleep');
  if (!next) {
    btn.style.color = '';
    btn.title = '定时停止';
    toast('已关闭定时停止');
    return;
  }
  btn.style.color = 'var(--accent)';
  btn.title = `${next} 分钟后停止`;
  sleepTimer = setTimeout(() => {
    player.pause();
    toast(`定时停止：${next} 分钟到，已暂停播放`);
    state.settings.sleepMinutes = 0;
    saveSettings();
    btn.style.color = '';
    btn.title = '定时停止';
    sleepTimer = null;
  }, next * 60 * 1000);
  toast(`将在 ${next} 分钟后自动停止播放`);
}

/* ------------------------------------------------------------------ */
/* 全局交互                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 语音服务节点（多后端并行）                                          */
/* ------------------------------------------------------------------ */

async function refreshBackends() {
  const enabled = state.settings.backends || {};
  try {
    const list = await fetchBackends();
    const checked = await Promise.all(list.map(async (b) => {
      const t0 = performance.now();
      try {
        const res = await fetch(`${b.base}/health`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        const h = await res.json();
        return { ...b, online: res.ok, health: h, ms: Math.round(performance.now() - t0) };
      } catch {
        return { ...b, online: false, health: null, ms: null };
      }
    }));
    state.backends = checked;
    for (const b of checked) if (enabled[b.id] === undefined) enabled[b.id] = true;
    state.settings.backends = enabled;
  } catch (err) {
    console.warn('[backends] 刷新失败', err);
    state.backends = [];
  }
  renderRenditionButton();
  return state.backends;
}

/**
 * 每台机器都有自己的音色库：同一个声音在不同机器上的 profile id 不一样。
 * 这里按「id → 同名 → 用户指定 → 该节点第一个」的顺序解析，
 * 解析不出来（该节点没有任何音色）就把节点跳过。
 */
async function refreshBackendProfiles() {
  const map = {};
  await Promise.all(state.backends.map(async (b) => {
    try {
      const res = await fetch(`${b.base}/profiles`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      map[b.id] = res.ok ? await res.json() : [];
    } catch {
      map[b.id] = [];
    }
  }));
  state.backendProfiles = map;
  return map;
}

/** 某台机器上应该用哪个音色（设置面板与生成都用它） */
function nodeProfileFor(backendId) {
  const rendition = activeRendition(state.book);
  const wantId = rendition?.profileId || state.settings.profileId;
  const wantName = (state.profiles.find((p) => p.id === wantId) || {}).name || '';
  const profs = state.backendProfiles?.[backendId] || [];
  const overrides = state.settings.nodeProfiles || {};
  let prof = overrides[backendId] ? (profs.find((p) => p.id === overrides[backendId]) || null) : null;
  let matched = prof ? 'manual' : '';
  if (!prof) { prof = profs.find((p) => p.id === wantId) || null; if (prof) matched = 'id'; }
  if (!prof && wantName) { prof = profs.find((p) => p.name === wantName) || null; if (prof) matched = 'name'; }
  if (!prof && profs.length) { prof = profs[0]; matched = 'fallback'; }
  return { prof, matched, profs, wantId, wantName };
}

function resolveBackendsForRun() {
  const rendition = activeRendition(state.book);
  const wantId = rendition?.profileId || state.settings.profileId;
  const list = [];
  const skipped = [];
  const remapped = [];

  for (const b of activeBackends()) {
    const info = nodeProfileFor(b.id);
    if (!info.prof) { skipped.push(b.label); continue; }
    if (info.prof.id !== wantId) remapped.push(`${b.label} → 「${info.prof.name}」`);
    list.push({ ...b, profileId: info.prof.id, profileName: info.prof.name });
  }
  return { list, skipped, remapped };
}

/** 当前音色版本 */
async function switchRendition(rid) {
  if (!state.book) return;
  if (!renditionById(state.book, rid)) return;
  state.book.activeRenditionId = rid;
  state.renditionId = rid;
  await store.put('books', state.book).catch(() => {});
  renderRenditionButton();
  renderTopbar();
  renderToc();
  if (state.chapter) await openChapter(state.chapter.id, { pause: true });
}

function openRenditionMenu(x, y) {
  if (!state.book) return;
  const renditions = state.book.renditions || [];
  const items = renditions.map((r) => ({
    label: `${r.id === state.book.activeRenditionId ? '✓ ' : '　'}${r.name}　(${profileShort(r.profileId)})`,
    action: () => switchRendition(r.id),
  }));
  items.push('-');
  items.push({ label: '＋ 新建音色版本…', action: () => openRenditionDialog() });
  if (renditions.length > 1) {
    items.push({ label: '删除当前版本…', danger: true, action: () => deleteRendition() });
  }
  showContextMenu(x, y, items);
}

function profileShort(id) {
  const p = state.profiles.find((x) => x.id === id);
  return p ? p.name : (id ? '未知音色' : '未指定');
}

/** 新建音色版本 */
function openRenditionDialog() {
  const nameInput = el('input', { class: 'input', value: `版本 ${(state.book.renditions || []).length + 1}` });
  const profileSelect = el('select', { class: 'select' },
    ...(state.profiles.length
      ? state.profiles.map((p) => el('option', { value: p.id, selected: p.id === state.settings.profileId }, `${p.name}${p.language ? ' · ' + p.language : ''}`))
      : [el('option', { value: '' }, '（语音服务未连接）')]));
  const engineSelect = el('select', { class: 'select' },
    ...ENGINES.map((e) => el('option', { value: e.id, selected: e.id === state.settings.engine }, e.label)));
  const sizeSelect = el('select', { class: 'select' },
    ...((ENGINES.find((e) => e.id === state.settings.engine)?.sizes) || ['1.7B']).map((s) => el('option', { value: s, selected: s === state.settings.modelSize }, s)));
  const langSelect = el('select', { class: 'select' },
    ...LANGUAGES.map(([v, label]) => el('option', { value: v, selected: v === state.settings.language }, v === 'auto' ? '自动检测' : label)));

  engineSelect.onchange = () => {
    const sizes = ENGINES.find((e) => e.id === engineSelect.value)?.sizes || [];
    sizeSelect.innerHTML = '';
    for (const s of sizes) sizeSelect.append(el('option', { value: s }, s));
    if (!sizes.length) sizeSelect.append(el('option', { value: '' }, '（引擎默认）'));
  };

  const modal = showModal({
    title: '新建音色版本',
    body: el('div', { class: 'modal-body' },
      el('div', { class: 'field' }, el('label', {}, '版本名称'),
        nameInput,
        el('div', { class: 'hint' }, '同一本书可以保存多个音色版本，各自保留一份音频，随时切换对比')),
      el('div', { class: 'row' },
        el('div', { class: 'field' }, el('label', {}, '音色'), profileSelect),
        el('div', { class: 'field' }, el('label', {}, '朗读语言'), langSelect),
      ),
      el('div', { class: 'row' },
        el('div', { class: 'field' }, el('label', {}, 'TTS 引擎'), engineSelect),
        el('div', { class: 'field' }, el('label', {}, '模型规模'), sizeSelect),
      ),
    ),
    footer: [
      el('button', { class: 'btn', onclick: () => modal.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          const name = nameInput.value.trim() || `版本 ${(state.book.renditions || []).length + 1}`;
          const rid = `${state.book.id}_r${Date.now().toString(36)}`;
          state.book.renditions = state.book.renditions || [];
          state.book.renditions.push({
            id: rid,
            name,
            profileId: profileSelect.value,
            engine: engineSelect.value,
            modelSize: sizeSelect.value || state.settings.modelSize,
            language: langSelect.value,
            createdAt: Date.now(),
          });
          await store.put('books', state.book).catch(() => {});
          modal.close();
          await switchRendition(rid);
          toast(`已创建音色版本「${name}」，可以开始生成了`, 'ok');
        },
      }, '创建'),
    ],
  });
}

async function deleteRendition() {
  const book = state.book;
  if (!book || (book.renditions || []).length <= 1) { toast('至少要保留一个音色版本'); return; }
  const rid = book.activeRenditionId;
  const target = renditionById(book, rid);
  const ok = await confirmDialog({
    title: '删除音色版本',
    message: `将删除「${target?.name || rid}」这个版本，以及它已生成的全部音频。\n其他版本不受影响。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;

  const chapters = await store.chaptersOf(book.id);
  for (const ch of chapters) {
    await store.deleteChapterAudio(ch.id, rid).catch(() => {});
    let changed = false;
    for (const c of ch.chunks || []) {
      if (c.audio && c.audio[rid]) { delete c.audio[rid]; changed = true; }
    }
    if (changed) await store.put('chapters', ch).catch(() => {});
  }

  book.renditions = book.renditions.filter((r) => r.id !== rid);
  book.activeRenditionId = book.renditions[0].id;
  await store.put('books', book).catch(() => {});
  state.renditionId = book.activeRenditionId;
  renderRenditionButton();
  if (state.chapter) await openChapter(state.chapter.id, { pause: true });
  toast('已删除该音色版本');
}

function renderRenditionButton() {
  const btn = $('#btn-rendition');
  if (!btn) return;
  const r = activeRendition(state.book);
  btn.disabled = !state.book;
  const label = btn.querySelector('span');
  if (label) label.textContent = r ? r.name : '音色';
  else btn.textContent = r ? `音色 · ${r.name}` : '音色';
  btn.title = r
    ? `当前音色版本：${r.name}（点击切换 / 新建）`
    : '选择音色版本';
}


function wireGlobal() {
  // 兜底：HTML 与脚本版本不一致时，缺失的元素用占位节点代替，避免整段事件绑定中断
  const q = (sel) => $(sel) || document.createElement('div');
  q('#btn-import').onclick = openImportModal;
  q('#btn-settings').onclick = async () => { await loadProfiles(); openSettingsModal(); };
  q('#btn-help').onclick = openHelpModal;
  q('#btn-generate-chapter').onclick = () => generateChapter(state.chapter);
  q('#btn-export-chapter').onclick = exportCurrentChapter;
  q('#btn-rendition').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openRenditionMenu(Math.min(r.left, window.innerWidth - 260), r.bottom + 6);
  };
  q('#btn-notes').onclick = toggleNotes;
  q('#notes-close').onclick = () => setNotesOpen(false);
  q('#btn-more').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const hasChapter = !!state.chapter;
    showContextMenu(Math.max(8, r.right - 210), r.bottom + 6, [
      { label: '生成本章 / 补齐', disabled: !hasChapter, action: () => generateChapter(state.chapter) },
      { label: '重新生成本章', disabled: !hasChapter, action: () => regenerateChapter(state.chapter) },
      '-',
      { label: '生成整本 / 补齐', disabled: !state.book, action: () => generateBook() },
      { label: '重新生成整本', disabled: !state.book, action: () => regenerateBook() },
      '-',
      { label: '全书按整句重新分段', disabled: !state.book, action: () => rechunkBook() },
      { label: '清除本章音频', danger: true, disabled: !hasChapter, action: () => clearChapterAudio() },
    ]);
  };

  $$('.side-tab').forEach((tab) => {
    tab.onclick = () => {
      $$('.side-tab').forEach((t) => t.classList.toggle('active', t === tab));
      const isLib = tab.dataset.tab === 'library';
      q('#pane-library').classList.toggle('hidden', !isLib);
      q('#pane-toc').classList.toggle('hidden', isLib);
      if (!isLib) renderToc();
    };
  });

  q('#pb-play').onclick = () => { togglePlayback(); };
  q('#pb-back').onclick = () => player.skip(-15);
  q('#pb-forward').onclick = () => player.skip(15);
  q('#pb-prev-chapter').onclick = () => goPrevChapter(player.state === 'playing');
  q('#pb-next-chapter').onclick = () => goNextChapter(player.state === 'playing');
  q('#pb-speed').onchange = (e) => {
    const rate = Number(e.target.value) || 1;
    player.setRate(rate);
    state.settings.rate = rate;
    saveSettings();
  };
  q('#pb-sleep').onclick = cycleSleepTimer;
  q('#pb-autonext').onclick = () => {
    state.settings.autoNext = !state.settings.autoNext;
    saveSettings();
    const btn = q('#pb-autonext');
    btn.style.color = state.settings.autoNext ? 'var(--accent)' : '';
    btn.title = state.settings.autoNext ? '自动播放下一章（开启）' : '自动播放下一章（关闭）';
    toast(state.settings.autoNext ? '已开启自动连播' : '已关闭自动连播');
  };

  const slider = q('#pb-slider');
  slider.addEventListener('input', () => {
    const dur = player.duration || 0;
    const t = (Number(slider.value) / 1000) * dur;
    q('#pb-time').textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
  });
  slider.addEventListener('change', () => {
    const dur = player.duration || 0;
    player.seek((Number(slider.value) / 1000) * dur);
  });

  q('#gen-pause').onclick = () => {
    if (generator.paused) {
      generator.paused = false;
      setGenState('running');
      if (!generator.running) {
        // 已经停在章节边界：用剩余队列重新启动
        const remaining = generator.queue
          .slice(generator.index)
          .filter((t) => Generator.pendingChars(t.chapter) > 0);
        if (remaining.length) {
          state.generating = true;
          generator.start(remaining, state.settings)
            .catch((err) => toast('恢复生成失败：' + err.message, 'err'))
            .finally(() => { state.generating = false; updateChapterButtons(); });
        }
      }
    } else {
      generator.pause();
      setGenState('paused');
      toast('将在当前段落完成后暂停');
    }
  };
  q('#gen-stop').onclick = () => {
    generator.stop();
    clearGenQueue();
    setGenState('done');
    toast('正在停止…');
  };
  q('#gen-queue-clear').onclick = () => clearGenQueue();
  q('#gen-collapse').onclick = () => { q('#gen-panel').classList.add('hidden'); updateGenPill(); };
  q('#gen-pill').onclick = () => { q('#gen-panel').classList.remove('hidden'); updateGenPill('', false); };

  /* 播放器事件 */
  player.addEventListener('track', (e) => {
    highlightChunk(e.detail.track.i);
    updateNowPlaying();
    updateTimeUI();
    saveProgress();
  });
  player.addEventListener('time', updateTimeUI);
  player.addEventListener('state', () => { updatePlayIcon(); });
  player.addEventListener('chapterend', async () => {
    if (state.settings.autoNext) await goNextChapter(true);
    else toast('本章播放完毕');
  });
  player.addEventListener('chapterempty', () => toast('本章还没有可播放的音频'));
  player.addEventListener('error', (e) => toast(e.detail.message, 'err'));
  player.addEventListener('timeline', updateTimeUI);

  /* 生成器事件 */
  generator.addEventListener('progress', (e) => { updateGenPanel(e.detail); scheduleActiveRefresh(); });
  generator.addEventListener('chunkDone', (e) => { scheduleActiveRefresh(); onChunkDone(e.detail).catch(() => {}); });
  generator.addEventListener('chunkError', (e) => toast(`第 ${e.detail.chunkIndex + 1} 段失败：${e.detail.message}`, 'err'));
  generator.addEventListener('finish', (e) => onGenFinish(e.detail).catch(() => {}));

  /* 键盘 */
  document.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target?.isContentEditable) return;
    if ($('.modal-backdrop')) return;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlayback(); break;
      case 'ArrowLeft': e.preventDefault(); player.skip(e.shiftKey ? -60 : -15); break;
      case 'ArrowRight': e.preventDefault(); player.skip(e.shiftKey ? 60 : 15); break;
      case 'ArrowUp': e.preventDefault(); goPrevChapter(player.state === 'playing'); break;
      case 'ArrowDown': e.preventDefault(); goNextChapter(player.state === 'playing'); break;
      case 'j': case 'J': player.skip(-30); break;
      case 'l': case 'L': player.skip(30); break;
      case 'R': e.preventDefault(); regenerateChapter(); break;
      case '+': case '=': {
        const rates = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
        const next = rates[Math.min(rates.length - 1, rates.indexOf(state.settings.rate) + 1)] || 1.25;
        state.settings.rate = next; player.setRate(next); q('#pb-speed').value = String(next); saveSettings();
        break;
      }
      case '-': case '_': {
        const rates = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
        const idx = Math.max(0, rates.indexOf(state.settings.rate) - 1);
        const next = rates[idx];
        state.settings.rate = next; player.setRate(next); q('#pb-speed').value = String(next); saveSettings();
        break;
      }
      default: break;
    }
  });

  window.addEventListener('beforeunload', () => { saveProgress(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
}

let saveProgressTimer = null;
function saveProgress() {
  clearTimeout(saveProgressTimer);
  saveProgressTimer = setTimeout(async () => {
    if (!state.book || !state.chapter || !player.currentTrack) return;
    state.book.lastChapterId = state.chapter.id;
    state.book.lastChunk = player.currentTrack.i;
    state.book.lastTime = player.currentTime;
    state.book.updatedAt = Date.now();
    await store.put('books', state.book).catch(() => {});
  }, 700);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  window.__APP_BOOTED__ = true;
  // 申请持久化存储，避免浏览器在空间紧张时回收已生成的音频
  navigator.storage?.persist?.().catch(() => {});
  const saved = await store.kvGet('settings', null);
  if (saved) Object.assign(state.settings, saved);
  applyTheme();
  applyFontSize();
  $('#pb-speed').value = String(state.settings.rate || 1);
  player.setRate(state.settings.rate || 1);
  $('#pb-autonext').style.color = state.settings.autoNext ? 'var(--accent)' : '';

  state.books = await store.listBooks();
  renderLibrary();
  renderToc();
  showEmptyReader();
  renderTopbar();
  updateNowPlayingEmpty();
  updateChapterButtons();
  wireGlobal();

  // 先连服务：即使后面恢复进度出错，状态栏也不会一直停在「检测中」
  await refreshBackends().catch(() => {});
  await refreshHealth({ silent: true }).catch(() => {});
  loadProfiles().catch(() => {});
  setTimeout(() => { refreshBackendProfiles().catch(() => {}); }, 800);

  // 恢复上次阅读位置：任何异常都不能阻断启动
  try {
    await restoreLastSession();
  } catch (err) {
    console.warn('[boot] 恢复上次进度失败', err);
    toast('上次的阅读进度恢复失败，已从书库重新打开');
    try {
      const first = state.books[0];
      if (first && !state.book) await openBook(first);
    } catch { /* noop */ }
  }
  renderTopbar();

  setInterval(() => refreshHealth({ silent: true }), 60000);
}

/** 恢复上次打开的书与朗读位置（无音频、书已删除等情况都要能安全跳过） */
async function restoreLastSession() {
  const lastBookId = await store.kvGet('lastBookId', null);
  if (!lastBookId) return;
  const book = state.books.find((b) => b.id === lastBookId);
  if (!book) return;

  await openBook(book, { chunk: Number(book.lastChunk) || 0 });

  const time = Number(book.lastTime);
  if (Number.isFinite(time) && time > 0 && player.tracks.length) {
    await player.seek(time);
  }
}

boot().catch((err) => {
  console.error(err);
  toast('启动失败：' + err.message, 'err');
  window.__showAppError__?.('启动失败：' + err.message, err?.stack || '');
});
