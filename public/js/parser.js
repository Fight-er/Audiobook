/**
 * 文本解析：纯文本 / EPUB / Markdown  ->  { title, author, chapters[] }
 * 每个 chapter = { title, blocks: [{ type:'h'|'p', text }] }
 *
 * 无任何第三方依赖：EPUB 用内置 DecompressionStream('deflate-raw') 解压。
 */

const HEADING_PATTERNS = [
  /^(第[〇零一二三四五六七八九十百千万0-9]{1,12}[章节回卷篇部集幕话])/,
  /^(Chapter|CHAPTER|Part|PART)\s+[\dIVXLCivxlc]+/,
  /^(序章|序言|自序|前言|引言|楔子|开篇|引子|尾声|后记|终章|结局|番外|附录|后记|致谢|译者序)/,
  /^(Prologue|Epilogue|Introduction|Preface|Afterword)\b/i,
  /^[\s]*[〇零一二三四五六七八九十百]{1,4}[、.．]\s*\S/,
];

const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', '"', "'", '…', '》', '】']);
const TERMINATORS = new Set(['。', '！', '？', '!', '?', '…', '；', ';', '.']);
const SOFT_BREAKS = new Set(['，', '、', ',', '：', ':', '—', ' ']);

import { readZipEntries, readZipEntry } from './zip.js';

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

export function cjkRatio(text) {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) || []).length;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const total = cjk + letters;
  return total ? cjk / total : 0;
}

export function detectLanguage(text) {
  const ratio = cjkRatio(text.slice(0, 4000));
  return ratio > 0.35 ? 'zh' : 'en';
}

/** 统一换行、去 BOM / 零宽字符、压缩多余空行 */
export function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isHeadingLine(line) {
  const t = line.trim();
  if (!t || t.length > 48) return false;
  if (/[。，、；！？:：]$/.test(t)) return false;
  return HEADING_PATTERNS.some((re) => re.test(t));
}

/**
 * 判断段落风格：
 *  - 'blank'  以空行分段（英文书 / 排版规范的中文书）
 *  - 'line'   每一行即一段（中文网络小说 txt 常见）
 */
function detectParagraphStyle(text) {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim()).length;
  const blanks = lines.filter((l) => !l.trim()).length;
  if (nonEmpty === 0) return 'blank';
  // 空行占比高 => 空行分段
  return blanks / nonEmpty > 0.28 ? 'blank' : 'line';
}

function joinWrappedLines(lines) {
  const joined = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (!joined.length) { joined.push(t); continue; }
    const prev = joined[joined.length - 1];
    // 中文之间的软换行直接拼接，西文补空格
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]$/.test(prev) || /^[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(t)) {
      joined[joined.length - 1] = prev + t;
    } else if (/-$/.test(prev)) {
      joined[joined.length - 1] = prev.slice(0, -1) + t;
    } else {
      joined[joined.length - 1] = prev + ' ' + t;
    }
  }
  return joined;
}

/** 把章节正文拆成块（段落 / 小标题） */
export function toBlocks(text, style = detectParagraphStyle(text)) {
  const blocks = [];
  if (style === 'blank') {
    const groups = text.split(/\n\s*\n/);
    for (const g of groups) {
      const lines = g.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      const head = lines[0].trim();
      if (lines.length === 1 && isHeadingLine(head)) { blocks.push({ type: 'h', text: head }); continue; }
      if (isHeadingLine(head) && lines.length > 1) {
        blocks.push({ type: 'h', text: head });
        for (const p of joinWrappedLines(lines.slice(1))) blocks.push({ type: 'p', text: p });
        continue;
      }
      for (const p of joinWrappedLines(lines)) blocks.push({ type: 'p', text: p });
    }
  } else {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) {
        // 空行 = 诗节分隔
        if (blocks.length && blocks[blocks.length - 1].type !== 'br') blocks.push({ type: 'br', text: '' });
        continue;
      }
      blocks.push({ type: isHeadingLine(t) ? 'h' : 'p', text: t });
    }
  }
  return blocks;
}

const CHAPTER_LABEL = ['第%d章', '第%d节', '第%d部分'];

