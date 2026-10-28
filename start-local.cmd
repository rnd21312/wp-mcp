@echo off
rem Starts the WP MCP panel on this computer only (http://127.0.0.1:8787/admin) and opens it.
rem Data folder: %WPMCP_DATA_DIR% if set, else D:\wpmcp-data if it exists, else .\wpmcp-data next to this file.
cd /d "%~dp0gateway"
if not exist dist\index.js (
  echo Building...
  call npm ci && call npm run build
)
if "%WPMCP_DATA_DIR%"=="" (
  if exist D:\wpmcp-data (set "WPMCP_DATA_DIR=D:\wpmcp-data") else (set "WPMCP_DATA_DIR=%~dp0wpmcp-data")
)
set WPMCP_PUBLIC_URL=http://127.0.0.1:8787
node dist\index.js local
pause
