// The monument at the hall's end (docs/SALON.md): centre x = 0, its face at z = -256, the end wall at z = -275.
// A stepped plinth; a brutalist mass 26 m wide and 24 m tall with rusticated pylons, stepped jambs and imposts, a
// half-round arch of 17 concrete voussoirs and a great keystone carrying the temperature display, a steel ring lining
// the opening, thin light strips in its reveal; behind the opening (14 x 18 m) a light chamber whose back wall is the
// light. Six stop lamps round the inner rim with their degree plates, cold to hot from lower left to lower right. On the
// plinth before the opening the console: the RGB lever, its plate, the three device lamps and their plates.
#include "scene/hall_kit.h"

#include <algorithm>
#include <cmath>

namespace salon::hall {

namespace {

constexpr float kFace = -256.0f;          // the mass's front face
constexpr float kProud = 0.3f;            // the voussoirs and jambs stand out of it
constexpr float kRevealBack = -260.0f;    // the reveal's end, the chamber's start
constexpr float kChamberBack = -266.0f;   // the light wall
constexpr float kMassBack = -266.6f;
constexpr float kBase = 1.2f;             // the plinth's top
constexpr float kSpring = 12.2f;          // the arch springs here: the opening is 14 m wide, 18 m tall (to 19.2)
constexpr float kRi = 7.0f, kRo = 9.4f;   // intrados, extrados
constexpr float kHalfW = 13.0f, kTop = 25.2f;
constexpr int kVoussoirs = 17;
const int kStopOn[6] = {15, 12, 9, 7, 4, 1};   // the voussoir each stop lamp sits on, from lower left to lower right

// a round lens of radius r at c facing n: a levha face (uv 0..1 over its square), its uv2 in metres
void lens(Hall& h, float3 c, float3 n, float r) {
    const size_t vm = h.vmark();
    h.at(facing(c, n), M_MERCEK, 0.05f).ring(0.0f, r, 0.0f, true);
    for (size_t i = vm; i < h.s.mesh.v.size(); ++i) {
        dz::Vtx& v = h.s.mesh.v[i];
        v.uv2 = v.uv;
        v.uv = make_float2(0.5f + v.uv.x / (2 * r), 0.5f - v.uv.y / (2 * r));
    }
}

void plinth(Hall& h) {
    // three steps of 0.3 m across its front, then the plinth itself to behind the mass
    for (int k = 1; k <= 3; ++k) {
        const float zf = -248.0f - 0.5f * (k - 1);
        h.box(v3(0, 0.15f * k, zf - 0.25f), v3(16.0f, 0.15f * k, 0.25f), 0.03f, M_ANIT, 4.0f);
    }
    const float za = -249.5f, zb = -268.0f;
    h.box(v3(0, 0.5f * kBase, 0.5f * (za + zb)), v3(16.0f, 0.5f * kBase, 0.5f * (za - zb)), 0.03f, M_ANIT, 4.0f);
}

void mass(Hall& h) {
    const Xform front = axes(v3(0, 0, kFace), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1));
    // the pylons below the springing: rusticated (horizontal grooves every 1.4 m)
    Formwork rust;
    rust.pu = 0.0f;
    rust.pv = 1.4f;
    rust.ov = kBase;
    rust.depth = 0.025f;
    rust.halfWidth = 0.03f;
    h.formworkFace(front, kRo, kHalfW, kBase, kSpring, rust, M_ANIT);
    h.formworkFace(front, -kHalfW, -kRo, kBase, kSpring, rust, M_ANIT);
    // the face above the springing, round the extrados
    h.archFrame(front * Xform::at(v3(0, kSpring, 0)), kRo, kHalfW, kTop - kSpring, true, M_ANIT);
    // the sides, the top, the back
    for (int s : {-1, 1})
        h.patch(v3(s * kHalfW, kBase, kFace), v3(s * kHalfW, kBase, kMassBack), v3(s * kHalfW, kTop, kFace),
                v3(s * kHalfW, kTop, kMassBack), v3(float(s), 0, 0), M_ANIT);
    h.patch(v3(-kHalfW, kTop, kFace), v3(kHalfW, kTop, kFace), v3(-kHalfW, kTop, kMassBack), v3(kHalfW, kTop, kMassBack),
            v3(0, 1, 0), M_ANIT);
    h.patch(v3(-kHalfW, kBase, kMassBack), v3(kHalfW, kBase, kMassBack), v3(-kHalfW, kTop, kMassBack),
            v3(kHalfW, kTop, kMassBack), v3(0, 0, -1), M_ANIT);
    // the crown: two stepped bands standing out of the front and the sides
    auto band = [&](float y0, float y1, float out) {
        const float zf = kFace + out, zb = kMassBack - 0.05f;
        h.box(v3(0, 0.5f * (y0 + y1), 0.5f * (zf + zb)), v3(kHalfW + out, 0.5f * (y1 - y0), 0.5f * (zf - zb)), 0.04f, M_ANIT, 4.0f);
    };
    band(23.8f, 24.4f, 0.15f);
    band(24.4f, kTop, 0.35f);
    // the jambs (the opening's straight sides) and the imposts at the springing
    for (int s : {-1, 1}) {
        h.box(v3(s * 0.5f * (kRi + kRo), 0.5f * (kBase + kSpring), 0.5f * (kFace + kProud + kRevealBack)),
              v3(0.5f * (kRo - kRi), 0.5f * (kSpring - kBase), 0.5f * (kFace + kProud - kRevealBack)), 0.04f, M_ANIT, 3.0f);
        h.box(v3(s * 0.5f * (kRi + 9.8f), kSpring - 0.3f, 0.5f * (kFace + 0.6f + kRevealBack - 0.2f)),
              v3(0.5f * (9.8f - kRi), 0.3f, 0.5f * (kFace + 0.6f - kRevealBack + 0.2f)), 0.04f, M_ANIT, 3.0f);
        // the archivolt's order continuing down beside the jamb, a string course at the springing across the pylon,
        // a pilaster strip at the mass's corner: the pylon's face becomes two framed panels
        h.box(v3(s * 0.5f * (kRo + 9.9f), 0.5f * (kBase + kSpring - 0.6f), kFace + 0.1f), v3(0.25f, 0.5f * (kSpring - 0.6f - kBase), 0.1f),
              0.03f, M_ANIT, 3.0f);
        h.box(v3(s * 0.5f * (9.8f + 12.3f), kSpring - 0.3f, kFace + 0.1f), v3(0.5f * (12.3f - 9.8f), 0.3f, 0.1f), 0.03f, M_ANIT, 3.0f);
        h.box(v3(s * 12.65f, 0.5f * (kBase + 23.8f), kFace + 0.1f), v3(0.35f, 0.5f * (23.8f - kBase), 0.1f), 0.03f, M_ANIT, 3.0f);
    }
    // the archivolt: a band round the voussoirs, standing out 0.2 m
    {
        std::vector<float2> av = Kit::roundOutline({{kRo, kFace - 0.05f}, {9.9f, kFace - 0.05f}, {9.9f, kFace + 0.2f}, {kRo, kFace + 0.2f}},
                                                   0.03f, 2);
        av.push_back(av.front());
        h.at(axes(v3(0, kSpring, 0), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)), M_ANIT, 1.0f).lathe(av, 0.0f, kPi);
    }
    // the voussoirs: annular sectors extruded through the reveal; the joints are their rounded edges meeting
    const Xform arch = axes(v3(0, kSpring, 0), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1));
    for (int i = 0; i < kVoussoirs; ++i) {
        const float a0 = kPi * i / kVoussoirs, a1 = kPi * (i + 1) / kVoussoirs;
        std::vector<float2> poly;
        if (i == kVoussoirs / 2) {
            // the keystone: its stem between the joints (a voussoir carried up into the block), and the block rising
            // above the extrados that carries the display; both convex
            poly.push_back({kRi * std::cos(a0), kRi * std::sin(a0)});
            poly.push_back({kRo * std::cos(a0), kRo * std::sin(a0)});
            poly.push_back({kRo * std::cos(a0), 9.7f});
            poly.push_back({kRo * std::cos(a1), 9.7f});
            poly.push_back({kRo * std::cos(a1), kRo * std::sin(a1)});
            for (int q = 0; q < 4; ++q) {
                const float a = a1 + (a0 - a1) * q / 4;
                poly.push_back({kRi * std::cos(a), kRi * std::sin(a)});
            }
            h.at(arch, M_ANIT, 2.0f).extrude(Kit::roundOutline(poly, 0.05f, 2), kRevealBack, kFace + kProud + 0.5f, true);
            const std::vector<float2> block = {{2.4f, 9.55f}, {2.4f, 11.4f}, {-2.4f, 11.4f}, {-2.4f, 9.55f}};
            h.at(arch, M_ANIT, 2.0f).extrude(Kit::roundOutline(block, 0.05f, 2), kRevealBack, kFace + kProud + 0.5f, true);
            continue;
        }
        for (int q = 0; q <= 6; ++q) {
            const float a = a0 + (a1 - a0) * q / 6;
            poly.push_back({kRo * std::cos(a), kRo * std::sin(a)});
        }
        for (int q = 0; q <= 5; ++q) {
            const float a = a1 + (a0 - a1) * q / 5;
            poly.push_back({kRi * std::cos(a), kRi * std::sin(a)});
        }
        h.at(arch, M_ANIT, 2.0f).extrude(Kit::roundOutline(poly, 0.05f, 2), kRevealBack, kFace + kProud, true);
    }
}

