@echo off
rem Builds izle.exe (the read-only debugger watcher) and nvtest.exe (its harmless test target), x86, into out\izle.
cd /d "%~dp0"
if not exist out\izle mkdir out\izle
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars32.bat" >nul
cl /nologo /O2 /W3 /DUNICODE /D_UNICODE izle.c /Foout\izle\ /Feout\izle\izle.exe /link psapi.lib advapi32.lib || exit /b 1
cl /nologo /O2 /W3 nvtest.c /Foout\izle\ /Feout\izle\nvtest.exe || exit /b 1
