// Phase 2, the outside (docs/SALON.md "The way up"): the hall is not underground. It is inside a raised concrete block
// (x +-48, y -4..35, z -350..8) standing on eight round columns that descend 600 m into the fog, like an offshore
// platform's legs; its roof is a bare walkable deck, no parapet: from it one can jump in any direction. On the deck,
// exactly over the gallery's shaft, the lamp that lights the hall's grate: the shaft's emitter (hall_gallery.cpp, the
// "daylight") seen from its other side, a 10 x 10 m pit of deep steel louvres sunk in the deck, glowing faintly in the
// same group (0): the daylight inside is fake, and from up here it gives itself away. Behind the hatch a tall thin mast
// with one dim steady lamp, the facility's one light seen from afar. The window instances all of it as the facility
// in the void: only the dis_* materials are used here (and nowhere else), so the exterior is its own draw ranges.
#include "scene/hall_kit.h"

#include <algorithm>
#include <cmath>

namespace salon::hall {

using namespace up;

namespace {

const float3 X = {1, 0, 0}, Y = {0, 1, 0}, Z = {0, 0, 1};

// the roof lamp over the shaft: the well's top (hall_gallery.cpp) is x +-5, z -26..-36, its emitter at y 33.5
constexpr float kLampX = 5.0f, kLampZ0 = -26.0f, kLampZ1 = -36.0f, kLampY = 33.5f, kRim = 0.2f;
// the mast behind the hatch
constexpr float kMastX = 2.6f, kMastZ = -348.0f, kMastH = 18.0f;
// the columns
constexpr float kLegR = 6.0f, kCapR = 8.5f, kLegBottom = -604.0f;
const float kLegX[2] = {-30.0f, 30.0f};
const float kLegZ[4] = {-21.0f, -121.0f, -221.0f, -321.0f};

// a rectangle of the deck split into tiles of at most 12 m, each its own light map chart (the density follows the
// distance to the hatch and the lamp tile by tile)
void deck(Hall& h, float x0, float x1, float z0, float z1) {
    const int nx = std::max(1, int(std::ceil((x1 - x0) / 12.0f - 1e-3f))), nz = std::max(1, int(std::ceil((z0 - z1) / 12.0f - 1e-3f)));
    for (int i = 0; i < nx; ++i)
        for (int j = 0; j < nz; ++j) {
            const float a = x0 + (x1 - x0) * i / nx, b = x0 + (x1 - x0) * (i + 1) / nx;
            const float c = z0 - (z0 - z1) * j / nz, d = z0 - (z0 - z1) * (j + 1) / nz;
            const size_t vm = h.vmark();
            h.patch(v3(a, kRoof, c), v3(b, kRoof, c), v3(a, kRoof, d), v3(b, kRoof, d), Y, M_DIS_ZEMIN, 12.0f);
            // world planar uv: the texture runs on across the tiles
            for (size_t k = vm; k < h.s.mesh.v.size(); ++k) h.s.mesh.v[k].uv = make_float2(h.s.mesh.v[k].p.x, -h.s.mesh.v[k].p.z);
        }
}

void roofDeck(Hall& h) {
    const float W = kBlockHW;
    const float lx = kLampX + kRim, lz0 = kLampZ0 + kRim, lz1 = kLampZ1 - kRim;                        // the lamp's pit
    const float hx = kStairHW + kCurbT, hz0 = kHatchZ0 + kCurbT, hz1 = kHatchZ1 - kCurbT;               // the hatch's curb
    deck(h, -W, W, kBlockZ0, lz0);
    deck(h, -W, -lx, lz0, lz1);
    deck(h, lx, W, lz0, lz1);
    deck(h, -W, W, lz1, hz0);
    deck(h, -W, -hx, hz0, hz1);
    deck(h, hx, W, hz0, hz1);
    deck(h, -W, W, hz1, kBlockZ1);
}

void shell(Hall& h) {
    // the outer walls: cast in lifts of 3.25 m (twelve from the underside to the deck), the joints as grooves
    Formwork f;
    f.pu = 0.0f;
    f.pv = 3.25f;
    f.ov = kBlockY0;
    f.depth = 0.05f;
    f.halfWidth = 0.07f;
    const float W = kBlockHW;
    for (int s : {-1, 1}) {
        const float3 n = v3(float(s), 0, 0);
        const Xform t = axes(v3(s * W, 0, 0), cross(Y, n), Y, n);   // u along -z on the right, +z on the left
        if (s > 0) h.formworkFace(t, -kBlockZ0, -kBlockZ1, kBlockY0, kRoof, f, M_DIS_DUVAR, 12.0f);
        else h.formworkFace(t, kBlockZ1, kBlockZ0, kBlockY0, kRoof, f, M_DIS_DUVAR, 12.0f);
    }
    h.formworkFace(axes(v3(0, 0, kBlockZ0), X, Y, Z), -W, W, kBlockY0, kRoof, f, M_DIS_DUVAR, 12.0f);
    h.formworkFace(axes(v3(0, 0, kBlockZ1), v3(-1, 0, 0), Y, v3(0, 0, -1)), -W, W, kBlockY0, kRoof, f, M_DIS_DUVAR, 12.0f);
    // the underside, seen falling past it
    h.patch(v3(-W, kBlockY0, kBlockZ0), v3(W, kBlockY0, kBlockZ0), v3(-W, kBlockY0, kBlockZ1), v3(W, kBlockY0, kBlockZ1), -Y, M_DIS_DUVAR, 24.0f);
    // a drip edge round the deck: a shallow steel angle on the walls' tops (the roof's only edge, ankle high at most)
    for (int s : {-1, 1}) {
        h.box(v3(s * (W - 0.03f), kRoof + 0.03f, 0.5f * (kBlockZ0 + kBlockZ1)), v3(0.03f, 0.03f, 0.5f * (kBlockZ0 - kBlockZ1)), 0.008f, M_DIS_KOYU, 24.0f);
        h.box(v3(0, kRoof + 0.03f, s > 0 ? kBlockZ0 - 0.03f : kBlockZ1 + 0.03f), v3(W - 0.06f, 0.03f, 0.03f), 0.008f, M_DIS_KOYU, 24.0f);
    }
}

// a column: round, 12 m across, flaring into a capital 17 m across under the block; open at its foot, which no one sees
void column(Hall& h, float x, float z) {
    struct Row { float r, y; };
    const std::vector<Row> rows = {{kLegR, kLegBottom}, {kLegR, -200.0f}, {kLegR, -40.0f}, {kLegR, -18.0f}, {kLegR + 0.2f, -15.5f},
                                   {kCapR - 0.9f, -8.0f}, {kCapR, kBlockY0 - 0.6f}, {kCapR, kBlockY0 + 0.05f}};
    const int nu = 48, nv = int(rows.size()) - 1;
    std::vector<float> sv(rows.size(), 0.0f);
    for (size_t j = 1; j < rows.size(); ++j) sv[j] = sv[j - 1] + std::hypot(rows[j].r - rows[j - 1].r, rows[j].y - rows[j - 1].y);
    h.at(Xform::at(v3(x, 0, z)), M_DIS_KOLON, 1e3f).grid(nu, nv, [&](int i, int j) {
        const float a = -2.0f * kPi * float(i % nu) / nu, ca = std::cos(a), sa = std::sin(a);   // clockwise from above: faces out
        const Row& q = rows[j];
        const Row& p = rows[j == 0 ? 0 : j - 1];
        const Row& nx = rows[std::min(nv, j + 1)];
        const float dr = nx.r - p.r, dy = nx.y - p.y, l = std::hypot(dr, dy);
        Kit::GridPt g;
        g.p = v3(q.r * ca, q.y, q.r * sa);
        g.n = normalize(v3(ca * dy / l, -dr / l, sa * dy / l));
        g.s = make_float2(2.0f * kPi * kLegR * float(i) / nu, sv[j]);
        return g;
    });
}

// the lamp over the shaft as seen from the roof: a pit as large as the well's top, lined in steel, its floor the faint
// roof-side glow of the emitter (whose lit side faces down into the well: the hall's light is unchanged), deep louvres
// over it slanted like the beam (10 degrees towards -z), a steel rim, two control boxes beside it
void roofLamp(Hall& h) {
    const float y0 = kLampY, y1 = kRoof, zc = 0.5f * (kLampZ0 + kLampZ1), hz = 0.5f * (kLampZ0 - kLampZ1);
    // the pit's walls (facing in), continuing the well's
    h.patch(v3(-kLampX, y0, kLampZ0), v3(-kLampX, y0, kLampZ1), v3(-kLampX, y1, kLampZ0), v3(-kLampX, y1, kLampZ1), X, M_DIS_KOYU, 10.0f);
    h.patch(v3(kLampX, y0, kLampZ0), v3(kLampX, y0, kLampZ1), v3(kLampX, y1, kLampZ0), v3(kLampX, y1, kLampZ1), -X, M_DIS_KOYU, 10.0f);
    h.patch(v3(-kLampX, y0, kLampZ0), v3(kLampX, y0, kLampZ0), v3(-kLampX, y1, kLampZ0), v3(kLampX, y1, kLampZ0), -Z, M_DIS_KOYU, 10.0f);
    h.patch(v3(-kLampX, y0, kLampZ1), v3(kLampX, y0, kLampZ1), v3(-kLampX, y1, kLampZ1), v3(kLampX, y1, kLampZ1), Z, M_DIS_KOYU, 10.0f);
    // the glow: just over the emitter's back, facing up, and its emitter (so the deck round it is lit by it in the bake)
    const float yg = y0 + 0.06f;
    h.quad(axes(v3(0, yg, zc), X, v3(0, 0, -1), Y), 2 * kLampX, 2 * hz, M_DIS_ISIK, 10.0f);
    Emitter e;
    e.type = Emitter::RECT;
    e.group = GROUP_KUYU;
    e.c = v3(0, yg + 0.001f, zc);
    e.u = v3(kLampX, 0, 0);
    e.v = v3(0, 0, hz);
    e.n = Y;
    e.L = kCatiL;
    e.lobe = 1.0f;
    h.s.lights.push_back(e);
    // the louvres: blades across x every 0.75 m, 0.25 m deep (the glow reads from 20 degrees down), slanted like the beam;
    // dividers along z every 2.5 m
    {
        const size_t vm = h.vmark();
        const uint32_t cm = h.cmark();
        const float tilt = kKuyuTilt * kPi / 180.0f, depth = 0.25f, ym = y1 - 0.05f - 0.5f * depth;
        const float3 along = v3(0, std::cos(tilt), std::sin(tilt));   // up the blade, against the beam's fall
        for (float z = kLampZ1 + 0.625f; z < kLampZ0 - 0.3f; z += 0.75f)
            h.box(axes(v3(0, ym, z), X, along, cross(X, along)), v3(kLampX - 0.01f, 0.5f * depth, 0.01f), 0.004f, M_DIS_KOYU, 10.0f);
        for (float x = -kLampX + 2.5f; x < kLampX - 0.1f; x += 2.5f)
            h.box(v3(x, ym, zc), v3(0.02f, 0.5f * depth + 0.05f, hz - 0.01f), 0.005f, M_DIS_KOYU, 10.0f);
        h.packCharts(vm, cm, 0.05f);
    }
    // the rim: a steel angle round the pit at the deck
    for (int s : {-1, 1}) {
        h.box(v3(s * (kLampX + 0.5f * kRim), y1 + 0.02f, zc), v3(0.5f * kRim, 0.04f, hz + kRim), 0.01f, M_DIS_KOYU, 10.0f);
        h.box(v3(0, y1 + 0.02f, s > 0 ? kLampZ0 + 0.5f * kRim : kLampZ1 - 0.5f * kRim), v3(kLampX, 0.04f, 0.5f * kRim), 0.01f, M_DIS_KOYU, 10.0f);
    }
    // two control boxes on the deck by its side, a conduit from each into the rim
    for (int s : {-1, 1}) {
        const float3 b = v3(s * (kLampX + 1.6f), y1, zc + s * 2.0f);
        h.box(b + v3(0, 0.6f, 0), v3(0.4f, 0.6f, 0.25f), 0.02f, M_DIS_KOYU, 1.0f);
        h.box(b + v3(0, 1.23f, 0), v3(0.46f, 0.03f, 0.31f), 0.01f, M_DIS_KOYU, 1.0f);
        h.tube(b + v3(-s * 0.4f, 0.15f, 0), v3(s * (kLampX + kRim), y1 + 0.15f, b.z), 0.04f, M_DIS_KOYU, 2.0f);
    }
}

// the mast: a thin steel pole on a base plate, three guys, a small lantern at the top: the one steady lamp
void mast(Hall& h) {
    const float3 b = v3(kMastX, kRoof, kMastZ);
    h.box(b + v3(0, 0.02f, 0), v3(0.35f, 0.02f, 0.35f), 0.006f, M_DIS_KOYU, 1.0f);
    for (int q = 0; q < 4; ++q) h.nut(Xform::at(b + v3(q % 2 ? 0.27f : -0.27f, 0.04f, q / 2 ? 0.27f : -0.27f)), 0.05f, M_DIS_KOYU);
    h.tube(b, b + v3(0, 0.4f * kMastH, 0), 0.11f, M_DIS_KOYU, 4.0f);
    h.tube(b + v3(0, 0.4f * kMastH - 0.05f, 0), b + v3(0, kMastH, 0), 0.075f, M_DIS_KOYU, 4.0f);
    h.at(facing(b + v3(0, 0.4f * kMastH - 0.06f, 0), Y, X), M_DIS_KOYU, 0.1f).roundedCylinder(0.13f, 0.0f, 0.08f, 0.01f);
    for (int q = 0; q < 3; ++q) {   // the guys, from two thirds up to the deck 6 m out
        const float a = 2.0f * kPi * q / 3.0f + 0.4f;
        const float3 g = b + v3(6.0f * std::cos(a), 0, 6.0f * std::sin(a));
        h.rod(b + v3(0, 0.66f * kMastH, 0), g + v3(0, 0.08f, 0), 0.012f, M_DIS_KOYU, 6.0f);
        h.box(g + v3(0, 0.04f, 0), v3(0.12f, 0.04f, 0.12f), 0.01f, M_DIS_KOYU, 0.5f);
    }
    // the lantern: a cap, a globe, a guard ring under it
    const float3 top = b + v3(0, kMastH, 0);
    h.at(facing(top, Y, X), M_DIS_KOYU, 0.05f).roundedCylinder(0.09f, 0.0f, 0.06f, 0.01f);
    const float r = 0.1f;
    const float3 c = top + v3(0, 0.06f + r + 0.01f, 0);
    h.at(Xform::at(c), M_DIS_FENER, 0.03f).sphere(r);
    h.at(facing(c + v3(0, r + 0.01f, 0), Y, X), M_DIS_KOYU, 0.05f).roundedCylinder(0.15f, 0.0f, 0.03f, 0.008f);
    for (int q = 0; q < 4; ++q) {
        const float a = 0.5f * kPi * q;
        h.rod(top + v3(0.12f * std::cos(a), 0.03f, 0.12f * std::sin(a)), c + v3(0.12f * std::cos(a), r + 0.01f, 0.12f * std::sin(a)), 0.006f,
              M_DIS_KOYU, 0.2f);
    }
    Emitter e;
    e.type = Emitter::SPHERE;
    e.group = GROUP_KUYU;
    e.c = c;
    e.r = r;
    e.L = kFenerL;
    h.s.lights.push_back(e);
    h.anchor("dis_fener", "nokta", Xform::at(c), v3(r + 0.05f, r + 0.05f, r + 0.05f));
}

}   // namespace

void buildOutside(Hall& h) {
    // the roof's lamp and the mast with its hatch beside it: lit things one stands by (from 16 m's density: 6.4 cm
    // texels at --texel-scale 2.5)
    DensityZone lamps;
    lamps.first = h.cmark();
    lamps.journey = false;
    lamps.dMin = 16.0f;
    roofLamp(h);
    mast(h);
    lamps.end = h.cmark();
    h.s.zones.push_back(lamps);
    // the deck: dark but round the lamp and the hatch, tile by tile from 32 cm to twice the coarsest
    DensityZone roof;
    roof.first = h.cmark();
    roof.journey = false;
    roof.dMin = 40.0f;
    roof.texelMul = 2.0f;
    roofDeck(h);
    roof.end = h.cmark();
    h.s.zones.push_back(roof);
    // far: the walls, the underside, the columns: no light reaches them but the faint spill of the roof's lamps, so
    // 2.5 m texels (four times the coarsest)
    DensityZone far;
    far.first = h.cmark();
    far.journey = false;
    far.dMin = 1e4f;
    far.texelMul = 4.0f;
    shell(h);
    for (float x : kLegX)
        for (float z : kLegZ) column(h, x, z);
    far.end = h.cmark();
    h.s.zones.push_back(far);
    const float e = 1.6f;
    h.s.walk.push_back({v3(0, kRoof + e, kTopTread - 1.0f)});                       // out of the hatch
    h.s.walk.push_back({v3(0, kRoof + e, 0.5f * (kLampZ0 + kLampZ1))});              // by the lamp

    // anchors for the window's void: the facility's bounds, the block, the deck one walks and lands on, the lamps
    const float W = kBlockHW;
    h.anchorBox("dis_sinir", "nokta", v3(-W, kLegBottom, kBlockZ1), v3(W, kRoof + kMastH + 0.5f, kBlockZ0));
    h.anchorBox("dis_blok", "nokta", v3(-W, kBlockY0, kBlockZ1), v3(W, kRoof, kBlockZ0));
    h.anchorBox("dis_cati", "nokta", v3(-W, kRoof, kBlockZ1), v3(W, kRoof, kBlockZ0));
    h.anchorBox("dis_kuyu_lamba", "nokta", v3(-kLampX - kRim, kLampY, kLampZ1 - kRim), v3(kLampX + kRim, kRoof + 0.06f, kLampZ0 + kRim));
}

}   // namespace salon::hall