void ringAndStrips(Hall& h) {
    // the steel ring lining the opening's front edge: an angle section round the arch and down both jambs
    std::vector<float2> L = {{6.78f, -255.74f}, {6.96f, -255.74f}, {6.96f, -256.40f}, {7.0f, -256.40f}, {7.0f, -255.70f},
                             {6.78f, -255.70f}};
    std::vector<float2> ring = Kit::roundOutline(L, 0.006f, 2);
    ring.push_back(ring.front());
    const Xform arch = axes(v3(0, kSpring, 0), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1));
    h.at(arch, M_KOYU, 0.5f).lathe(ring, 0.0f, kPi);
    ring.pop_back();
    const Xform jambR = axes(v3(0, kSpring, 0), v3(1, 0, 0), v3(0, 0, 1), v3(0, -1, 0));
    const Xform jambL = axes(v3(0, kBase, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 1, 0));
    h.at(jambR, M_KOYU, 2.0f).extrude(ring, 0.0f, kSpring - kBase, false);
    h.at(jambL, M_KOYU, 2.0f).extrude(ring, 0.0f, kSpring - kBase, false);
    // rivets along the ring's face
    for (int i = 0; i <= 40; ++i) {
        const float a = kPi * i / 40, r = 6.88f;
        h.at(Xform::at(v3(r * std::cos(a), kSpring + r * std::sin(a), -255.70f)), M_KOYU, 0.02f).dome(0.018f, 0.01f);
    }
    // the light strips in the reveal, half way back: 6 cm wide, round the arch and down the jambs
    const float zs = 0.5f * (kFace + kRevealBack), rs = 6.975f;
    std::vector<float2> S = {{rs, zs - 0.03f}, {7.005f, zs - 0.03f}, {7.005f, zs + 0.03f}, {rs, zs + 0.03f}};
    S.push_back(S.front());
    h.at(arch, M_KEMER_ISIK, 0.5f).lathe(S, 0.0f, kPi);
    // The final two lathe rows bound the flat inward-facing luminous surface, including the kit's edge rounding.
    // Use those actual facets, not tangent planes (whose ends used to enter the concrete reveal).
    const int nSeg = h.k.arcSegs(7.005f, kPi, 4);
    const size_t innerRow = h.s.mesh.v.size() - (nSeg + 1);
    S.pop_back();
    h.at(jambR, M_KEMER_ISIK, 2.0f).extrude(S, 0.0f, kSpring - kBase, false);
    h.at(jambL, M_KEMER_ISIK, 2.0f).extrude(S, 0.0f, kSpring - kBase, false);
    auto strip = [&](float3 c, float3 u, float3 n) {
        Emitter e;
        e.type = Emitter::RECT;
        e.group = GROUP_KEMER;
        e.c = c;
        e.u = u;
        e.v = v3(0, 0, 0.03f);
        e.n = n;
        e.L = kKemerL;
        h.s.lights.push_back(e);
    };
    const size_t curvedBegin = h.s.lights.size();
    double area = 0;
    for (int k = 0; k < nSeg; ++k) {
        const float3 a = h.s.mesh.v[innerRow + k].p, b = h.s.mesh.v[innerRow + k + 1].p;
        const float3 upper = h.s.mesh.v[innerRow - (nSeg + 1) + k].p;
        const float3 u = (b - a) * 0.5f, v = (upper - a) * 0.5f;
        strip(a + u + v, u, -normalize(cross(u, v)));
        h.s.lights.back().v = v;
        area += 4.0 * length(cross(u, v));
    }
    // Preserve the old 12 rectangles' integrated flux. This is an area quadrature correction, not a change to
    // the luminous material: the actual face is slightly narrower because its edge is rounded by the kit.
    const double oldArea = 12.0 * (2.0 * rs * std::sin(kPi / 24.0f)) * (2.0 * 0.03f);
    for (size_t i = curvedBegin; i < h.s.lights.size(); ++i)
        h.s.lights[i].L = float(kKemerL * oldArea / area);
    for (int s : {-1, 1}) strip(v3(s * rs, 0.5f * (kBase + kSpring), zs), v3(0, 0.5f * (kSpring - kBase), 0), v3(float(-s), 0, 0));
}

