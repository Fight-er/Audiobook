/**
 * 离线有声书生成器（多后端并行）
 *
 * 「离线」= 全部在本机/局域网内的 Voicebox 上合成，不经过任何云端。
 * 生成结果以 WAV Blob 存入 IndexedDB，之后断网、关掉服务也能继续听。
 *
 * 并行策略：把章节拆成「段落任务」放进共享队列，
 * 每个可用后端开一个 worker（各自串行、互不干扰），谁空闲谁取下一个任务。
 * 这样 4060Ti 和 2060 可以同时干活，总耗时接近对半。
 */

import { createClient } from './api.js';
import { store } from './store.js';
import { stripForSpeech } from './parser.js';
import { chunkState, markChunk } from './model.js';

export class Generator extends EventTarget {
  constructor() {
    super();
    this.running = false;
    this.paused = false;
    this.stopping = false;
    this.queue = [];
    this.current = null;
    this._abort = null;
    this._session = { chars: 0, seconds: 0, startedAt: 0 };
    this.lastError = null;
    this.warnings = [];
    this.offline = new Set();
  }

  get busy() {
    return this.running;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** 还差多少字（用于「生成本章」按钮与预估） */
  static pendingChars(chapter, renditionId) {
    return (chapter?.chunks || []).reduce((a, c) => {
      if (c.head) return a;
      if (chunkState(c, renditionId).status === 'done') return a;
      return a + c.text.length;
    }, 0);
  }

  _progress(extra = {}) {
    const st = this._state;
    if (!st) return;
    const remain = this._pending.reduce((a, t) => a + (t.chapter.chunks[t.index]?.text.length || 0), 0) +
      (this.current ? (this.current.chapter.chunks[this.current.index]?.text.length || 0) : 0);
    let etaMs = null;
    if (this._session.chars > 0 && this._session.seconds > 1) {
      const cps = this._session.chars / this._session.seconds;
      if (cps > 0.1) etaMs = (remain / cps) * 1000;
    }
    this._emit('progress', {
      done: st.done,
      total: st.total,
      doneChars: st.doneChars,
      chars: st.chars,
      etaMs,
      message: '',
      status: 'working',
      perBackend: st.perBackend.map((b) => ({ id: b.id, label: b.label, done: b.done, offline: b.offline })),
      ...extra,
    });
  }

  /**
   * @param {Array<{book:object, chapter:object, only?:Set<number>}>} targets
   * @param {object} settings { renditionId, profileId, engine, modelSize, language, instruct, seed, backends }
   */
  async start(targets, settings) {
    if (this.running) throw new Error('已有生成任务在进行中');

    const rid = settings.renditionId;
    const backends = (settings.backends || []).filter((b) => b.online !== false);
    if (!backends.length) throw new Error('没有可用的语音服务节点');

    // 1. 收集任务
    const pending = [];
    let totalChars = 0;
    for (const t of targets) {
      const chunks = t.chapter.chunks || [];
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        if (c.head) continue;
        if (t.only && !t.only.has(i)) continue;
        if (chunkState(c, rid).status === 'done') continue;
        pending.push({ book: t.book, chapter: t.chapter, index: i });
        totalChars += c.text.length;
      }
    }
    if (!pending.length) return { skipped: true };

    this._pending = pending;
    this.running = true;
    this.paused = false;
    this.stopping = false;
    this.warnings = [];
    this.lastError = null;
    this.offline = new Set();
    this._abort = new AbortController();
    this._session = { chars: 0, seconds: 0, startedAt: performance.now() };
    this._state = {
      total: pending.length,
      done: 0,
      chars: totalChars,
      doneChars: 0,
      perBackend: backends.map((b) => ({ id: b.id, label: b.label, done: 0, offline: false })),
    };

    this._emit('start', { total: pending.length, backends: backends.length });
    this._progress({ status: 'started' });

    try {
      await Promise.all(backends.map((b) => this._worker(b, settings)));
    } catch (err) {
      this.lastError = err.message;
      this._emit('error', { message: err.message });
    } finally {
      const paused = this.paused;
      const stopped = this.stopping;
      this.running = false;
      this.current = null;
      this._pending = [];
      this._state = null;
      this._emit('finish', { stopped, paused, done: !paused && !stopped, warnings: this.warnings });
      this.stopping = false;
    }
    return { warnings: this.warnings };
  }

  pause() {
    if (!this.running) return;
    this.paused = true;
  }

  stop() {
    if (!this.running) return;
    this.stopping = true;
    this._abort?.abort();
  }

  /* ------------------------------------------------------------------ */

  async _worker(backend, settings) {
    for (;;) {
      if (this.stopping || this.paused) return;
      if (this.offline.has(backend.id)) return;
      const task = this._pending.shift();
      if (!task) return;
      this.current = { ...task, backendId: backend.id };

      const ok = await this._runTask(task, backend, settings);

      if (!ok && this.stopping) return;
      if (!ok) {
        // 该节点连续失败：标记离线，把它没做完的任务交回队列
        this.offline.add(backend.id);
        const st = this._state?.perBackend.find((b) => b.id === backend.id);
        if (st) st.offline = true;
        this._emit('backendDown', { id: backend.id, label: backend.label });
        if (chunkState(task.chapter.chunks[task.index], settings.renditionId).status !== 'done') {
          this._pending.push(task);
        }
        return;
      }
    }
  }

