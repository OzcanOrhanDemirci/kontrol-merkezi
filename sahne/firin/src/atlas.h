// The light map's texels: where each one lies on the surface (the oven's starting points) and the padding around the
// charts. Ported from pc_graphics' Denizaltı (dz_atlas.cpp); buildAtlas itself is declared in bake.h.
#pragma once
#include "bake.h"

#include <cstdint>
#include <vector>

namespace salon {

// one texel the oven lights
struct Texel {
    float3 p, n;        // on the surface; the shading normal there
    float footprint;    // its side on the surface (m): the oven spreads its samples over it
    uint32_t pixel;     // y * width + x on its page
    uint32_t chart;
    uint32_t mat;
};

struct Raster {
    std::vector<int32_t> index;   // page pixel -> its texel (-1: none)
    std::vector<Texel> texels;
};

// The texels of one page: centres inside a triangle, or within half a texel of one (a chart's rim is lit too); at most
// one per pixel, the triangle that holds it best
Raster rasterise(const Scene& s, const Atlas& a, const std::vector<int>& chartPage, int page);

// The padding: every empty pixel of a chart's rectangle next to texels of that chart takes their mean, a.pad times, so
// bilinear (and bicubic) reads at a chart's rim never mix in empty texels or another chart. values: `channels` floats
// per texel of r; the new pixels are appended to r.texels and values.
void dilate(const Atlas& a, int page, Raster& r, std::vector<float>& values, int channels);

}   // namespace salon