void chamber(Hall& h) {
    // the chamber behind the opening: wider and taller than it, so the light spills round the reveal's edges
    const float hw = 8.6f, ceil = 20.6f;
    const Xform inner = axes(v3(0, kSpring, kRevealBack), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1));
    h.archFrame(inner, kRi, hw, ceil - kSpring, false, M_ANIT);
    for (int s : {-1, 1}) {
        h.patch(v3(s * kRi, kBase, kRevealBack), v3(s * hw, kBase, kRevealBack), v3(s * kRi, kSpring, kRevealBack),
                v3(s * hw, kSpring, kRevealBack), v3(0, 0, -1), M_ANIT);
        h.patch(v3(s * hw, kBase, kRevealBack), v3(s * hw, kBase, kChamberBack), v3(s * hw, ceil, kRevealBack),
                v3(s * hw, ceil, kChamberBack), v3(float(-s), 0, 0), M_ANIT);
    }
    h.patch(v3(-hw, ceil, kRevealBack), v3(hw, ceil, kRevealBack), v3(-hw, ceil, kChamberBack), v3(hw, ceil, kChamberBack),
            v3(0, -1, 0), M_ANIT);
    // the light wall and its emitter
    const float yc = 0.5f * (kBase + ceil);
    h.quad(axes(v3(0, yc, kChamberBack), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)), 2 * hw, ceil - kBase, M_KEMER_ISIK, 4.0f);
    Emitter e;
    e.type = Emitter::RECT;
    e.group = GROUP_KEMER;
    e.c = v3(0, yc, kChamberBack + 0.001f);
    e.u = v3(hw, 0, 0);
    e.v = v3(0, 0.5f * (ceil - kBase), 0);
    e.n = v3(0, 0, 1);
    e.L = kKemerL;
    h.s.lights.push_back(e);
}

