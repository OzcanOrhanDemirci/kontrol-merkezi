@echo off
rem Kontrol Merkezi penceresini RTSS'in (RivaTuner) kancasinin disinda tutar: RTSS'e msedgewebview2.exe icin
rem "kanca yok" profili ekler (Global profilin kopyasi, yalniz EnableHooking=0). Diger programlar etkilenmez.
rem Geri almak: bu dosyayi "geri" argumaniyla calistir (profil silinir). Ozcan'in onayiyla calistirilir.
rem Sonra RTSS'i kapatip acin (ya da bilgisayari yeniden baslatin); dogrulama: araclar\donma-testi.ps1
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
    if "%~1"=="" (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs") else (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs")
    exit /b
)
set "RTSS=C:\Program Files (x86)\RivaTuner Statistics Server\Profiles"
set "PROFIL=%RTSS%\msedgewebview2.exe.cfg"
if /i "%1"=="geri" (
    if exist "%PROFIL%" del "%PROFIL%"
    echo RTSS istisnasi kaldirildi.
    pause
    exit /b
)
if not exist "%RTSS%\Global" (
    echo RTSS profil klasoru bulunamadi: %RTSS%
    pause
    exit /b 1
)
powershell -NoProfile -Command "$g = Get-Content -LiteralPath '%RTSS%\Global'; $o = $g -replace '^EnableHooking=1$', 'EnableHooking=0'; Set-Content -LiteralPath '%PROFIL%' -Value $o -Encoding Ascii; Select-String -LiteralPath '%PROFIL%' -Pattern '^EnableHooking='"
echo RTSS istisnasi yazildi: %PROFIL%
pause
