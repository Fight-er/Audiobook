#!/usr/bin/env node
/**
 * 有声书阅读器 —— 本地服务器
 *
 * 职责：
 *   1. 托管 public/ 下的静态前端（零构建、零依赖）
 *   2. 把 /api/* 反向代理到本地 Voicebox TTS 服务（默认 http://127.0.0.1:17493）
 *      —— 因为 Voicebox 不发送 CORS 头，浏览器无法直接跨端口调用，故由本进程转发。
 *
 * 用法：
 *   node server.mjs
 *   环境变量：PORT（默认 5178）、HOST（默认 127.0.0.1）、VOICEBOX_URL（默认 http://127.0.0.1:17493）
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || '127.0.0.1';
const VOICEBOX_URL = (process.env.VOICEBOX_URL || 'http://127.0.0.1:17493').replace(/\/+$/, '');

/**
 * 多后端：默认本机，VOICEBOX_EXTRA 里用逗号追加其他机器（例如局域网）
 *   set VOICEBOX_EXTRA=http://192.168.18.33:17493
 */
const CONFIG_FILE = path.join(ROOT, 'backends.json');

function defaultBackends() {
  const list = [{ id: 'local', label: '本机', url: VOICEBOX_URL }];
  const extra = (process.env.VOICEBOX_EXTRA || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  extra.forEach((url, i) => {
    const clean = url.replace(/\/+$/, '');
    if (list.some((b) => b.url === clean)) return;
    let label = `节点 ${i + 2}`;
    try { label = `局域网 ${new URL(clean).hostname}`; } catch { /* noop */ }
    list.push({ id: `node${i + 1}`, label, url: clean });
  });
  return list;
}

function loadBackends() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (Array.isArray(raw?.backends) && raw.backends.length) {
      return raw.backends
        .filter((b) => b && typeof b.url === 'string')
        .map((b, i) => ({
          id: String(b.id || `node${i}`).replace(/[^\w-]/g, '') || `node${i}`,
          label: String(b.label || b.url),
          url: b.url.replace(/\/+$/, ''),
        }));
    }
  } catch { /* 没有配置文件就用默认值 */ }
  return defaultBackends();
}

let BACKENDS = loadBackends();
const backendById = (id) => BACKENDS.find((b) => b.id === id);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function log(...args) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...args);
}

/* ------------------------------------------------------------------ */
/* 反向代理：/api/* -> Voicebox                                         */
/* ------------------------------------------------------------------ */

async function handleProxy(req, res, url, baseUrl = VOICEBOX_URL) {
  const targetPath = url.pathname.replace(/^\/(api|b\/[^/]+)/, '') || '/';
  const target = baseUrl + targetPath + url.search;

  const bodyChunks = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) bodyChunks.push(chunk);
  }
  const body = bodyChunks.length ? Buffer.concat(bodyChunks) : undefined;

  const headers = { 'accept-encoding': 'identity' };
  for (const name of ['content-type', 'accept', 'range', 'if-none-match', 'cache-control']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }

  const started = Date.now();
  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
  } catch (err) {
    log('代理失败', req.method, target, err.message);
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        detail: `无法连接 Voicebox 服务（${baseUrl}）：${err.message}`,
        hint: '请确认 Voicebox 桌面应用已启动，或设置环境变量 VOICEBOX_URL 指向正确的地址。',
      })
    );
    return;
  }

  const outHeaders = {};
  for (const [k, v] of upstream.headers) {
    if (['content-type', 'content-length', 'content-disposition', 'cache-control', 'last-modified', 'etag', 'accept-ranges', 'content-range'].includes(k)) {
      outHeaders[k] = v;
    }
  }
  outHeaders['access-control-allow-origin'] = '*';
  outHeaders['cache-control'] = outHeaders['cache-control'] || 'no-store';

  res.writeHead(upstream.status, outHeaders);
  res.flushHeaders?.();
  req.socket?.setNoDelay?.(true);

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  res.on('close', () => {
    reader.cancel().catch(() => {});
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } catch {
    /* 客户端中断 */
  }
  res.end();
  if (upstream.status >= 400) log('代理返回', upstream.status, req.method, targetPath, `${Date.now() - started}ms`);
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                             */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    stat = null;
  }

  if (!stat || !stat.isFile()) {
    // SPA 回退
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (path.extname(pathname) === '') {
      const html = await fsp.readFile(index).catch(() => null);
      if (html) {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        res.end(html);
        return;
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('未找到：' + pathname);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return;
  }
  // 代码与页面绝不允许被缓存，避免浏览器/SW 拿到旧版本
  const isCode = ['.html', '.js', '.mjs', '.css', '.webmanifest'].includes(ext);
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': isCode ? 'no-store, must-revalidate' : 'public, max-age=300',
    etag,
  });
  fs.createReadStream(filePath).pipe(res);
}

