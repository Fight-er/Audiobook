/**
 * 数据模型辅助：书籍的「音色版本（rendition）」与每段音频的状态
 *
 * 一段文字可以有多个音色版本，每个版本各自持有一份音频：
 *   book.renditions = [{ id, name, profileId, engine, modelSize, language, createdAt }]
 *   book.activeRenditionId
 *   chunk.audio = { [renditionId]: { status, dur, meta } }
 */

export const DEFAULT_RENDITION_NAME = '默认音色';

/** 确保书籍至少有一个音色版本（老数据自动补一个默认版本） */
export function ensureRenditions(book, defaults = {}) {
  if (!Array.isArray(book.renditions) || !book.renditions.length) {
    const rid = `${book.id}_r0`;
    book.renditions = [{
      id: rid,
      name: DEFAULT_RENDITION_NAME,
      profileId: defaults.profileId || '',
      engine: defaults.engine || 'qwen',
      modelSize: defaults.modelSize || '1.7B',
      language: defaults.language || 'auto',
      createdAt: Date.now(),
    }];
    book.activeRenditionId = rid;
  }
  if (!book.activeRenditionId || !book.renditions.some((r) => r.id === book.activeRenditionId)) {
    book.activeRenditionId = book.renditions[0].id;
  }
  return book.renditions;
}

export function renditionById(book, id) {
  return (book?.renditions || []).find((r) => r.id === id) || null;
}

/** 书籍的「默认音色」版本：老数据（没有版本概念的音频）都归到它名下 */
export function defaultRenditionId(book) {
  if (!book) return null;
  return (book.renditions || [])[0]?.id || book.activeRenditionId || null;
}

export function activeRendition(book) {
  if (!book) return null;
  return renditionById(book, book.activeRenditionId) || (book.renditions || [])[0] || null;
}

/** 取某一段在指定版本下的状态 */
export function chunkState(chunk, renditionId) {
  const entry = chunk?.audio?.[renditionId];
  if (!entry) return { status: 'pending' };
  return entry;
}

export function isChunkDone(chunk, renditionId) {
  return chunkState(chunk, renditionId).status === 'done';
}

/** 写入某一段在某版本下的状态 */
export function markChunk(chunk, renditionId, patch) {
  if (!chunk.audio) chunk.audio = {};
  chunk.audio[renditionId] = { ...(chunk.audio[renditionId] || {}), ...patch };
  return chunk.audio[renditionId];
}

export function clearChunk(chunk, renditionId) {
  if (chunk.audio) delete chunk.audio[renditionId];
}

export function chapterDoneCount(chapter, renditionId) {
  return (chapter.chunks || []).filter((c) => isChunkDone(c, renditionId)).length;
}

/**
 * 老数据迁移：把 chunk.status/dur/meta 搬进 chunk.audio[默认版本]
 * @returns {boolean} 是否有改动
 */
export function migrateChunkStates(chapter, renditionId) {
  if (!renditionId) return false;
  let changed = false;
  for (const c of chapter.chunks || []) {
    if (c.status !== undefined || c.dur !== undefined || c.meta !== undefined) {
      if (!c.audio) c.audio = {};
      if (!c.audio[renditionId]) {
        c.audio[renditionId] = {
          status: c.status || 'pending',
          ...(c.dur !== undefined ? { dur: c.dur } : {}),
          ...(c.meta ? { meta: c.meta } : {}),
        };
      }
      delete c.status;
      delete c.dur;
      delete c.meta;
      delete c.genId;
      delete c.err;
      changed = true;
    }
  }
  return changed;
}

/** 某个版本的音色标识，用于判断「这段音频是不是当前音色生成的」 */
export function voiceKeyOf(source = {}) {
  return [source.profileId || '', source.engine || '', source.modelSize || '', source.language || ''].join('|');
}
