/**
 * Voicebox API 客户端（经 server.mjs 的反向代理，规避 CORS）
 *
 * 支持多后端：每个节点用 base 路径区分（/api 默认本机，/b/<id> 其他机器）
 */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient(base = '/api') {
  const B = base.replace(/\/+$/, '');

  async function request(path, opts = {}) {
    let res;
    try {
      res = await fetch(B + path, opts);
    } catch (err) {
      throw new ApiError(`无法连接语音服务：${err.message}`, 0);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const text = await res.text();
        try {
          const json = JSON.parse(text);
          detail = json.detail || json.message || text;
        } catch {
          detail = text;
        }
      } catch { /* ignore */ }
      throw new ApiError(`Voicebox 返回 ${res.status}${detail ? '：' + String(detail).slice(0, 300) : ''}`, res.status);
    }
    return res;
  }

  const json = async (path, opts) => (await request(path, opts)).json();

  return {
    base: B,
    ApiError,

    health() {
      return json('/health', { signal: AbortSignal.timeout(8000) });
    },

    profiles() {
      return json('/profiles', { signal: AbortSignal.timeout(15000) });
    },

    models() {
      return json('/models/status', { signal: AbortSignal.timeout(15000) });
    },

    generate(payload) {
      return json('/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },

    status(generationId) {
      return json(`/history/${encodeURIComponent(generationId)}`, { signal: AbortSignal.timeout(15000) });
    },

    cancel(generationId) {
      return request(`/generate/${encodeURIComponent(generationId)}/cancel`, { method: 'POST' })
        .then((r) => r.json().catch(() => ({})));
    },

    async audio(generationId) {
      const res = await request(`/audio/${encodeURIComponent(generationId)}`, { signal: AbortSignal.timeout(120000) });
      return res.blob();
    },

    /** 轮询直到完成 / 失败 / 取消 */
    async wait(generationId, { signal, intervalMs = 1200, timeoutMs = 15 * 60 * 1000, onTick } = {}) {
      const started = Date.now();
      let last = null;
      for (;;) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        let rec;
        try {
          rec = await this.status(generationId);
        } catch (err) {
          if (err.status === 404) return { status: 'failed', record: last, error: '任务在服务端不存在' };
          await sleepFn(intervalMs * 2);
          continue;
        }
        last = rec;
        onTick?.(rec);
        if (rec.status === 'completed') return { status: 'completed', record: rec };
        if (rec.status === 'failed') return { status: 'failed', record: rec, error: rec.error || '生成失败' };
        if (rec.status === 'cancelled') return { status: 'cancelled', record: rec };
        if (Date.now() - started > timeoutMs) return { status: 'timeout', record: rec };
        await sleepFn(intervalMs);
      }
    },
  };
}

/** 默认后端（本机） */
export const api = createClient('/api');

/** 后端列表（由 server.mjs 维护，含 base 路径） */
export async function fetchBackends() {
  const res = await fetch('/backends', { cache: 'no-store' });
  if (!res.ok) throw new Error('无法获取后端列表');
  const data = await res.json();
  return data.backends || [];
}

export async function saveBackends(backends) {
  const res = await fetch('/backends', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backends }),
  });
  if (!res.ok) throw new Error('保存后端列表失败');
  const data = await res.json();
  return data.backends || [];
}

export function sleep(ms) {
  return sleepFn(ms);
}

export const ENGINES = [
  { id: 'qwen', label: 'Qwen3-TTS（音色克隆 / 推荐）', sizes: ['1.7B', '0.6B'] },
  { id: 'qwen_custom_voice', label: 'Qwen CustomVoice（预置音色）', sizes: ['1.7B', '0.6B'] },
  { id: 'kokoro', label: 'Kokoro 82M（极快 / CPU 可用）', sizes: [] },
  { id: 'luxtts', label: 'LuxTTS（快 / 免 GPU）', sizes: [] },
  { id: 'chatterbox', label: 'Chatterbox（多语种）', sizes: [] },
  { id: 'chatterbox_turbo', label: 'Chatterbox Turbo（英文）', sizes: [] },
  { id: 'tada', label: 'TADA（英文）', sizes: [] },
];

export const LANGUAGES = [
  ['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'],
  ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['ru', 'Русский'],
  ['it', 'Italiano'], ['pt', 'Português'], ['ar', 'العربية'], ['nl', 'Nederlands'],
  ['pl', 'Polski'], ['tr', 'Türkçe'], ['hi', 'हिन्दी'], ['auto', '自动检测'],
];
