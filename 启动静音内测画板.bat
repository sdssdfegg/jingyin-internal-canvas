@echo off
setlocal EnableExtensions

rem ==========================================================================
rem  Jingyin AI Drawing V11 - Windows launcher
rem
rem  IMPORTANT: keep this file ASCII-only.
rem  cmd.exe reads .bat bytes using the active console codepage; mixing a
rem  non-ANSI codepage with CJK text makes the parser mis-read the file.
rem  All Chinese diagnostics live in scripts\start-jingyin-board.ps1, which is
rem  saved as UTF-8 with BOM so Windows PowerShell 5.1 reads it correctly.
rem
rem  This launcher does NOT hardcode any Node.js path. The PowerShell script
rem  probes project-local, launcher-local, PATH and common install locations.
rem ==========================================================================

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "START_SCRIPT=%APP_DIR%\scripts\start-jingyin-board.ps1"

title Jingyin AI Drawing V11 Launcher

echo.
echo ========================================
echo  Jingyin AI Drawing V11 Launcher
echo ========================================
echo.
echo Source directory: %APP_DIR%
echo.

if not exist "%START_SCRIPT%" (
  echo [ERROR] Launcher script not found:
  echo   %START_SCRIPT%
  echo.
  echo Make sure this .bat file sits next to the V11 source root and that
  echo scripts\start-jingyin-board.ps1 exists.
  echo.
  pause
  exit /b 1
)

rem Prefer PowerShell 7 (pwsh); fall back to Windows PowerShell 5.1.
set "PS_EXE="
where pwsh.exe >nul 2>nul && set "PS_EXE=pwsh.exe"
if not defined PS_EXE (
  where powershell.exe >nul 2>nul && set "PS_EXE=powershell.exe"
)
if not defined PS_EXE (
  if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
)

if not defined PS_EXE (
  echo [ERROR] PowerShell was not found on this machine.
  echo   Windows PowerShell 5.1 or PowerShell 7 is required.
  echo.
  pause
  exit /b 1
)

echo Using PowerShell: %PS_EXE%
echo Probing for Node.js and starting the local server...
echo.

rem Working directory is pinned to the source root; extra args are passed through.
pushd "%APP_DIR%"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%START_SCRIPT%" %*
set "START_EXIT=%ERRORLEVEL%"
popd

echo.
if not "%START_EXIT%"=="0" (
  echo ========================================
  echo  STARTUP FAILED
  echo ========================================
  echo Exit code: %START_EXIT%
  echo   1 = server failed to start ^(Node error, port never listened, or health check failed^)
  echo   2 = no usable Node.js found
  echo   3 = port is listening but /api/health did not pass
  echo   other = the real exit code reported by the Node process
  echo.
  echo Diagnostic report: %APP_DIR%\logs\launcher-diagnostic.log
  echo Server error log : %APP_DIR%\logs\launcher-server.err.log
  echo.
  echo The window is kept open so the reason above stays visible. Press any key to close.
  pause >nul
  exit /b %START_EXIT%
)

echo ========================================
echo  STARTED
echo ========================================
echo Use the URL printed above. If the browser did not open automatically,
echo copy that URL into the browser yourself.
echo.
echo This window closes in 8 seconds. Press any key to keep it open.
timeout /t 8 >nul 2>nul

endlocal
exit /b 0