/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // /b/<backendId>/* -> 指定后端
    const m = url.pathname.match(/^\/b\/([^/]+)(\/.*)?$/);
    if (m) {
      const backend = backendById(m[1]);
      if (!backend) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ detail: `未知后端 ${m[1]}` }));
        return;
      }
      await handleProxy(req, res, url, backend.url);
      return;
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await handleProxy(req, res, url);
      return;
    }
    if (url.pathname === '/backends') {
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* invalid */ }
        const list = Array.isArray(body?.backends) ? body.backends : null;
        if (!list || !list.length) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ detail: 'backends 不能为空' }));
          return;
        }
        const clean = list
          .filter((b) => b && typeof b.url === 'string' && /^https?:\/\//.test(b.url))
          .map((b, i) => ({
            id: String(b.id || `node${i}`).replace(/[^\w-]/g, '') || `node${i}`,
            label: String(b.label || b.url),
            url: b.url.replace(/\/+$/, ''),
          }));
        if (!clean.length) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ detail: '没有合法的 url（需以 http:// 或 https:// 开头）' }));
          return;
        }
        BACKENDS = clean;
        try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ backends: clean }, null, 2)); } catch (err) { log('写入 backends.json 失败', err.message); }
        log('后端列表已更新:', clean.map((b) => `${b.label}=${b.url}`).join(', '));
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        backends: BACKENDS.map((b) => ({ id: b.id, label: b.label, url: b.url, base: `/b/${b.id}` })),
      }));
      return;
    }
    if (url.pathname === '/__status') {
      const results = await Promise.all(BACKENDS.map(async (b) => {
        try {
          const r = await fetch(b.url + '/health', { signal: AbortSignal.timeout(4000) });
          return { id: b.id, label: b.label, url: b.url, online: r.ok, detail: await r.json() };
        } catch (err) {
          return { id: b.id, label: b.label, url: b.url, online: false, detail: { error: err.message } };
        }
      }));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        server: true,
        voicebox: results.some((r) => r.online),
        voiceboxUrl: VOICEBOX_URL,
        backends: results,
        detail: results[0]?.detail || null,
      }));
      return;
    }
    await serveStatic(req, res, url);
  } catch (err) {
    log('请求处理异常', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error: ' + err.message);
  }
});

server.listen(PORT, HOST, () => {
  log(`有声书阅读器已启动  →  http://${HOST}:${PORT}/`);
  for (const b of BACKENDS) log(`Voicebox 节点「${b.label}」→ ${b.url}`);
  fetch(VOICEBOX_URL + '/health', { signal: AbortSignal.timeout(4000) })
    .then((r) => r.json())
    .then((h) => log(`Voicebox 状态: ${h.status} / 模型已加载=${h.model_loaded} / GPU=${h.gpu_type || '无'}`))
    .catch((e) => log(`⚠ Voicebox 暂不可用（${e.message}），仍可播放已下载到本地的音频`));
});