void displayAndStops(Hall& h) {
    // the keystone's display, recessed in a bezel
    const float kz = kFace + kProud + 0.5f;   // the keystone's face
    const float3 dc = v3(0, kSpring + 10.45f, kz + 0.003f);
    const float dw = 4.0f, dh = 1.6f;
    h.levha("kilit_tasi_ekran", "kilit_tasi_ekran", dc, v3(0, 0, 1), dw, dh, M_EKRAN);
    for (int s = -1; s <= 1; s += 2) {
        h.box(v3(0, dc.y + s * (0.5f * dh + 0.06f), kz + 0.04f), v3(0.5f * dw + 0.12f, 0.06f, 0.04f), 0.015f, M_KOYU, 1.0f);
        h.box(v3(s * (0.5f * dw + 0.06f), dc.y, kz + 0.04f), v3(0.06f, 0.5f * dh, 0.04f), 0.015f, M_KOYU, 1.0f);
    }
    // the stop lamps: a housing with a hood, a lens in a bezel; a plate outside each
    const float zf = kFace + kProud;
    for (int i = 0; i < 6; ++i) {
        const float a = kPi * (kStopOn[i] + 0.5f) / kVoussoirs;
        const float3 rad = v3(std::cos(a), std::sin(a), 0);
        const float3 c = v3(7.75f * rad.x, kSpring + 7.75f * rad.y, zf);
        const Xform t = facing(c, v3(0, 0, 1));
        h.at(t, M_KOYU, 0.1f).roundedCylinder(0.3f, 0.0f, 0.22f, 0.02f);
        h.at(t * Xform::at(v3(0, 0, 0.22f)), M_KOYU, 0.1f).torus(0.235f, 0.02f);
        lens(h, c + v3(0, 0, 0.222f), v3(0, 0, 1), 0.215f);
        h.at(t, M_KOYU, 0.1f).cylinderWall(0.312f, 0.0f, kPi, 0.12f, 0.42f, false);
        h.at(t, M_KOYU, 0.1f).cylinderWall(0.304f, 0.0f, kPi, 0.12f, 0.42f, true);
        Anchor an;
        an.name = "durak_" + std::to_string(i);
        an.type = "nokta";
        an.box = {c + v3(0, 0, 0.22f), v3(0.3f, 0, 0), v3(0, 0.3f, 0), v3(0, 0, 0.15f)};
        h.s.anchors.push_back(an);
        const float3 pc = v3(8.65f * rad.x, kSpring + 8.65f * rad.y, zf);
        h.box(pc + v3(0, 0, 0.006f), v3(0.37f, 0.16f, 0.006f), 0.003f, M_SAC, 0.5f);
        h.levha("durak_plaka_" + std::to_string(i), "durak_plaka_" + std::to_string(i), pc + v3(0, 0, 0.0125f), v3(0, 0, 1),
                0.7f, 0.28f, M_TABELA);
    }
}

