// The oven: light map atlas, OptiX path tracing of every texel and every volume cell, per light group, and the pack.
// Method and lessons from pc_graphics' Denizaltı oven (C:/dev/pc_graphics/src/scenes/denizalti/dz_bake.*, dz_atlas.*,
// docs/denizalti/DURUM.md); formats in docs/SALON.md ("The pack").
#pragma once
#include "scene.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace salon {

struct BakeOptions {
    int samples = 1024;        // paths per texel
    int volSamples = 512;      // per volume cell
    int bounces = 8;
    float clamp = 0.0f;        // the indirect light's firefly clamp (one path's luminance); 0: from the brightest surface
    float texelScale = 1.0f;   // multiplies texelFor (a quick preview bakes coarser)
    int atlasWidth = 8192;
    int pages = 0;             // 0: as many as needed
    bool filter = true;        // the edge-keeping filter inside each chart
    bool compress = true;      // the pack's binaries as zlib streams (<name>.bin.z), docs/SALON.md "The pack"
    std::string root;          // sahne/firin (to find device/*.cu for NVRTC)
    std::string thirdParty;    // C:/dev/pc_graphics/third_party (OptiX and CUDA headers for NVRTC)
};

struct Atlas {
    // a chart's rectangle on its page (texels, padding included) and its density (metres per texel)
    struct Chart { int page = -1, x = 0, y = 0, w = 0, h = 0; float texel = 0; };
    int width = 0, height = 0, pages = 0;
    int pad = 2;
    size_t usedTexels = 0;     // texels inside triangles (after rasterising: the baked ones)
    std::vector<Chart> charts; // by chart id (unused ids: page -1)
};

// Packs the charts of s.mesh at their density (texelFor × texelScale), writes every vertex's uv2 and page
// (Vtx.uv2; the page in the chart table), pages of width × height.
Atlas buildAtlas(Scene& s, const BakeOptions& o, std::vector<int>& chartPage);

struct Baked {
    Atlas atlas;
    // per page, per group: plane A (RGBA16F) and plane B (RGBA8), docs/SALON.md "Light map pages"
    std::vector<std::vector<uint16_t>> planeA;   // [page * groups + group]
    std::vector<std::vector<uint8_t>> planeB;
    // per volume, per group: grid M and grid F (RGBA16F)
    std::vector<std::vector<uint16_t>> volM, volF;   // [volume * groups + group]
    double seconds = 0.0;
    size_t invalidValues = 0;          // NaN, Inf or beyond half float's range, replaced (should be 0)
    float clampUsed[GROUP_COUNT] = {}; // the firefly clamp each group was baked with
};

bool bake(const Scene& s, const Atlas& a, const std::vector<int>& chartPage, const BakeOptions& o, Baked& out,
          std::string& err, const std::function<void(float, const std::string&)>& progress = {});

// writes sahne.json, geo.bin, rotor files, lm_<page>.bin, vol_<name>.bin into dir
bool writePack(const std::string& dir, const Scene& s, const Atlas& a, const std::vector<int>& chartPage,
               const Baked* baked, const BakeOptions& o, std::string& err);

uint16_t toHalf(float f);
float fromHalf(uint16_t h);

}   // namespace salon
