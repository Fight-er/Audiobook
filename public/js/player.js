/**
 * 播放引擎
 * - 每个「朗读块」对应一段本地音频（IndexedDB 中的 Blob）
 * - 使用单个 HTMLAudioElement 逐块连续播放；换块间隙由预取 + objectURL 缓存压到最低
 * - playbackRate 变速时保持音调（Chromium/Firefox 默认 preservesPitch）
 * - 对外暴露整章时间轴（按各块时长累加），支持拖动进度、跳块、跨章续播
 */

import { store } from './store.js';

const MAX_URL_CACHE = 8;

export class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
    if ('preservesPitch' in this.audio) this.audio.preservesPitch = true;
    if ('mozPreservesPitch' in this.audio) this.audio.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in this.audio) this.audio.webkitPreservesPitch = true;

    this.book = null;
    this.chapter = null;
    this.renditionId = null;
    /** @type {Array<{i:number,dur:number,start:number,text:string,url?:string,blob?:Blob}>} */
    this.tracks = [];
    this.index = -1;
    this.rate = 1;
    this.volume = 1;
    this.state = 'idle'; // idle | loading | playing | paused | ended
    this._urls = new Map();
    this._revoking = [];
    this._pendingSeek = null;
    this._loadToken = 0;
    this._errorSkip = 0;

    this.audio.addEventListener('timeupdate', () => this._emitTime());
    this.audio.addEventListener('durationchange', () => this._syncDuration());
    this.audio.addEventListener('ended', () => this._onEnded());
    this.audio.addEventListener('play', () => this._setState('playing'));
    this.audio.addEventListener('pause', () => {
      if (this.state !== 'loading') this._setState('paused');
    });
    this.audio.addEventListener('error', () => this._onError());
  }

  /* ---------------- 状态 ---------------- */

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: { state: s } }));
  }

  _emitTime() {
    if (this.index < 0 || !this.tracks[this.index]) return;
    const track = this.tracks[this.index];
    const t = track.start + (this.audio.currentTime || 0);
    this.dispatchEvent(new CustomEvent('time', { detail: { time: t, duration: this.duration, index: this.index } }));
  }

  _syncDuration() {
    if (this.index < 0) return;
    const track = this.tracks[this.index];
    const real = this.audio.duration;
    if (!Number.isFinite(real) || real <= 0) return;
    if (Math.abs(real - track.dur) > 0.35) {
      track.dur = real;
      this._rebuildTimeline();
      this.dispatchEvent(new CustomEvent('timeline', { detail: { index: this.index } }));
    }
  }

  _rebuildTimeline() {
    let acc = 0;
    for (const t of this.tracks) {
      t.start = acc;
      acc += t.dur || 0;
    }
    this._total = acc;
  }

  get duration() {
    return this._total || this.tracks.reduce((a, t) => a + (t.dur || 0), 0);
  }

  get currentTime() {
    if (this.index < 0) return 0;
    const track = this.tracks[this.index];
    if (!track) return 0;
    return track.start + Math.min(this.audio.currentTime || 0, track.dur || 0);
  }

  get currentTrack() {
    return this.index >= 0 ? this.tracks[this.index] : null;
  }

  /* ---------------- 加载 ---------------- */

  /**
   * @param {object} book
   * @param {object} chapter 含 chunks[]
   * @param {Array} audioRows 该章已生成音频的 {key, dur, size} 记录
   * @param {number} startChunkIndex 章节内的朗读块序号（不是 tracks 序号）
   */
  async loadChapter({ book, chapter, audioRows, renditionId = null, startChunkIndex = 0, autoplay = false }) {
    const byChunk = new Map();
    for (const row of audioRows) {
      const i = Number(row.key.split(':').pop());
      byChunk.set(i, row);
    }
    this.book = book;
    this.chapter = chapter;
    this.renditionId = renditionId;
    this.tracks = [];
    for (let i = 0; i < chapter.chunks.length; i++) {
      const row = byChunk.get(i);
      if (!row) continue;
      this.tracks.push({ i, dur: row.dur || 0, start: 0, text: chapter.chunks[i].text });
    }
    this._rebuildTimeline();
    this._errorSkip = 0;

    if (!this.tracks.length) {
      this.index = -1;
      this._setState('idle');
      this.dispatchEvent(new CustomEvent('chapterempty', { detail: { chapter } }));
      return false;
    }

    let target = this.tracks.findIndex((t) => t.i >= startChunkIndex);
    if (target < 0) target = this.tracks.length - 1;

    this._setState('loading');
    await this._activate(target, 0, autoplay);
    return true;
  }

  clear() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this._revokeAll();
    this.tracks = [];
    this.index = -1;
    this.book = null;
    this.chapter = null;
    this.renditionId = null;
    this._setState('idle');
  }

  async _urlFor(track) {
    if (track.url) return track.url;
    const key = this.renditionId
      ? `${this.renditionId}:${this.chapter.id}:${track.i}`
      : `${this.chapter.id}:${track.i}`;
    let url = this._urls.get(key);
    if (!url) {
      const row = await store.get('audio', key);
      if (!row?.blob) throw new Error('音频数据缺失');
      url = URL.createObjectURL(row.blob);
      this._urls.set(key, url);
      if (this._urls.size > MAX_URL_CACHE) {
        const oldest = this._urls.keys().next().value;
        const oldUrl = this._urls.get(oldest);
        this._urls.delete(oldest);
        this._revoking.push(oldUrl);
      }
    }
    track.url = url;
    return url;
  }

  _flushRevoked() {
    while (this._revoking.length) {
      const url = this._revoking.shift();
      try { URL.revokeObjectURL(url); } catch { /* noop */ }
    }
  }

  _revokeAll() {
    for (const url of this._urls.values()) {
      try { URL.revokeObjectURL(url); } catch { /* noop */ }
    }
    this._urls.clear();
    this._flushRevoked();
  }

  async _activate(trackIdx, offset = 0, autoplay = true) {
    const token = ++this._loadToken;
    this.index = trackIdx;
    this._setState('loading');
    this._flushRevoked();
    const track = this.tracks[trackIdx];
    if (!track) { this._setState('idle'); return; }

    let url;
    try {
      url = await this._urlFor(track);
    } catch (err) {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: err.message } }));
      return;
    }
    if (token !== this._loadToken) return;

    this.audio.src = url;
    this.audio.playbackRate = this.rate;
    await new Promise((resolve) => {
      const done = () => { cleanup(); resolve(); };
      const cleanup = () => {
        this.audio.removeEventListener('loadedmetadata', done);
        this.audio.removeEventListener('error', done);
      };
      if (this.audio.readyState >= 1) return done();
      this.audio.addEventListener('loadedmetadata', done, { once: true });
      this.audio.addEventListener('error', done, { once: true });
    });
    if (token !== this._loadToken) return;

    this._syncDuration();
    if (offset > 0) {
      try { this.audio.currentTime = Math.min(offset, (this.audio.duration || offset)); } catch { /* noop */ }
    }
    this.dispatchEvent(new CustomEvent('track', { detail: { index: this.index, track } }));
    this._emitTime();

    if (autoplay) {
      try {
        await this.audio.play();
        this._setState('playing');
      } catch (err) {
        this._setState('paused');
        this.dispatchEvent(new CustomEvent('error', { detail: { message: '播放被浏览器拦截：' + err.message } }));
      }
    } else {
      this._setState('paused');
    }
    this._prefetch(trackIdx + 1);
  }

  async _prefetch(i) {
    const track = this.tracks[i];
    if (!track || track.url) return;
    try { await this._urlFor(track); } catch { /* ignore */ }
  }

  /* ---------------- 控制 ---------------- */

  async play() {
    if (this.index < 0) {
      if (this.tracks.length) await this._activate(0, 0, true);
      return;
    }
    try {
      await this.audio.play();
      this._setState('playing');
    } catch (err) {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: '无法播放：' + err.message } }));
    }
  }

  pause() {
    this.audio.pause();
    this._setState('paused');
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  setRate(rate) {
    this.rate = rate;
    this.audio.playbackRate = rate;
    this.audio.defaultPlaybackRate = rate;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.audio.volume = this.volume;
  }

  /** 跳转到章节内时间（秒） */
  async seek(time) {
    if (!this.tracks.length) return;   // 本章还没有音频：静默忽略，避免调用方拿到 -1 索引

    const total = this.duration;
    const t = Math.max(0, Math.min(Math.max(0, total - 0.05), time));
    let idx = this.tracks.findIndex((tr) => t >= tr.start && t < tr.start + tr.dur);
    if (idx < 0) idx = this.tracks.length - 1;
    const track = this.tracks[idx];
    if (!track) return;
    const offset = Math.max(0, t - track.start);
    if (idx === this.index && Math.abs((this.audio.currentTime || 0) - offset) < 0.4) {
      this._emitTime();
      return;
    }
    const wasPlaying = this.state === 'playing' || this.state === 'loading';
    if (idx === this.index) {
      try {
        this.audio.currentTime = offset;
        this._emitTime();
      } catch { /* noop */ }
      return;
    }
    await this._activate(idx, offset, wasPlaying);
  }

  /** 跳到指定朗读块 */
  async goToChunk(chunkIndex, autoplay = true) {
    const idx = this.tracks.findIndex((t) => t.i === chunkIndex);
    if (idx < 0) return false;
    await this._activate(idx, 0, autoplay);
    return true;
  }

  /** 相对跳转（秒） */
  skip(seconds) {
    return this.seek(this.currentTime + seconds);
  }

  nextTrack() {
    if (this.index + 1 < this.tracks.length) {
      return this._activate(this.index + 1, 0, this.state === 'playing');
    }
    return Promise.resolve();
  }

  prevTrack() {
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return Promise.resolve();
    }
    if (this.index > 0) return this._activate(this.index - 1, 0, this.state === 'playing');
    return Promise.resolve();
  }

  _onEnded() {
    const next = this.index + 1;
    if (next < this.tracks.length) {
      this._activate(next, 0, true);
      return;
    }
    this._setState('ended');
    this.dispatchEvent(new CustomEvent('chapterend', { detail: { book: this.book, chapter: this.chapter } }));
  }

  _onError() {
    const track = this.currentTrack;
    if (!track || !this.audio.src) return;
    // 单块解码失败：跳过，避免整章卡死
    if (this._errorSkip < 3 && this.index + 1 < this.tracks.length) {
      this._errorSkip += 1;
      this.dispatchEvent(new CustomEvent('error', { detail: { message: '音频块损坏，已跳过' } }));
      this._activate(this.index + 1, 0, true);
    } else {
      this._setState('paused');
      this.dispatchEvent(new CustomEvent('error', { detail: { message: '音频解码失败' } }));
    }
  }
}
