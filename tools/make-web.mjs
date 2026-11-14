/**
 * 生成「纯静态网页版」：把 public/ 打包成一个可以直接拖到 Netlify Drop / Vercel / 任意 HTTPS 空间的目录。
 * 为什么要 HTTPS：Service Worker 只在安全上下文里注册，局域网的 http://192.168.x.x 不行，
 * 所以手机想断网阅读，必须让页面从 https:// 打开一次。
 * 运行：node tools/make-web.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'dist', 'web');

const README = `把整个 web 文件夹上传到任意「支持 HTTPS、根路径」的静态空间即可。

推荐 Netlify Drop（无需注册即可上传，之后可绑定账号）：
  1. 打开 https://app.netlify.com/drop
  2. 把本文件夹（web）整个拖进去
  3. 等几十秒，拿到形如 https://xxxx.netlify.app 的地址

然后手机：
  1. 用这个 https 地址打开
  2. 浏览器菜单 →「添加到主屏幕 / 安装应用」
  3. 首次打开后 Service Worker 会缓存整个界面，之后断网也能打开
  4. 设置 → 数据 → 导入备份，把电脑上导出的 zip 导进来

注意：
  - 必须部署在域名根路径下（netlify / vercel 默认就是），否则 /js/... 这类绝对路径会 404
  - 静态版没有 Node 代理，所以【不能生成新语音】，只能读和听已经生成好的
  - 想生成语音：回到电脑用便携版，生成完再导出备份同步过来
`;

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}

/** Netlify / Vercel 通用：sw.js 不缓存，保证更新能生效 */
const NETLIFY_HEADERS = `/*
  X-Frame-Options: SAMEORIGIN

/sw.js
  Cache-Control: no-cache
  Service-Worker-Allowed: /
`;

const VERCL_JSON = JSON.stringify({
  headers: [
    { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
  ],
}, null, 2);

async function main() {
  if (!fs.existsSync(SRC)) throw new Error('找不到 public/ 目录');
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  await copyDir(SRC, OUT);
  await fsp.writeFile(path.join(OUT, '_headers'), NETLIFY_HEADERS, 'utf8');
  await fsp.writeFile(path.join(OUT, 'vercel.json'), VERCL_JSON, 'utf8');
  await fsp.writeFile(path.join(OUT, '部署说明.txt'), README.replace(/\n/g, '\r\n'), 'utf8');

  const size = await dirSize(OUT);
  console.log(`完成：${OUT}`);
  console.log(`体积：${(size / 1024).toFixed(0)} KB（不含书籍音频，音频在浏览器的 IndexedDB 里）`);
  console.log('\n下一步：');
  console.log('  1. 打开 https://app.netlify.com/drop');
  console.log('  2. 把 dist/web 整个文件夹拖进去');
  console.log('  3. 用手机打开拿到的 https 地址 →「添加到主屏幕」→ 导入备份');
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else total += (await fsp.stat(p)).size;
  }
  return total;
}

main().catch((err) => {
  console.error('打包失败：', err);
  process.exit(1);
});
