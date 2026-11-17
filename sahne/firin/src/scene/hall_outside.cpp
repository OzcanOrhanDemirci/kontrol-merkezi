// Phase 2, the outside (docs/SALON.md "The way up"): the hall is not underground. It is inside a raised concrete block
// (x +-48, y -4..35, z -350..8) held up by eight cores that run 600 m down into the fog, like an offshore platform's
// legs; its roof is a bare walkable deck, no parapet: from it one can jump in any direction. On the deck,
// exactly over the gallery's shaft, the lamp that lights the hall's grate: the shaft's emitter (hall_gallery.cpp, the
// "daylight") seen from its other side, a 10 x 10 m pit of deep steel louvres sunk in the deck, glowing faintly in the
// same group (0): the daylight inside is fake, and from up here it gives itself away. Behind the hatch a tall thin mast
// with one dim steady lamp, the facility's one light seen from afar. The window instances all of it as the facility
// in the void: only the dis_* materials are used here (and nowhere else), so the exterior is its own draw ranges.
//
// The massing (11-17, after Özcan's walk: "dikdörtgen çok düz"): brutalist concrete in the manner of the National
// Theatre and Boston City Hall, read by its silhouette and by light and shadow on its masses, not by detail. The block
// is wrapped in stacked horizontal trays, each cantilevering further out the higher it is (the deck's tray widest, so
// one jumping from its edge falls clear of everything below), each with a board-marked fascia, a chamfered underside
// and a band of dark glazing in the shadow under it; under the block a heavy base whose chamfered underside runs in
// towards the legs. The legs are eight cores of one chamfered square section, the same from their feet in the fog to
// their tops: on the long sides they stand proud of every tray and run up through them, the four at the ends rising
// above the deck as towers (the front pair higher than the back), the two in the middle of each side ending flush with
// it (the deck carried on them). In this light (the fog's, brighter from above) a face reads by where it looks: tray
// tops light, fascias and cores mid, chamfers and undersides dark, the glazing darker still.
//
// The junctions (11-17, second pass: the cores passed through the trays as separate prisms): each core is a trunk
// that branches into the mass. Under the base it splays: a haunch along the building on each flank and a knee inwards
// under the cross girder, all leaving the trunk at one height (kHaunchY), so that from the side the mass's underside
// comes down to each leg in a rake and from below each leg is a splayed capital. Above the haunches the trunk has
// shoulders: plain walls in the legs' own concrete, a little proud of the trays' fascias but inside the deck's
// reach, that stop the trays and the glazing short of the trunk: full height beside the towers and out to the
// building's corners (the ends are solid masses raking up from the end legs), lower beside the middle cores (the upper
// glazing runs over them). So the long side is trunks, shoulders and three bays of trays, not one extrusion.
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

// ---- the massing. Offsets are outward from the block's outline (x +-48, z 8..-350), heights are y.
// the deck's tray: its fascia at offset 10 from the deck down to kT1F, a chamfer in to (kT1C, kT1Y), its underside
constexpr float kDeckOff = 10.0f, kT1F = 28.0f, kT1C = 6.0f, kT1Y = 24.0f;
constexpr float kDeckW = kBlockHW + kDeckOff, kDeckZ0 = kBlockZ0 + kDeckOff, kDeckZ1 = kBlockZ1 - kDeckOff;
// the second tray (a glazing band over and under it)
constexpr float kT2Top = 19.0f, kT2Off = 6.0f, kT2F = 12.0f, kT2C = 4.0f, kT2Y = 10.0f;
// the base under the block (whose floor slab ends at y -4): a ledge out to kBaseOff, its fascia down to kBaseF, a long
// chamfer in towards the legs to its underside at kBaseY
constexpr float kBaseOff = 4.0f, kBaseF = -12.0f, kBaseIn = -6.0f, kBaseY = -24.0f;
// the legs: cores of one chamfered square section, x 45.5..67.5 (their inner faces in the block's wall, clear of the
// hall's at 45), z +-13 about their lines; the ones at the ends rise above the deck, the middle ones end flush with it
constexpr float kLegHX = 11.0f, kLegHZ = 13.0f, kLegC = 3.5f, kLegX = 56.5f, kLegBottom = -604.0f;
const float kLegZ[4] = {-21.0f, -121.0f, -221.0f, -321.0f};
const float kLegTop[4] = {64.0f, kRoof, kRoof, 50.0f};   // towers at the ends (the front pair the higher), flush between
// the junctions. A shoulder: a wall beside the trunk from the legs' inner face out to offset kWingOff (proud of the
// second tray's fascia, inside the deck's), kWing along the building from the trunk's flank (the end legs' outer ones
// run to the corner), from its foot kWingLip under the base up into the deck's tray (kWingTop) or, beside the middle
// cores, to a ledge over the second tray (kWingLow). The haunch under it: its underside rakes from the shoulder's
// foot down to the trunk at kHaunchY; the knee under the cross girder does the same inwards, to the long girder
constexpr float kWingOff = 9.5f, kWing = 16.0f, kWingTop = 28.0f, kWingLow = 20.0f, kWingLip = 3.0f, kHaunchY = -52.0f;
constexpr float kKneeHZ = 3.5f, kKneeX = 24.0f, kKneeTop = -30.0f, kKneeFoot = -36.0f;

