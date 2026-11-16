// The monument at the hall's end (docs/SALON.md "Arch"): a hydraulic work in raw cast concrete, built into the end wall
// and the ceiling. Two piers 13 m wide stand the full height in thick pours (a construction joint every lift); between
// them a 14 x 19.2 m opening 8 m deep, closed by a riveted steel sluice gate raised to 40 % of the opening; above it a
// heavy lintel (two pours) with the temperature display in a recessed service housing and over it the gauge: five stop
// lamps in a row, cold to hot from left to right, their plates under them, lit by a hooded strip. Above the lintel the
// hoist bay, open at the back into the chamber. Behind the gate (chamberInterior) the chamber runs 30 m deep, full
// height, through receding concrete portals to the heat core, a stack of steel rings round a glowing finned heart: the
// one light of the place (group 1; no floodlights). It pours out under the gate (the tongue across the plaza), through
// the gaps at its sides, and over the portals into the hoist bay, where the gate's top, the hoist girders and the
// winches stand as silhouettes in a second glowing rectangle high up: the monument reads from the hall's middle.
// Before the steps a low console (the gap under the gate stays in view over it) with the RGB lever, its plate, the
// three device lamps and plates; service doors, the exit sign, caged lamps.
#include "scene/hall_kit.h"

#include <algorithm>
#include <cmath>