  /** @returns {Promise<boolean>} 是否成功（失败时任务已记为 error） */
  async _runTask(task, backend, settings) {
    const { book, chapter, index } = task;
    const chunk = chapter.chunks[index];
    const rid = settings.renditionId;
    const client = createClient(backend.base);
    const text = stripForSpeech(chunk.text);
    if (!text) { markChunk(chunk, rid, { status: 'skip' }); return true; }

    const language = !settings.language || settings.language === 'auto'
      ? detectLang(chapter)
      : settings.language;

    markChunk(chunk, rid, { status: 'queued', backend: backend.id });
    this._progress({ status: 'queued', message: text.slice(0, 60), backend: backend.label });

    let lastErr = '';
    const t0 = performance.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.stopping) return false;
      try {
        const payload = {
          profile_id: backend.profileId || settings.profileId,
          text,
          language,
          engine: settings.engine || 'qwen',
          model_size: settings.modelSize || '1.7B',
          max_chunk_chars: 800,
          normalize: true,
        };
        if (settings.seed !== null && settings.seed !== undefined && settings.seed !== '') payload.seed = Number(settings.seed);
        if (settings.instruct) payload.instruct = String(settings.instruct).slice(0, 500);

        const rec = await client.generate(payload);
        markChunk(chunk, rid, { status: 'generating', genId: rec.id, backend: backend.id });
        this._saveChapter(chapter);

        const res = await client.wait(rec.id, {
          signal: this._abort.signal,
          timeoutMs: 25 * 60 * 1000,
          onTick: (s) => {
            this._progress({
              status: s.status === 'loading_model' ? 'loading_model' : 'generating',
              message: s.status === 'loading_model' ? `正在加载模型（${backend.label}）…` : text.slice(0, 60),
              backend: backend.label,
            });
          },
        });

        if (res.status === 'completed') {
          let blob = await client.audio(rec.id);
          const dur = Number(res.record?.duration) || 0;
          // 存盘前压缩：WAV -> Opus（体积约 1/10 ~ 1/16）
          if (settings.compress) blob = await compressBlob(blob);
          await store.putAudio(rid, chapter.id, book.id, index, blob, dur);
          markChunk(chunk, rid, {
            status: 'done',
            dur,
            genId: undefined,
            backend: backend.id,
            meta: {
              profileId: settings.profileId,
              backendProfileId: backend.profileId || settings.profileId,
              profileName: backend.profileName || '',
              engine: settings.engine || 'qwen',
              modelSize: settings.modelSize || '1.7B',
              // 记录「配置值」而不是解析后的值，否则「自动检测」会被误判为音色变更
              language: settings.language || 'auto',
              resolvedLanguage: language,
              backend: backend.id,
            },
          });
          this._saveChapter(chapter);
          this._emit('chunkDone', { chapterId: chapter.id, chunkIndex: index, backend: backend.id });
          this._session.chars += text.length;
          this._session.seconds += (performance.now() - t0) / 1000;
          const st = this._state;
          if (st) {
            st.done += 1;
            st.doneChars += text.length;
            const be = st.perBackend.find((b) => b.id === backend.id);
            if (be) be.done += 1;
          }
          return true;
        }

        if (res.status === 'cancelled') { markChunk(chunk, rid, { status: 'pending' }); return false; }

        lastErr = res.error || (res.status === 'timeout' ? '生成超时' : '生成失败');
        markChunk(chunk, rid, { status: 'error', err: lastErr });
      } catch (err) {
        if (err.name === 'AbortError') { markChunk(chunk, rid, { status: 'pending' }); return false; }
        lastErr = err.message;
        markChunk(chunk, rid, { status: 'error', err: err.message });
        // 连接层面的错误（后端挂了）不再重试
        if (/无法连接|Failed to fetch|ECONNREFUSED|timeout/i.test(err.message) && attempt >= 2) break;
      }
      if (attempt < 3) {
        this._progress({ status: 'retry', message: `第 ${attempt} 次失败，重试中…（${backend.label}）`, backend: backend.label });
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }

    markChunk(chunk, rid, { status: 'error', err: lastErr });
    this.warnings.push(`${chapter.title} #${index + 1}: ${lastErr}`);
    this._saveChapter(chapter);
    this._emit('chunkError', { chapterId: chapter.id, chunkIndex: index, message: lastErr });
    return false;
  }

  _saveChapter(chapter) {
    chapter.doneCount = (chapter.chunks || []).filter((c) => Object.values(c.audio || {}).some((a) => a.status === 'done')).length;
    chapter.updatedAt = Date.now();
    store.put('chapters', chapter).catch(() => {});
  }
}

/** 交给本地服务端用 ffmpeg 转 Opus；失败或没压小就保留原始 WAV */
async function compressBlob(blob) {
  try {
    const res = await fetch('/transcode', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: blob,
    });
    if (!res.ok) return blob;
    const out = await res.blob();
    if (!out.size || out.size >= blob.size * 0.85) return blob;
    return new Blob([out], { type: 'audio/webm' });
  } catch {
    return blob;
  }
}

function detectLang(chapter) {
  const sample = (chapter.chunks || []).slice(0, 12).map((c) => c.text).join('').slice(0, 800);
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk / Math.max(1, sample.length) > 0.3 ? 'zh' : 'en';
}
