/**
 * 音频导出：把 IndexedDB 里的分块 WAV 拼成一整章 / 整本 WAV。
 *
 * 优先走「裸 PCM 拼接」——只重写一个 WAV 头，零解码、零内存拷贝；
 * 如果各块格式不一致，则回退到 WebAudio 解码后重采样到 24kHz 单声道再编码。
 */

function parseWavHeader(buffer) {
  const dv = new DataView(buffer);
  if (dv.byteLength < 44) return null;
  const tag = (off) => String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let pos = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (pos + 8 <= dv.byteLength) {
    const id = tag(pos);
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: dv.getUint16(pos + 8, true),
        channels: dv.getUint16(pos + 10, true),
        sampleRate: dv.getUint32(pos + 12, true),
        bitsPerSample: dv.getUint16(pos + 22, true),
      };
    } else if (id === 'data') {
      dataOffset = pos + 8;
      dataSize = Math.min(size, dv.byteLength - dataOffset);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) return null;
  return { ...fmt, dataOffset, dataSize };
}

function sameFormat(a, b) {
  return a && b && a.audioFormat === b.audioFormat && a.channels === b.channels &&
    a.sampleRate === b.sampleRate && a.bitsPerSample === b.bitsPerSample;
}

function wavHeader(dataSize, { channels, sampleRate, bitsPerSample }) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buf = new ArrayBuffer(44);
  const dv = new DataView(buf);
  const write = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  write(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  write(36, 'data');
  dv.setUint32(40, dataSize, true);
  return buf;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => Number(a.key.split(':').pop()) - Number(b.key.split(':').pop()));
}

/** @returns {Promise<Blob>} */
export async function concatWavBlobs(blobs, { onProgress } = {}) {
  const buffers = [];
  for (let i = 0; i < blobs.length; i++) {
    buffers.push(await blobs[i].arrayBuffer());
    onProgress?.(i + 1, blobs.length);
  }
  if (!buffers.length) throw new Error('没有可导出的音频');

  const headers = buffers.map((b) => parseWavHeader(b));
  const fmt = headers[0];
  const canRaw = fmt && headers.every((h) => sameFormat(fmt, h));

  if (canRaw) {
    const datas = buffers.map((b, i) => new DataView(b).buffer.slice(headers[i].dataOffset, headers[i].dataOffset + headers[i].dataSize));
    const total = datas.reduce((a, d) => a + d.byteLength, 0);
    return new Blob([wavHeader(total, fmt), ...datas], { type: 'audio/wav' });
  }

  // 回退：解码后重采样
  const sampleRate = fmt?.sampleRate || 24000;
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const decoded = [];
  for (let i = 0; i < buffers.length; i++) {
    try {
      decoded.push(await ctx.decodeAudioData(buffers[i].slice(0)));
    } catch { /* 跳过损坏块 */ }
    onProgress?.(i + 1, buffers.length);
  }
  if (!decoded.length) throw new Error('音频块无法解码');

  const totalFrames = decoded.reduce((a, b) => a + b.length, 0);
  const merged = new Float32Array(totalFrames);
  let offset = 0;
  for (const buf of decoded) {
    const ch = buf.numberOfChannels > 1
      ? averageChannels(buf)
      : buf.getChannelData(0);
    merged.set(ch, offset);
    offset += ch.length;
  }
  return encodeWav(merged, sampleRate);
}

function averageChannels(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  const chs = [...Array(buffer.numberOfChannels)].map((_, i) => buffer.getChannelData(i));
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const c of chs) v += c[i];
    out[i] = v / chs.length;
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function exportChapterWav(rows, { onProgress } = {}) {
  return concatWavBlobs(sortRows(rows).map((r) => r.blob), { onProgress });
}

export async function exportBookWav(allRows, { onProgress } = {}) {
  // allRows 需已按 (章节序, 块序) 排序
  return concatWavBlobs(allRows.map((r) => r.blob), { onProgress });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeFilename(name) {
  return (name || 'audiobook').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
}
