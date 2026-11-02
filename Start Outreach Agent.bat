@echo off
REM Double-click to start the Outreach Agent on Windows.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo First run: installing, one-time...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
call npm run build --silent || (pause & exit /b 1)
echo Starting Outreach Agent - your browser will open. Keep this window open (close it to stop).
node dist\index.js
pause
