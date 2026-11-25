@echo off
cd /d "%~dp0"
if exist "dist\localhostSearch-Portable-*.exe" (
  start "" "dist\localhostSearch-Portable-1.0.1.exe"
) else (
  node run-electron.js
)