// four faces round the block's outline between (offset o0, y0) and (o1, y1), facing (outward nOut, up nUp): a ring of
// a tray's chamfer, underside or top. Each face its own chart, uv in metres
void ring(Hall& h, float o0, float y0, float o1, float y1, float nOut, float nUp, int mat, float maxEdge = 12.0f) {
    auto P = [&](int side, float o, float y, bool end) {   // side 0 +x, 1 -x, 2 front (+z), 3 back (-z)
        const float x = kBlockHW + o, z0 = kBlockZ0 + o, z1 = kBlockZ1 - o;
        switch (side) {
            case 0: return v3(x, y, end ? z1 : z0);
            case 1: return v3(-x, y, end ? z0 : z1);
            case 2: return v3(end ? x : -x, y, z0);
            default: return v3(end ? -x : x, y, z1);
        }
    };
    const float3 n[4] = {v3(nOut, nUp, 0), v3(-nOut, nUp, 0), v3(0, nUp, nOut), v3(0, nUp, -nOut)};
    for (int s = 0; s < 4; ++s) h.patch(P(s, o0, y0, false), P(s, o0, y0, true), P(s, o1, y1, false), P(s, o1, y1, true), normalize(n[s]), mat, maxEdge);
}

// four vertical cast faces round the outline at offset o from y0 to y1, in the walls' lifts (3.25 m from the block's
// underside: one joint line runs round the whole building, trays and walls)
void band(Hall& h, float o, float y0, float y1, int mat) {
    Formwork f;
    f.pu = 0.0f;
    f.pv = 3.25f;
    f.ov = kBlockY0;
    f.depth = 0.05f;
    f.halfWidth = 0.07f;
    const float x = kBlockHW + o, z0 = kBlockZ0 + o, z1 = kBlockZ1 - o;
    if (mat != M_DIS_CAM) {
        h.formworkFace(axes(v3(x, 0, 0), v3(0, 0, -1), Y, X), -z0, -z1, y0, y1, f, mat, 12.0f);
        h.formworkFace(axes(v3(-x, 0, 0), Z, Y, v3(-1, 0, 0)), z1, z0, y0, y1, f, mat, 12.0f);
        h.formworkFace(axes(v3(0, 0, z0), X, Y, Z), -x, x, y0, y1, f, mat, 12.0f);
        h.formworkFace(axes(v3(0, 0, z1), v3(-1, 0, 0), Y, v3(0, 0, -1)), -x, x, y0, y1, f, mat, 12.0f);
    } else {
        ring(h, o, y0, o, y1, 1.0f, 0.0f, mat, 24.0f);
    }
}

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

bool tower(int j) { return kLegTop[j] > kRoof; }

// a flat four-cornered face in the legs' concrete whose upper edge t0-t1 is level: the texture's marks run up it as
// they do on the trunk (uv0 in metres along the upper edge and down the face)
void face(Hall& h, float3 t0, float3 t1, float3 b0, float3 b1, float3 n) {
    if (dot(cross(t1 - t0, b0 - t0), n) < 0) {   // patch() would swap its edges: keep the level one first
        std::swap(t0, t1);
        std::swap(b0, b1);
    }
    h.patch(t0, t1, b0, b1, n, M_DIS_KOLON, 24.0f);
}

