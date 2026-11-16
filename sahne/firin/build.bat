@echo off
rem Configures (first time) and builds salon.exe into sahne\firin\build\. MSVC from VS 2026, CMake + Ninja from VS.
rem Needs C:\dev\pc_graphics\third_party (CUDA, OptiX, cgltf, stb).
setlocal
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 || exit /b 1
set VSCM=C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake
set PATH=%VSCM%\CMake\bin;%VSCM%\Ninja;%PATH%
cd /d %~dp0
if not exist build\build.ninja (
  cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release || exit /b 1
)
cmake --build build || exit /b 1
