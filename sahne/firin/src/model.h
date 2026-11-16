// Models from Poly Haven (glTF with a separate .bin and 2K textures) into the scene.
#pragma once
#include "scene.h"

#include <string>
#include <vector>

namespace salon {

// Appends the model's triangles (placed by t after `scale`) to s.mesh and its materials to s.mats: texture paths
// relative to sahne/varlik (the model must lie below it), uvScale 1, meanAlbedo from the albedo image (sRGB decoded,
// mean, times the base colour factor). Light map charts from xatlas: chart-local coordinates in metres in uv2, new chart
// ids. The glTF's emissive texture is recorded, but the material is not made emissive: the builder gives it a group,
// an emitScale and the matching emitter. `nodes`: only these mesh nodes (by name; empty: all), each at its place in
// the glTF's scene (a modular kit's pieces lie side by side: the caller moves the piece's origin to its own). A model
// placed several times shares its materials (rows of s.mats compared by name, maps and constants). An ARM map without
// occlusion in its red channel is replaced by a copy with red = 1 (the renderer multiplies diffuse light by it).
bool importModel(Scene& s, const std::string& gltfPath, const dz::Xform& t, float scale, std::string& err,
                 const std::vector<std::string>& nodes = {});

}   // namespace salon
