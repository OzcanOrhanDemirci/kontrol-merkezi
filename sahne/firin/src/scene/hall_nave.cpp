// The hall itself (docs/SALON.md): x in [-30, 30], y in [0, 26], z in [-275, -44]. A wet floor with drainage channels
// along the walls and a few floor drains; four rows of 2 x 7 m columns (x = ±8, ±22) every 20 m from z = -60 to -220,
// ending ~35 m before the arch to leave it a plaza; a flat ceiling on deep cross beams over the column lines and
// lighter beams along the rows; side walls with pilasters carrying the beams; a catwalk with its ladder cage and a door
// with a lit frame on the left wall; pipe runs on brackets; a sparse row of caged lamps. Human scale: railings 1.1 m,
// doors 2.1 m, rungs 0.3 m apart.
#include "scene/hall_kit.h"

#include <algorithm>
#include <cmath>

namespace salon::hall {

namespace {

constexpr float kZ0 = -44.0f, kZ1 = -275.0f, kW = 30.0f, kH = 26.0f;
constexpr float kRowX[4] = {-22.0f, -8.0f, 8.0f, 22.0f};
constexpr float kColZ0 = -60.0f, kColZ1 = -220.0f, kColStep = 20.0f;
constexpr float kBeamZ1 = -240.0f;            // the last cross beam (over the plaza's front)
constexpr float kChanIn = 27.6f, kChanOut = 28.2f, kChanD = 0.35f;   // drainage channels (|x|), depth
constexpr float kPilFace = 29.0f;             // the pilasters' face (|x|)
const float kDrainZ[3] = {-90.0f, -150.0f, -210.0f};
constexpr float kDrainX = 15.0f, kDrainH = 0.4f;

bool atPilaster(float z, float margin = 0.8f) {
    for (float zp = kColZ0; zp >= kBeamZ1 - 1e-3f; zp -= kColStep)
        if (std::fabs(z - zp) < margin) return true;
    return false;
}

void floorPlane(Hall& h) {
    // the floor round the drains' holes and between the channels: rectangles of one chart (planar coordinates)
    const size_t vm = h.vmark();
    const uint32_t cm = h.cmark();
    std::vector<float> xs = {-kChanIn, -kDrainX - kDrainH, -kDrainX + kDrainH, kDrainX - kDrainH, kDrainX + kDrainH, kChanIn};
    std::vector<float> zs = {kZ0};
    for (float z : kDrainZ) {
        zs.push_back(z + kDrainH);
        zs.push_back(z - kDrainH);
    }
    zs.push_back(kZ1);
    for (size_t i = 0; i + 1 < xs.size(); ++i)
        for (size_t j = 0; j + 1 < zs.size(); ++j) {
            const bool holeX = (i == 1 || i == 3), holeZ = (j % 2 == 1);
            if (holeX && holeZ) continue;
            const float x0 = xs[i], x1 = xs[i + 1], z0 = zs[j], z1 = zs[j + 1];
            h.patch(v3(x0, 0, z0), v3(x1, 0, z0), v3(x0, 0, z1), v3(x1, 0, z1), v3(0, 1, 0), M_ZEMIN, 6.0f);
        }
    for (int s : {-1, 1})   // the strips between the channels and the walls
        h.patch(v3(s * kChanOut, 0, kZ0), v3(s * kW, 0, kZ0), v3(s * kChanOut, 0, kZ1), v3(s * kW, 0, kZ1), v3(0, 1, 0), M_ZEMIN, 6.0f);
    // one chart needs one coordinate system: every patch's uv ran from its own corner, so 31 patches shared the same
    // light map texels (review 1, B3); world planar metres instead (the texture is continuous across patches too)
    for (size_t i = vm; i < h.s.mesh.v.size(); ++i) h.s.mesh.v[i].uv = make_float2(h.s.mesh.v[i].p.x, -h.s.mesh.v[i].p.z);
    h.oneChart(vm, cm);
}

void channels(Hall& h) {
    for (int s : {-1, 1}) {
        const float xi = s * kChanIn, xo = s * kChanOut;
        // the channel: its two walls and its bottom
        h.patch(v3(xi, -kChanD, kZ0), v3(xi, -kChanD, kZ1), v3(xi, 0, kZ0), v3(xi, 0, kZ1), v3(float(s), 0, 0), M_DUVAR, 8.0f);
        h.patch(v3(xo, -kChanD, kZ0), v3(xo, -kChanD, kZ1), v3(xo, 0, kZ0), v3(xo, 0, kZ1), v3(float(-s), 0, 0), M_DUVAR, 8.0f);
        h.patch(v3(xi, -kChanD, kZ0), v3(xo, -kChanD, kZ0), v3(xi, -kChanD, kZ1), v3(xo, -kChanD, kZ1), v3(0, 1, 0), M_ZEMIN, 8.0f);
        // the grating: steel angles on both edges, bearing bars along the channel in 11.55 m lengths, cross rods
        const size_t vm = h.vmark();
        const uint32_t cm = h.cmark();
        for (float x : {xi, xo}) h.bar(v3(x, -0.02f, kZ0), v3(x, -0.02f, kZ1), 0.012f, 0.04f, v3(0, 1, 0), M_PASLI);
        const int nl = 20;
        const float L = (kZ0 - kZ1) / nl;
        for (int q = 0; q < nl; ++q) {
            const float za = kZ0 - q * L - 0.006f, zb = kZ0 - (q + 1) * L + 0.006f;
            for (int b = 0; b < 6; ++b) {
                const float x = xi + (xo - xi) * (b + 0.5f) / 6;
                h.bar(v3(x, -0.022f, za), v3(x, -0.022f, zb), 0.008f, 0.04f, v3(0, 1, 0), M_PASLI);
            }
        }
        for (float z = kZ0 - 0.25f; z > kZ1; z -= 0.5f)
            h.bar(v3(xi, -0.006f, z), v3(xo, -0.006f, z), 0.008f, 0.008f, v3(0, 1, 0), M_PASLI);
        h.packCharts(vm, cm, 0.05f);
    }
    // the floor drains: a sump under a cast grate
    for (float z : kDrainZ)
        for (int s : {-1, 1}) {
            const float x = s * kDrainX, a = kDrainH, d = 0.45f;
            h.patch(v3(x - a, -d, z - a), v3(x + a, -d, z - a), v3(x - a, -d, z + a), v3(x + a, -d, z + a), v3(0, 1, 0), M_ZEMIN);
            h.patch(v3(x - a, -d, z - a), v3(x - a, -d, z + a), v3(x - a, 0, z - a), v3(x - a, 0, z + a), v3(1, 0, 0), M_DUVAR);
            h.patch(v3(x + a, -d, z - a), v3(x + a, -d, z + a), v3(x + a, 0, z - a), v3(x + a, 0, z + a), v3(-1, 0, 0), M_DUVAR);
            h.patch(v3(x - a, -d, z - a), v3(x + a, -d, z - a), v3(x - a, 0, z - a), v3(x + a, 0, z - a), v3(0, 0, 1), M_DUVAR);
            h.patch(v3(x - a, -d, z + a), v3(x + a, -d, z + a), v3(x - a, 0, z + a), v3(x + a, 0, z + a), v3(0, 0, -1), M_DUVAR);
            const size_t vm = h.vmark();
            const uint32_t cm = h.cmark();
            for (int e = 0; e < 4; ++e) {   // the frame
                const float sx = e < 2 ? (e ? 1.0f : -1.0f) * (a - 0.02f) : 0.0f, sz = e >= 2 ? (e == 3 ? 1.0f : -1.0f) * (a - 0.02f) : 0.0f;
                if (e < 2) h.bar(v3(x + sx, -0.025f, z - a), v3(x + sx, -0.025f, z + a), 0.04f, 0.05f, v3(0, 1, 0), M_KOYU);
                else h.bar(v3(x - a, -0.025f, z + sz), v3(x + a, -0.025f, z + sz), 0.04f, 0.05f, v3(0, 1, 0), M_KOYU);
            }
            for (int b = 1; b < 10; ++b) {
                const float bx = x - a + 2 * a * b / 10;
                h.bar(v3(bx, -0.025f, z - a + 0.04f), v3(bx, -0.025f, z + a - 0.04f), 0.025f, 0.05f, v3(0, 1, 0), M_KOYU);
            }
            h.packCharts(vm, cm, 0.03f);
        }
}

void column(Hall& h, float x, float z, bool detailed) {
    const float hx = 1.0f, hz = 3.5f, rc = 0.08f;
    const float yb = 1.8f, yt = 23.2f;
    // the flared foot (G-Cans' columns stand on a sloped skirt) and the haunch into the ceiling
    h.loft(v3(x, 0, z), hx, hz, rc, {{0.55f, 0.0f}, {0.55f, 0.3f}, {0.54f, 0.34f}, {0.5f, 0.4f}, {0.04f, 1.74f}, {0.01f, 1.79f},
                                     {0.0f, yb}},
           M_KOLON);
    h.loft(v3(x, 0, z), hx, hz, rc, {{0.0f, yt}, {0.01f, yt + 0.02f}, {0.04f, yt + 0.07f}, {0.31f, 23.95f}, {0.34f, 23.99f},
                                     {0.35f, 24.05f}, {0.35f, kH}},
           M_KOLON);
    // the shaft: on the inner rows near the gallery its aisle face is cast formwork with tie holes, as geometry
    const int aisle = x > 0 ? 2 : 0;   // the side facing x = 0
    h.loft(v3(x, 0, z), hx, hz, rc, {{0.0f, yb}, {0.0f, yt}}, M_KOLON, detailed ? aisle : -1, 3.0f);
    if (detailed) {
        const float fx = x > 0 ? x - hx : x + hx;
        const float3 n = v3(x > 0 ? -1.0f : 1.0f, 0, 0);
        const Xform t = axes(v3(fx, 0, z), v3(0, 0, x > 0 ? 1.0f : -1.0f), v3(0, 1, 0), n);
        const float hw = hz - rc;
        Formwork f;
        f.pu = 2 * hw / 6;
        f.ou = -hw;
        f.pv = (yt - yb) / 9;
        f.ov = yb;
        f.tiesU = 2;
        f.tiesV = 4;
        h.formworkFace(t, -hw, hw, yb, yt, f, M_KOLON);
    }
}

void columns(Hall& h) {
    for (float x : kRowX)
        for (float z = kColZ0; z >= kColZ1 - 1e-3f; z -= kColStep) {
            const bool detailed = std::fabs(x) < 10.0f && z > kZ0 - 61.0f;   // the inner rows within ~60 m of the gallery
            column(h, x, z, detailed);
        }
}

void ceilingAndWalls(Hall& h) {
    // the ceiling and the walls: one chart each
    const size_t vc = h.vmark();
    const uint32_t cc = h.cmark();
    h.patch(v3(-kW, kH, kZ0), v3(kW, kH, kZ0), v3(-kW, kH, kZ1), v3(kW, kH, kZ1), v3(0, -1, 0), M_TAVAN, 8.0f);
    h.oneChart(vc, cc);
    for (int s : {-1, 1}) {
        const size_t vm = h.vmark();
        const uint32_t cm = h.cmark();
        h.patch(v3(s * kW, 0, kZ0), v3(s * kW, 0, kZ1), v3(s * kW, kH, kZ0), v3(s * kW, kH, kZ1), v3(float(-s), 0, 0), M_DUVAR, 8.0f);
        h.oneChart(vm, cm);
    }
    {
        const size_t vm = h.vmark();
        const uint32_t cm = h.cmark();
        h.patch(v3(-kW, 0, kZ1), v3(kW, 0, kZ1), v3(-kW, kH, kZ1), v3(kW, kH, kZ1), v3(0, 0, 1), M_DUVAR, 8.0f);
        h.oneChart(vm, cm);
    }
    // cross beams over the column lines (1.2 m wide, 2 m deep), wall to wall; lighter beams along the rows
    for (float z = kColZ0; z >= kBeamZ1 - 1e-3f; z -= kColStep) h.box(v3(0, kH - 1.0f, z), v3(kW, 1.0f, 0.6f), 0.05f, M_TAVAN, 6.0f);
    for (float x : kRowX) {
        const float za = kZ0, zb = kBeamZ1;
        h.box(v3(x, kH - 0.6f, 0.5f * (za + zb)), v3(0.5f, 0.6f, 0.5f * (za - zb)), 0.04f, M_TAVAN, 6.0f);
    }
    // the pilasters carrying the beams: a foot and a haunch like the columns', their back in the wall
    for (int s : {-1, 1})
        for (float z = kColZ0; z >= kBeamZ1 - 1e-3f; z -= kColStep)
            h.loft(v3(s * (kPilFace + 0.5f), 0, z), 0.5f, 0.8f, 0.06f,
                   {{0.25f, 0.0f}, {0.25f, 0.3f}, {0.23f, 0.34f}, {0.01f, 1.28f}, {0.0f, 1.3f}, {0.0f, 23.4f}, {0.02f, 23.45f},
                    {0.28f, 23.97f}, {0.3f, 24.02f}, {0.3f, kH}},
                   M_KOLON, s > 0 ? 0 : 2);
}

void catwalk(Hall& h) {
    // along the left wall at y = 12, in front of the pilasters; reached by a caged ladder against the front wall
    const float y = 12.0f, xa = -kPilFace + 0.05f, xb = -27.75f, za = -45.0f, zb = -246.0f;
    const float xc = 0.5f * (xa + xb), zc = 0.5f * (za + zb);
    h.box(v3(xc, y - 0.006f, zc), v3(0.5f * (xb - xa), 0.006f, 0.5f * (za - zb)), 0.003f, M_SAC, 6.0f);
    for (float x : {xa, xb}) h.bar(v3(x, y - 0.08f, za), v3(x, y - 0.08f, zb), 0.012f, 0.15f, v3(0, 1, 0), M_KOYU);
    for (float z = za - 0.5f; z > zb; z -= 5.0f) {
        const float x0 = atPilaster(z) ? -kPilFace : -kW;
        h.bar(v3(x0, y - 0.21f, z), v3(xb + 0.05f, y - 0.21f, z), 0.08f, 0.12f, v3(0, 1, 0), M_KOYU);
        h.bar(v3(x0, y - 1.5f, z), v3(xb, y - 0.27f, z), 0.07f, 0.07f, v3(0, 0, 1), M_KOYU);
        h.box(v3(x0 + 0.008f, y - 0.85f, z), v3(0.008f, 0.8f, 0.1f), 0.003f, M_KOYU, 1.0f);
    }
    h.railing({v3(xb - 0.05f, y, za), v3(xb - 0.05f, y, zb + 0.05f), v3(xa, y, zb + 0.05f)}, 1.5f, M_PASLI);
    // the cable tray above the walkway, its cables
    {
        const float ty = 14.3f, tx0 = -28.9f, tx1 = -28.55f;
        h.bar(v3(0.5f * (tx0 + tx1), ty, za), v3(0.5f * (tx0 + tx1), ty, zb), tx1 - tx0, 0.01f, v3(0, 1, 0), M_SAC);
        for (float x : {tx0, tx1}) h.bar(v3(x, ty + 0.04f, za), v3(x, ty + 0.04f, zb), 0.008f, 0.08f, v3(0, 1, 0), M_SAC);
        for (int c = 0; c < 3; ++c) h.tube(v3(tx0 + 0.08f + 0.1f * c, ty + 0.03f, za), v3(tx0 + 0.08f + 0.1f * c, ty + 0.03f, zb), 0.024f, M_KABLO, 6.0f);
        for (float z = za - 1.0f; z > zb; z -= 4.0f) {
            const float x0 = atPilaster(z) ? -kPilFace : -kW;
            h.bar(v3(x0, ty - 0.03f, z), v3(tx1, ty - 0.03f, z), 0.05f, 0.05f, v3(0, 1, 0), M_KOYU);
        }
    }
    // the door off the catwalk (between two pilasters), its lit frame; a platform bridges to it
    {
        const float zd = -150.0f, w = 1.0f, hgt = 2.1f, x = -kW;
        h.box(v3(0.5f * (x + xa), y - 0.006f, zd), v3(0.5f * (xa - x), 0.006f, 0.75f), 0.003f, M_SAC, 2.0f);
        h.box(v3(x + 0.05f, y + 0.5f * hgt + 0.05f, zd), v3(0.05f, 0.5f * hgt + 0.08f, 0.5f * w + 0.13f), 0.012f, M_KOYU, 0.5f);
        h.box(v3(x + 0.125f, y + 0.5f * hgt, zd), v3(0.025f, 0.5f * hgt, 0.5f * w), 0.008f, M_PASLI, 0.5f);
        h.rod(v3(x + 0.17f, y + 0.95f, zd + 0.38f), v3(x + 0.17f, y + 1.15f, zd + 0.38f), 0.016f, M_KOYU);
        // the light strips: both jambs and the head, 4 cm wide on the frame's face
        struct S { float3 c, u, v; };
        const float fx = x + 0.102f;
        const S strips[3] = {{v3(fx, y + 0.5f * (hgt + 0.1f), zd - 0.5f * w - 0.07f), v3(0, 0.5f * (hgt + 0.1f), 0), v3(0, 0, 0.02f)},
                             {v3(fx, y + 0.5f * (hgt + 0.1f), zd + 0.5f * w + 0.07f), v3(0, 0.5f * (hgt + 0.1f), 0), v3(0, 0, 0.02f)},
                             {v3(fx, y + hgt + 0.12f, zd), v3(0, 0, -(0.5f * w + 0.09f)), v3(0, 0.02f, 0)}};   // frames right-handed
        for (const S& st : strips) {
            h.box(axes(st.c - v3(0.003f, 0, 0), normalize(st.u), normalize(st.v), v3(1, 0, 0)),
                  v3(length(st.u), length(st.v), 0.004f), 0.002f, M_CAM_LAMBA, 3.0f);
            Emitter e;
            e.type = Emitter::RECT;
            e.group = GROUP_LAMBA;
            e.c = st.c + v3(0.002f, 0, 0);
            e.u = st.u;
            e.v = st.v;
            e.n = v3(1, 0, 0);
            e.L = kLambaL;
            h.s.lights.push_back(e);
        }
    }
    // the ladder: stiles 0.5 m apart off the front wall, rungs every 0.3 m, a cage of hoops from 2.4 m up
    {
        const float lx = -28.4f, lz = kZ0 - 0.25f, top = y + 1.1f;
        for (float sx : {-0.25f, 0.25f}) {
            h.bar(v3(lx + sx, 0.0f, lz), v3(lx + sx, top, lz), 0.012f, 0.065f, v3(0, 0, 1), M_PASLI);
            for (float yy = 1.5f; yy < top; yy += 2.5f) h.bar(v3(lx + sx, yy, kZ0), v3(lx + sx, yy, lz + 0.01f), 0.06f, 0.012f, v3(1, 0, 0), M_PASLI);
        }
        for (float yy = 0.3f; yy < y - 0.05f; yy += 0.3f) h.rod(v3(lx - 0.25f, yy, lz), v3(lx + 0.25f, yy, lz), 0.012f, M_PASLI);
        const std::vector<float2> hoop = {{0.25f, 0.0f}, {0.42f, -0.2f}, {0.42f, -0.55f}, {0.0f, -0.74f}, {-0.42f, -0.55f},
                                          {-0.42f, -0.2f}, {-0.25f, 0.0f}};
        for (float yy = 2.4f; yy < y - 0.4f; yy += 0.9f) {
            std::vector<float3> pts;
            for (const float2& q : hoop) pts.push_back(v3(lx + q.x, yy, lz + q.y));
            dz::pipeRun(h.at(Xform(), M_PASLI, 0.3f), pts, 0.01f, 0.1f);
        }
        for (int i = 1; i < 6; ++i) {
            const float2 q = hoop[i];
            h.bar(v3(lx + q.x, 2.4f, lz + q.y), v3(lx + q.x, 2.4f + 0.9f * int((y - 0.4f - 2.4f) / 0.9f), lz + q.y), 0.04f, 0.006f,
                  v3(0, 0, 1), M_PASLI);
        }
    }
}

void pipes(Hall& h) {
    // the right wall: a big main at 17.5 m, two smaller lines at 2.8 and 3.4 m diving into the floor near the end
    struct Run { float x, y, r; bool dive; int side; };
    const Run runs[] = {{28.45f, 17.5f, 0.35f, false, 1}, {28.72f, 2.8f, 0.15f, true, 1}, {28.72f, 3.4f, 0.15f, true, 1},
                        {-28.5f, 9.6f, 0.2f, false, -1}};
    for (const Run& r : runs) {
        // the left line comes out of the side wall behind the ladder's reach
        std::vector<float3> pts = {r.side < 0 ? v3(-kW, r.y, -47.0f) : v3(r.x, r.y, kZ0)};
        if (r.side < 0) pts.push_back(v3(r.x, r.y, -47.0f));
        if (r.dive) {
            pts.push_back(v3(r.x, r.y, -270.0f));
            pts.push_back(v3(r.x, -0.5f, -270.0f));
        } else {
            pts.push_back(v3(r.x, r.y, kZ1));
        }
        dz::pipeRun(h.at(Xform(), M_PASLI, 3.0f), pts, r.r, 2.5f * r.r);
        // flanges every 12 m
        for (float z = kZ0 - 10.0f; z > (r.dive ? -268.0f : kZ1 + 1.0f); z -= 12.0f)
            h.at(Xform::at(v3(r.x, r.y, z)), M_PASLI, 0.5f).roundedCylinder(r.r + 0.06f, -0.03f, 0.03f, 0.01f);
        // brackets every 6 m: an arm from the wall (or pilaster) under the pipe and a strap over it
        for (float z = kZ0 - 3.0f; z > kZ1 + 2.0f; z -= 6.0f) {
            if (r.dive && z < -268.0f) break;
            if (r.side < 0 && z > -48.0f) continue;
            const float wx = r.side * (atPilaster(z) ? kPilFace : kW);
            const float ay = r.y - r.r - 0.05f;
            h.bar(v3(wx, ay, z), v3(r.x - r.side * (r.r + 0.1f), ay, z), 0.1f, 0.1f, v3(0, 1, 0), M_KOYU);
            Xform t = axes(v3(r.x, r.y, z), v3(r.side * 1.0f, 0, 0), v3(0, 1, 0), v3(0, 0, float(r.side)));
            h.at(t, M_KOYU, 0.1f).torus(r.r + 0.012f, 0.008f, 0.0f, kPi);
            if (r.r > 0.3f) h.bar(v3(wx, ay - 1.2f, z), v3(r.x, ay - 0.05f, z), 0.08f, 0.08f, v3(0, 0, 1), M_KOYU);
        }
    }
}

void doorsAndLamps(Hall& h) {
    // a door at floor level in the right wall near the gallery, a lamp over it
    {
        const float x = kW, zd = -52.0f;
        h.box(v3(x - 0.05f, 1.1f, zd), v3(0.05f, 1.15f, 0.6f), 0.012f, M_KOYU, 0.5f);
        h.box(v3(x - 0.125f, 1.05f, zd), v3(0.025f, 1.05f, 0.5f), 0.008f, M_PASLI, 0.5f);
        h.rod(v3(x - 0.17f, 0.95f, zd - 0.38f), v3(x - 0.17f, 1.15f, zd - 0.38f), 0.016f, M_KOYU);
        h.cagedLamp(v3(x, 4.6f, zd), v3(-1, 0, 0), kBulbBoard);
    }
    // uplights at the foot of every inner-row column, on the aisle side (group 2, warm, dim): G-Cans' pillars are lit
    // from their bases, so down the hall each column stands in its own pool of light with the haze between them, the
    // columns fading one by one into the distance
    for (float x : kRowX) {
        if (std::fabs(x) > 10.0f) continue;
        const float sx = x > 0 ? -1.0f : 1.0f;           // towards the aisle
        const float tilt = 12.0f * kPi / 180.0f;
        const float3 n = v3(-sx * std::sin(tilt), std::cos(tilt), 0);   // up, leaning onto the column's face
        for (float z = kColZ0; z >= kColZ1 - 1e-3f; z -= kColStep) {
            const float3 base = v3(x + sx * 1.9f, 0.0f, z);
            h.box(base + v3(0, 0.07f, 0), v3(0.24f, 0.07f, 0.34f), 0.012f, M_KOYU, 0.5f);
            h.at(axes(base + v3(0, 0.141f, 0), v3(0, 0, 1), v3(1, 0, 0), v3(0, 1, 0)), M_CAM_LAMBA, 1.0f).quad(0.5f, 0.3f);
            Emitter e;
            e.type = Emitter::RECT;
            e.group = GROUP_LAMBA;
            e.c = base + v3(0, 0.143f, 0);
            e.u = v3(0, 0, 0.25f);
            e.v = v3(0.15f, 0, 0);
            e.n = n;
            e.L = kColUpL;
            e.lobe = 14.0f;
            h.s.lights.push_back(e);
        }
    }
    // the sparse row along both walls, every 40 m, mid-bay (dim: smaller bulbs)
    for (int s : {-1, 1})
        for (float z = -70.0f; z > -235.0f; z -= 40.0f) h.cagedLamp(v3(s * kW, 4.6f, z), v3(float(-s), 0, 0), kBulbHall);
}

}   // namespace

void buildNave(Hall& h) {
    floorPlane(h);
    channels(h);
    columns(h);
    ceilingAndWalls(h);
    catwalk(h);
    pipes(h);
    doorsAndLamps(h);
}

}   // namespace salon::hall
