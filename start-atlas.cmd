@echo off
rem Project ATLAS launcher (Windows). Double-click to start the application.
rem Uses the portable Node.js in .tools if present, otherwise the Node.js on PATH.
setlocal
set "ROOT=%~dp0"
if exist "%ROOT%.tools\node\node.exe" set "PATH=%ROOT%.tools\node;%PATH%"
cd /d "%ROOT%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist "%ROOT%node_modules" (
  echo Installing dependencies. This happens once.
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Starting ATLAS. Your browser will open at http://localhost:5173
echo Close this window to stop the application.
call npm run dev -- --open