void console(Hall& h) {
    // a steel console on a concrete base before the opening, its top sloping towards the viewer
    const float zf = -251.7f, depth = 1.0f, y0 = kBase + 0.3f, hf = 0.75f, hb = 1.0f, x0 = -3.8f, x1 = 3.8f;
    h.box(v3(0, kBase + 0.15f, zf - 0.5f), v3(3.9f, 0.15f, 0.6f), 0.03f, M_ANIT, 2.0f);
    const Xform t = axes(v3(x0, y0, zf), v3(0, 0, -1), v3(0, 1, 0), v3(1, 0, 0));
    h.at(t, M_KOYU, 2.0f).extrude(Kit::roundOutline({{0, 0}, {depth, 0}, {depth, hb}, {0, hf}}, 0.03f, 3), 0.0f, x1 - x0, true);
    const float3 nTop = normalize(v3(0, depth, hb - hf));
    auto top = [&](float x, float d) { return v3(x, y0 + hf + (hb - hf) * d / depth, zf - d); };
    // the RGB lever: two cheeks on the top, the arm (Scene::dyn) between them, its plate on the front
    const float lx = -1.6f;
    const float3 pivot = top(lx, 0.5f) + nTop * 0.09f;
    for (int s = -1; s <= 1; s += 2)
        h.box(axes(top(lx + s * 0.11f, 0.5f) + nTop * 0.07f, v3(1, 0, 0), nTop, cross(v3(1, 0, 0), nTop)), v3(0.015f, 0.07f, 0.12f),
              0.006f, M_SAC, 0.2f);
    {
        Dynamic d;
        d.name = "kol_rgb";
        d.centre = pivot;
        d.axis = v3(1, 0, 0);   // own frame: x the hinge, y up, z towards the viewer; built at rest, leaning 15 degrees
        Kit q(d.mesh);
        q.maxEdge = 0.2f;
        q.mat = M_SAC;
        q.t = Xform::frame(v3(-0.09f, 0, 0), v3(1, 0, 0), v3(0, 1, 0));
        q.roundedCylinder(0.06f, 0.0f, 0.18f, 0.01f);
        const float lean = 15.0f * kPi / 180.0f;
        const float3 up = v3(0, std::cos(lean), std::sin(lean));
        q.mat = M_KOYU;
        q.t = axes(up * 0.5f, v3(1, 0, 0), up, cross(v3(1, 0, 0), up));
        q.roundedBox(v3(0.03f, 0.5f, 0.025f), 0.01f);
        q.mat = M_KABLO;
        q.t = Xform::frame(up * 1.02f + v3(-0.2f, 0, 0), v3(1, 0, 0), v3(0, 1, 0));
        q.roundedCylinder(0.035f, 0.0f, 0.4f, 0.012f);
        d.radius = 1.1f;
        d.blades = 0;
        d.bakeTransmit = 1.0f;
        h.s.dyn.push_back(std::move(d));
        Anchor an;
        an.name = "kol_rgb";
        an.type = "nokta";
        an.box = {pivot + up * 0.55f, v3(0.25f, 0, 0), up * 0.6f, cross(v3(1, 0, 0), up) * 0.12f};
        an.pivot = pivot;
        an.axis = v3(1, 0, 0);
        h.s.anchors.push_back(an);
    }
    h.levha("plaka_rgb", "plaka_rgb", v3(lx, y0 + 0.37f, zf + 0.003f), v3(0, 0, 1), 1.3f, 0.45f, M_TABELA);
    h.anchor("anahtar_rgb", "tik", Xform::at(v3(lx, y0 + 0.8f, zf - 0.4f)), v3(0.7f, 0.95f, 0.65f));
    // the device lamps on the top, their plates on the front
    const char* dev[3] = {"aio", "klavye", "gpu"};
    for (int i = 0; i < 3; ++i) {
        const float x = 0.4f + 1.2f * i;
        const float3 c = top(x, 0.45f);
        const Xform lt = facing(c, nTop);
        h.at(lt, M_KOYU, 0.05f).roundedCylinder(0.14f, 0.0f, 0.07f, 0.01f);
        h.at(lt * Xform::at(v3(0, 0, 0.07f)), M_KOYU, 0.05f).torus(0.12f, 0.012f);
        lens(h, c + nTop * 0.072f, nTop, 0.11f);
        h.anchor(std::string("lamba_") + dev[i], "nokta", facing(c + nTop * 0.08f, nTop), v3(0.15f, 0.15f, 0.08f));
        h.levha(std::string("cihaz_") + dev[i], std::string("cihaz_") + dev[i], v3(x, y0 + 0.37f, zf + 0.003f), v3(0, 0, 1), 1.1f,
                0.4f, M_TABELA);
    }
    // two lamps on posts at its ends, lighting its plates
    for (int s = -1; s <= 1; s += 2) {
        const float3 b = v3(s * 4.4f, kBase, zf - 0.9f);
        h.box(b + v3(0, 0.01f, 0), v3(0.15f, 0.01f, 0.15f), 0.004f, M_KOYU, 0.3f);
        h.rod(b, b + v3(0, 2.7f, 0), 0.045f, M_KOYU);
        h.cagedLamp(b + v3(0, 2.4f, 0.045f), v3(0, 0, 1), kBulbBoard);
    }
}

