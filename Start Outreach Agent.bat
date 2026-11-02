@echo off
title Outreach Agent
REM Double-click to start the Outreach Agent on Windows.
cd /d "%~dp0"

where node >nul 2>nul || goto nonode
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || goto oldnode

if exist "node_modules\.bin\tsc.cmd" goto build
echo.
echo Installing the app - one time only, takes about a minute...
echo.
call npm install --no-audit --no-fund
if not exist "node_modules\.bin\tsc.cmd" goto installfail

:build
call npm run build --silent
if errorlevel 1 goto buildfail

echo.
echo Outreach Agent is starting - your browser will open at http://localhost:3000
echo Keep this window open. Closing it stops the agent.
echo.
node --disable-warning=ExperimentalWarning dist\index.js
echo.
echo The app stopped. Scroll up to see why.
pause
exit /b

:nonode
echo Node.js is not installed. Download the LTS version from https://nodejs.org
echo Install it, then double-click this file again.
pause
exit /b 1

:oldnode
for /f %%v in ('node -v') do set NODEV=%%v
echo Your Node.js is %NODEV% - this app needs version 22.13 or newer.
echo Download the LTS version from https://nodejs.org, install it, then double-click this file again.
pause
exit /b 1

:installfail
echo.
echo The install did not finish. Scroll up to see the error.
echo Common fixes: check your internet connection, then delete the "node_modules" folder and double-click this file again.
pause
exit /b 1

:buildfail
echo.
echo The build failed. Delete the "node_modules" folder and double-click this file again.
pause
exit /b 1
