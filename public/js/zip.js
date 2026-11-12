/**
 * 极简 ZIP 读写（Store 方式，不压缩 —— 音频已经是压缩格式）
 *  - createZip(entries)  把若干 Blob/字节写成一个 zip Blob（流式计算 CRC，不占内存）
 *  - readZipEntries()    解析中央目录（和 parser.js 共用）
 *  - readZipEntry()      取出某个条目的字节（支持 store / deflate-raw）
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Update(crc, bytes) {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function dosTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (date.getSeconds() >> 1);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/** 读取一个 Blob/ArrayBuffer 的字节数并算 CRC（流式，不整块驻留） */
async function crcOfBlob(blob) {
  let crc = 0xffffffff;
  let size = 0;
  if (blob.stream) {
    const reader = blob.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      crc = crc32Update(crc, value);
    }
  } else {
    const buf = new Uint8Array(await blob.arrayBuffer());
    size = buf.length;
    crc = crc32Update(crc, buf);
  }
  return { crc: (crc ^ 0xffffffff) >>> 0, size };
}

/**
 * @param {Array<{name:string, data:Blob|Uint8Array}>} entries
 * @param {{onProgress?:(done:number,total:number)=>void}} opts
 * @returns {Promise<Blob>}
 */
export async function createZip(entries, opts = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosTime();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const data = entry.data instanceof Blob ? entry.data : new Blob([entry.data]);
    const nameBytes = new TextEncoder().encode(entry.name);
    const { crc, size } = await crcOfBlob(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);   // UTF-8 文件名
    local.setUint16(8, 0, true);        // store
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    parts.push(local.buffer, nameBytes, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, day, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, size, true);
    cen.setUint32(24, size, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen.buffer, nameBytes);

    offset += 30 + nameBytes.length + size;
    opts.onProgress?.(i + 1, entries.length);
  }

  const centralSize = central.reduce((a, b) => a + (b.byteLength || b.length || 0), 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);

  return new Blob([...parts, ...central, eocd.buffer], { type: 'application/zip' });
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

export function readZipEntries(buffer) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  if (u8.length < 22) throw new Error('文件太小，不是有效的 ZIP');
  let eocd = -1;
  const min = Math.max(0, u8.length - 66000);
  for (let i = u8.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 目录结构');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = decoder.decode(u8.subarray(off + 46, off + 46 + nameLen));
    entries.set(name, { name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, dv, u8 };
}

export async function readZipEntry(zip, entry) {
  const { dv, u8 } = zip;
  const lo = entry.localOff;
  if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error('ZIP 局部头损坏');
  const nameLen = dv.getUint16(lo + 26, true);
  const extraLen = dv.getUint16(lo + 28, true);
  const start = lo + 30 + nameLen + extraLen;
  const data = u8.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error(`不支持的压缩方式 ${entry.method}`);
  if (typeof DecompressionStream !== 'function') throw new Error('浏览器不支持解压（需要 DecompressionStream）');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
