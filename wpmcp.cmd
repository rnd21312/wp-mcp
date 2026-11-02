@echo off
rem WP MCP control panel in the terminal: start/stop, sites, updates, rebuild, checks. Double-click or run: wpmcp
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node scripts\tui.mjs %*
goto :eof

:nonode
echo Node.js 20 or newer is required. Install it from https://nodejs.org and run this file again.
pause
