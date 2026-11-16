// Set dressing from Poly Haven models (CC0 1.0, https://polyhaven.com/license): the gallery as a working place, every
// object with a purpose. A drain line along each side wall from the back wall to a floor penetration near the portal
// (flanged pipe, a valve with its handwheel by the boards), the supply-air duct hung under the ceiling along each side
// wall to a fan outlet facing the portal, rusty bins by the stair's foot, a board and the exit door, an aluminium
// ladder put away against the wall by the door. Real measures; nothing in the journey's 1.5 m.
//
// The models are modular kits (all pieces side by side in one glTF): a piece is imported by its node name and placed
// by one of its flanges (the flange's centre and outward normal measured in the kit, below). Procedural steel (stands,
// clamps, plates, hanger anchors) is the hall's own kit, in its materials.
#include "scene/hall_props.h"
#include "model.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <vector>

namespace salon::hall {

namespace {

const char* const kPipes = "modular_industrial_pipes_01";
const char* const kDuct = "modular_airduct_circular_01";

std::string gltf(const Props& p, const char* model) { return p.assetDir + "/model/" + model + "/" + model + "_2k.gltf"; }

// a frame whose rotation takes the local orthonormal pair (n, a) onto the world pair (N, A), placed so that the local
// point pl (in kit metres, before scale) lands on world pw
Xform onto(float3 pl, float3 n, float3 a, float3 pw, float3 N, float3 A, float scale) {
    const float3 b = cross(n, a), B = cross(N, A);
    // R = [N A B] [n a b]^T: column k of R is N n_k + A a_k + B b_k
    auto col = [&](float nk, float ak, float bk) { return N * nk + A * ak + B * bk; };
    Xform t;
    t.x = col(n.x, a.x, b.x);
    t.y = col(n.y, a.y, b.y);
    t.z = col(n.z, a.z, b.z);
    t.o = pw - t.dir(pl * scale);
    return t;
}

// xatlas makes a chart of every bolt and rung (a pipe piece ~150, a duct section ~80): the placement's charts are
// shelved into one, kGap apart, in uv2 (chart metres; uv0 is the model's texture and stays). The gap is ~2.5 texels at
// the density of things within 20 m of the journey (texelFor: 1.6 mm per metre of distance); the oven's dilation fills
// it from both sides, as in the hall's own packed charts
constexpr float kGap = 0.08f;

void packPlacement(Mesh& m, size_t firstVertex, uint32_t firstChart) {
    const uint32_t n = m.charts - firstChart;
    if (n <= 1) return;
    std::vector<float2> lo(n, make_float2(1e30f, 1e30f)), hi(n, make_float2(-1e30f, -1e30f));
    for (size_t i = firstVertex; i < m.v.size(); ++i) {
        const uint32_t c = m.v[i].chart - firstChart;
        lo[c] = make_float2(std::min(lo[c].x, m.v[i].uv2.x), std::min(lo[c].y, m.v[i].uv2.y));
        hi[c] = make_float2(std::max(hi[c].x, m.v[i].uv2.x), std::max(hi[c].y, m.v[i].uv2.y));
    }
    std::vector<uint32_t> order;
    double area = 0;
    float widest = 0;
    for (uint32_t c = 0; c < n; ++c) {
        if (lo[c].x > hi[c].x) continue;   // a chart without vertices (none expected)
        order.push_back(c);
        area += double(hi[c].x - lo[c].x + kGap) * (hi[c].y - lo[c].y + kGap);
        widest = std::max(widest, hi[c].x - lo[c].x);
    }
    std::stable_sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return hi[a].y - lo[a].y > hi[b].y - lo[b].y; });
    const float rowW = std::max(widest, float(std::sqrt(area)) * 1.1f);
    std::vector<float2> shift(n, make_float2(0, 0));
    float x = 0, y = 0, rowH = 0;
    for (uint32_t c : order) {
        const float w = hi[c].x - lo[c].x, h = hi[c].y - lo[c].y;
        if (x > 0 && x + w > rowW) {
            x = 0;
            y += rowH + kGap;
            rowH = 0;
        }
        shift[c] = make_float2(x - lo[c].x, y - lo[c].y);
        x += w + kGap;
        rowH = std::max(rowH, h);
    }
    for (size_t i = firstVertex; i < m.v.size(); ++i) {
        dz::Vtx& v = m.v[i];
        v.uv2 = v.uv2 + shift[v.chart - firstChart];
        v.chart = firstChart;
    }
    m.charts = firstChart + 1;
}

