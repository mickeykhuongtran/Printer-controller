@echo off
setlocal
title ZbrePrinter - Test Printer TCP Port

if "%~1"=="" goto interactive
if "%~2"=="" goto host_only

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Test-Printer-TCP.ps1" -PrinterHost "%~1" -Port %~2
exit /b %ERRORLEVEL%

:host_only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Test-Printer-TCP.ps1" -PrinterHost "%~1"
exit /b %ERRORLEVEL%

:interactive
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Test-Printer-TCP.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
