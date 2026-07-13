@echo off
:: etteum.cmd - Wrapper to call etteum.ps1 from CMD/prompt
:: Usage: etteum start|stop|restart|status|logs|build|dev|migrate|update
::
:: Prefers the shim next to this .cmd (install puts both in ~/.local/bin).
:: Project root is resolved by etteum.ps1 via ETTEUM_HOME / etteum.home pointer.

set "SCRIPT_DIR=%~dp0"

if exist "%SCRIPT_DIR%etteum.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%etteum.ps1" %*
    exit /b %ERRORLEVEL%
)

:: Home pointer written by install.ps1 (one path per line)
if exist "%SCRIPT_DIR%etteum.home" (
    set /p ETTEUM_FROM_POINTER=<"%SCRIPT_DIR%etteum.home"
    if defined ETTEUM_FROM_POINTER if exist "%ETTEUM_FROM_POINTER%\etteum.ps1" (
        powershell -NoProfile -ExecutionPolicy Bypass -File "%ETTEUM_FROM_POINTER%\etteum.ps1" %*
        exit /b %ERRORLEVEL%
    )
)

if defined ETTEUM_HOME if exist "%ETTEUM_HOME%\etteum.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%ETTEUM_HOME%\etteum.ps1" %*
    exit /b %ERRORLEVEL%
)

if exist "%USERPROFILE%\.config\etteum\home" (
    set /p ETTEUM_FROM_POINTER=<"%USERPROFILE%\.config\etteum\home"
    if defined ETTEUM_FROM_POINTER if exist "%ETTEUM_FROM_POINTER%\etteum.ps1" (
        powershell -NoProfile -ExecutionPolicy Bypass -File "%ETTEUM_FROM_POINTER%\etteum.ps1" %*
        exit /b %ERRORLEVEL%
    )
)

set "DEFAULT_DIR=%USERPROFILE%\etteum-pool"
if exist "%DEFAULT_DIR%\etteum.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%DEFAULT_DIR%\etteum.ps1" %*
    exit /b %ERRORLEVEL%
)

echo Error: Could not find etteum.ps1
echo Re-run install.ps1, or set ETTEUM_HOME to your install folder.
exit /b 1