void place(Props& p, const char* model, std::vector<std::string> nodes, const Xform& t, float scale) {
    std::string err;
    const size_t vm = p.h.vmark();
    const uint32_t cm = p.h.cmark();
    if (!importModel(p.h.s, gltf(p, model), t, scale, err, nodes)) throw std::runtime_error("props: " + err);
    packPlacement(p.h.s.mesh, vm, cm);
}

// ---- the pipe kit's pieces (kit metres): every piece along y, its axis at z = -0.025, a valve's wheel towards +z
struct PipePiece {
    const char* node;
    float3 a, b;   // the flanges' centres: a faces -y (where a run enters), b the other end
};
const PipePiece kLong = {"modular_industrial_pipes_01_pipe02", {-0.6f, -1.0017f, -0.025f}, {-0.6f, 0.9517f, -0.025f}};
const PipePiece kShort = {"modular_industrial_pipes_01_pipe01", {0.4f, -0.954f, -0.025f}, {0.4f, -0.096f, -0.025f}};
const PipePiece kValve = {"modular_industrial_pipes_01_pipe08", {-0.3f, -0.9137f, -0.025f}, {-0.3f, -0.5349f, -0.025f}};
// the elbow: one flange faces +y, the other -x
const char* const kElbow = "modular_industrial_pipes_01_pipe04";
const float3 kElbowY = {-0.0761f, 0.9292f, -0.025f}, kElbowX = {-0.3967f, 0.5881f, -0.025f};

const PipePiece& pieceOf(char c) {
    switch (c) {
        case 'L': return kLong;
        case 'S': return kShort;
        case 'V': return kValve;
    }
    throw std::runtime_error(std::string("props: unknown pipe piece ") + c);
}

}   // namespace

float pipeRunLength(const std::string& pieces) {
    float l = 0;
    for (char c : pieces) l += (pieceOf(c).b.y - pieceOf(c).a.y) * kPipeScale;
    return l + (kElbowY.y - kElbowX.y) * kPipeScale;
}

float3 pipeRun(Props& p, float3 start, float3 dir, float3 wheel, const std::string& pieces) {
    Hall& h = p.h;
    const float s = kPipeScale;
    float3 at = start;
    for (char c : pieces) {
        const PipePiece& q = pieceOf(c);
        Xform t = onto(q.a, v3(0, -1, 0), v3(0, 0, 1), at, -dir, wheel, s);
        // the valve's gauge stands on its +x side: up, so a run whose handedness turns it down takes the valve the
        // other way round (it is the same from both ends)
        if (c == 'V' && t.x.y < 0) t = onto(q.b, v3(0, 1, 0), v3(0, 0, 1), at, -dir, wheel, s);
        place(p, kPipes, {q.node}, t, s);
        const float len = (q.b.y - q.a.y) * s;
        if (c == 'L') {
            // a stand under the piece's middle: a foot plate, a square post, a saddle, a clamp ring round the pipe
            const float3 m = at + dir * (0.5f * len);
            const float bottom = m.y - kPipeBodyR;
            const float3 f = v3(m.x, 0, m.z), up = v3(0, 1, 0), across = cross(up, dir);
            h.box(f + v3(0, 0.008f, 0), v3(0.16f, 0.008f, 0.16f), 0.003f, M_KOYU, 0.5f);
            const float post = 0.5f * (bottom - 0.022f - 0.016f);
            h.box(f + v3(0, 0.016f + post, 0), v3(0.04f, post, 0.04f), 0.006f, M_KOYU, 0.5f);
            h.box(axes(f + v3(0, bottom - 0.011f, 0), across, up, dir), v3(0.13f, 0.011f, 0.035f), 0.004f, M_KOYU, 0.5f);
            h.at(Xform::frame(m, dir, up), M_PASLI, 0.3f).torus(kPipeBodyR + 0.009f, 0.008f);
        }
        at = at + dir * len;
    }
    // the elbow turns down; its lower flange lies on the floor (the pipe goes on below it)
    const float3 down = v3(0, -1, 0);
    place(p, kPipes, {kElbow}, onto(kElbowY, v3(0, 1, 0), v3(-1, 0, 0), at, -dir, down, s), s);
    const float3 end = at + dir * ((kElbowY.y - kElbowX.y) * s) + down * ((kElbowY.x - kElbowX.x) * s);
    // a steel plate round the penetration, just under the flange
    h.box(v3(end.x, 0.004f, end.z), v3(0.36f, 0.004f, 0.36f), 0.002f, M_KOYU, 0.5f);
    return end;
}

