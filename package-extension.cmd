@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-extension.ps1"
if errorlevel 1 (
  echo.
  echo Packaging failed.
  pause
  exit /b 1
)
echo.
echo Created RoleTrack.zip in this folder.
pause
