@echo off
setlocal
title E-mote local server
cd /d "%~dp0"

rem Port: default 8000. To change it: run.bat 8901
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

rem Detect node by running it: "where node" can fail with access-denied on some PATHs
node -v >nul 2>nul
if errorlevel 1 goto no_node
for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"

echo [OK] Node %NODEV% found. Starting on port %PORT% ...
echo.

node main.mjs --port %PORT% --open

echo.
echo E-mote server stopped.
echo If port %PORT% was already in use, close that program and retry,
echo or use another port: run.bat 8901
echo.
pause
exit /b 1

:no_node
echo.
echo [!] Node.js not found. This project needs Node.js only, nothing else.
echo.
echo     1) The download page will open: https://nodejs.org/zh-cn/download
echo     2) Install the LTS version and keep the default options.
echo     3) Close this window, then double-click run.bat again.
echo.
echo     Verify later: type "node -v" in a terminal, it should print a version.
echo.
start "" "https://nodejs.org/zh-cn/download"
echo Press any key to close...
pause >nul
exit /b 1