namespace salon::hall {

namespace {

// ---- the massing: the shell follows from these (adjust here)
constexpr float kHalfW = 20.0f;          // the mass: x in [-20, 20]
constexpr float kTop = 32.0f;            // the hall's ceiling: the mass is built into it
constexpr float kPierZ = -255.0f;        // the piers' front faces
constexpr float kFace = -256.0f;         // the lintel's face, 1 m behind the piers'
constexpr float kMassBack = -275.0f;     // the hall's end wall
constexpr float kSill = 1.2f;            // the plinth's top, the opening's sill
constexpr float kLift = 3.2f;            // pour height: a construction joint every lift from the sill
constexpr float kOpenHW = 7.0f;          // the opening, 14 m wide ...
constexpr float kOpenTop = kSill + 6 * kLift;   // ... to 20.4 (19.2 m tall), on a joint
constexpr float kLintelTop = kOpenTop + 2 * kLift;   // the lintel, two pours to 26.8; the hoist bay above it
constexpr float kRevealEnd = -263.0f;    // the opening's end, the chamber's start (the bay opens into it too)
// the display's housing in the lintel (a recess 0.5 m deep) and the gauge row over it
constexpr float kHousRX = 4.5f, kHousY0 = 20.9f, kHousY1 = 23.9f;
constexpr float kGaugeY = 25.85f;        // the stop lamps' centres; their plates 1.25 m lower
// the gate
constexpr float kGateZ = -260.4f;        // its skin plate's downstream face; the girders stand out towards +z
constexpr float kGateDepth = 0.9f;       // skin to the girders' front flanges
constexpr float kGateHW = 6.65f;         // a 0.27 m gap to each jamb's rail: the light's side slits
constexpr float kGateRaised = 0.4f;      // its lower edge 40 % up the opening
constexpr float kGateBottom = kSill + kGateRaised * (kOpenTop - kSill);
constexpr float kGateTop = kGateBottom + (kOpenTop - kSill) + 0.6f;   // closed, it would reach 0.6 m into the slot
constexpr float kGirderPitch = 2.2f;     // its main girders; the core's heavy rings keep the rhythm
constexpr float kPostIn = 6.15f;         // the end posts' inner faces
// the chamber
constexpr float kChamberBack = -293.0f;  // 30 m behind the gate
constexpr float kChamberHW = 12.0f;      // full height: its ceiling is the hall's (kTop), so the glow reaches the bay
constexpr float kPortalTop = kSill + 7 * kLift;   // the receding portals end at 23.6: the light passes over them
constexpr float kCoreZ = -288.0f;        // the heat core's axis
// the heart: a square glowing column 4 m wide, 18.4 m tall, with eight glowing fins out to r 3.4 inside the rings.
// Its brightness comes from its area (~580 m2 of cekirdek_isik), not from a higher radiance: it never blows out
constexpr float kCoreBase = kSill + 1.4f, kHeartTop = 21.0f, kHeartHW = 2.0f, kFinR = 3.4f;
constexpr float kRingIn = 3.6f, kRingOut = 4.6f;
// the console before the steps
constexpr float kConsoleZ = -240.6f;     // its front face

const float3 X = {1, 0, 0}, Y = {0, 1, 0}, Z = {0, 0, 1};

Formwork lifts() {
    Formwork f;
    f.pu = 0.0f;          // no vertical seams: the pours read as horizontal bands
    f.pv = kLift;
    f.ov = kSill;
    f.depth = 0.05f;
    f.halfWidth = 0.07f;
    return f;
}

// a face of a pier, a jamb, a wall: [u0,u1] x [v0,v1] of t's plane with the lift joints
void liftFace(Hall& h, const Xform& t, float u0, float u1, float v0, float v1) {
    h.formworkFace(t, u0, u1, v0, v1, lifts(), M_DUVAR, 3.0f);
}

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

// a rivet (or bolt) head: a low dome of radius r at p on a face of normal n, 10 segments round (the kit's dome keeps
// chords within 0.05 mm: ~750 triangles a head; these are a pixel or two from the views). Batches of them are packed
// into one light map chart by the caller
void rivet(Hall& h, float3 p, float3 n, float r, int mat) {
    const float hgt = 0.55f * r;
    h.at(facing(p, n), mat, 1.0f).grid(10, 3, [&](int i, int j) {
        const float a = 2.0f * kPi * float(i % 10) / 10, ph = 0.5f * kPi * float(j) / 3;
        const float c = std::cos(ph), sn = std::sin(ph);
        Kit::GridPt g;
        g.p = v3(r * c * std::cos(a), r * c * std::sin(a), hgt * sn - 0.002f);
        g.n = normalize(v3(c * std::cos(a) * hgt, c * std::sin(a) * hgt, sn * r));
        g.s = make_float2(r * a, r * ph);
        return g;
    });
}

// a closed ring about t's z axis from a (r, z) section (counter-clockwise, corners rounded), nu segments round: the
// kit's lathe keeps chords within 0.05 mm, thousands of segments on a 4 m ring; at these sizes 120 do
void ringSection(Hall& h, const Xform& t, int mat, std::vector<float2> sec, int nu) {
    sec.push_back(sec.front());
    const int m = int(sec.size());
    std::vector<float2> nrm(m);
    std::vector<float> sv(m, 0.0f);
    for (int j = 0; j < m; ++j) {
        const float2 a = sec[(j - 1 + m - 1) % (m - 1)], b = sec[j], c = sec[(j + 1) % (m - 1)];
        const float2 d0 = make_float2(b.x - a.x, b.y - a.y), d1 = make_float2(c.x - b.x, c.y - b.y);
        const float l0 = std::hypot(d0.x, d0.y), l1 = std::hypot(d1.x, d1.y);
        const float2 n = make_float2(d0.y / l0 + d1.y / l1, -(d0.x / l0 + d1.x / l1));
        const float ln = std::hypot(n.x, n.y);
        nrm[j] = make_float2(n.x / ln, n.y / ln);
        if (j) sv[j] = sv[j - 1] + std::hypot(sec[j].x - sec[j - 1].x, sec[j].y - sec[j - 1].y);
    }
    h.at(t, mat, 1.0f).grid(nu, m - 1, [&](int i, int j) {
        const float a = 2.0f * kPi * float(i % nu) / nu, ca = std::cos(a), sa = std::sin(a);
        Kit::GridPt g;
        g.p = v3(sec[j].x * ca, sec[j].x * sa, sec[j].y);
        g.n = v3(nrm[j].x * ca, nrm[j].x * sa, nrm[j].y);
        g.s = make_float2(2.0f * kPi * sec[j].x * float(i) / nu, sv[j]);
        return g;
    });
}

// an annular plate ri..ro, thickness th, centred at height y on the vertical axis through (0, ., z)
void annulus(Hall& h, float y, float z, float ri, float ro, float th, int mat) {
    const float e = std::min(0.03f, 0.3f * th);
    const std::vector<float2> sec = Kit::roundOutline({{ri, -0.5f * th}, {ro, -0.5f * th}, {ro, 0.5f * th}, {ri, 0.5f * th}}, e, 2);
    ringSection(h, axes(v3(0, y, z), X, v3(0, 0, -1), Y), mat, sec, 120);
}

// a winch: a rope drum (axis x) between two flanges, the gearbox and the motor outboard on side `out` (+-1)
void winch(Hall& h, float3 c, float out) {
    const Xform ax = axes(c, v3(0, 0, -1), Y, X);   // z along x
    h.at(ax, M_KOYU, 0.3f).roundedCylinder(0.55f, -0.65f, 0.65f, 0.02f);
    for (float s : {-1.0f, 1.0f}) h.at(ax, M_KOYU, 0.3f).roundedCylinder(0.72f, s * 0.65f - 0.04f, s * 0.65f + 0.04f, 0.015f);
    // grooves of the wound rope: thin tori round the drum
    h.at(ax, M_PASLI, 0.3f).roundedCylinder(0.6f, -0.55f, 0.55f, 0.03f);   // the wound rope
    h.box(c + v3(out * 1.0f, -0.05f, 0), v3(0.28f, 0.5f, 0.45f), 0.03f, M_KOYU, 0.5f);
    h.at(axes(c + v3(out * 1.3f, -0.15f, 0), v3(0, 0, -out), Y, v3(out, 0, 0)), M_KOYU, 0.2f).roundedCylinder(0.3f, 0.0f, 0.75f, 0.03f);
    // the frame under it
    for (float s : {-1.0f, 1.0f}) h.box(c + v3(s * 0.75f, -0.6f, 0), v3(0.05f, 0.08f, 0.9f), 0.01f, M_KOYU, 0.5f);
}

// ---------------------------------------------------------------------------------------------------------------------

void plinth(Hall& h) {
    // two steps of 0.4 m across the front, then the plinth to the opening's end; beside the chamber back to the end wall
    for (int k = 1; k <= 2; ++k) {
        const float zf = -247.0f - 0.6f * (k - 1), zb = -249.0f;
        h.box(v3(0, 0.2f * k, 0.5f * (zf + zb)), v3(21.0f, 0.2f * k, 0.5f * (zf - zb)), 0.03f, M_KOLON, 4.0f);
    }
    const float za = -248.2f;
    h.box(v3(0, 0.5f * kSill, 0.5f * (za + kRevealEnd)), v3(21.0f, 0.5f * kSill, 0.5f * (za - kRevealEnd)), 0.03f, M_KOLON, 4.0f);
    for (int s : {-1, 1})
        h.box(v3(s * 16.5f, 0.5f * kSill, 0.5f * (kRevealEnd + kMassBack)), v3(4.5f, 0.5f * kSill, 0.5f * (kRevealEnd - kMassBack)),
              0.03f, M_KOLON, 4.0f);
    // the steel sill under the gate, flush with the concrete
    h.box(v3(0, kSill + 0.005f, kGateZ + 0.35f), v3(kOpenHW, 0.012f, 0.7f), 0.004f, M_KOYU, 2.0f);
}

void mass(Hall& h) {
    // the piers' fronts, their outer sides, the jambs (inner sides) through the opening and the hoist bay
    for (int s : {-1, 1}) {
        liftFace(h, axes(v3(0, 0, kPierZ), X, Y, Z), s < 0 ? -kHalfW : kOpenHW, s < 0 ? -kOpenHW : kHalfW, kSill, kTop);
        const float3 side = v3(float(s), 0, 0);
        // a face of normal n has x = y x n: outer side n = s x, jamb n = -s x
        liftFace(h, axes(v3(s * kHalfW, 0, 0), cross(Y, side), Y, side), s > 0 ? -kPierZ : kMassBack, s > 0 ? -kMassBack : kPierZ, kSill, kTop);
        liftFace(h, axes(v3(s * kOpenHW, 0, 0), cross(Y, -side), Y, -side), s > 0 ? kRevealEnd : -kPierZ, s > 0 ? kPierZ : -kRevealEnd,
                 kSill, kTop);
    }
    // the lintel: a beam 3 m deep in front of the gate's slot, its face framing the display's housing (a 9 x 3 m recess
    // 0.5 m deep); behind the slot the upstream block over the chamber's mouth. Their tops are the hoist bay's floor; the
    // bay has no back wall: it looks into the chamber, whose ceiling is the hall's
    const float zr = kFace - 0.5f, rx = kHousRX, ry0 = kHousY0, ry1 = kHousY1;
    h.box(v3(0, 0.5f * (kOpenTop + kLintelTop), 0.5f * (zr + kGateZ + 1.4f)), v3(kOpenHW, 0.5f * (kLintelTop - kOpenTop), 0.5f * (zr - kGateZ - 1.4f)),
          0.04f, M_DUVAR, 3.0f);
    auto skin = [&](float x0, float x1, float y0, float y1) {
        h.box(v3(0.5f * (x0 + x1), 0.5f * (y0 + y1), 0.5f * (kFace + zr)), v3(0.5f * (x1 - x0), 0.5f * (y1 - y0), 0.5f * (kFace - zr)), 0.04f, M_DUVAR, 3.0f);
    };
    skin(-kOpenHW, kOpenHW, kOpenTop, ry0);
    skin(-kOpenHW, kOpenHW, ry1, kLintelTop);
    skin(-kOpenHW, -rx, ry0, ry1);
    skin(rx, kOpenHW, ry0, ry1);
    h.box(v3(0, 0.5f * (kOpenTop + kLintelTop), 0.5f * (kGateZ - 0.6f + kRevealEnd)),
          v3(kOpenHW, 0.5f * (kLintelTop - kOpenTop), 0.5f * (kGateZ - 0.6f - kRevealEnd)), 0.04f, M_DUVAR, 3.0f);
    // the walkway's railing along the lintel's front edge, 27 m up
    h.railing({v3(-kOpenHW, kLintelTop, kFace - 0.15f), v3(kOpenHW, kLintelTop, kFace - 0.15f)}, 1.75f, M_KOYU);
    // the jambs' steel at the gate: armour plates with bolt rows, and the guide rails the gate's rollers run on
    for (int s : {-1, 1}) {
        const float3 n = v3(float(-s), 0, 0);
        const float za = kGateZ - 0.5f, zb = kGateZ + kGateDepth + 0.5f;
        h.box(v3(s * (kOpenHW - 0.015f), 0.5f * (kSill + kLintelTop), 0.5f * (za + zb)), v3(0.015f, 0.5f * (kLintelTop - kSill), 0.5f * (zb - za)),
              0.006f, M_KOYU, 2.0f);
        h.box(v3(s * (kOpenHW - 0.07f), 0.5f * (kSill + kTop - 1.0f), kGateZ + 0.45f), v3(0.045f, 0.5f * (kTop - 1.0f - kSill), 0.12f),
              0.01f, M_KOYU, 2.0f);
        const size_t vm = h.vmark();
        const uint32_t cm = h.cmark();
        for (float y = kSill + 0.4f; y < kLintelTop; y += 0.8f)
            for (float z : {za + 0.12f, zb - 0.12f}) rivet(h, v3(s * (kOpenHW - 0.03f), y, z), n, 0.035f, M_KOYU);
        h.packCharts(vm, cm, 0.02f);
    }
}

void gate(Hall& h) {
    const float yb = kGateBottom, yt = kGateTop, ym = 0.5f * (yb + yt), hy = 0.5f * (yt - yb);
    const float zc = kGateZ + 0.5f * kGateDepth;   // the girders' axis
    // the skin plate, the heavy bottom beam with its rubber seal, the top beam
    h.box(v3(0, ym, kGateZ - 0.02f), v3(kGateHW, hy, 0.02f), 0.008f, M_KANAT, 3.0f);
    h.box(v3(0, yb + 0.3f, zc), v3(kPostIn, 0.3f, 0.5f * kGateDepth), 0.02f, M_KANAT, 2.0f);
    h.box(v3(0, yb - 0.035f, kGateZ - 0.04f), v3(kGateHW - 0.1f, 0.035f, 0.06f), 0.015f, M_KABLO, 2.0f);
    h.box(v3(0, yt - 0.25f, zc), v3(kPostIn, 0.25f, 0.5f * kGateDepth), 0.02f, M_KANAT, 2.0f);
    // the main girders: welded I sections, web out of the skin, every 2.2 m
    std::vector<float> girders;
    for (float y = yb + kGirderPitch; y < yt - 1.0f; y += kGirderPitch) girders.push_back(y);
    for (float y : girders) h.ibeam(v3(-kPostIn, y, zc), v3(kPostIn, y, zc), kGateDepth, 0.42f, 0.03f, 0.04f, Z, M_KANAT);
    // diaphragms (full depth) and the flat bar stiffeners between them, on the skin
    const float dx = kPostIn / 3.0f;
    for (int i = -2; i <= 2; ++i)
        h.box(v3(i * dx, ym, kGateZ + 0.5f * (kGateDepth - 0.05f)), v3(0.014f, hy - 0.02f, 0.5f * (kGateDepth - 0.05f)), 0.005f, M_KANAT, 3.0f);
    for (int i = -3; i <= 2; ++i)
        h.box(v3((i + 0.5f) * dx, ym, kGateZ + 0.11f), v3(0.01f, hy - 0.02f, 0.11f), 0.004f, M_KANAT, 3.0f);
    // the end posts (heavy boxes), the side rollers in their forks, rivet lines (one packed chart)
    const size_t vm = h.vmark();
    const uint32_t cm = h.cmark();
    for (int s : {-1, 1}) {
        const float xp = s * 0.5f * (kPostIn + kGateHW);
        h.box(v3(xp, ym, kGateZ + 0.5f * (kGateDepth - 0.1f)), v3(0.5f * (kGateHW - kPostIn), hy, 0.5f * (kGateDepth + 0.3f)), 0.02f, M_KOYU, 3.0f);
        const float xr = s * (kOpenHW - 0.12f - 0.17f);
        for (float y = yb + 1.2f; y < yt; y += 4.8f) {
            h.at(axes(v3(xr, y, zc - 0.06f), X, Y, Z), M_KOYU, 0.1f).roundedCylinder(0.17f, 0.0f, 0.12f, 0.02f);
            for (float q : {-0.1f, 0.22f})
                h.box(v3(xr - s * 0.1f, y, zc + q - 0.02f), v3(0.13f, 0.24f, 0.02f), 0.006f, M_KOYU, 0.3f);
        }
        for (float y = yb + 0.3f; y < yt - 0.2f; y += 0.42f)
            for (float q : {-0.12f, 0.12f})
                rivet(h, v3(xp + q, y, kGateZ + kGateDepth + 0.1f), Z, 0.026f, M_KOYU);
    }
    for (float y : girders)
        for (float x = -kPostIn + 0.3f; x < kPostIn - 0.2f; x += 0.41f)
            for (float q : {-0.13f, 0.13f}) rivet(h, v3(x, y + q, kGateZ + kGateDepth), Z, 0.024f, M_KANAT);
    for (float x = -kPostIn + 0.3f; x < kPostIn - 0.2f; x += 0.41f)
        for (float q : {-0.15f, 0.15f}) rivet(h, v3(x, yb + 0.3f + q, zc + 0.5f * kGateDepth), Z, 0.024f, M_KANAT);
    h.packCharts(vm, cm, 0.02f);
}

// the hoist bay above the lintel: the gate's top with its lifting lugs, the hoist frame (two girders across the bay)
// carrying two winches, their ropes down to the lugs; service lamps on the bay's sides
void hoist(Hall& h) {
    const float zc = kGateZ + 0.45f, yg = 30.0f;
    for (float dz : {-1.15f, 1.5f}) {
        h.ibeam(v3(-kOpenHW, yg, zc + dz), v3(kOpenHW, yg, zc + dz), 1.0f, 0.5f, 0.03f, 0.05f, Y, M_KOYU);
        for (int s : {-1, 1}) h.box(v3(s * (kOpenHW - 0.3f), yg - 0.53f, zc + dz), v3(0.3f, 0.03f, 0.35f), 0.01f, M_KOYU, 0.5f);
    }
    for (int s : {-1, 1}) {
        const float x = s * 2.05f * 2.0f;
        // lug on the gate's top beam, its pin
        h.box(v3(x, kGateTop + 0.3f, zc), v3(0.05f, 0.35f, 0.3f), 0.01f, M_KOYU, 0.3f);
        h.rod(v3(x - 0.14f, kGateTop + 0.45f, zc), v3(x + 0.14f, kGateTop + 0.45f, zc), 0.06f, M_KOYU, 0.2f);
        // the winch on two cross beams over the girders, its drum's back tangent above the lug
        for (float q : {-0.75f, 0.75f}) h.box(v3(x + q, yg + 0.62f, zc + 0.17f), v3(0.12f, 0.12f, 1.55f), 0.01f, M_KOYU, 0.5f);
        winch(h, v3(x, yg + 1.32f, zc + 0.55f), float(s));
        for (float q : {-0.08f, 0.08f}) h.rod(v3(x + q, yg + 1.32f, zc + 0.02f), v3(x + q, kGateTop + 0.5f, zc), 0.032f, M_PASLI, 0.5f);
    }
    // no service lamps in the bay: the gate's top, the girders and the winches stand dark against the core's glow
}

void displayAndStops(Hall& h) {
    // the display at the housing's back, a steel liner round the recess, a bezel, a drip hood over it
    const float zr = kFace - 0.5f, rx = kHousRX, ry0 = kHousY0, ry1 = kHousY1, dy = 0.5f * (ry0 + ry1), dw = 8.0f, dh = 2.0f;
    h.levha("kilit_tasi_ekran", "kilit_tasi_ekran", v3(0, dy, zr + 0.062f), Z, dw, dh, M_EKRAN);
    for (int s : {-1, 1}) {
        h.box(v3(0, s > 0 ? ry1 - 0.015f : ry0 + 0.015f, kFace - 0.25f), v3(rx, 0.015f, 0.25f), 0.005f, M_KOYU, 1.0f);
        h.box(v3(s * (rx - 0.015f), 0.5f * (ry0 + ry1), kFace - 0.25f), v3(0.015f, 0.5f * (ry1 - ry0), 0.25f), 0.005f, M_KOYU, 1.0f);
        h.box(v3(0, dy + s * (0.5f * dh + 0.07f), zr + 0.04f), v3(0.5f * dw + 0.14f, 0.07f, 0.04f), 0.012f, M_KOYU, 1.0f);
        h.box(v3(s * (0.5f * dw + 0.07f), dy, zr + 0.04f), v3(0.07f, 0.5f * dh, 0.04f), 0.012f, M_KOYU, 1.0f);
    }
    for (int i = 0; i < 12; ++i) {
        const float x = -0.5f * dw - 0.07f + (dw + 0.14f) * i / 11.0f;
        for (float y : {dy - 0.5f * dh - 0.07f, dy + 0.5f * dh + 0.07f}) h.nut(facing(v3(x, y, zr + 0.08f), Z), 0.04f, M_KOYU);
    }
    h.box(v3(0, ry1 + 0.06f, kFace + 0.2f), v3(rx + 0.2f, 0.03f, 0.2f), 0.01f, M_KOYU, 1.0f);
    // the gauge: the service's five colour stops as five lamps in one row over the display, cold to hot from left to
    // right, on a steel rail across the lintel; each plate under its lamp
    constexpr int kStops = 5;
    const float pitch = 2.9f, yl = kGaugeY, zf = kFace;
    h.box(v3(0, yl, zf + 0.06f), v3(2.0f * pitch + 0.6f, 0.16f, 0.06f), 0.015f, M_KOYU, 2.0f);
    for (int i = 0; i < kStops; ++i) {
        const float x = (i - 2) * pitch;
        const float3 c = v3(x, yl, zf + 0.12f);
        const Xform t = facing(c, Z);
        h.at(t, M_KOYU, 0.1f).roundedCylinder(0.42f, 0.0f, 0.28f, 0.025f);
        h.at(t * Xform::at(v3(0, 0, 0.28f)), M_KOYU, 0.1f).torus(0.39f, 0.028f);
        lens(h, c + v3(0, 0, 0.282f), Z, 0.36f);
        h.at(t, M_KOYU, 0.1f).cylinderWall(0.435f, 0.0f, kPi, 0.2f, 0.62f, false);
        h.at(t, M_KOYU, 0.1f).cylinderWall(0.425f, 0.0f, kPi, 0.2f, 0.62f, true);
        Anchor an;
        an.name = "durak_" + std::to_string(i);
        an.type = "nokta";
        an.box = {c + v3(0, 0, 0.28f), v3(0.45f, 0, 0), v3(0, 0.45f, 0), v3(0, 0, 0.2f)};
        h.s.anchors.push_back(an);
        const float3 pc = v3(x, yl - 1.25f, zf);
        h.box(pc + v3(0, 0, 0.01f), v3(1.06f, 0.56f, 0.01f), 0.004f, M_SAC, 0.5f);
        for (int q = 0; q < 4; ++q) h.nut(facing(pc + v3(q % 2 ? 0.98f : -0.98f, q / 2 ? 0.48f : -0.48f, 0.02f), Z), 0.04f, M_KOYU);
        h.levha("durak_plaka_" + std::to_string(i), "durak_plaka_" + std::to_string(i), pc + v3(0, 0, 0.022f), Z, 2.0f, 1.0f, M_TABELA);
    }
    // the plates' own lamp (group 2): a steel hood on arms 0.45 m out between the lamps and the plates, a light strip
    // under it shining down and back onto the plates (the face is no longer floodlit: the piers stand dark against the
    // glow; the stop lamps light themselves)
    {
        const float out = 0.45f, yh = yl - 0.6f, hw = 2.0f * pitch + 0.9f;
        for (float x : {-hw + 0.3f, -0.5f * pitch, 0.5f * pitch, hw - 0.3f})
            h.bar(v3(x, yh, zf), v3(x, yh, zf + out), 0.04f, 0.04f, Y, M_KOYU);
        h.box(v3(0, yh + 0.04f, zf + out), v3(hw, 0.03f, 0.08f), 0.01f, M_KOYU, 0.5f);
        const float3 dn = normalize(v3(0, -1.0f, -0.55f));
        const float3 c = v3(0, yh + 0.005f, zf + out);
        h.at(facing(c, dn, v3(-1, 0, 0)), M_CAM_LAMBA, 1.0f).quad(0.05f, 2 * (hw - 0.1f));
        Emitter e;
        e.type = Emitter::RECT;
        e.group = GROUP_LAMBA;
        e.c = c + dn * 0.002f;
        e.u = v3(hw - 0.1f, 0, 0);
        e.v = normalize(cross(dn, X)) * 0.025f;
        e.n = dn;
        e.L = kSignLampL;
        e.lobe = 4.0f;
        h.s.lights.push_back(e);
    }
}

void console(Hall& h) {
    // a low steel control cabinet on a concrete pedestal before the steps, its top sloping up towards the monument: it
    // stays under the arriving eye's line to the gate's sill (2.1 m over its back), so the gap under the gate and the
    // light's tongue on the plinth stay in view over it; the plates on its upright front, in the frame's lower edge
    const float zf = kConsoleZ, depth = 1.2f, y0 = 0.55f, hf = 1.3f, hb = 1.45f, x0 = -5.0f, x1 = 5.0f;
    h.box(v3(0, 0.5f * y0, zf - 0.5f * depth), v3(5.2f, 0.5f * y0, 0.5f * depth + 0.15f), 0.03f, M_KOLON, 2.0f);
    const Xform t = axes(v3(x0, y0, zf), v3(0, 0, -1), Y, X);
    h.at(t, M_KOYU, 2.0f).extrude(Kit::roundOutline({{0, 0}, {depth, 0}, {depth, hb}, {0, hf}}, 0.03f, 3), 0.0f, x1 - x0, true);
    const float3 nTop = normalize(v3(0, depth, hb - hf));
    auto top = [&](float x, float d) { return v3(x, y0 + hf + (hb - hf) * d / depth, zf - d); };
    // the RGB lever: two cheeks on the top, the arm (Scene::dyn) between them, its plate on the front
    const float lx = -3.7f;
    const float3 pivot = top(lx, 0.55f) + nTop * 0.12f;
    for (int s = -1; s <= 1; s += 2)
        h.box(axes(top(lx + s * 0.14f, 0.55f) + nTop * 0.09f, X, nTop, cross(X, nTop)), v3(0.02f, 0.09f, 0.16f), 0.008f, M_SAC, 0.2f);
    {
        Dynamic d;
        d.name = "kol_rgb";
        d.centre = pivot;
        d.axis = X;   // own frame: x the hinge, y up, z towards the viewer; built at rest, leaning 15 degrees
        Kit q(d.mesh);
        q.maxEdge = 0.2f;
        q.mat = M_SAC;
        q.t = Xform::frame(v3(-0.12f, 0, 0), X, Y);
        q.roundedCylinder(0.08f, 0.0f, 0.24f, 0.012f);
        const float lean = 15.0f * kPi / 180.0f;
        const float3 up = v3(0, std::cos(lean), std::sin(lean));
        q.mat = M_KOYU;
        q.t = axes(up * 0.65f, X, up, cross(X, up));
        q.roundedBox(v3(0.04f, 0.65f, 0.032f), 0.012f);
        q.mat = M_KABLO;
        q.t = Xform::frame(up * 1.32f + v3(-0.26f, 0, 0), X, Y);
        q.roundedCylinder(0.045f, 0.0f, 0.52f, 0.015f);
        d.radius = 1.45f;
        d.blades = 0;
        d.bakeTransmit = 1.0f;
        h.s.dyn.push_back(std::move(d));
        Anchor an;
        an.name = "kol_rgb";
        an.type = "nokta";
        an.box = {pivot + up * 0.7f, v3(0.32f, 0, 0), up * 0.75f, cross(X, up) * 0.15f};
        an.pivot = pivot;
        an.axis = X;
        h.s.anchors.push_back(an);
    }
    h.levha("plaka_rgb", "plaka_rgb", v3(lx, y0 + 0.75f, zf + 0.003f), Z, 1.6f, 0.8f, M_TABELA);
    h.anchor("anahtar_rgb", "tik", Xform::at(v3(lx, y0 + 1.0f, zf - 0.45f)), v3(0.9f, 1.3f, 0.75f));
    // the device lamps on the front above their plates (a header strip), the plates in a row
    const char* dev[3] = {"aio", "klavye", "gpu"};
    for (int i = 0; i < 3; ++i) {
        const float x = -1.1f + 2.4f * i;
        const float3 c = v3(x, y0 + 1.07f, zf);
        const Xform lt = facing(c, Z);
        h.at(lt, M_KOYU, 0.05f).roundedCylinder(0.15f, 0.0f, 0.08f, 0.012f);
        h.at(lt * Xform::at(v3(0, 0, 0.08f)), M_KOYU, 0.05f).torus(0.13f, 0.014f);
        lens(h, c + v3(0, 0, 0.082f), Z, 0.12f);
        h.anchor(std::string("lamba_") + dev[i], "nokta", facing(c + v3(0, 0, 0.09f), Z), v3(0.16f, 0.16f, 0.08f));
        h.levha(std::string("cihaz_") + dev[i], std::string("cihaz_") + dev[i], v3(x, y0 + 0.6f, zf + 0.003f), Z, 2.0f, 0.5f, M_TABELA);
    }
    // two lamps on posts at its ends, lighting its plates
    for (int s = -1; s <= 1; s += 2) {
        const float3 b = v3(s * 5.7f, 0.0f, zf - 0.4f);
        h.box(b + v3(0, 0.01f, 0), v3(0.15f, 0.01f, 0.15f), 0.004f, M_KOYU, 0.3f);
        h.rod(b, b + v3(0, 3.1f, 0), 0.05f, M_KOYU);
        h.cagedLamp(b + v3(0, 2.8f, 0.05f), Z, kBulbBoard);
    }
}

void doors(Hall& h) {
    // human-sized service doors at the piers' feet: a steel frame, a rusted leaf, a handle; the exit sign over the
    // right one, a lamp over the left one
    for (int s = -1; s <= 1; s += 2) {
        const float x = s * 17.0f;
        h.box(v3(x, kSill + 1.2f, kPierZ + 0.05f), v3(0.68f, 1.2f, 0.05f), 0.012f, M_KOYU, 0.5f);
        h.box(v3(x, kSill + 1.15f, kPierZ + 0.125f), v3(0.55f, 1.15f, 0.025f), 0.008f, M_PASLI, 0.5f);
        h.rod(v3(x - s * 0.42f, kSill + 1.0f, kPierZ + 0.17f), v3(x - s * 0.42f, kSill + 1.2f, kPierZ + 0.17f), 0.016f, M_KOYU);
        h.box(v3(x, kSill + 2.5f, kPierZ + 0.2f), v3(0.85f, 0.06f, 0.2f), 0.015f, M_KOYU, 0.5f);   // a drip hood
    }
    const float3 c = v3(17.0f, kSill + 3.2f, kPierZ + 0.075f);
    h.box(c, v3(0.68f, 0.38f, 0.075f), 0.02f, M_KOYU, 0.5f);
    h.levha("cikis_2", "cikis_2", c + v3(0, 0, 0.077f), Z, 1.2f, 0.6f, M_EKRAN);
    h.anchor("cikis_2_tik", "tik", Xform::at(c), v3(0.75f, 0.45f, 0.18f));
    h.cagedLamp(v3(-17.0f, kSill + 3.2f, kPierZ), Z, kBulbBoard);
}

}   // namespace

// Everything behind the gate's plane: the chamber 30 m deep and full height (its own floor, walls and back wall; its
// ceiling over the mass is the hall's, behind the end wall its own: the hall's end wall is open over it, x in [-12, 12],
// floor to ceiling), four receding concrete portals in the shell's lifts with the gate's steel (a girder of its section
// under each lintel), all ending at 23.6 so the core's light passes over them into the hoist bay, and at the end the
// heat core: a square glowing column with eight glowing fins (cekirdek_isik, group 1; a RECT emitter on every glowing
// face) inside a stack of steel rings, on a concrete drum, held by a steel portal with a winch like the gate's.
void chamberInterior(Hall& h) {
    const float zm = 0.5f * (kRevealEnd + kChamberBack), dz = 0.5f * (kRevealEnd - kChamberBack);
    h.box(v3(0, 0.5f * kSill, zm), v3(kChamberHW, 0.5f * kSill, dz), 0.03f, M_KOLON, 4.0f);
    for (int s : {-1, 1}) {
        const float3 n = v3(float(-s), 0, 0);
        liftFace(h, axes(v3(s * kChamberHW, 0, 0), cross(Y, n), Y, n), s > 0 ? kChamberBack : -kRevealEnd, s > 0 ? kRevealEnd : -kChamberBack,
                 kSill, kTop);
        // the mouth's wall beside the opening and the bay (facing the chamber); over the opening the upstream block's
        // own back face, over that the bay's open back
        h.patch(v3(s * kOpenHW, kSill, kRevealEnd), v3(s * kChamberHW, kSill, kRevealEnd), v3(s * kOpenHW, kTop, kRevealEnd),
                v3(s * kChamberHW, kTop, kRevealEnd), v3(0, 0, -1), M_DUVAR, 3.0f);
    }
    h.patch(v3(-kChamberHW, kTop, kMassBack), v3(kChamberHW, kTop, kMassBack), v3(-kChamberHW, kTop, kChamberBack),
            v3(kChamberHW, kTop, kChamberBack), v3(0, -1, 0), M_TAVAN, 4.0f);
    liftFace(h, axes(v3(0, 0, kChamberBack), X, Y, Z), -kChamberHW, kChamberHW, kSill, kTop);

    // the receding portals: each pour a box (its rounded edges are the joints), each narrower and lower, all ending at
    // the same joint (kPortalTop) with the open chamber above them
    for (int k = 0; k < 4; ++k) {
        const float zc = kRevealEnd - 4.0f - 5.0f * k, hz = 0.8f;
        const float w = kOpenHW - 0.4f - 0.6f * k, top = kOpenTop - 0.8f - 0.7f * k;
        for (float y = kSill; y < kPortalTop - 1e-3f; y += kLift) {
            const float y1 = std::min(kPortalTop, y + kLift), yc = 0.5f * (y + y1), hy = 0.5f * (y1 - y);
            if (y >= top - 1e-3f) {   // above the opening a pour spans the portal
                h.box(v3(0, yc, zc), v3(kChamberHW, hy, hz), 0.05f, M_DUVAR, 3.0f);
                continue;
            }
            for (int s : {-1, 1}) h.box(v3(s * 0.5f * (w + kChamberHW), yc, zc), v3(0.5f * (kChamberHW - w), hy, hz), 0.05f, M_DUVAR, 3.0f);
            if (y1 > top + 0.05f)     // the lintel's first pour, from the opening's top to the joint
                h.box(v3(0, 0.5f * (top + y1), zc), v3(w, 0.5f * (y1 - top), hz), 0.05f, M_DUVAR, 3.0f);
        }
        // the steel: a girder under the lintel, the gate's section (rails on the jambs read as bars through the slot)
        h.ibeam(v3(-w, top - 0.4f, zc + 0.35f), v3(w, top - 0.4f, zc + 0.35f), 0.8f, 0.42f, 0.03f, 0.04f, Y, M_KANAT);
    }

    // the heat core: the concrete drum, the heart and its fins, the rings, the tie columns, the cap
    h.at(axes(v3(0, kSill, kCoreZ), X, v3(0, 0, -1), Y), M_DUVAR, 1.0f).roundedCylinder(5.2f, 0.0f, kCoreBase - kSill, 0.05f);
    const float hh = 0.5f * (kHeartTop - kCoreBase), yh = 0.5f * (kHeartTop + kCoreBase);
    const float3 axis = v3(0, yh, kCoreZ);
    auto glow = [&](float3 c, float3 n, float halfW) {   // a glowing face 2 halfW x 2 hh at c facing n, and its emitter
        const float3 xa = cross(Y, n);
        h.quad(axes(c, xa, Y, n), 2 * halfW, kHeartTop - kCoreBase, M_CEKIRDEK_ISIK, 2.0f);
        Emitter e;
        e.type = Emitter::RECT;
        e.group = GROUP_KEMER;
        e.c = c + n * 0.001f;
        e.u = xa * halfW;
        e.v = v3(0, hh, 0);
        e.n = n;
        e.L = kCekirdekL;
        h.s.lights.push_back(e);
    };
    for (int i = 0; i < 4; ++i) {   // the column, a corner towards the hall
        const float a = 0.25f * kPi + 0.5f * kPi * i;
        const float3 n = v3(std::cos(a), 0, std::sin(a));
        glow(axis + n * kHeartHW, n, kHeartHW);
    }
    // the fins: 0.12 m plates, one from each face's middle and one from each corner, out to kFinR; both sides and the
    // outer edge glow (the edge without an emitter of its own: 0.12 m of it adds little)
    const float ft = 0.06f;
    for (int i = 0; i < 8; ++i) {
        const float a = 0.25f * kPi * i;
        const float3 r = v3(std::cos(a), 0, std::sin(a)), tg = cross(r, Y);
        const float r0 = (i % 2 ? kHeartHW : kHeartHW * 1.41421f) - 0.02f, rm = 0.5f * (r0 + kFinR), hw = 0.5f * (kFinR - r0);
        for (float s : {-1.0f, 1.0f}) glow(axis + r * rm + tg * (s * ft), tg * s, hw);
        h.quad(axes(axis + r * kFinR, cross(Y, r), Y, r), 2 * ft, kHeartTop - kCoreBase, M_CEKIRDEK_ISIK, 2.0f);
    }
    for (int k = 0; k * kGirderPitch + 3.0f < kHeartTop; ++k) {
        const float y = 3.0f + kGirderPitch * k;
        annulus(h, y, kCoreZ, kRingIn, kRingOut, 0.36f, M_KANAT);
        if (y + kGirderPitch < kHeartTop)
            for (int q = 1; q <= 2; ++q) annulus(h, y + kGirderPitch * q / 3.0f, kCoreZ, kRingIn, kRingIn + 0.55f, 0.16f, M_KANAT);
    }
    const float yTie = kHeartTop + 0.6f;
    for (int i = 0; i < 8; ++i) {
        const float a = kPi * i / 4.0f + kPi / 8.0f;
        const float3 r = v3(std::cos(a), 0, std::sin(a));
        h.box(axes(v3(0, 0.5f * (kCoreBase + yTie), kCoreZ) + r * (kRingOut + 0.25f), cross(Y, r), Y, r), v3(0.16f, 0.5f * (yTie - kCoreBase), 0.18f),
              0.015f, M_KOYU, 3.0f);
    }
    const float rCap = kRingOut + 0.3f;
    h.at(axes(v3(0, kHeartTop, kCoreZ), X, v3(0, 0, -1), Y), M_KOYU, 1.0f).roundedCylinder(rCap, 0.0f, 0.6f, 0.04f);
    // the portal: two columns in guide channels, a girder across, the winch and its ropes down to the cap's lug
    const float xp = 6.0f, yg = kHeartTop + 5.5f;
    for (int s : {-1, 1}) {
        h.ibeam(v3(s * xp, kSill, kCoreZ), v3(s * xp, yg - 0.5f, kCoreZ), 0.8f, 0.5f, 0.03f, 0.05f, Z, M_KOYU);
        const float xa0 = rCap - 0.1f, xa1 = xp - 0.25f;   // the cap's guide arm
        h.box(v3(s * 0.5f * (xa0 + xa1), kHeartTop + 0.3f, kCoreZ), v3(0.5f * (xa1 - xa0), 0.25f, 0.3f), 0.02f, M_KOYU, 0.5f);
    }
    h.ibeam(v3(-xp - 0.5f, yg, kCoreZ), v3(xp + 0.5f, yg, kCoreZ), 1.0f, 0.5f, 0.03f, 0.05f, Y, M_KOYU);
    winch(h, v3(0, yg + 1.4f, kCoreZ + 0.55f), 1.0f);
    h.box(v3(0, kHeartTop + 0.95f, kCoreZ), v3(0.06f, 0.35f, 0.3f), 0.01f, M_KOYU, 0.3f);
    for (float q : {-0.08f, 0.08f}) h.rod(v3(q, yg + 1.4f, kCoreZ + 0.02f), v3(q, kHeartTop + 1.1f, kCoreZ), 0.032f, M_PASLI, 0.5f);

    // anchors for the live parts: the heart (breathing), the opening's air (heat shimmer)
    h.anchor("cekirdek", "nokta", Xform::at(v3(0, 0.5f * (kCoreBase + kHeartTop + 0.6f), kCoreZ)), v3(rCap, 0.5f * (kHeartTop + 0.6f - kCoreBase), rCap));
    h.anchor("kemer_agiz", "nokta", Xform::at(v3(0, 0.5f * (kSill + kOpenTop), 0.5f * (kPierZ + kRevealEnd))),
             v3(kOpenHW, 0.5f * (kOpenTop - kSill), 0.5f * (kPierZ - kRevealEnd)));
}

void buildArch(Hall& h) {
    plinth(h);
    mass(h);
    gate(h);
    hoist(h);
    displayAndStops(h);
    console(h);
    doors(h);
    chamberInterior(h);
}

}   // namespace salon::hall