/** 把整本书拆成章节 */
export function splitChapters(normalized, opts = {}) {
  const targetChars = opts.targetChars || 5200;
  const lines = normalized.split('\n');
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t && isHeadingLine(t)) headings.push({ line: i, title: t });
  }

  const chapters = [];
  const pushChapter = (title, bodyLines) => {
    const body = bodyLines.join('\n').trim();
    if (!body) return;
    if (body.replace(/\s/g, '').length < 2) return;
    chapters.push({ title: title || '未命名', blocks: toBlocks(body) });
  };

  if (headings.length >= 2) {
    const firstLine = headings[0].line;
    const preface = lines.slice(0, firstLine).join('\n').trim();
    if (preface.replace(/\s/g, '').length > 40) pushChapter('前言', lines.slice(0, firstLine));
    for (let h = 0; h < headings.length; h++) {
      const start = headings[h].line + 1;
      const end = h + 1 < headings.length ? headings[h + 1].line : lines.length;
      pushChapter(headings[h].title, lines.slice(start, end));
    }
  }

  if (!chapters.length) {
    // 无标题：按字数切分
    const blocks = toBlocks(normalized);
    let buf = [];
    let chars = 0;
    let n = 0;
    const flush = () => {
      if (!buf.length) return;
      n += 1;
      chapters.push({ title: CHAPTER_LABEL[Math.min(n - 1, 2)]?.replace('%d', n) || `第${n}节`, blocks: buf });
      buf = [];
      chars = 0;
    };
    for (const b of blocks) {
      buf.push(b);
      chars += b.text.length;
      if (chars >= targetChars && b.type === 'p') flush();
    }
    flush();
  }

  return chapters.map((c, i) => ({ ...c, index: i }));
}

/**
 * 单句拆分（保留原文位置，便于脚注标记与分块对齐）
 * 中文按句末标点，英文按 . ! ? 且后接空白
 * @returns {{from:number, to:number}[]}
 */
