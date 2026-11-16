@echo off
setlocal
title ZbrePrinter - Send Test ZPL over TCP

if "%~1"=="" goto interactive
if "%~2"=="" goto host_only

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Send-ZPL-TCP.ps1" -PrinterHost "%~1" -Port %~2 -FilePath "%~dp0test-label.zpl"
exit /b %ERRORLEVEL%

:host_only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Send-ZPL-TCP.ps1" -PrinterHost "%~1" -FilePath "%~dp0test-label.zpl"
exit /b %ERRORLEVEL%

:interactive
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Send-ZPL-TCP.ps1" -FilePath "%~dp0test-label.zpl"
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