void ductRun(Props& p, float3 start, float3 dir, int n, float ceilingY) {
    Hall& h = p.h;
    const float s = kDuctScale;
    const float3 up = v3(0, 1, 0);
    const float3 side = normalize(cross(up, dir));
    // the kit's pieces lie along +z, their axes at y = 0. The smooth riveted sections (the spiral-ribbed ones have
    // fine stripes that would shimmer at 20-40 m) start at x = -1.9; the hanger (a band round the duct, two threaded
    // rods and a strut) lies on the axis x = 0.7 at z = 0.3035
    const float sec = 0.8497f;
    float3 at = start;
    for (int i = 0; i < n; ++i) {
        place(p, kDuct, {"modular_airduct_circular_smooth_triple"},
              onto(v3(-1.9f, 0, 0), v3(0, 0, -1), v3(0, 1, 0), at, -dir, up, s), s);
        // a hanger round the middle of every other section, its rods up to anchor plates on the ceiling
        if (i % 2 == 1) {
            const float3 m = at + dir * (0.5f * sec * s);
            place(p, kDuct,
                  {"modular_airduct_circular_brace", "modular_airduct_circular_brace_extention",
                   "modular_airduct_circular_brace_extention_wires"},
                  onto(v3(0.7f, 0, 0.3035f), v3(0, 0, -1), v3(0, 1, 0), m, -dir, up, s), s);
            for (float r : {-0.1035f, 0.1035f})
                h.box(m + side * (r * s) + v3(0, ceilingY - m.y - 0.006f, 0), v3(0.05f, 0.006f, 0.05f), 0.002f, M_KOYU, 0.3f);
        }
        at = at + dir * (sec * s);
    }
    // the fan outlet on the duct's end (its collar on the section's end, the grille towards dir)
    place(p, kDuct, {"modular_airduct_circular_fan"}, onto(v3(0.7f, 0, 0.7f), v3(0, 0, -1), v3(0, 1, 0), at, -dir, up, s), s);
}

void trashCan(Props& p, float3 at, float yawDeg) {
    const float a = yawDeg * kPi / 180.0f;
    const float3 x = v3(std::cos(a), 0, -std::sin(a)), z = v3(std::sin(a), 0, std::cos(a));
    // the rust can's own centre in the kit is (-0.5, 0, 0); its lid leans on its -x side
    place(p, "metal_trash_can",
          {"metal_trash_can_rust", "metal_trash_can_rust_handle_left", "metal_trash_can_rust_handle_right",
           "metal_trash_can_rust_lid"},
          onto(v3(-0.5f, 0, 0), v3(1, 0, 0), v3(0, 0, 1), at, x, z, 1.0f), 1.0f);
}

