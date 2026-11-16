// The oven: what the host (bake.cpp) and the device program (device/salon_bake.cu, NVRTC) share.
#pragma once
#include "kit/vec.h"

#if !defined(__CUDACC_RTC__)
#include <optix_types.h>
#endif

#define SALON_GROUPS 3   // = salon::GROUP_COUNT (checked in bake.cpp)

enum BakeLightType : unsigned { BL_RECT = 0, BL_SPHERE = 1, BL_DISC = 2 };

struct BakeLight {
    float3 c, u, v, n;   // centre; RECT: half axes; DISC: u = a radius vector; n: the emitting side (unit)
    float r;             // SPHERE radius
    float L;             // radiance (along n for RECT and DISC)
    float lobe;          // radiance L·cos^(lobe-1) about n (>= 1)
    unsigned type, group;
};

enum BakeMatFlag : unsigned {
    BM_EMISSIVE = 1u,    // paths end on it (its light is the matching emitter's, counted by next-event estimation)
};
struct BakeMat {
    float3 albedo;       // the mean linear albedo light bounces with
    unsigned flags;      // BakeMatFlag
};

// a rotor: in the oven a disc letting `transmit` of the light through, the rest meets a blade
struct BakeRotor {
    float3 c, axis;
    float r, transmit;
    float3 albedo;
};

// one texel's or one volume cell's sums over its samples
//   texel: l0 = sum of radiance x Y0 (rgb), l1 = sum of luminance x Y1 x direction; open, openW: cosine-weighted
//          openness within 0.5 m and its weight
//          e = sum of the direct irradiance (pass 1: what the texel sends on as a secondary light)
//   cell:  l0 = sum of radiance / 4pi-weighted (M), l1 = luminance flux (F); open: 1 open air, 0 inside geometry
struct BakeAccum {
    float l0[SALON_GROUPS][3];
    float l1[SALON_GROUPS][3];
    float e[SALON_GROUPS];
    float open, openW;
};

struct SalonParams {
    OptixTraversableHandle handle;
    const float4* vtxN;        // per vertex: the shading normal
    const uint3* idx;          // per triangle of the ray structure
    const unsigned* triMat;
    const float2* vtxUV2;      // per vertex: the light map coordinates (the secondary lights' pdf where a ray hits)
    const unsigned* triPage;   // per triangle: its light map page
    const BakeMat* mats;
    const BakeLight* lights;
    const BakeRotor* rotors;
    unsigned lightCount, rotorCount;
    float4* texP;              // per texel of the batch: position, w = its footprint (m) (__raygen__place moves it)
    float4* texN;              // normal, w: 1 if __raygen__place moved it
    BakeAccum* acc;
    unsigned count;            // texels (cells) in the batch
    unsigned seedBase;         // the batch's first texel's (cell's) global index: it seeds the sequences
    unsigned salt;             // and the pass (pass 1 and pass 2 draw different numbers)
    unsigned sampleBase;       // the first sample of this launch (the sequence continues across launches)
    unsigned samples;          // samples in this launch
    unsigned maxBounces;
    float clampLum[SALON_GROUPS];   // one indirect path's luminance at most, per group (the firefly clamp)
    float sigma;               // the medium's extinction (1/m)
    // the secondary lights (pass 2): directly lit texels picked by power (Walker's alias table)
    const float4* secP;        // position, w = the texel's side (m)
    const float4* secN;        // normal, w = the pdf by area of a point on it (probability / area)
    const float4* secL;        // [texel * groups + group]: the radiance it sends (its direct light reflected)
    const float* secProb;
    const unsigned* secAlias;
    unsigned secCount;         // 0: none (pass 1)
    const int* secMap;         // per page and pixel: the texel's index in the table (-1: not a secondary light)
    unsigned mapW, mapH;
    float3 volLo;              // the volume pass: lower corner, cell size, cells
    float volCell;
    uint3 volDim;
};
