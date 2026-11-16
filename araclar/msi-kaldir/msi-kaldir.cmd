@echo off
rem MSI Center'i ve kanitin geride biraktiklarini kaldirir. Karta hicbir sey gondermez. Tek UAC.
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
title MSI Center kaldiriliyor - pencere kendisi kapanir
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msi-kaldir.ps1"
echo.
echo Bitti. Pencere 10 saniye sonra kapanir.
timeout /t 10 >nul
