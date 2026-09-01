@echo off
REM Starts EquixLite and opens it. Runs in this window; close it to stop the server.
cd /d "%~dp0server"
if not exist node_modules ( echo Installing dependencies... && call npm install --no-audit --no-fund )
call npm run migrate
start "" http://localhost:5070
node src/server.js
