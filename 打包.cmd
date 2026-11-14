@echo off
cd /d "%~dp0"
echo Building portable bundle...
node tools\make-portable.mjs
if errorlevel 1 goto fail
echo Zipping...
if exist "dist\有声书阅读器-便携版.zip" del /f /q "dist\有声书阅读器-便携版.zip"
powershell -NoProfile -Command "Compress-Archive -Path 'dist\有声书阅读器-便携版\*' -DestinationPath 'dist\有声书阅读器-便携版.zip' -Force"
echo.
echo Done: dist\有声书阅读器-便携版.zip
pause
exit /b 0
:fail
echo Build failed.
pause