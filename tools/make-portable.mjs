/**
 * 打包「便携版」：把运行所需的一切（含 node.exe）复制到 dist/，双击即用。
 * 运行：node tools/make-portable.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, 'dist');
const NAME = '有声书阅读器-便携版';
const OUT = path.join(OUT_ROOT, NAME);

const LAUNCHER = `@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set PORT=5178
set HOST=0.0.0.0
if not exist "%~dp0node\\node.exe" (
  echo [ERROR] node\\node.exe missing, package is broken.
  pause
  exit /b 1
)

echo.
echo   Audiobook Reader - portable
echo   ---------------------------------
echo   starting local server on port %PORT% ...
echo   (listening on 0.0.0.0 so your phone on the same Wi-Fi can connect)

start "audiobook-server" /min "%~dp0node\\node.exe" "%~dp0server.mjs"

set /a tries=0
:wait
set /a tries+=1
timeout /t 1 >nul
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%PORT%)).Close();exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 if %tries% lss 25 goto wait
if errorlevel 1 (
  echo   [WARN] server did not answer in time, open the URL manually.
)

set "EDGE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"

if exist "%EDGE%" (
  echo   opening app window ^(data stays inside this folder^)
  start "" "%EDGE%" --app=http://127.0.0.1:%PORT%/ --user-data-dir="%~dp0userdata" --window-size=1320,900 --no-first-run --no-default-browser-check
) else (
  echo   Edge not found, opening default browser instead.
  echo   NOTE: your books will then live in that browser profile, not in this folder.
  start "" http://127.0.0.1:%PORT%/
)

echo.
echo   URL: http://127.0.0.1:%PORT%/
echo   Close this window anytime; the server keeps running.
echo   Use "stop.cmd" to shut the server down.
echo.
timeout /t 3 >nul
`;

const STOPPER = `@echo off
cd /d "%~dp0"
set PORT=5178
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do (
  taskkill /f /pid %%a >nul 2>&1
  set FOUND=1
)
if "%FOUND%"=="0" (
  echo No server listening on port %PORT%.
) else (
  echo Server stopped.
)
timeout /t 2 >nul
`;

const GUIDE = `有声书阅读器 · 便携版
==============================

【怎么用】
  1. 双击「启动.cmd」
  2. 会自动开一个独立窗口（Edge 应用模式），地址是 http://127.0.0.1:5178/
  3. 用完后关掉窗口即可；要彻底停服务，双击「停止.cmd」

【数据存在哪】
  - 书籍、音频、笔记、进度都在浏览器数据库（IndexedDB）里
  - 本便携版用「userdata」文件夹作为独立浏览器配置，
    所以【整个文件夹拷走 = 书和数据一起搬走】，换电脑直接能用
  - 如果系统里没有 Edge，会退回默认浏览器，此时数据存在于那个浏览器的配置里，
    换电脑请用「设置 → 数据 → 导出备份」再导入

【语音合成要用 Voicebox】
  本软件只负责阅读与排版，合成依赖本机的 Voicebox：
    https://github.com/jamiepine/voicebox
  Voicebox 需要单独安装并启动（默认端口 17493），它带 GPU 模型，不在这个包里。
  只读书不听音的话，不需要启动 Voicebox。

【可选：音频压缩】
  装过 ffmpeg 的话，生成的音频会自动压成 Opus（约 1/10 体积）；
  没装则保存原始 WAV，功能不受影响。

【换电脑】
  方案 A（推荐）：整个文件夹拷过去，双击「启动.cmd」
  方案 B：新电脑装 Node.js 后运行 server.mjs，再用设置里的导出/导入备份搬数据

【手机上读书（高铁/通勤也能用）】
  1. 双击「手机访问.cmd」，窗口里会打印 http://<本机IP>:5178/
  2. 手机连同一个 Wi-Fi，浏览器打开那个地址
  3. 手机上：设置 → 数据 → 导入备份，选你传过去的备份 zip
     （备份在电脑上：设置 → 数据 → 导出备份）
  4. 导入完成后，界面和音频都已经在手机上，断网也能读

  连不上怎么办？
    - 确认手机和电脑连的是同一个 Wi-Fi（不是访客网络）
    - 双击一次「allow-firewall.cmd」（需要管理员权限），放行 5178 端口
    - 如果之前用「启动.cmd」开过服务，先「停止.cmd」再试
  说明：手机上只能「读和听已经生成好的」，要生成新语音仍然需要本机的 Voicebox。

【端口被占用】
  改「启动.cmd」第 5 行的 set PORT=5178 为别的端口即可。
`;

const FIREWALL = `@echo off
setlocal
cd /d "%~dp0"
set PORT=5178

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" 2>nul
  exit /b
)

echo.
echo   Opening TCP port %PORT% for the local network...
netsh advfirewall firewall delete rule name="Audiobook Reader %PORT%" >nul 2>&1
netsh advfirewall firewall add rule name="Audiobook Reader %PORT%" dir=in action=allow protocol=TCP localport=%PORT% profile=private,domain >nul
if errorlevel 1 (
  echo   [ERROR] failed to add firewall rule.
) else (
  echo   Done. Rule "Audiobook Reader %PORT%" added ^(private / domain networks^).
)
echo.
pause
`;
const MOBILE = `@echo off
setlocal
cd /d "%~dp0"
set PORT=5178
set HOST=0.0.0.0

set "NODEEXE=%~dp0node\\node.exe"
if not exist "%NODEEXE%" set "NODEEXE=node"

echo.
echo   Audiobook Reader - LAN mode  ^(phone / tablet^)
echo   =============================================
echo   Same Wi-Fi required. Open one of these on the phone:
echo.
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=1" %%j in ("%%i") do echo       http://%%j:%PORT%/
)
echo.
echo   Then on the phone:
echo     1. open that URL
echo     2. Settings - Data - Import backup   (pick the .zip you copied over)
echo     3. books + audio now live on the phone, and it keeps working offline
echo.
echo   Note: generating new speech still needs Voicebox running on this PC.
echo.
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
  echo   [WARN] port %PORT% is already in use.
  echo   If that server was started by 启动.cmd it only listens on this PC.
  echo   Run 停止.cmd first, then run this again.
  goto afterstart
)
start "audiobook-server" /min "%~dp0node\\node.exe" "%~dp0server.mjs"
timeout /t 2 >nul
:afterstart
echo.
if exist "%~dp0node\\node.exe" (
  echo   Tip: if the phone still cannot connect, run "allow-firewall.cmd" once
  echo   ^(it needs administrator rights and opens port %PORT% for local network^).
)
echo   Started. Use stop.cmd to shut it down.
echo.
pause
`;

async function copyDir(src, dest, filter = () => true) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (!filter(s, entry)) continue;
    if (entry.isDirectory()) await copyDir(s, d, filter);
    else await fsp.copyFile(s, d);
  }
}

async function main() {
  console.log('清理旧产物…');
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  console.log('复制程序文件…');
  await fsp.copyFile(path.join(ROOT, 'server.mjs'), path.join(OUT, 'server.mjs'));
  await fsp.copyFile(path.join(ROOT, 'README.md'), path.join(OUT, 'README.md'));
  for (const f of ['backends.json']) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) await fsp.copyFile(src, path.join(OUT, f));
  }
  await copyDir(path.join(ROOT, 'public'), path.join(OUT, 'public'));
  if (fs.existsSync(path.join(ROOT, 'samples'))) {
    await copyDir(path.join(ROOT, 'samples'), path.join(OUT, 'samples'));
  }

  console.log('放入 node 运行时…');
  const nodeExe = process.execPath;
  await fsp.mkdir(path.join(OUT, 'node'), { recursive: true });
  await fsp.copyFile(nodeExe, path.join(OUT, 'node', 'node.exe'));

  console.log('写启动脚本…');
  await fsp.writeFile(path.join(OUT, '启动.cmd'), LAUNCHER.replace(/\r?\n/g, '\r\n'), 'utf8');
  await fsp.writeFile(path.join(OUT, '停止.cmd'), STOPPER.replace(/\r?\n/g, '\r\n'), 'utf8');
  await fsp.writeFile(path.join(OUT, '手机访问.cmd'), MOBILE.replace(/\r?\n/g, '\r\n'), 'utf8');
  await fsp.writeFile(path.join(OUT, 'allow-firewall.cmd'), FIREWALL.replace(/\r?\n/g, '\r\n'), 'utf8');
  await fsp.writeFile(path.join(OUT, '使用说明.txt'), GUIDE.replace(/\r?\n/g, '\r\n'), 'utf8');

  const size = await dirSize(OUT);
  console.log(`\n完成：${OUT}`);
  console.log(`体积：${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log('\n下一步：双击「启动.cmd」即可。');
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
