@echo off
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server.server\.js' }; if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; 'EdgeLoop stopped.' } else { 'EdgeLoop was not running.' }"
ping -n 4 127.0.0.1 >nul
