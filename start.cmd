@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 18 或更高版本： https://nodejs.org/
  pause
  exit /b 1
)

set "PORT=5178"
if not "%~1"=="" set "PORT=%~1"

echo.
echo   有声书 · 本地朗读与离线语音书
echo   ------------------------------------
echo   阅读器地址 : http://127.0.0.1:%PORT%/
echo   语音服务   : http://127.0.0.1:17493  ^(请先启动 Voicebox^)
echo   关闭此窗口即可停止服务
echo.

start "" "http://127.0.0.1:%PORT%/"
node server.mjs

echo.
echo 服务已退出。
pause
