@echo off
rem MSI'in isik surecini (LEDKeeper2.exe) salt okuma izler: MSI'in ekran kartina gonderdigi I2C yazma/okumalarini
rem kaydeder, hicbirini degistirmez, karta kendisi hicbir sey gondermez. Tek UAC. Durdurmak: pencerede Ctrl+C ya da
rem C:\ProgramData\KontrolMerkezi-nvspy\dur dosyasi; en gec 30 dakikada kendiliginden ayrilir.
rem Kayit: C:\ProgramData\KontrolMerkezi-nvspy\izle-SSDDss.txt
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
title Kontrol Merkezi - MSI isik izleme (salt okuma)
"%~dp0out\izle\izle.exe" LEDKeeper2.exe 30
echo.
echo Izleme bitti. Pencereyi kapatabilirsiniz.
pause
