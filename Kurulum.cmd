@echo off
rem Kontrol Merkezi kurulumu: cift tikla (ya da sag tik > Yonetici olarak calistir). Tek bir UAC "Evet" ister.
rem Hazir derlenmis bin\Release'i kurar (derleme gerekmez); ayrinti kur.ps1'de, sonuc kur-gunluk.txt'de.
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kur.ps1"
echo.
pause
