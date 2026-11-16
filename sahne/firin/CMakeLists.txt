cmake_minimum_required(VERSION 3.26)
project(salon LANGUAGES C CXX)

# salon.exe: the hall's builder and oven (docs/SALON.md). Host C++ only; the OptiX programs in device/ are compiled at
# run time by NVRTC, as in pc_graphics. The toolchain (CUDA, OptiX, cgltf, stb) comes from pc_graphics' third_party.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT DEFINED PCG_TP)
    set(PCG_TP C:/dev/pc_graphics/third_party)
endif()

file(GLOB SALON_SRC CONFIGURE_DEPENDS src/*.cpp src/kit/*.cpp src/scene/*.cpp)
# third party: xatlas (MIT, vendored in third_party/xatlas), miniz (MIT, pc_graphics third_party/tinyexr)
add_executable(salon ${SALON_SRC} third_party/xatlas/xatlas.cpp ${PCG_TP}/tinyexr/miniz.c)
target_include_directories(salon PRIVATE src third_party/xatlas ${PCG_TP}/cuda/include ${PCG_TP}/optix/include ${PCG_TP}/cgltf
                                         ${PCG_TP}/stb ${PCG_TP}/tinyexr)
target_compile_definitions(salon PRIVATE SALON_ROOT="${CMAKE_SOURCE_DIR}" SALON_THIRD_PARTY="${PCG_TP}" NOMINMAX _SILENCE_CXX20_U8PATH_DEPRECATION_WARNING
                                         WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
if(MSVC)
    target_compile_options(salon PRIVATE /W3 /O2 /utf-8 /wd4244 /wd4267 /wd4305 /openmp)
endif()
target_link_libraries(salon PRIVATE ${PCG_TP}/cuda/lib/x64/cudart_static.lib ${PCG_TP}/cuda/lib/x64/cuda.lib
                                    ${PCG_TP}/cuda/lib/x64/nvrtc.lib advapi32)
add_custom_command(TARGET salon POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${PCG_TP}/cuda/bin/x64/nvrtc64_130_0.dll
            ${PCG_TP}/cuda/bin/x64/nvrtc-builtins64_134.dll $<TARGET_FILE_DIR:salon>)