export function sentenceRanges(text) {
  const out = [];
  let start = 0;
  const push = (from, to) => {
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (to > from) out.push({ from, to });
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!TERMINATORS.has(ch)) continue;

    if (ch === '.') {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (prev && /\d/.test(prev) && next && /\d/.test(next)) continue;  // 3.14 里的点
      if (next && !/[\s"'”’）)]/.test(next)) continue;                    // 缩写 / 网址 / 文件名
    }
    // 吸收紧随的收尾符号（引号、括号、省略号）
    let j = i + 1;
    while (j < text.length && CLOSERS.has(text[j])) j++;
    push(start, j);
    start = j;
    i = j - 1;
  }
  push(start, text.length);
  return out;
}

export function splitSentences(text) {
  return sentenceRanges(text).map((r) => text.slice(r.from, r.to));
}

/** 该段文字是否以句末标点收尾 */
export function endsSentence(text) {
  return /[。．.！？!?…；;]["'”’」』）)]*$/.test(String(text).trim());
}

function needsSpace(prevChunk, nextPiece) {
  const a = prevChunk[prevChunk.length - 1] || '';
  const b = nextPiece[0] || '';
  const cjk = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  return !cjk.test(a) && !cjk.test(b);
}

/**
 * 把章节 blocks 切成朗读块。
 *
 * 每个块记录它所覆盖的原文片段 segs（块号 + 字符区间），因此：
 *  - 散文：一段 = 一块（过长才按句切）
 *  - 诗歌/分行排版（merge=true）：跨行合并成「整句」朗读，避免一行一句的生硬停顿
 * 返回 [{ b0, b1, segs, text, head?, notes? }]
 */
const SENTENCE_END_CHARS = new Set(['。', '！', '？', '!', '?', '…', '；', ';', '.']);
const SOFT_BREAK_CHARS = new Set(['，', '、', ',', '：', ':', '—', '～', '~']);

function isAsciiWord(ch) {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

/**
 * 在 [start, start+limit] 内找一个「像样的断点」：
 *   1) 句末标点（。！？…；; 以及英文句点）→ 最靠后的那个
 *   2) 逗号 / 顿号 / 分号之外的软断点（，、：— 等）
 *   3) 任意空白
 *   4) 英文单词中间则回退到上一个空白
 *   5) 都不行才硬切在 limit 处
 * @returns {number} 切点（字符下标，切割区间为 [start, cut)）
 */
function findBreakPoint(text, start, limit, minTarget) {
  const hardEnd = Math.min(start + limit, text.length);
  if (hardEnd >= text.length) return text.length;

  const minEnd = Math.min(hardEnd, start + Math.max(1, minTarget));

  // 1) 句末
  for (let i = hardEnd - 1; i >= minEnd; i--) {
    const ch = text[i];
    if (!SENTENCE_END_CHARS.has(ch)) continue;
    if (ch === '.') {
      const prev = text[i - 1] || '';
      const next = text[i + 1] || '';
      if (isAsciiWord(next)) continue;              // 3.14 / example.com
      if (isAsciiWord(prev) && !next) { /* 句末的缩写，允许 */ }
    }
    let j = i + 1;
    while (j < hardEnd && CLOSERS.has(text[j])) j++;
    if (j > start + 1) return j;
  }

  // 2) 软断点（至少保留 55% 的上限，避免切出太碎的块）
  const softMin = Math.max(start + 6, start + Math.floor(limit * 0.55));
  for (let i = hardEnd - 1; i >= softMin; i--) {
    if (SOFT_BREAK_CHARS.has(text[i])) return i + 1;
  }

  // 3) 空白
  for (let i = hardEnd - 1; i >= softMin; i--) {
    if (/\s/.test(text[i])) return i;
  }

  // 4) 卡在英文单词中间：回退到上一个空白
  if (isAsciiWord(text[hardEnd - 1]) && isAsciiWord(text[hardEnd] || '')) {
    for (let i = hardEnd - 1; i >= start + 10; i--) {
      if (/\s/.test(text[i])) return i;
    }
  }

  // 5) 兜底：硬切
  return hardEnd;
}

/** 把流里的 [start,end) 映射成 blocks 上的片段 */
function segsForRange(parts, start, end) {
  const segs = [];
  for (const p of parts) {
    const s = Math.max(start, p.start);
    const e = Math.min(end, p.end);
    if (e <= s) continue;
    segs.push({ b: p.b, from: p.from + (s - p.start), to: p.from + (e - p.start) });
  }
  return segs;
}

function notesOfSegs(blocks, segs) {
  const notes = [];
  for (const seg of segs) {
    const marks = blocks[seg.b].marks;
    if (!marks) continue;
    for (const m of marks) if (m.at >= seg.from && m.at <= seg.to) notes.push(m.n);
  }
  return notes.length ? [...new Set(notes)] : null;
}

/** 散文：一段一块；超长段落按断句点切 */
function paragraphChunks(blocks, limit) {
  const chunks = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'br' || block.type === 'note') continue;
    if (block.type === 'h') {
      chunks.push({ b0: i, b1: i, segs: [{ b: i, from: 0, to: block.text.length }], text: block.text, head: true });
      continue;
    }
    if (!block.text) continue;

    const text = block.text;
    if (text.length <= limit) {
      const segs = [{ b: i, from: 0, to: text.length }];
      const chunk = { b0: i, b1: i, segs, text: text.trim() };
      const notes = notesOfSegs(blocks, segs);
      if (notes) chunk.notes = notes;
      chunks.push(chunk);
      continue;
    }

    let pos = 0;
    const minTarget = Math.floor(limit * 0.55);
    while (pos < text.length) {
      let start = pos;
      while (start < text.length && /\s/.test(text[start])) start++;
      if (start >= text.length) break;
      const end = findBreakPoint(text, start, limit, minTarget);
      const piece = text.slice(start, end).trim();
      if (piece) {
        const segs = [{ b: i, from: start, to: end }];
        const chunk = { b0: i, b1: i, segs, text: piece };
        const notes = notesOfSegs(blocks, segs);
        if (notes) chunk.notes = notes;
        chunks.push(chunk);
      }
      pos = end > start ? end : start + 1;
    }
  }
  return chunks;
}

/**
 * 诗体/分行排版：把每个诗节拼成一条文字流，
 * 到上限时回退到最近的断句点（句末 → 逗号/冒号 → 空白），不会把词组切开。
 */
function mergeChunks(blocks, limit, minTarget) {
  const chunks = [];

  const emitStanza = (idxs) => {
    if (!idxs.length) return;
    const parts = [];
    let text = '';
    for (const bi of idxs) {
      const t = blocks[bi].text;
      if (!t) continue;
      if (text && needsSpace(text, t)) text += ' ';
      const start = text.length;
      text += t;
      parts.push({ b: bi, start, end: text.length, from: 0, to: t.length });
    }
    if (!text.trim()) return;

    let pos = 0;
    while (pos < text.length) {
      let start = pos;
      while (start < text.length && /\s/.test(text[start])) start++;
      if (start >= text.length) break;
      const end = findBreakPoint(text, start, limit, minTarget);
      const piece = text.slice(start, end).trim();
      if (piece) {
        const segs = segsForRange(parts, start, end);
        if (segs.length) {
          const chunk = { b0: segs[0].b, b1: segs[segs.length - 1].b, segs, text: piece };
          const notes = notesOfSegs(blocks, segs);
          if (notes) chunk.notes = notes;
          chunks.push(chunk);
        }
      }
      pos = end > start ? end : start + 1;
    }
  };

  let stanza = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'h') {
      emitStanza(stanza);
      stanza = [];
      chunks.push({ b0: i, b1: i, segs: [{ b: i, from: 0, to: block.text.length }], text: block.text, head: true });
      continue;
    }
    if (block.type === 'br' || block.type === 'note' || !block.text) {
      emitStanza(stanza);
      stanza = [];
      continue;
    }
    stanza.push(i);
  }
  emitStanza(stanza);
  return chunks;
}

