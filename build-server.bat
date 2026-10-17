@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-server.ps1" %*
set "build_result=%errorlevel%"
pause
exit /b %build_result%
