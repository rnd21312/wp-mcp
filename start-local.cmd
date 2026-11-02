@echo off
setlocal
rem Starts the WP MCP panel on this computer only (http://127.0.0.1:8787/admin) and opens it in your browser.
rem First run installs the packages and builds everything (a few minutes). After updating the code run: start-local.cmd rebuild
rem Data folder: %WPMCP_DATA_DIR% if set, else .\wpmcp-data next to this file (your connected sites live there).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

set NEED=0
if /i "%~1"=="rebuild" set NEED=1
if not exist "gateway\node_modules" set NEED=1
if not exist "panel\node_modules" set NEED=1
if not exist "gateway\dist\index.js" set NEED=1
if not exist "gateway\dist\panel\index.html" set NEED=1
if "%NEED%"=="1" goto build
goto run

:build
echo Installing packages and building. This takes a few minutes the first time.
call npm --prefix gateway ci
if errorlevel 1 goto fail
call npm --prefix panel ci
if errorlevel 1 goto fail
call npm --prefix gateway run build
if errorlevel 1 goto fail

:run
set WPMCP_PUBLIC_URL=http://127.0.0.1:8787
netstat -ano | findstr /r /c:":8787 .*LISTENING" >nul
if errorlevel 1 goto free
echo WP MCP is already running. Opening it in your browser.
start "" http://127.0.0.1:8787/admin
timeout /t 3 >nul
exit /b 0

:free
netstat -ano | findstr /r /c:":8788 .*LISTENING" >nul
if errorlevel 1 goto start
echo Port 8788 is used by another program. WP MCP needs 8787 and 8788. Close that program and try again.
goto end

:start
echo Starting WP MCP at http://127.0.0.1:8787/admin
echo Leave this window open while you use it. Press Ctrl+C to stop.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 4; Start-Process 'http://127.0.0.1:8787/admin'"
node "%~dp0gateway\dist\index.js" local
echo.
echo WP MCP stopped.
goto end

:nonode
echo Node.js 20 or newer is required. Install it from https://nodejs.org and run this file again.
goto end

:fail
echo.
echo Setup failed. Read the message above, then run start-local.cmd rebuild.

:end
pause