// a leg's junction with the mass (see the constants): its two shoulders with their haunches, its knee
void junction(Hall& h, int sx, int j) {
    const float xi = sx * (kLegX - kLegHX), xo = sx * (kBlockHW + kWingOff), foot = kBaseY - kWingLip;
    const float3 nx = v3(float(sx), 0, 0);
    for (int s : {-1, 1}) {
        const float zf = kLegZ[j] + s * kLegHZ;
        float ze = zf + s * kWing;
        if (j == 0 && s > 0) ze = kBlockZ0 + kWingOff;      // the corner masses
        if (j == 3 && s < 0) ze = kBlockZ1 - kWingOff;
        const float top = tower(j) ? kWingTop : kWingLow;
        // the outer face: the shoulder and the haunch's side in one
        face(h, v3(xo, top, zf), v3(xo, top, ze), v3(xo, kHaunchY, zf), v3(xo, foot, ze), nx);
        // the inner face, where it shows under the base's chamfer
        face(h, v3(xi, kBaseF, zf), v3(xi, kBaseF, ze), v3(xi, kHaunchY, zf), v3(xi, foot, ze), nx * -1.0f);
        // its end, the rake under it, its top where it is a ledge
        face(h, v3(xi, top, ze), v3(xo, top, ze), v3(xi, foot, ze), v3(xo, foot, ze), v3(0, 0, float(s)));
        face(h, v3(xi, foot, ze), v3(xo, foot, ze), v3(xi, kHaunchY, zf), v3(xo, kHaunchY, zf),
             normalize(v3(0, -std::fabs(ze - zf), s * (foot - kHaunchY))));
        if (!tower(j)) face(h, v3(sx * kBlockHW, top, zf), v3(sx * kBlockHW, top, ze), v3(xo, top, zf), v3(xo, top, ze), Y);
    }
    // the knee: from the trunk's inner face at kHaunchY up and in under the cross girder to the long girder's line
    const float z = kLegZ[j], xk = sx * kKneeX;
    for (int s : {-1, 1})
        face(h, v3(xi, kKneeTop, z + s * kKneeHZ), v3(xk, kKneeTop, z + s * kKneeHZ), v3(xi, kHaunchY, z + s * kKneeHZ),
             v3(xk, kKneeFoot, z + s * kKneeHZ), v3(0, 0, float(s)));
    face(h, v3(xk, kKneeFoot, z - kKneeHZ), v3(xk, kKneeFoot, z + kKneeHZ), v3(xi, kHaunchY, z - kKneeHZ), v3(xi, kHaunchY, z + kKneeHZ),
         normalize(v3(-sx * (kKneeFoot - kHaunchY), -std::fabs(xi - xk), 0)));
    face(h, v3(xk, kKneeTop, z - kKneeHZ), v3(xk, kKneeTop, z + kKneeHZ), v3(xk, kKneeFoot, z - kKneeHZ), v3(xk, kKneeFoot, z + kKneeHZ), nx * -1.0f);
}

void roofDeck(Hall& h) {
    const float W = kDeckW;
    const float lx = kLampX + kRim, lz0 = kLampZ0 + kRim, lz1 = kLampZ1 - kRim;                        // the lamp's pit
    const float hx = kStairHW + kCurbT, hz0 = kHatchZ0 + kCurbT, hz1 = kHatchZ1 - kCurbT;               // the hatch's curb
    deck(h, -W, W, kDeckZ0, lz0);
    deck(h, -W, -lx, lz0, lz1);
    deck(h, lx, W, lz0, lz1);
    deck(h, -W, W, lz1, hz0);
    deck(h, -W, -hx, hz0, hz1);
    deck(h, hx, W, hz0, hz1);
    deck(h, -W, W, hz1, kDeckZ1);
    // over the middle cores the deck runs out onto their tops (they stand 4 m proud of its fascia), their chamfers too
    for (int j = 0; j < 4; ++j) {
        if (tower(j)) continue;
        for (int s : {-1, 1}) {
            const float zc = kLegZ[j], xa = s * W, xb = s * (kLegX + kLegHX - kLegC), xc = s * (kLegX + kLegHX);
            const size_t vm = h.vmark();
            h.patch(v3(xa, kRoof, zc + kLegHZ), v3(xb, kRoof, zc + kLegHZ), v3(xa, kRoof, zc - kLegHZ), v3(xb, kRoof, zc - kLegHZ), Y, M_DIS_ZEMIN, 12.0f);
            h.patch(v3(xb, kRoof, zc + kLegHZ), v3(xc, kRoof, zc + kLegHZ - kLegC), v3(xb, kRoof, zc - kLegHZ), v3(xc, kRoof, zc - kLegHZ + kLegC), Y,
                    M_DIS_ZEMIN, 12.0f);
            for (size_t k = vm; k < h.s.mesh.v.size(); ++k) h.s.mesh.v[k].uv = make_float2(h.s.mesh.v[k].p.x, -h.s.mesh.v[k].p.z);
        }
    }
}

