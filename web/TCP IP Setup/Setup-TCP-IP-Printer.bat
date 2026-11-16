@echo off
setlocal
title ZbrePrinter - Setup Windows TCP/IP Printer

echo This operation creates a Windows Standard TCP/IP Port and printer queue.
echo It must be run with Administrator rights.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-TCP-IP-Printer.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo Setup failed. Review the error above and TCP IP Setup\README.md.
) else (
    echo Setup completed successfully.
)
pause
exit /b %EXIT_CODE%