/**
 * 把章节 blocks 切成朗读块。
 *
 * 每个块记录它覆盖的原文片段 segs（块号 + 字符区间），因此：
 *  - 散文：一段 = 一块（过长才按断句点切）
 *  - 诗歌/分行排版（merge=true）：跨行合并成整句朗读；
 *    到达字数上限时回退到最近的逗号/分号/句号，避免把词组从中间切开
 * 返回 [{ b0, b1, segs, text, head?, notes? }]
 */
export function chunkBlocks(blocks, maxChars = 220, opts = {}) {
  const limit = Math.max(60, Math.min(2000, maxChars | 0));
  const merge = typeof opts === 'boolean' ? !!opts : !!opts.merge;
  const minTarget = Math.min(limit, opts.minTarget || (merge ? 110 : Math.floor(limit * 0.55)));
  return merge ? mergeChunks(blocks, limit, minTarget) : paragraphChunks(blocks, limit);
}

/* ------------------------------------------------------------------ */
/* 脚注                                                                */
/* ------------------------------------------------------------------ */

const CIRCLED_RANGES = [[0x2460, 0x2473], [0x3251, 0x325f]]; // ①..⑳, ㉑..㉟

/** 圈号 → 数字（① → 1） */
function circledValue(ch) {
  const code = ch.codePointAt(0);
  let offset = 0;
  for (const [from, to] of CIRCLED_RANGES) {
    if (code >= from && code <= to) return code - from + 1 + offset;
    offset += to - from + 1;
  }
  return 0;
}

/** 扫出正文里的注释引用（[12] / ［12］ / ① / ⑫ …） */
function scanNoteRefs(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[' || ch === '［') {
      const m = /^[\[［]\s*(\d{1,4})\s*[\]］]/.exec(text.slice(i));
      if (m) {
        out.push({ n: Number(m[1]), at: i, len: m[0].length });
        i += m[0].length - 1;
        continue;
      }
    }
    const cv = circledValue(ch);
    if (cv) out.push({ n: cv, at: i, len: 1 });
  }
  return out;
}

const NOTE_DEF_RE = /^\s*(?:[\[［]\s*(\d{1,4})\s*[\]］]|([①-⑳㉑-㉟]))\s*([\s\S]+)$/;

