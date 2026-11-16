@echo off
rem nvspy kayitcisini Mystic Light'in yanina koyar (yerlestir.cmd) ya da kaldirir (yerlestir.cmd kaldir). Tek UAC.
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%1' -Verb RunAs"
    exit /b
)
set "IS=kur"
if /i "%1"=="kaldir" set "IS=kaldir"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0yerlestir.ps1" -Is %IS%