// a tray round the block: its top from the wall out to offset `off` at yTop (none for the deck's: the deck is its top),
// its fascia down to yF, a chamfer in and down to (oC, yC), its underside back to the wall (none for the base's)
void tray(Hall& h, float yTop, float off, float yF, float oC, float yC, bool top, bool soffit) {
    if (top) ring(h, 0.0f, yTop, off, yTop, 0.0f, 1.0f, M_DIS_DUVAR);
    band(h, off, yF, yTop, M_DIS_DUVAR);
    ring(h, off, yF, oC, yC, yF - yC, oC - off, M_DIS_DUVAR, 24.0f);
    if (soffit) ring(h, oC, yC, 0.0f, yC, 0.0f, -1.0f, M_DIS_DUVAR);
}

// a band of dark glazing in a tray's shadow, the wall behind it (what shows where the far detail has no glass)
void glazing(Hall& h, float y0, float y1) {
    band(h, 0.0f, y0, y1, M_DIS_DUVAR);
    band(h, 0.12f, y0, y1, M_DIS_CAM);
}

// the trays, the walls between them, the base: the block's whole outside but its legs
void shell(Hall& h) {
    tray(h, kRoof, kDeckOff, kT1F, kT1C, kT1Y, false, true);   // the deck's tray
    glazing(h, kT2Top, kT1Y);
    tray(h, kT2Top, kT2Off, kT2F, kT2C, kT2Y, true, true);     // the second, its top a ledge under the deck's reach
    glazing(h, kT2Y - 4.0f, kT2Y);
    band(h, 0.0f, kBlockY0, kT2Y - 4.0f, M_DIS_DUVAR);          // the block's plain wall down to its slab
    // the base: a ledge, its fascia, the long chamfer in towards the legs, the underside seen falling past it
    tray(h, kBlockY0, kBaseOff, kBaseF, kBaseIn, kBaseY, true, false);
    {
        const float x = kBlockHW + kBaseIn, z0 = kBlockZ0 + kBaseIn, z1 = kBlockZ1 - kBaseIn;
        h.patch(v3(-x, kBaseY, z0), v3(x, kBaseY, z0), v3(-x, kBaseY, z1), v3(x, kBaseY, z1), -Y, M_DIS_DUVAR, 24.0f);
        // under it the structure it is: deep chamfered girders across between each pair of legs, two along, a coffered
        // underside seen falling past (each 1 m into the base)
        for (float z : kLegZ) h.bar(v3(-(kLegX - kLegHX + 1.0f), kBaseY - 4.0f, z), v3(kLegX - kLegHX + 1.0f, kBaseY - 4.0f, z), 8.0f, 10.0f, Y, M_DIS_DUVAR);
        for (int s : {-1, 1}) h.bar(v3(s * 24.0f, kBaseY - 3.0f, z0), v3(s * 24.0f, kBaseY - 3.0f, z1), 6.0f, 8.0f, Y, M_DIS_DUVAR);
    }
    // a drip edge round the deck: a shallow steel angle on the fascia's top (the roof's only edge, ankle high at most);
    // on the long sides it stops at the cores (the towers rise there, the middle cores carry the deck out)
    const float W = kDeckW;
    for (int s : {-1, 1}) {
        h.box(v3(0, kRoof + 0.03f, s > 0 ? kDeckZ0 - 0.03f : kDeckZ1 + 0.03f), v3(W - 0.06f, 0.03f, 0.03f), 0.008f, M_DIS_KOYU, 24.0f);
        float z = kDeckZ0 - 0.06f;
        for (int j = 0; j <= 4; ++j) {
            const float e = j < 4 ? kLegZ[j] + kLegHZ : kDeckZ1 + 0.06f;
            h.box(v3(s * (W - 0.03f), kRoof + 0.03f, 0.5f * (z + e)), v3(0.03f, 0.03f, 0.5f * (z - e)), 0.008f, M_DIS_KOYU, 24.0f);
            if (j < 4) z = kLegZ[j] - kLegHZ;
        }
    }
}