/** 朗读前去掉残留的脚注序号 */
export function stripForSpeech(text) {
  return String(text ?? '')
    .replace(/[\[［]\s*\d{1,4}\s*[\]］]/g, '')
    .replace(/[①-⑳㉑-㉟]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 从 blocks 中抽取脚注：
 *  - 行内 [12] 之类的引用标记变成 marks（供 UI 显示为可点击角标）
 *  - 以 [12] 开头的段落视为脚注正文，移出正文
 * @returns {{ blocks: object[], notes: {n:number,text:string}[] }}
 */
export function extractNotes(blocks, opts = {}) {
  const keepPlaceholders = !!opts.keepPlaceholders;

  // 有些排版把整组注释挤在一段里（换行被合并），这里先按注释序号拆开
  const flat = [];
  const DEF_START = /^\s*(?:[\[［]\s*\d{1,4}\s*[\]］]|[①-⑳㉑-㉟])/;
  for (const b of blocks) {
    if (b.type === 'p' && DEF_START.test(b.text)) {
      const parts = b.text
        .split(/(?=[\[［]\s*\d{1,4}\s*[\]］])|(?=[①-⑳㉑-㉟])/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 1 && parts.length <= 60 && parts.every((p) => DEF_START.test(p))) {
        for (const p of parts) flat.push({ ...b, text: p });
        continue;
      }
    }
    flat.push(b);
  }

  const defs = [];
  flat.forEach((b, i) => {
    if (b.type !== 'p') return;
    const m = b.text.match(NOTE_DEF_RE);
    if (!m) return;
    const body = m[3].trim();
    if (body.length < 2) return;
    const n = m[1] ? Number(m[1]) : circledValue(m[2]);
    if (!n) return;
    defs.push({ i, n, text: body });
  });

  const noteBlocks = new Set();
  if (defs.length >= 2) defs.forEach((d) => noteBlocks.add(d.i));
  else if (defs.length === 1 && defs[0].i >= blocks.length - 2) noteBlocks.add(defs[0].i);

  const notes = [];
  const out = [];
  flat.forEach((b, i) => {
    if (noteBlocks.has(i)) {
      const d = defs.find((x) => x.i === i);
      if (d) notes.push({ n: d.n, text: d.text });
      if (keepPlaceholders) out.push({ type: 'note', text: '' });
      return;
    }
    if (b.type !== 'p') { out.push(b); return; }

    const text = b.text;
    let clean = '';
    let last = 0;
    const marks = [];
    for (const ref of scanNoteRefs(text)) {
      clean += text.slice(last, ref.at);
      marks.push({ n: ref.n, at: clean.length });
      last = ref.at + ref.len;
    }
    clean += text.slice(last);

    const nb = { type: b.type, text: clean };
    if (marks.length) nb.marks = marks;
    out.push(nb);
  });

  notes.sort((a, b) => a.n - b.n);
  const seen = new Set();
  const uniq = [];
  for (const n of notes) {
    if (seen.has(n.n)) continue;
    seen.add(n.n);
    uniq.push(n);
  }
  return { blocks: out, notes: uniq };
}

/**
 * 判断章节是否为「分行排版」（史诗、诗歌、分行译文）
 * 特征：段落多而短、多数行不以句末标点结尾
 */
/* 行末行号："……车子， 245" / "……他说　250" */
const LINE_NO_RE = /[ \t\u00a0\u3000]+(\d{1,4})$/;

/**
 * 去掉诗行末尾的行号标注。
 * 只看单个数字容易误伤正文（"他数到 20"），所以要求：
 *   - 至少 3 处
 *   - 编号的步长有稳定的众数（通常每 5 行标一次）
 * 命中的数字会记到 block.lineNo 上，方便以后需要时显示。
 */
export function stripLineNumbers(blocks) {
  const hits = [];
  blocks.forEach((b, i) => {
    if (b.type !== 'p') return;
    const m = b.text.match(LINE_NO_RE);
    if (!m) return;
    const n = Number(m[1]);
    if (!n || n > 9999) return;
    hits.push({ i, n, cut: m[0].length });
  });
  if (hits.length < 3) return { blocks, removed: 0 };

  const deltas = [];
  for (let k = 1; k < hits.length; k++) deltas.push(hits[k].n - hits[k - 1].n);
  const freq = new Map();
  for (const d of deltas) freq.set(d, (freq.get(d) || 0) + 1);
  let modal = 0;
  let modalCount = 0;
  for (const [d, c] of freq) {
    if (c > modalCount) { modal = d; modalCount = c; }
  }
  const steady = modal >= 1 && modal <= 20 && modalCount >= Math.max(2, Math.ceil(deltas.length * 0.6));
  if (!steady) return { blocks, removed: 0 };

  const byIndex = new Map(hits.map((h) => [h.i, h]));
  const out = blocks.map((b, i) => {
    const h = byIndex.get(i);
    if (!h) return b;
    return { ...b, text: b.text.slice(0, b.text.length - h.cut).replace(/\s+$/, ''), lineNo: h.n };
  });
  return { blocks: out, removed: hits.length };
}

export function looksLikeVerse(blocks) {
  const ps = blocks.filter((b) => b.type === 'p' && b.text.length > 2);
  if (ps.length < 10) return false;
  const lens = ps.map((b) => b.text.length).sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)];
  const shortRatio = ps.filter((b) => b.text.length <= 46).length / ps.length;
  const openEnded = ps.filter((b) => !endsSentence(b.text)).length / ps.length;
  return median <= 42 && shortRatio >= 0.7 && openEnded >= 0.45;
}

