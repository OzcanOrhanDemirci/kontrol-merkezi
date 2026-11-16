// salon.exe dump: the scene as plain binaries + JSON for checking it (sahne/araclar/geo_onizle.py); not the pack.
#pragma once
#include "scene.h"

#include <string>

namespace salon {

// writes DIR/dump.json, DIR/static.bin and DIR/<rotor>.bin (format KGD1: header uint32 magic, vertices, indices,
// stride; per vertex 12 float32: position, normal, uv0, uv2, material, chart; then uint32 indices)
bool dumpScene(const Scene& s, const std::string& dir, std::string& err);

}   // namespace salon
