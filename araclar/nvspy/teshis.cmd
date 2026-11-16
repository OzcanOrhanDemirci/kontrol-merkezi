@echo off
rem Salt okuma teshis: hangi MSI sureci hangi nvapi/NDA modulunu nereden yukledi. Tek UAC, hicbir sey degistirmez.
net session >nul 2>&1
if %errorlevel% neq 0 (
    if "%~1"=="" (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs") else (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs")
    exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0teshis.ps1"
