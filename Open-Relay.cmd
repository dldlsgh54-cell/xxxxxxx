@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
    echo Install Node.js 24 or later, then open Relay again.
    pause
    exit /b 1
)
set "NODE_USE_SYSTEM_CA=1"
if not exist "node_modules\twitter-text\package.json" (
    call npm.cmd ci --ignore-scripts
    if errorlevel 1 (
        pause
        exit /b 1
    )
)
node --use-system-ca dashboard.mjs --open
if errorlevel 1 pause