// a leg: a core of one chamfered square section from its foot in the fog (y kLegBottom, which the window stretches
// on down) to its top. One face per side of the octagon, one chart; uv0 runs round the section and up the world's y,
// so a stretched foot keeps its texture's scale
void leg(Hall& h, float x, float z, float top, bool cap) {
    const float a = kLegHX, b = kLegHZ, c = kLegC;
    const float2 o[8] = {{a, b - c}, {a, -b + c}, {a - c, -b}, {-a + c, -b}, {-a, -b + c}, {-a, b - c}, {-a + c, b}, {a - c, b}};
    const size_t vm = h.vmark();
    const uint32_t cm = h.cmark();
    float u = 0.0f;
    for (int i = 0; i < 8; ++i) {
        const float2 p = o[i], q = o[(i + 1) % 8];
        const float l = std::hypot(q.x - p.x, q.y - p.y);
        const float3 n = normalize(v3(-(q.y - p.y), 0, q.x - p.x));   // outward
        const size_t v0 = h.vmark();
        h.patch(v3(x + p.x, kLegBottom, z + p.y), v3(x + q.x, kLegBottom, z + q.y), v3(x + p.x, top, z + p.y), v3(x + q.x, top, z + q.y), n,
                M_DIS_KOLON, 1e4f);
        for (size_t k = v0; k < h.s.mesh.v.size(); ++k) {
            dz::Vtx& v = h.s.mesh.v[k];
            const float t = std::hypot(v.p.x - (x + p.x), v.p.z - (z + p.y)) / l;
            v.uv = make_float2(u + t * l, v.p.y);
        }
        u += l + 0.5f;
    }
    if (cap) {
        h.patch(v3(x - a, top, z + b - c), v3(x + a, top, z + b - c), v3(x - a, top, z - b + c), v3(x + a, top, z - b + c), Y, M_DIS_KOLON, 1e4f);
        for (int s : {-1, 1})
            h.patch(v3(x - a, top, z + s * (b - c)), v3(x + a, top, z + s * (b - c)), v3(x - a + c, top, z + s * b), v3(x + a - c, top, z + s * b), Y,
                    M_DIS_KOLON, 1e4f);
        // the caps' metres lie beside the faces' (one chart)
        for (size_t k = h.vmark() - 12; k < h.s.mesh.v.size(); ++k) {
            dz::Vtx& v = h.s.mesh.v[k];
            v.uv = make_float2(u + 1.0f + (v.p.x - x + a), kLegBottom - 1.0f - 2.0f * b + (v.p.z - z + b));
        }
    }
    h.oneChart(vm, cm);
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
    // far: the trays, the walls, the base, the legs: no light reaches them but the faint spill of the roof's lamps, so
    // 2.5 m texels (four times the coarsest)
    DensityZone far;
    far.first = h.cmark();
    far.journey = false;
    far.dMin = 1e4f;
    far.texelMul = 4.0f;
    shell(h);
    int n = 0;
    for (int s : {-1, 1})
        for (int j = 0; j < 4; ++j) {
            const float x = s * kLegX, z = kLegZ[j], top = kLegTop[j];
            leg(h, x, z, top, tower(j));
            junction(h, s, j);
            // walk mode collides with the window's continuation of the leg below kLegBottom: the section's box
            h.anchorBox("dis_kolon_" + std::to_string(n++), "nokta", v3(x - kLegHX, kLegBottom, z - kLegHZ), v3(x + kLegHX, top, z + kLegHZ));
        }
    far.end = h.cmark();
    h.s.zones.push_back(far);
    const float e = 1.6f;
    h.s.walk.push_back({v3(0, kRoof + e, kTopTread - 1.0f)});                       // out of the hatch
    h.s.walk.push_back({v3(0, kRoof + e, 0.5f * (kLampZ0 + kLampZ1))});              // by the lamp

    // anchors for the window's void: the facility's bounds (legs, towers and mast included), the block that holds the
    // hall, the deck one walks and lands on, the lamps
    const float W = kBlockHW;
    h.anchorBox("dis_sinir", "nokta", v3(-(kLegX + kLegHX), kLegBottom, kDeckZ1), v3(kLegX + kLegHX, std::max(kRoof + kMastH + 0.5f, *std::max_element(kLegTop, kLegTop + 4)), kDeckZ0));
    h.anchorBox("dis_blok", "nokta", v3(-W, kBlockY0, kBlockZ1), v3(W, kRoof, kBlockZ0));
    h.anchorBox("dis_cati", "nokta", v3(-kDeckW, kRoof, kDeckZ1), v3(kDeckW, kRoof, kDeckZ0));
    h.anchorBox("dis_kuyu_lamba", "nokta", v3(-kLampX - kRim, kLampY, kLampZ1 - kRim), v3(kLampX + kRim, kRoof + 0.06f, kLampZ0 + kRim));
}

}   // namespace salon::hall
