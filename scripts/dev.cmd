@echo off
rem Runs the Vite dev server, using the portable Node in .tools if one is present.
setlocal
set "ROOT=%~dp0.."
if exist "%ROOT%\.tools\node\node.exe" set "PATH=%ROOT%\.tools\node;%PATH%"
cd /d "%ROOT%"
call npm run dev -- %*
