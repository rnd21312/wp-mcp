@echo off
rem Starts the WP MCP panel on this computer only (http://127.0.0.1:8787/admin) and opens it.
rem Data folder: %WPMCP_DATA_DIR% if set, else .\wpmcp-data next to this file (same default as every other way of starting WP MCP).
cd /d "%~dp0gateway"
if not exist dist\panel\index.html (
  echo Building the panel (first run only)...
  call npm ci && call npm --prefix ..\panel ci && call npm run build
)
set WPMCP_PUBLIC_URL=http://127.0.0.1:8787
node dist\index.js local
pause
