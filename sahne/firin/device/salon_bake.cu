// The hall's oven (OptiX 9.1, compiled at run time by NVRTC). Ported from pc_graphics' Denizaltı oven
// (src/scenes/denizalti/device/dz_bake.cu) and extended: light groups, rectangle and disc emitters with a lobe, a
// homogeneous medium, rotors as stochastic discs. docs/SALON.md "The pack" has the quantities.
//   one thread per texel (or volume cell) of a batch, `samples` paths each:
//   direct light: next-event estimation to every emitter, shadow rays (a grate casts crisp shadows)
//   the rest: one path per sample, every bounce lit by every emitter again, Russian roulette after the third;
//   every path carries all light groups at once (light transport is linear in each group's emission)
// Deterministic: every random number is a hash of the texel's (cell's) global index and the sample's; no state.
#include <optix.h>

#include "bake_shared.h"

extern "C" {
__constant__ SalonParams params;
}

#define Y0 0.282095f
#define Y1 0.488603f
#define EPS 3e-4f   // ray origins off the surface (m): above float precision anywhere in a 300 m hall

static __forceinline__ __device__ unsigned pcg(unsigned v) {
    const unsigned s = v * 747796405u + 2891336453u;
    const unsigned w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
struct Rng {
    unsigned s;
    __device__ float next() {
        s = pcg(s);
        return float(s >> 8) * (1.0f / 16777216.0f);
    }
};
static __forceinline__ __device__ float unit(unsigned h) { return float(h >> 8) * (1.0f / 16777216.0f); }

static __forceinline__ __device__ float lum(float3 c) { return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z; }

static __forceinline__ __device__ float3 cosineDir(float3 n, float u1, float u2) {
    float3 t, b;
    makeBasis(n, t, b);
    const float r = sqrtf(u1), ph = 2.0f * M_PIf * u2;
    return normalize(t * (r * cosf(ph)) + b * (r * sinf(ph)) + n * sqrtf(fmaxf(0.0f, 1.0f - u1)));
}

struct Hit {
    float t;
    float3 p, n, ng;   // ng: the geometric normal, as wound
    unsigned mat, prim;
    float2 bc;         // barycentrics in the triangle
    bool front, rotor;
};

static __forceinline__ __device__ bool trace(float3 o, float3 d, float tmax, Hit& h) {
    optixTraverse(params.handle, o, d, 0.0f, tmax, 0.0f, OptixVisibilityMask(1u), OPTIX_RAY_FLAG_DISABLE_ANYHIT, 0, 1, 0);
    if (!optixHitObjectIsHit()) return false;
    const unsigned prim = optixHitObjectGetPrimitiveIndex();
    const float2 bc = optixHitObjectGetTriangleBarycentrics();
    float3 v[3];
    optixHitObjectGetTriangleVertexData(v);
    const uint3 tri = params.idx[prim];
    const float4 n0 = params.vtxN[tri.x], n1 = params.vtxN[tri.y], n2 = params.vtxN[tri.z];
    const float w0 = 1.0f - bc.x - bc.y;
    h.t = optixHitObjectGetRayTmax();
    h.p = o + d * h.t;
    h.ng = normalize(cross(v[1] - v[0], v[2] - v[0]));
    h.n = normalize(make_float3(n0.x * w0 + n1.x * bc.x + n2.x * bc.y, n0.y * w0 + n1.y * bc.x + n2.y * bc.y,
                                n0.z * w0 + n1.z * bc.x + n2.z * bc.y));
    h.mat = params.triMat[prim];
    h.prim = prim;
    h.bc = bc;
    h.front = dot(d, h.ng) < 0.0f;
    h.rotor = false;
    return true;
}

static __forceinline__ __device__ bool blocked(float3 o, float3 d, float tmax) {
    optixTraverse(params.handle, o, d, 0.0f, tmax, 0.0f, OptixVisibilityMask(1u),
                  OPTIX_RAY_FLAG_DISABLE_ANYHIT | OPTIX_RAY_FLAG_TERMINATE_ON_FIRST_HIT, 0, 1, 0);
    return optixHitObjectIsHit();
}

// where the ray crosses a rotor's disc (tmax: none)
static __forceinline__ __device__ float discHit(const BakeRotor& r, float3 o, float3 d, float tmax) {
    const float den = dot(r.axis, d);
    if (fabsf(den) < 1e-7f) return tmax;
    const float t = dot(r.c - o, r.axis) / den;
    if (t <= EPS || t >= tmax) return tmax;
    const float3 q = o + d * t - r.c;
    return dot(q, q) < r.r * r.r ? t : tmax;
}

// the share of light passing from o along d for tmax: 0 behind geometry, else the rotors' transmission
static __forceinline__ __device__ float transmittance(float3 o, float3 d, float tmax) {
    if (blocked(o, d, tmax)) return 0.0f;
    float tr = 1.0f;
    for (unsigned i = 0; i < params.rotorCount; ++i)
        if (discHit(params.rotors[i], o, d, tmax) < tmax) tr *= params.rotors[i].transmit;
    return tr * expf(-params.sigma * tmax);
}

// where a ray from p along w meets a rectangle's or disc's face, inside it: the distance
static __forceinline__ __device__ bool hitFace(const BakeLight& l, float3 p, float3 w, float& t) {
    const float den = dot(w, l.n);
    if (den >= 0.0f) return false;   // only the emitting side faces the ray
    t = dot(l.c - p, l.n) / den;
    if (t <= 0.0f) return false;
    const float3 q = p + w * t - l.c;
    if (l.type == BL_DISC) return dot(q, q) <= dot(l.u, l.u);
    const float uu = dot(l.u, l.u), vv = dot(l.v, l.v);
    return fabsf(dot(q, l.u)) <= uu && fabsf(dot(q, l.v)) <= vv;
}

// One sample of an emitter from p: the direction w, the distance, and radiance / pdf (solid angle) in `value`.
// A sphere: the cone of directions it fills, uniformly (Denizaltı's lamps). A rectangle or a disc of radiance
// L cos^(lobe-1): two strategies in one-sample MIS (balance heuristic): a point uniform on its area (good for a small
// emitter), or a direction from its lobe (good for a collimated one: a shaft's emitter as large as the well with a lobe
// of thousands casts the grate's bars crisp, and by area almost every sample would fall where it does not shine).
// u3 picks the strategy, with the share the emitter's solid angle and the lobe's suggest.
static __forceinline__ __device__ bool sampleLight(const BakeLight& l, float3 p, float u1, float u2, float u3, float3& w, float& value,
                                                   float& dist) {
    if (l.type == BL_SPHERE) {
        const float3 dc = l.c - p;
        const float d2 = dot(dc, dc);
        if (d2 <= l.r * l.r * 1.0001f) return false;
        const float dl = sqrtf(d2), sin2 = l.r * l.r / d2, cosMax = sqrtf(fmaxf(0.0f, 1.0f - sin2));
        const float oneMinus = sin2 / (1.0f + cosMax);   // 1 - cosMax without cancellation
        const float ct = 1.0f - u1 * oneMinus, st = sqrtf(fmaxf(0.0f, 1.0f - ct * ct)), ph = 2.0f * M_PIf * u2;
        float3 t, b;
        const float3 wc = dc / dl;
        makeBasis(wc, t, b);
        w = normalize(t * (st * cosf(ph)) + b * (st * sinf(ph)) + wc * ct);
        const float proj = dl * ct;
        dist = proj - sqrtf(fmaxf(0.0f, l.r * l.r - (d2 - proj * proj)));
        value = l.L * (2.0f * M_PIf * oneMinus);
        return true;
    }
    const float height = dot(p - l.c, l.n);   // in front of the emitting side
    if (height <= 0.0f) return false;
    const float area = l.type == BL_RECT ? 4.0f * length(cross(l.u, l.v)) : M_PIf * dot(l.u, l.u);
    const float k = l.lobe - 1.0f;
    // the strategies' shares: the emitter's solid angle from p (roughly) against the lobe's
    const float3 dc = l.c - p;
    const float dc2 = dot(dc, dc);
    const float omegaArea = fminf(2.0f * M_PIf, area * height / (dc2 * sqrtf(dc2))), omegaLobe = 2.0f * M_PIf / (k + 1.0f);
    const float c = clampf(omegaLobe / (omegaLobe + omegaArea), 0.02f, 0.98f);   // the area strategy's share
    float cl;
    if (u3 < c) {   // a point on the area
        float3 q;
        if (l.type == BL_RECT) {
            q = l.c + l.u * (2.0f * u1 - 1.0f) + l.v * (2.0f * u2 - 1.0f);
        } else {
            float3 t, b;
            makeBasis(l.n, t, b);
            const float rr = length(l.u) * sqrtf(u1), ph = 2.0f * M_PIf * u2;
            q = l.c + t * (rr * cosf(ph)) + b * (rr * sinf(ph));
        }
        const float3 dq = q - p;
        const float d2 = dot(dq, dq);
        if (d2 < 1e-10f) return false;
        dist = sqrtf(d2);
        w = dq / dist;
        cl = dot(l.n, -w);
        if (cl <= 0.0f) return false;
    } else {   // a direction from the lobe (pdf (k+1)/2pi cos^k about n), followed to the face
        const float oneMinusCos = -expm1f(logf(fmaxf(u1, 1e-30f)) / (k + 1.0f));   // 1 - u^(1/(k+1)), precise near 1
        const float ct = 1.0f - oneMinusCos, st = sqrtf(fmaxf(0.0f, oneMinusCos * (2.0f - oneMinusCos))), ph = 2.0f * M_PIf * u2;
        float3 t, b;
        makeBasis(l.n, t, b);
        w = -normalize(t * (st * cosf(ph)) + b * (st * sinf(ph)) + l.n * ct);
        if (!hitFace(l, p, w, dist)) return false;
        cl = ct;
    }
    const float lobeK = k > 0.0f ? powf(cl, k) : 1.0f;
    const float pdfArea = dist * dist / (area * cl);
    const float pdfLobe = (k + 1.0f) * (0.5f * INV_PIf) * lobeK;
    value = l.L * lobeK / (c * pdfArea + (1.0f - c) * pdfLobe);
    return true;
}

// ---- the secondary lights: the directly lit texels of pass 1 as emitters (their direct light, reflected)

// the pdf (solid angle, seen from the ray's origin) with which the secondary strategy would have picked the point hit
// (0: not a secondary light)
static __forceinline__ __device__ float secondaryPdf(const Hit& h, float3 d) {
    if (params.secCount == 0 || h.rotor) return 0.0f;
    const uint3 tri = params.idx[h.prim];
    const float2 a = params.vtxUV2[tri.x], b = params.vtxUV2[tri.y], c = params.vtxUV2[tri.z];
    const float w0 = 1.0f - h.bc.x - h.bc.y;
    const float u = a.x * w0 + b.x * h.bc.x + c.x * h.bc.y, v = a.y * w0 + b.y * h.bc.x + c.y * h.bc.y;
    const unsigned px = min(unsigned(fmaxf(u, 0.0f) * float(params.mapW)), params.mapW - 1);
    const unsigned py = min(unsigned(fmaxf(v, 0.0f) * float(params.mapH)), params.mapH - 1);
    const int j = params.secMap[(size_t(params.triPage[h.prim]) * params.mapH + py) * params.mapW + px];
    if (j < 0) return 0.0f;
    return params.secN[j].w * h.t * h.t / fmaxf(fabsf(dot(h.n, d)), 1e-4f);
}

// one secondary light sample from x: a texel by power, a point on its footprint; the direction, the pdf (solid
// angle), and in L the radiance it sends towards x per group, times the transmittance (false: unseen)
static __forceinline__ __device__ bool sampleSecondary(float3 x, Rng& rng, float3& w, float& pdf, float3* L) {
    const float u1 = rng.next(), u2 = rng.next(), u3 = rng.next(), u4 = rng.next();
    unsigned j = min(unsigned(u1 * float(params.secCount)), params.secCount - 1);
    if (u2 >= params.secProb[j]) j = params.secAlias[j];
    const float4 P = params.secP[j], N = params.secN[j];
    const float3 n = make_float3(N.x, N.y, N.z);
    float3 t, b;
    makeBasis(n, t, b);
    const float3 z = make_float3(P.x, P.y, P.z) + n * EPS + t * ((u3 - 0.5f) * P.w) + b * ((u4 - 0.5f) * P.w);
    const float3 dz = z - x;
    const float d2 = dot(dz, dz);
    if (d2 < 1e-8f) return false;
    const float dist = sqrtf(d2);
    w = dz / dist;
    const float cz = dot(n, -w);
    if (cz <= 0.0f) return false;
    pdf = N.w * d2 / cz;
    const float tr = transmittance(x, w, dist * (1.0f - 1e-4f) - EPS);
    if (tr <= 0.0f) return false;
    for (int g = 0; g < SALON_GROUPS; ++g) {
        const float4 l = params.secL[size_t(j) * SALON_GROUPS + g];
        L[g] = make_float3(l.x, l.y, l.z) * tr;
    }
    return true;
}

// the radiance arriving at o from direction d (sampled with pdf pdfD), per group, not counting emitters seen directly
// (the direct estimator has them): a path, every bounce lit by every emitter and by a secondary light; the light a
// bounce reflects straight from an emitter and the secondary light from the vertex before are two estimates of the
// same light, weighted by MIS (balance heuristic)
static __forceinline__ __device__ void incoming(float3 o, float3 d, float pdfD, Rng& rng, float3* Li) {
    float3 beta = make_float3(1, 1, 1);
    for (unsigned bounce = 0; bounce < params.maxBounces; ++bounce) {
        Hit h;
        bool hit = trace(o, d, 1e5f, h);
        float nearest = hit ? h.t : 1e5f;
        // a rotor is not geometry: each disc the ray crosses before the hit stops it with 1 - transmit
        for (unsigned i = 0; i < params.rotorCount; ++i) {
            const BakeRotor& r = params.rotors[i];
            const float t = discHit(r, o, d, nearest);
            if (t < nearest && rng.next() >= r.transmit) {
                nearest = t;
                hit = true;
                h.t = t;
                h.p = o + d * t;
                h.n = h.ng = dot(d, r.axis) < 0.0f ? r.axis : -r.axis;
                h.front = true;
                h.rotor = true;
                h.mat = i;
            }
        }
        if (!hit) break;
        beta *= expf(-params.sigma * h.t);
        float3 albedo;
        if (h.rotor) {
            albedo = params.rotors[h.mat].albedo;
        } else {
            const BakeMat& mt = params.mats[h.mat];
            // an emitter's own surface; or a back face: inside a part. Two-sided materials too (glTF doubleSided is
            // set on closed props as often as not): lit as two-sided, paths in a solid's inside wandered between its
            // interpenetrating pieces, and which of two pieces at the same distance a ray met was the ray structure's
            // build order, different every run (the bake was no longer the same bytes)
            if ((mt.flags & BM_EMISSIVE) || !h.front) break;
            albedo = mt.albedo;
        }
        const float3 n = dot(h.n, h.ng) > 0.0f ? h.n : h.ng;
        const float3 x = h.p + h.ng * EPS;
        // the emitters' light reflected here, weighted against the secondary strategy of the vertex before
        const float wPath = pdfD / (pdfD + secondaryPdf(h, d));
        for (unsigned j = 0; j < params.lightCount; ++j) {
            const BakeLight& l = params.lights[j];
            float3 w;
            float value, dist;
            const float u1 = rng.next(), u2 = rng.next(), u3 = rng.next();
            if (!sampleLight(l, x, u1, u2, u3, w, value, dist)) continue;
            const float c = dot(n, w);
            if (c <= 0.0f) continue;
            const float tr = transmittance(x, w, dist - EPS);
            if (tr <= 0.0f) continue;
            Li[l.group] += beta * albedo * (value * tr * c * INV_PIf * wPath);
        }
        // a secondary light seen from here, weighted against the cosine-sampled continuation
        if (params.secCount) {
            float3 w, L[SALON_GROUPS];
            float pdf;
            if (sampleSecondary(x, rng, w, pdf, L)) {
                const float c = dot(n, w);
                if (c > 0.0f) {
                    const float k = c * INV_PIf / (pdf + c * INV_PIf);   // f cos / pdf, times the MIS weight
                    for (int g = 0; g < SALON_GROUPS; ++g) Li[g] += beta * albedo * L[g] * k;
                }
            }
        }
        beta *= albedo;
        if (bounce >= 2) {
            const float q = fminf(0.95f, maxc(beta) * 1.5f);
            if (rng.next() >= q) break;
            beta *= 1.0f / q;
        }
        o = x;
        d = cosineDir(n, rng.next(), rng.next());
        if (dot(d, h.ng) <= 0.0f) break;
        pdfD = dot(n, d) * INV_PIf;
    }
}

static __forceinline__ __device__ void addSH(BakeAccum& a, unsigned g, float3 c, float l, float3 w, float k0, float k1) {
    a.l0[g][0] += c.x * k0;
    a.l0[g][1] += c.y * k0;
    a.l0[g][2] += c.z * k0;
    a.l1[g][0] += w.x * l * k1;
    a.l1[g][1] += w.y * l * k1;
    a.l1[g][2] += w.z * l * k1;
}

// the per-group firefly clamp on one indirect path (each group alone: its bake is what a bake of that group alone gives)
static __forceinline__ __device__ void clampPath(float3* Li) {
    for (int g = 0; g < SALON_GROUPS; ++g) {
        const float l = lum(Li[g]);
        if (l > params.clampLum[g]) Li[g] *= params.clampLum[g] / l;
    }
}

// the secondary light arriving at an origin (a texel: normal n, the paths' pdf pdfPath; a cell: no normal), into the
// harmonics with k0, k1 (radiance / pdf, MIS-weighted against the origin's own path directions)
static __forceinline__ __device__ void secondaryAtOrigin(BakeAccum& acc, float3 x, const float3* n, float pdfPath, float k0, float k1, Rng& rng) {
    float3 w, L[SALON_GROUPS];
    float pdf;
    if (!sampleSecondary(x, rng, w, pdf, L)) return;
    if (n && dot(*n, w) <= 0.0f) return;
    clampPath(L);
    const float k = 1.0f / (pdf + pdfPath);   // (1 / pdf) x pdf / (pdf + pdfPath)
    for (int g = 0; g < SALON_GROUPS; ++g) {
        const float3 c = L[g] * k;
        addSH(acc, g, c, lum(c), w, k0, k1);
    }
}

// inside geometry: the nearest surface is a back face along half of six directions or more (an open mesh is not a
// solid). Where two parts meet flush a ray crossing the shared plane meets both faces at one distance and which it
// reports is the ray structure's choice: a point just inside one part, by the plane, has three rays that never cross
// it (two opposite rays, or "most of six", were a coin toss there)
// six rays from p: how many first meet a back face, and how many run farther than `reach` to a front face or to nothing
static __forceinline__ __device__ void probe(float3 p, float reach, int& back, int& free) {
    const float3 d[3] = {make_float3(0.57735f, 0.57735f, 0.57735f), make_float3(0.78868f, -0.21132f, -0.57735f),
                         make_float3(-0.21132f, 0.78868f, -0.57735f)};   // an orthonormal frame on the cube's diagonal
    back = free = 0;
    for (int k = 0; k < 6; ++k) {
        Hit h;
        if (!trace(p, k < 3 ? d[k] : -d[k - 3], 1e5f, h)) ++free;
        else if (!h.front) ++back;
        else if (h.t > reach) ++free;
    }
}
static __forceinline__ __device__ bool inside(float3 p) {
    int back, free;
    probe(p, 0.0f, back, free);
    return back >= 3;
}

// Where a texel's light is gathered (once per batch, before its samples): its centre lifted off the surface, or, if
// that lies inside another part, a point near it in open air. Two parts meeting flush (a wall piece's end face under
// the next piece, a wall standing on the floor) leave the rounded strip along the joint narrower than a texel and
// shaded from the texel of the hidden face: left inside, that texel baked black and every joint stood drawn as a
// black line. The candidates, within the texel's footprint: where a ray along one of the 26 directions of a cube's
// faces, edges and corners leaves the solid (lit with that surface's normal), and points slid along the texel's own
// plane, on either side of it (lit with its normal, or its reverse); the one with the most open air around it, then
// the nearest. Deeper inside (no candidate) the texel stays: hidden, black.
static __forceinline__ __device__ bool place(float3& o, float3& n, float3 p, float footprint) {
    int back, free;
    o = p + n * EPS;
    probe(o, 0.0f, back, free);
    if (back < 3) return false;
    float3 t, b;
    makeBasis(n, t, b);
    float bestD = 2.0f * footprint;
    int bestFree = -1;
    float3 bo = o, bn = n;
    auto consider = [&](float3 q, float3 qn, float d) {
        probe(q, footprint, back, free);
        if (back >= 3 || free < bestFree || (free == bestFree && d >= bestD)) return;
        bestFree = free;
        bestD = d;
        bo = q;
        bn = qn;
    };
    for (int k = 0; k < 27; ++k) {
        if (k == 13) continue;
        const float3 d = normalize(t * float(k % 3 - 1) + b * float(k / 3 % 3 - 1) + n * float(k / 9 - 1));
        Hit h;
        if (!trace(o, d, footprint, h) || h.front) continue;   // a back face: where the ray leaves the solid
        consider(h.p + h.ng * EPS, dot(h.n, h.ng) > 0.0f ? h.n : h.ng, h.t);
    }
    for (int k = 0; k < 24; ++k) {
        const float a = float(k % 8) * (0.25f * M_PIf), r = footprint * (k < 8 ? 0.25f : k < 16 ? 0.5f : 1.0f);
        const float3 q = p + (t * cosf(a) + b * sinf(a)) * r;
        consider(q + n * EPS, n, r);
        consider(q - n * EPS, -n, r);
    }
    o = bo;
    n = bn;
    return true;
}

extern "C" __global__ void __raygen__place() {
    const unsigned i = optixGetLaunchIndex().x;
    if (i >= params.count) return;
    const float4 P = params.texP[i], N = params.texN[i];
    float3 n = normalize(make_float3(N.x, N.y, N.z)), o;
    const bool moved = place(o, n, make_float3(P.x, P.y, P.z), P.w);
    const float3 q = o - n * EPS;   // the bake lifts it by EPS again
    params.texP[i] = make_float4(q.x, q.y, q.z, P.w);
    params.texN[i] = make_float4(n.x, n.y, n.z, moved ? 1.0f : 0.0f);
}

// a light map texel: the radiance arriving over its hemisphere as L1 spherical harmonics, per group
extern "C" __global__ void __raygen__bake() {
    const unsigned i = optixGetLaunchIndex().x;
    if (i >= params.count) return;
    const unsigned gi = params.seedBase + i;
    const float4 P = params.texP[i], N = params.texN[i];
    const float3 n = normalize(make_float3(N.x, N.y, N.z));
    const float3 o = make_float3(P.x, P.y, P.z) + n * EPS;   // placed by __raygen__place
    float3 tt, bb;
    makeBasis(n, tt, bb);
    BakeAccum acc = params.acc[i];
    // the indirect direction of every sample from a 2D low-discrepancy sequence (R2), shifted per texel
    const unsigned key = pcg(gi ^ params.salt);
    const float sx = unit(pcg(key ^ 0x68E31DA4u)), sy = unit(pcg(key ^ 0xB5297A4Du));
    const float pdfHemi = 0.5f * INV_PIf;
    for (unsigned s = 0; s < params.samples; ++s) {
        const unsigned k = params.sampleBase + s;
        Rng rng{pcg(key + k)};
        // the sample's origin anywhere on the texel's footprint (the texel holds the footprint's mean: a shadow's edge
        // across texels comes out graded, not in steps); the centre where something stands between
        float3 os = o;
        {
            const float3 off = tt * ((rng.next() - 0.5f) * P.w) + bb * ((rng.next() - 0.5f) * P.w);
            const float jl = length(off);
            if (jl > 1e-7f && !blocked(o, off / jl, jl)) os = o + off;
        }
        // direct: every emitter
        for (unsigned l = 0; l < params.lightCount; ++l) {
            const BakeLight& lt = params.lights[l];
            float3 w;
            float value, dist;
            const float u1 = rng.next(), u2 = rng.next(), u3 = rng.next();
            if (!sampleLight(lt, os, u1, u2, u3, w, value, dist)) continue;
            const float c = dot(w, n);
            if (c <= 0.0f) continue;
            value *= transmittance(os, w, dist - EPS);
            if (value <= 0.0f) continue;
            addSH(acc, lt.group, make_float3(value, value, value), value, w, Y0, Y1);
            acc.e[lt.group] += value * c;
        }
        if (params.maxBounces == 0) continue;   // pass 1: direct light only
        // the secondary lights
        if (params.secCount) secondaryAtOrigin(acc, os, &n, pdfHemi, Y0, Y1, rng);
        // indirect: a direction uniform over the hemisphere (pdf 1/2pi). The harmonics hold radiance, not irradiance:
        // with cosine sampling the weight pi/cos explodes at grazing angles (single bright texels)
        float u1 = sx + 0.7548776662f * float(k), u2 = sy + 0.5698402910f * float(k);
        u1 -= floorf(u1);
        u2 -= floorf(u2);
        const float cz = u1, sz = sqrtf(fmaxf(0.0f, 1.0f - cz * cz)), ph = 2.0f * M_PIf * u2;
        const float3 w = normalize(tt * (sz * cosf(ph)) + bb * (sz * sinf(ph)) + n * cz);
        acc.openW += cz;
        if (!blocked(os, w, 0.5f)) acc.open += cz;
        float3 Li[SALON_GROUPS];
        for (int g = 0; g < SALON_GROUPS; ++g) Li[g] = make_float3(0, 0, 0);
        incoming(os, w, pdfHemi, rng, Li);
        clampPath(Li);
        for (int g = 0; g < SALON_GROUPS; ++g) {
            const float3 c = Li[g] * (2.0f * M_PIf);
            addSH(acc, g, c, lum(c), w, Y0, Y1);
        }
    }
    params.acc[i] = acc;
}

// a volume cell: the mean radiance M = (1/4pi) int L and the luminance flux F = (1/4pi) int lum(L) w, per group
extern "C" __global__ void __raygen__volume() {
    const unsigned i = optixGetLaunchIndex().x;
    if (i >= params.count) return;
    const unsigned gi = params.seedBase + i, nx = params.volDim.x, ny = params.volDim.y;
    const float3 centre = params.volLo + make_float3(float(gi % nx) + 0.5f, float((gi / nx) % ny) + 0.5f, float(gi / (nx * ny)) + 0.5f) * params.volCell;
    BakeAccum acc = params.acc[i];
    if (params.sampleBase == 0) acc.open = inside(centre) ? 0.0f : 1.0f;
    if (acc.open == 0.0f) {
        params.acc[i] = acc;
        return;
    }
    const unsigned key = pcg(gi ^ params.salt ^ 0x3C6EF372u);
    const float inv4pi = 1.0f / (4.0f * M_PIf);
    for (unsigned s = 0; s < params.samples; ++s) {
        const unsigned k = params.sampleBase + s;
        Rng rng{pcg(key + k)};
        // anywhere in the cell (the cell holds its mean: a beam's edge is graded), the centre where a wall is between
        float3 p = centre;
        {
            const float3 off = make_float3(rng.next() - 0.5f, rng.next() - 0.5f, rng.next() - 0.5f) * params.volCell;
            const float d = length(off);
            if (d > 1e-7f && !blocked(centre, off / d, d)) p = centre + off;
        }
        for (unsigned l = 0; l < params.lightCount; ++l) {
            const BakeLight& lt = params.lights[l];
            float3 w;
            float value, dist;
            const float u1 = rng.next(), u2 = rng.next(), u3 = rng.next();
            if (!sampleLight(lt, p, u1, u2, u3, w, value, dist)) continue;
            value *= transmittance(p, w, dist - EPS);
            if (value > 0.0f) addSH(acc, lt.group, make_float3(value, value, value), value, w, inv4pi, inv4pi);
        }
        if (params.secCount) secondaryAtOrigin(acc, p, nullptr, inv4pi, inv4pi, inv4pi, rng);
        // the rest: a direction uniform over the sphere (pdf 1/4pi, so the 1/4pi of M and F cancels)
        const float z = 1.0f - 2.0f * rng.next(), ph = 2.0f * M_PIf * rng.next(), r = sqrtf(fmaxf(0.0f, 1.0f - z * z));
        const float3 w = make_float3(r * cosf(ph), r * sinf(ph), z);
        float3 Li[SALON_GROUPS];
        for (int g = 0; g < SALON_GROUPS; ++g) Li[g] = make_float3(0, 0, 0);
        incoming(p, w, inv4pi, rng, Li);
        clampPath(Li);
        for (int g = 0; g < SALON_GROUPS; ++g) addSH(acc, g, Li[g], lum(Li[g]), w, 1.0f, 1.0f);
    }
    params.acc[i] = acc;
}

// Reflection probes (not needed yet) go here: a __raygen__probe as Denizaltı's, one launch per mip with every probe of
// the mip in z (probe * 6 + face), its own clamp, the GGX-filtered mips traced directly.
