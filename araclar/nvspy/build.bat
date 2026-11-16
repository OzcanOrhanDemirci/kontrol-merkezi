@echo off
rem Builds the two logging proxies from one source: x64 nvapi64.dll (out\x64) and x86 nvapi.dll (out\x86).
cd /d "%~dp0"
if not exist out\x64 mkdir out\x64
if not exist out\x86 mkdir out\x86
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cl /nologo /O2 /W3 /LD nvspy.c /Foout\x64\ /link /DEF:nvspy64.def /OUT:out\x64\nvapi64.dll || exit /b 1
endlocal
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars32.bat" >nul
cl /nologo /O2 /W3 /LD nvspy.c /Foout\x86\ /link /DEF:nvspy32.def /OUT:out\x86\nvapi.dll || exit /b 1
endlocal
