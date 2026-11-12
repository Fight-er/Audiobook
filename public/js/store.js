/**
 * IndexedDB 持久层
 *
 * books     { id, title, author, cover, createdAt, updatedAt, chapterRefs:[{id,title,index,chars}],
 *             lastChapterId, lastChunk, totalChars, generatedChars }
 * chapters  { id, bookId, index, title, blocks:[{type,text}], chunks:[{b,text,head,dur,status,genId,err}],
 *             chars, doneCount, updatedAt }
 * audio     { key:`${chapterId}:${chunkIndex}`, chapterId, bookId, blob, mime, dur, size, createdAt }
 * kv        { k, v }
 */

const DB_NAME = 'audiobook-reader';
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chapters')) {
        const s = db.createObjectStore('chapters', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('audio')) {
        const s = db.createObjectStore('audio', { keyPath: 'key' });
        s.createIndex('chapterId', 'chapterId');
        s.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wait(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function txStore(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export const store = {
  async put(table, value) {
    const s = await txStore(table, 'readwrite');
    return wait(s.put(value));
  },
  async get(table, key) {
    const s = await txStore(table);
    return wait(s.get(key));
  },
  async del(table, key) {
    const s = await txStore(table, 'readwrite');
    return wait(s.delete(key));
  },
  async allKeys(table) {
    const st = await txStore(table);
    return wait(st.getAllKeys());
  },
  async all(table) {
    const s = await txStore(table);
    return wait(s.getAll());
  },
  async allBy(table, index, key) {
    const s = await txStore(table);
    return wait(s.index(index).getAll(key));
  },
  async countBy(table, index, key) {
    const s = await txStore(table);
    return wait(s.index(index).count(key));
  },

  /* ---- 便捷封装 ---- */
  async listBooks() {
    const books = await this.all('books');
    return books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  async getBook(id) { return this.get('books', id); },
  async getChapter(id) { return this.get('chapters', id); },
  async chaptersOf(bookId) {
    const list = await this.allBy('chapters', 'bookId', bookId);
    return list.sort((a, b) => a.index - b.index);
  },
  async audioOf(chapterId) {
    return this.allBy('audio', 'chapterId', chapterId);
  },
  /** 某个音色版本下的音频（key = `${renditionId}:${chapterId}:${index}`） */
  async audioOfRendition(chapterId, renditionId) {
    const rows = await this.audioOf(chapterId);
    return rows.filter((r) => r.renditionId === renditionId);
  },
  async audioKey(renditionId, chapterId, i) {
    return this.get('audio', `${renditionId}:${chapterId}:${i}`);
  },
  async putAudio(renditionId, chapterId, bookId, i, blob, dur) {
    return this.put('audio', {
      key: `${renditionId}:${chapterId}:${i}`,
      renditionId,
      chapterId,
      bookId,
      index: i,
      blob,
      mime: blob.type || 'audio/wav',
      dur: dur || 0,
      size: blob.size,
      createdAt: Date.now(),
    });
  },
  /**
   * 老数据（key 为 `${chapterId}:${index}`、没有 renditionId）归到默认音色版本名下。
   * 只搬这本书这一章的几条，代价很小。
   */
  async adoptLegacyAudio(chapterId, renditionId) {
    if (!renditionId) return 0;
    const rows = await this.audioOf(chapterId);
    const legacy = rows.filter((r) => !r.renditionId);
    if (!legacy.length) return 0;
    const db = await openDB();
    const tx = db.transaction('audio', 'readwrite');
    const s = tx.objectStore('audio');
    for (const r of legacy) {
      const i = Number(String(r.key).split(':').pop()) || 0;
      s.delete(r.key);
      s.put({
        ...r,
        key: `${renditionId}:${chapterId}:${i}`,
        renditionId,
        chapterId,
        index: i,
      });
    }
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    return legacy.length;
  },
  async kvGet(k, fallback = null) {
    const row = await this.get('kv', k);
    return row ? row.v : fallback;
  },
  async kvSet(k, v) { return this.put('kv', { k, v }); },

  async deleteChapterAudio(chapterId, renditionId = null) {
    const rows = (await this.audioOf(chapterId))
      .filter((r) => !renditionId || r.renditionId === renditionId);
    if (!rows.length) return 0;
    const db = await openDB();
    const tx = db.transaction('audio', 'readwrite');
    const s = tx.objectStore('audio');
    for (const r of rows) s.delete(r.key);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    return rows.length;
  },

  async deleteChunkAudio(chapterId, renditionId, index) {
    return this.del('audio', `${renditionId}:${chapterId}:${index}`);
  },

  async deleteBook(bookId) {
    const chapters = await this.chaptersOf(bookId);
    const db = await openDB();
    const tx = db.transaction(['books', 'chapters', 'audio'], 'readwrite');
    tx.objectStore('books').delete(bookId);
    for (const c of chapters) {
      tx.objectStore('chapters').delete(c.id);
      const idx = tx.objectStore('audio').index('chapterId');
      const cur = idx.openKeyCursor(IDBKeyRange.only(c.id));
      cur.onsuccess = () => {
        const cursor = cur.result;
        if (cursor) { tx.objectStore('audio').delete(cursor.primaryKey); cursor.continue(); }
      };
    }
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  },

  async estimateUsage() {
    if (!navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  },
};

export function newId(prefix = '') {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...rand].map((b) => b.toString(16).padStart(2, '0')).join('');
  return prefix + Date.now().toString(36) + '-' + hex;
}