// floodlights sunk in the plinth before the face (group 1): they wash the monument upwards in the temperature colour,
// so arriving the arch itself is lit, not only its opening; a housing of dark steel, a glass slot that glows
void floods(Hall& h) {
    const float z = kFace + 5.0f, tilt = 14.0f * kPi / 180.0f;
    for (float x : {-11.0f, -5.2f, 5.2f, 11.0f}) {
        h.box(v3(x, kBase + 0.06f, z), v3(0.55f, 0.06f, 0.28f), 0.012f, M_KOYU, 0.5f);
        h.at(axes(v3(x, kBase + 0.121f, z), v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0)), M_KEMER_ISIK, 1.0f).quad(0.9f, 0.36f);
        Emitter e;
        e.type = Emitter::RECT;
        e.group = GROUP_KEMER;
        e.c = v3(x, kBase + 0.122f, z);
        e.u = v3(0.45f, 0, 0);
        e.v = v3(0, 0, 0.18f);
        e.n = v3(0, std::cos(tilt), -std::sin(tilt));
        e.L = kKemerFloodL;
        e.lobe = 24.0f;
        h.s.lights.push_back(e);
    }
}

void doors(Hall& h) {
    // service doors in both pylons; the exit sign over the right one, a lamp over the left one
    for (int s = -1; s <= 1; s += 2) {
        const float x = s * 11.2f;
        h.box(v3(x, kBase + 1.2f, kFace + 0.05f), v3(0.68f, 1.2f, 0.05f), 0.012f, M_KOYU, 0.5f);
        h.box(v3(x, kBase + 1.15f, kFace + 0.125f), v3(0.55f, 1.15f, 0.025f), 0.008f, M_PASLI, 0.5f);
        h.rod(v3(x - s * 0.42f, kBase + 1.0f, kFace + 0.17f), v3(x - s * 0.42f, kBase + 1.2f, kFace + 0.17f), 0.016f, M_KOYU);
    }
    const float3 c = v3(11.2f, kBase + 3.1f, kFace + 0.075f);
    h.box(c, v3(0.8f, 0.3f, 0.075f), 0.02f, M_KOYU, 0.5f);
    h.levha("cikis_2", "cikis_2", c + v3(0, 0, 0.077f), v3(0, 0, 1), 1.45f, 0.48f, M_EKRAN);
    h.anchor("cikis_2", "tik", Xform::at(c), v3(0.85f, 0.35f, 0.15f));
    h.cagedLamp(v3(-11.2f, kBase + 3.2f, kFace), v3(0, 0, 1), kBulbBoard);
}

}   // namespace

void buildArch(Hall& h) {
    plinth(h);
    mass(h);
    ringAndStrips(h);
    chamber(h);
    displayAndStops(h);
    console(h);
    floods(h);
    doors(h);
}

}   // namespace salon::hall