void ladder(Props& p, float3 foot, float3 wallN, float wallPlane, float leanDeg) {
    // the kit's ladder stands on y = 0 in its xy plane, centred at x = 0.03, its back at z = -0.096 (the top's back
    // rests on the wall), the lowest back corner of its feet at z = -0.039
    const float a = leanDeg * kPi / 180.0f;
    const float3 n = normalize(v3(wallN.x, 0, wallN.z));
    const float3 d = v3(0, std::cos(a), 0) - n * std::sin(a);   // up the ladder, towards the wall
    const float3 zf = n * std::cos(a) + v3(0, std::sin(a), 0);  // the ladder's front, away from the wall
    const float3 xa = cross(d, zf);                             // along the wall
    // the top's back on the wall (2 mm off) sets how far out the feet stand; the feet's back corner on the floor
    const float out = 2.134f * std::sin(a) + 0.096f * std::cos(a) + 0.002f;
    float3 o = foot - n * (dot(n, foot) - wallPlane) + n * out;
    o.y = 0.039f * std::sin(a);
    Xform t;
    t.x = xa;
    t.y = d;
    t.z = zf;
    t.o = o - t.dir(v3(0.03f, 0, 0));
    place(p, "ladder_sectioned_01", {"ladder_section_01", "ladder_section_02", "ladder_section_03", "ladder_ribbon"}, t,
          1.0f);
}

void buildProps(Hall& h, const std::string& assetDir) {
    Props p{h, assetDir};
    // the gallery: x in [-12, 12], y in [0, 20], z in [0, -44] (scene/hall_gallery.cpp)
    constexpr float kGx = 12.0f, kGy = 20.0f;

    // drain lines at the foot of the side walls, 0.4 m off them: out of the back wall, under the fans' recesses and
    // the lever boxes (whose bottom is at 0.85 m), down into the floor before the exit door (left) and the portal
    // (right). Each has a valve by its board, clear of the lever box, the handwheel towards the gallery.
    {
        const float x = kGx - 0.4f, y = kPipeAxisY;
        const std::string left = "LLLLLLLLLVLS", right = "LLLLLLLLLLVLSS";
        const float zl = -37.8f, zr = -42.6f;   // where each meets the floor
        // the runs start in the back wall (z = 0): laid out back from their ends, their first flange in the wall
        const float sl = zl + pipeRunLength(left), sr = zr + pipeRunLength(right);
        if (sl < 0.05f || sl > 0.6f || sr < 0.05f || sr > 0.6f)
            throw std::runtime_error("props: a drain line does not start in the back wall");
        pipeRun(p, v3(-x, y, sl), v3(0, 0, -1), v3(1, 0, 0), left);
        pipeRun(p, v3(x, y, sr), v3(0, 0, -1), v3(-1, 0, 0), right);
        // the plates where they leave the back wall
        for (float sx : {-x, x}) h.box(v3(sx, y, -0.006f), v3(0.3f, 0.3f, 0.006f), 0.002f, M_KOYU, 0.5f);
    }

    // the supply-air ducts under the ceiling along the side walls, out of the back wall to fan outlets facing the
    // portal (their hangers' rods reach the ceiling)
    {
        const float x = kGx - kDuctR - 0.25f, y = kGy - 0.012f - kDuctHang;
        for (float sx : {-x, x}) {
            ductRun(p, v3(sx, y, 0.15f), v3(0, 0, -1), 23, kGy);   // to z = -39.2
            h.box(v3(sx, y, -0.006f), v3(kDuctR + 0.08f, kDuctR + 0.08f, 0.006f), 0.002f, M_KOYU, 0.5f);
        }
    }

    // bins: by the stair's foot, by the exit door, by the GPU board's lever box
    trashCan(p, v3(2.35f, 0, -8.7f), 200.0f);
    trashCan(p, v3(-11.25f, 0, -38.9f), 95.0f);
    trashCan(p, v3(10.85f, 0, -31.4f), -30.0f);

    // a ladder put away against the left wall between the exit door and the portal
    ladder(p, v3(-kGx, 0, -42.6f), v3(1, 0, 0), -kGx, 17.0f);
}

}   // namespace salon::hall