/** 从纯文本构建完整书籍对象（不含 id） */
export function parsePlainText(raw, fallbackTitle = '未命名书籍') {
  let text = normalizeText(raw);
  let title = fallbackTitle;

  // 首行若是短标题则提升为书名
  const firstLine = text.split('\n', 1)[0]?.trim() || '';
  if (firstLine && firstLine.length <= 40 && !/[。，,；;!?！？]/.test(firstLine) && !isHeadingLine(firstLine)) {
    title = firstLine;
    text = text.slice(text.indexOf('\n') + 1).trim();
  }
  if (!text) throw new Error('文本内容为空');

  const chapters = splitChapters(text);
  if (!chapters.length) throw new Error('未能解析出任何章节');
  return { title, author: '', chapters };
}

/* ------------------------------------------------------------------ */
/* EPUB                                                                */
/* ------------------------------------------------------------------ */

const textDecoder = new TextDecoder('utf-8');

function resolveHref(base, href) {
  const cleanBase = base.split('/').slice(0, -1).join('/');
  const parts = (cleanBase ? cleanBase.split('/') : []).concat(href.split('/'));
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function blocksFromDocument(doc) {
  const blocks = [];
  const ids = [];
  const push = (block, el) => {
    blocks.push(block);
    ids.push(el?.getAttribute?.('id') || el?.getAttribute?.('name') || '');
  };
  const walk = (node) => {
    for (const child of node.children) {
      const tag = child.tagName.toLowerCase();
      if (['script', 'style', 'head', 'nav', 'svg'].includes(tag)) continue;
      if (/^h[1-6]$/.test(tag)) {
        const t = child.textContent.replace(/\s+/g, ' ').trim();
        if (t) push({ type: 'h', text: t }, child);
        else walk(child);
        continue;
      }
      if (['p', 'li', 'blockquote', 'td', 'dd', 'figcaption', 'div', 'section', 'article'].includes(tag)) {
        // 容器内还有块级子元素则继续下钻
        const hasBlockChild = [...child.children].some((c) =>
          /^(p|div|section|article|ul|ol|li|h[1-6]|blockquote|table|pre)$/i.test(c.tagName)
        );
        const t = child.textContent.replace(/\s+/g, ' ').trim();
        if (!hasBlockChild) {
          if (t) push({ type: 'p', text: t }, child);
          // 只有 <br> 或空内容的段落 = 诗节/段间空行
          else if (blocks.length && blocks[blocks.length - 1].type !== 'br') push({ type: 'br', text: '' }, child);
        } else {
          if (t && tag !== 'div' && tag !== 'section' && tag !== 'article') push({ type: 'p', text: t }, child);
          walk(child);
        }
        continue;
      }
      if (child.children.length) walk(child);
      else {
        const t = child.textContent.replace(/\s+/g, ' ').trim();
        if (t) push({ type: 'p', text: t }, child);
      }
    }
  };
  walk(doc.body || doc.documentElement);
  return { blocks, ids };
}

function splitHref(base, href) {
  const [rawPath, frag] = String(href || '').split('#');
  if (!rawPath) return { path: '', fragment: frag || '' };
  return { path: resolveHref(base, rawPath), fragment: frag || '' };
}

function flattenNavPoints(nodes, base, level = 0, out = [], parent = '') {
  for (const node of nodes) {
    const tag = (node.localName || node.tagName || '').toLowerCase();
    if (tag !== 'navpoint') continue;
    const label = (node.querySelector('navLabel')?.textContent || '').replace(/\s+/g, ' ').trim();
    const src = node.querySelector('content')?.getAttribute('src') || '';
    const { path, fragment } = splitHref(base, src);
    if (label) out.push({ label, path, fragment, level, parent });
    const kids = [...node.children].filter((c) => ((c.localName || c.tagName || '').toLowerCase()) === 'navpoint');
    if (kids.length) flattenNavPoints(kids, base, level + 1, out, label || parent);
  }
  return out;
}

function parseNavDoc(doc, base) {
  const navs = [...doc.querySelectorAll('nav')];
  const toc = navs.find((n) => /toc/i.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) || navs[0];
  if (!toc) return [];
  const out = [];
  const walk = (ol, level, parent) => {
    for (const li of [...ol.children]) {
      if (((li.localName || li.tagName || '').toLowerCase()) !== 'li') continue;
      const a = [...li.children].find((c) => ((c.localName || c.tagName || '').toLowerCase()) === 'a');
      const label = (a?.textContent || '').replace(/\s+/g, ' ').trim();
      const href = a?.getAttribute('href') || '';
      const { path, fragment } = splitHref(base, href);
      if (label && path) out.push({ label, path, fragment, level, parent });
      const sub = [...li.children].find((c) => ((c.localName || c.tagName || '').toLowerCase()) === 'ol');
      if (sub) walk(sub, level + 1, label || parent);
    }
  };
  const first = toc.querySelector('ol');
  if (first) walk(first, 0, '');
  return out;
}

/** 读 EPUB 自带的目录：优先 NCX，其次 EPUB3 nav 文档 */
async function readTocEntries(zip, opfDoc, opfPath) {
  const items = [...opfDoc.querySelectorAll('manifest > item')];

  const ncxItem = items.find((i) => /dtbncx/i.test(i.getAttribute('media-type') || ''))
    || items.find((i) => /\.ncx$/i.test(i.getAttribute('href') || ''));
  if (ncxItem) {
    const ncxPath = resolveHref(opfPath, ncxItem.getAttribute('href'));
    const entry = zip.entries.get(ncxPath);
    if (entry) {
      try {
        const xml = textDecoder.decode(await readZipEntry(zip, entry));
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const navMap = doc.getElementsByTagName('navMap')[0];
        if (navMap) {
          const list = flattenNavPoints([...navMap.children], ncxPath);
          if (list.length) return list;
        }
      } catch { /* 落到 nav 文档 */ }
    }
  }

  const navItem = items.find((i) => /(^|\s)nav(\s|$)/i.test(i.getAttribute('properties') || ''));
  if (navItem) {
    const navPath = resolveHref(opfPath, navItem.getAttribute('href'));
    const entry = zip.entries.get(navPath);
    if (entry) {
      try {
        const html = textDecoder.decode(await readZipEntry(zip, entry));
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const list = parseNavDoc(doc, navPath);
        if (list.length) return list;
      } catch { /* ignore */ }
    }
  }
  return [];
}

export async function parseEpub(arrayBuffer, fallbackTitle = '未命名书籍') {
  const zip = await readZipEntries(arrayBuffer);

  const containerEntry = zip.entries.get('META-INF/container.xml');
  if (!containerEntry) throw new Error('EPUB 缺少 META-INF/container.xml');
  const containerXml = textDecoder.decode(await readZipEntry(zip, containerEntry));
  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB 中未找到 OPF 描述文件');

  const opfEntry = zip.entries.get(opfPath);
  if (!opfEntry) throw new Error('OPF 文件缺失：' + opfPath);
  const opfXml = textDecoder.decode(await readZipEntry(zip, opfEntry));
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

  const getMeta = (localName) => {
    const wanted = localName.toLowerCase();
    for (const node of opfDoc.getElementsByTagName('*')) {
      const name = (node.localName || node.tagName || '').toLowerCase();
      if (name === wanted) return (node.textContent || '').trim();
    }
    return '';
  };
  const title = getMeta('title') || fallbackTitle;
  const author = getMeta('creator');

  const manifest = new Map();
  for (const item of opfDoc.querySelectorAll('manifest > item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) manifest.set(id, { href: resolveHref(opfPath, href), mediaType: item.getAttribute('media-type') || '' });
  }

  const spineIds = [...opfDoc.querySelectorAll('spine > itemref')].map((el) => el.getAttribute('idref')).filter(Boolean);
  const docs = spineIds.length
    ? spineIds.map((id) => manifest.get(id)).filter(Boolean)
    : [...manifest.values()].filter((m) => /x?html/i.test(m.mediaType) || /\.x?html?$/i.test(m.href));

  const tocEntries = await readTocEntries(zip, opfDoc, opfPath);
  const tocByPath = new Map();
  for (const e of tocEntries) {
    if (!e.path) continue;
    if (!tocByPath.has(e.path)) tocByPath.set(e.path, []);
    tocByPath.get(e.path).push(e);
  }

  // 有些 EPUB 把「部」标题单独放一页，这些页面不该当章节
  const partLabels = new Set(tocEntries.map((e) => e.parent).filter(Boolean));

  const chapters = [];
  const pushChapter = (title, part, blocks) => {
    if (!blocks || !blocks.length) return;
    if (!blocks.some((b) => b.type === 'p' && b.text.trim().length > 1)) return;
    chapters.push({ title: (title || '').trim() || `第${chapters.length + 1}节`, part: (part || '').trim(), blocks });
  };

  for (const item of docs) {
    if (item.mediaType && !/x?html/i.test(item.mediaType)) continue;
    const entry = zip.entries.get(item.href);
    if (!entry) continue;
    let html;
    try {
      html = textDecoder.decode(await readZipEntry(zip, entry));
    } catch {
      continue;
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const raw = blocksFromDocument(doc);
    // 过滤空块，同时保持 ids 对齐
    const pairs = raw.blocks
      .map((b, i) => ({ b, id: raw.ids[i] }))
      .filter(({ b }) => b.type === 'br' || b.text.replace(/\s/g, '').length > 0);
    while (pairs.length && pairs[0].b.type === 'br') pairs.shift();
    while (pairs.length && pairs[pairs.length - 1].b.type === 'br') pairs.pop();
    if (!pairs.length) continue;

    const blocks = pairs.map((x) => x.b);
    const ids = pairs.map((x) => x.id);
    const anchorIndex = new Map();
    ids.forEach((id, i) => { if (id && !anchorIndex.has(id)) anchorIndex.set(id, i); });

    const heading = blocks.find((b) => b.type === 'h');
    const entries = (tocByPath.get(item.href) || []).filter((e) => e.label);
    const bounds = [];
    const usedIdx = new Set();
    for (const e of entries) {
      let idx = 0;
      if (e.fragment) {
        if (!anchorIndex.has(e.fragment)) continue;
        idx = anchorIndex.get(e.fragment);
      }
      if (usedIdx.has(idx)) continue;
      usedIdx.add(idx);
      bounds.push({ idx, label: e.label, part: e.parent || '' });
    }
    bounds.sort((a, b) => a.idx - b.idx);

    // 「部」标题页：只有一两段、且这个标题正是别的条目的父级
    if (!bounds.length && partLabels.has((heading?.text || '').trim()) && blocks.filter((b) => b.type === 'p').length <= 3) {
      continue;
    }

    if (!bounds.length) {
      const title = heading?.text || '';
      pushChapter(title, '', blocks);
      continue;
    }

    if (bounds[0].idx > 0) {
      const pre = blocks.slice(0, bounds[0].idx);
      pushChapter(heading?.text || '', '', pre);
    }
    for (let i = 0; i < bounds.length; i++) {
      const from = bounds[i].idx;
      const to = i + 1 < bounds.length ? bounds[i + 1].idx : blocks.length;
      const seg = blocks.slice(from, to);
      // 跳过只有标题的「部」页
      if (partLabels.has(bounds[i].label) && seg.filter((b) => b.type === 'p').length <= 3) continue;
      pushChapter(bounds[i].label, bounds[i].part, seg);
    }
  }

  if (!chapters.length) throw new Error('EPUB 中没有可读的文字内容');
  return { title, author, chapters };
}

/** 从 File 对象导入 */
export async function parseFile(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = (file.name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();

  if (ext === 'epub') {
    const buf = await file.arrayBuffer();
    const res = await parseEpub(buf, name);
    return { ...res, format: 'epub', fileName: file.name };
  }

  const raw = await readAsText(file);
  const res = parsePlainText(raw, name);
  return { ...res, format: ext === 'md' ? 'markdown' : 'txt', fileName: file.name };
}

async function readAsText(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // 尝试 UTF-8，失败则回退 GB18030
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}
