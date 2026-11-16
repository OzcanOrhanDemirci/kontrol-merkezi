@echo off
rem MSI Center hizmetlerini durdurur ve devre disi birakir (msi-durdur.cmd), ya da eski haline getirir (msi-durdur.cmd geri).
rem Karta hicbir sey gondermez. Tek UAC.
net session >nul 2>&1
if %errorlevel% neq 0 (
    if "%~1"=="" (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs") else (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs")
    exit /b
)
set "IS=durdur"
if /i "%~1"=="geri" set "IS=geri"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msi-durdur.ps1" -Is %IS%
