@echo off
REM ===========================================================================
REM  Grade 2 Learning Station - one-click local start (Windows)
REM  Double-click this file. Real logic lives in scripts\start.ps1
REM  Keep this file ASCII-only to avoid console encoding issues.
REM ===========================================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
if errorlevel 1 (
  echo.
  echo Startup exited with an error. See the messages above.
  pause
)
endlocal
