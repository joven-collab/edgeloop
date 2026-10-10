@echo off
setlocal
set "LOOP_DIR=%~dp0"
set "STASH_DIR="

rem Optional: "stashDir" in loop.config.json lets this also start Stash.
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "try { (Get-Content -Raw '%LOOP_DIR%loop.config.json' | ConvertFrom-Json).stashDir } catch {}"`) do set "STASH_DIR=%%D"

tasklist /FI "IMAGENAME eq stash-win.exe" 2>nul | find /I "stash-win.exe" >nul
if not errorlevel 1 (
    echo Stash is already running.
) else if not defined STASH_DIR (
    echo Start Stash yourself, or set "stashDir" in loop.config.json to have it started here.
) else if not exist "%STASH_DIR%\stash-win.exe" (
    echo stash-win.exe is not in "%STASH_DIR%". Check "stashDir" in loop.config.json.
) else (
    echo Starting Stash...
    powershell -NoProfile -Command "Start-Process -FilePath '%STASH_DIR%\stash-win.exe' -ArgumentList '--nobrowser' -WorkingDirectory '%STASH_DIR%' -WindowStyle Hidden"
)

powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server.server\.js' }) { exit 1 } else { exit 0 }"
if errorlevel 1 (
    echo EdgeLoop is already running at http://localhost:8420/
) else (
    echo Starting EdgeLoop...
    powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'server\server.js' -WorkingDirectory '%LOOP_DIR%' -WindowStyle Hidden"
    echo EdgeLoop is running at http://localhost:8420/
)
ping -n 4 127.0.0.1 >nul
