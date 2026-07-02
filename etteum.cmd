@echo off
:: etteum.cmd - Wrapper to call etteum.ps1 from CMD/prompt
:: Usage: etteum start|stop|restart|status|logs|build|dev|migrate

:: Resolve the real location of this script (follow symlinks)
set "SCRIPT_DIR=%~dp0"

:: Check if etteum.ps1 is in the same directory
if exist "%SCRIPT_DIR%etteum.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%etteum.ps1" %*
    exit /b %ERRORLEVEL%
)

:: Otherwise, check default install location
set "DEFAULT_DIR=%USERPROFILE%\etteum-pool"
if exist "%DEFAULT_DIR%\etteum.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%DEFAULT_DIR%\etteum.ps1" %*
    exit /b %ERRORLEVEL%
)

echo Error: Could not find etteum.ps1
echo Make sure Etteum Pool is installed.
exit /b 1
