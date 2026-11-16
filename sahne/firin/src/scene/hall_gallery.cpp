// The entrance gallery (docs/SALON.md, "Layout"): x in [-12, 12], y in [0, 20], z in [-44, 0]. The back wall with the
// tunnel mouth we came out of, the steel landing at y = 3 with its stair, the ceiling shaft with its grate and the
// daylight at the well's top, the portal into the hall. The fans in the side walls are scene/hall_fans.cpp's.
#include "scene/hall_kit.h"

#include <cmath>

namespace salon::hall {

namespace {

// the fans' recesses in the side walls (scene/hall_fans.cpp builds what is inside): square, on the formwork's grid
constexpr float kRecessHalf = 7.2f;   // half size of the opening in the wall plane
constexpr float kFanY = 8.5f, kFanZ = -24.0f;

// the formwork of the gallery: 1.2 m wide, 2.4 m tall panels from the floor and from the back wall
Formwork galleryForm() {
    Formwork f;
    f.pu = 1.2f;
    f.pv = 2.4f;
    return f;
}

void sideWalls(Hall& h) {
    for (int side : {-1, 1}) {
        // the wall's frame (right-handed, z out of the wall): the left wall's u runs along -z (from the back wall),
        // the right wall's along +z; both have seams at |z| = k * 1.2 and y = k * 2.4
        const float3 n = v3(float(-side), 0, 0);
        const Xform tw = axes(v3(12.0f * side, 0, 0), v3(0, 0, float(side)), v3(0, 1, 0), n);
        const Formwork f = galleryForm();
        const float ra = -kFanZ - kRecessHalf, rb = -kFanZ + kRecessHalf;   // the recess in |z|: 16.8 .. 31.2
        const float ya = kFanY - kRecessHalf, yb = kFanY + kRecessHalf;     // 1.3 .. 15.7
        struct R { float za, zb, y0, y1; };   // pieces in |z| and y
        const R pieces[] = {{0.0f, ra, 0.0f, 20.0f}, {ra, rb, 0.0f, ya}, {ra, rb, yb, 20.0f}, {rb, 44.0f, 0.0f, 20.0f}};
        for (const R& p : pieces) {
            if (side < 0) h.formworkFace(tw, p.za, p.zb, p.y0, p.y1, f, M_DUVAR);
            else h.formworkFace(tw, -p.zb, -p.za, p.y0, p.y1, f, M_DUVAR);
        }
    }
}

void backWallAndTunnel(Hall& h) {
    // the back wall z = 0 faces -z; u = -x so the frame is right-handed with z = -z
    const Xform t = axes(v3(0, 0, 0), v3(-1, 0, 0), v3(0, 1, 0), v3(0, 0, -1));
    Formwork f = galleryForm();
    f.ou = 0.6f;   // seams symmetric about the tunnel
    // the tunnel mouth: 5.2 x 4.4 m from the landing's deck, a 0.25 m chamfer round it
    const float tw = 2.6f, ty0 = 3.0f, ty1 = 7.4f, ch = 0.25f;
    const float ow = tw + ch, oy1 = ty1 + ch;
    h.formworkFace(t, -12.0f, -ow, 0.0f, 20.0f, f, M_DUVAR);
    h.formworkFace(t, ow, 12.0f, 0.0f, 20.0f, f, M_DUVAR);
    h.formworkFace(t, -ow, ow, 0.0f, ty0, f, M_DUVAR);
    h.formworkFace(t, -ow, ow, oy1, 20.0f, f, M_DUVAR);
    // the chamfer: left, top, right (mitred at the corners)
    h.patch(v3(-ow, ty0, 0), v3(-tw, ty0, ch), v3(-ow, oy1, 0), v3(-tw, ty1, ch), normalize(v3(1, 0, -1)), M_DUVAR);
    h.patch(v3(-ow, oy1, 0), v3(-tw, ty1, ch), v3(ow, oy1, 0), v3(tw, ty1, ch), normalize(v3(0, -1, -1)), M_DUVAR);
    h.patch(v3(ow, ty0, 0), v3(tw, ty0, ch), v3(ow, oy1, 0), v3(tw, ty1, ch), normalize(v3(-1, 0, -1)), M_DUVAR);
    // the tunnel: 5 m deep, then closed by a bulkhead with a steel door
    const float tz = 5.0f;
    h.patch(v3(-ow, ty0, 0), v3(ow, ty0, 0), v3(-tw, ty0, tz), v3(tw, ty0, tz), v3(0, 1, 0), M_ZEMIN);
    h.patch(v3(-tw, ty0, ch), v3(-tw, ty0, tz), v3(-tw, ty1, ch), v3(-tw, ty1, tz), v3(1, 0, 0), M_DUVAR);
    h.patch(v3(tw, ty0, ch), v3(tw, ty0, tz), v3(tw, ty1, ch), v3(tw, ty1, tz), v3(-1, 0, 0), M_DUVAR);
    h.patch(v3(-tw, ty1, ch), v3(tw, ty1, ch), v3(-tw, ty1, tz), v3(tw, ty1, tz), v3(0, -1, 0), M_TAVAN);
    h.patch(v3(-tw, ty0, tz), v3(tw, ty0, tz), v3(-tw, ty1, tz), v3(tw, ty1, tz), v3(0, 0, -1), M_DUVAR);
    // the bulkhead door (1.0 x 2.1 m: the scale of a person), its frame and handle
    const float dx = 1.1f;
    h.box(v3(dx, ty0 + 1.09f, tz - 0.04f), v3(0.58f, 1.13f, 0.04f), 0.015f, M_KOYU, 0.5f);
    h.box(v3(dx, ty0 + 1.06f, tz - 0.1f), v3(0.5f, 1.05f, 0.025f), 0.01f, M_PASLI, 0.5f);
    h.rod(v3(dx - 0.38f, ty0 + 1.0f, tz - 0.13f), v3(dx - 0.38f, ty0 + 1.2f, tz - 0.13f), 0.016f, M_KOYU);
    for (float y : {0.35f, 1.75f}) h.box(v3(dx + 0.52f, ty0 + y, tz - 0.12f), v3(0.03f, 0.09f, 0.03f), 0.01f, M_KOYU, 0.2f);
    // a cable run along the tunnel's left wall into the gallery, on brackets
    for (int c = 0; c < 3; ++c) {
        const float y = ty1 - 0.35f - 0.07f * c;
        h.tube(v3(-tw + 0.12f, y, tz), v3(-tw + 0.12f, y, ch + 0.05f), 0.022f, M_KABLO, 1.0f);
    }
    for (float z : {1.0f, 2.5f, 4.0f})
        h.box(v3(-tw + 0.07f, ty1 - 0.42f, z), v3(0.07f, 0.13f, 0.02f), 0.006f, M_KOYU, 0.2f);
}

void floorAndCeiling(Hall& h) {
    // the gallery's floor (the hall's is scene/hall_nave.cpp's): one chart
    const size_t vm = h.vmark();
    const uint32_t cm = h.cmark();
    h.quad(axes(v3(0, 0, -22), v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0)), 24.0f, 44.0f, M_ZEMIN, 4.0f);
    h.oneChart(vm, cm);
    // the ceiling y = 20, facing down, round the shaft's opening x in [-5, 5], z in [-36, -26]
    const Xform t = axes(v3(0, 20, 0), v3(1, 0, 0), v3(0, 0, 1), v3(0, -1, 0));   // u = x, v = z
    Formwork f = galleryForm();
    f.pu = 2.4f;
    f.pv = 1.2f;
    h.formworkFace(t, -12, 12, -26, 0, f, M_TAVAN);
    h.formworkFace(t, -12, 12, -44, -36, f, M_TAVAN);
    h.formworkFace(t, -12, -5, -36, -26, f, M_TAVAN);
    h.formworkFace(t, 5, 12, -36, -26, f, M_TAVAN);
}

void shaft(Hall& h) {
    // the well: 12 m above the 1.5 m slab, its walls continuing the opening's edges from the ceiling up to y = 33.5
    const float y0 = 20.0f, y1 = 33.5f, x0 = 5.0f, za = -26.0f, zb = -36.0f;
    Formwork f;
    f.pu = 1.25f;
    f.pv = 2.25f;
    f.ov = y0;
    // x = -5 faces +x, x = +5 faces -x; z = -26 faces -z, z = -36 faces +z (frames with u horizontal, v = y)
    h.formworkFace(axes(v3(-x0, 0, za), v3(0, 0, -1), v3(0, 1, 0), v3(1, 0, 0)), 0, 10, y0, y1, f, M_DUVAR);
    h.formworkFace(axes(v3(x0, 0, zb), v3(0, 0, 1), v3(0, 1, 0), v3(-1, 0, 0)), 0, 10, y0, y1, f, M_DUVAR);
    h.formworkFace(axes(v3(x0, 0, za), v3(-1, 0, 0), v3(0, 1, 0), v3(0, 0, -1)), 0, 10, y0, y1, f, M_DUVAR);
    h.formworkFace(axes(v3(-x0, 0, zb), v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)), 0, 10, y0, y1, f, M_DUVAR);

    // the grate: it rests on steel angles round the well at y = 20.3; main bars every ~0.9 m both ways (150 mm deep
    // flats), light bearing bars between them along x every ~0.22 m (60 mm): the beam in the haze shows the pattern
    const float gy = 20.3f, hi = 4.9f;
    for (int s = -1; s <= 1; s += 2) {
        h.box(v3(s * 4.95f, gy - 0.005f, -31), v3(0.05f, 0.005f, 5.0f), 0.003f, M_PASLI, 2.0f);
        h.box(v3(s * 4.995f, gy - 0.05f, -31), v3(0.005f, 0.05f, 5.0f), 0.003f, M_PASLI, 2.0f);
        h.box(v3(0, gy - 0.005f, -31 + s * 4.95f), v3(4.9f, 0.005f, 0.05f), 0.003f, M_PASLI, 2.0f);
        h.box(v3(0, gy - 0.05f, -31 + s * 4.995f), v3(4.9f, 0.05f, 0.005f), 0.003f, M_PASLI, 2.0f);
    }
    {
        const size_t vm = h.vmark();
        const uint32_t cm = h.cmark();
        const int nMain = 11;
        for (int q = 0; q <= nMain; ++q) {
            const float c = -hi + 2 * hi * q / nMain;
            h.bar(v3(c, gy + 0.075f, -31 - hi), v3(c, gy + 0.075f, -31 + hi), 0.012f, 0.15f, v3(0, 1, 0), M_PASLI);
            h.bar(v3(-hi, gy + 0.075f, -31 + c), v3(hi, gy + 0.075f, -31 + c), 0.012f, 0.15f, v3(0, 1, 0), M_PASLI);
            if (q == nMain) break;
            for (int l = 1; l < 4; ++l) {
                const float cl = c + 2 * hi / nMain * l / 4;
                h.bar(v3(-hi, gy + 0.12f, -31 + cl), v3(hi, gy + 0.12f, -31 + cl), 0.006f, 0.06f, v3(0, 1, 0), M_PASLI);
            }
        }
        h.packCharts(vm, cm, 0.05f);
    }
    // two steel beams across the well's top under the light (their shadows are the beam's strongest stripes)
    for (float z : {-29.4f, -32.6f})
        h.ibeam(v3(-x0, 32.9f, z), v3(x0, 32.9f, z), 0.4f, 0.18f, 0.01f, 0.016f, v3(0, 1, 0), M_KOYU);
    // the light: the well's top closed by an emissive face; the emitter's normal slants towards -z so the beams fall
    // slanted, a collimated dim daylight
    const float tilt = kKuyuTilt * kPi / 180.0f;
    h.quad(axes(v3(0, y1, -31), v3(1, 0, 0), v3(0, 0, 1), v3(0, -1, 0)), 10.0f, 10.0f, M_KUYU_ISIK, 10.0f);
    Emitter e;
    e.type = Emitter::RECT;
    e.group = GROUP_KUYU;
    e.c = v3(0, y1 - 0.001f, -31);
    e.u = v3(5, 0, 0);
    e.v = v3(0, 0, 5);
    e.n = v3(0, -std::cos(tilt), -std::sin(tilt));
    e.L = kKuyuL;
    e.lobe = kKuyuLobe;
    h.s.lights.push_back(e);
}

void landing(Hall& h) {
    const float dy = 3.0f, hx = 5.0f, zf = -6.0f;
    // the deck: tread plate on stringers, a fascia round its edge
    h.box(v3(0, dy - 0.006f, zf / 2), v3(hx, 0.006f, -zf / 2), 0.003f, M_SAC, 4.0f);
    h.box(v3(0, dy - 0.09f, zf + 0.006f), v3(hx, 0.09f, 0.006f), 0.003f, M_KOYU, 4.0f);
    for (int s : {-1, 1}) h.box(v3(s * (hx - 0.006f), dy - 0.09f, zf / 2), v3(0.006f, 0.09f, -zf / 2), 0.003f, M_KOYU, 4.0f);
    const float sy = dy - 0.012f - 0.125f;   // the stringers' centre line (250 mm beams)
    for (float x : {-4.85f, -1.6f, 1.6f, 4.85f}) h.ibeam(v3(x, sy, 0.0f), v3(x, sy, zf + 0.15f), 0.25f, 0.125f, 0.008f, 0.012f, v3(0, 1, 0), M_KOYU);
    for (float z : {-2.9f, zf + 0.15f}) h.ibeam(v3(-hx, sy - 0.25f, z), v3(hx, sy - 0.25f, z), 0.25f, 0.125f, 0.008f, 0.012f, v3(0, 1, 0), M_KOYU);
    // two posts under the front beam: square hollow sections on base plates with anchor nuts
    for (int s : {-1, 1}) {
        const float3 b = v3(s * 4.85f, 0.0f, zf + 0.15f);
        h.box(b + v3(0, (sy - 0.375f) / 2, 0), v3(0.1f, (sy - 0.375f) / 2, 0.1f), 0.012f, M_KOYU, 1.0f);
        h.box(b + v3(0, 0.012f, 0), v3(0.2f, 0.012f, 0.2f), 0.004f, M_KOYU, 0.5f);
        for (int q = 0; q < 4; ++q)
            h.nut(Xform::at(b + v3(q % 2 ? 0.15f : -0.15f, 0.024f, q / 2 ? 0.15f : -0.15f)), 0.03f, M_KOYU);
        // a knee brace to the side stringer
        h.bar(b + v3(0, sy - 1.1f, 0.08f), b + v3(0, sy - 0.14f, 1.0f), 0.08f, 0.08f, v3(1, 0, 0), M_KOYU);
    }
    // the stair down towards -z: 16 risers of 187.5 mm, goings of 270 mm, open treads between flat-bar stringers
    const int nr = 16;
    const float rise = dy / nr, go = 0.27f, sw = 1.2f;
    for (int q = 1; q < nr; ++q) {
        const float y = dy - q * rise, z = zf - q * go;
        h.box(v3(0, y - 0.015f, z + 0.145f), v3(sw, 0.015f, 0.145f), 0.006f, M_SAC, 4.0f);
    }
    const float zb = zf - nr * go;   // the stair's foot on the floor
    for (int s : {-1, 1}) {
        const float x = s * (sw + 0.008f);
        const float3 a = v3(x, dy - 0.1f, zf + 0.05f), b = v3(x, -0.12f, zb - 0.06f);
        const float3 d = normalize(b - a);
        const float3 up = normalize(v3(0, 1, 0) - d * d.y);
        h.box(Xform::frame(0.5f * (a + b), d, up), v3(0.008f, 0.125f, 0.5f * length(b - a)), 0.004f, M_KOYU, 2.0f);
    }
    // railings: the deck's sides and front, the front turning down the stair as its handrail
    for (int s : {-1, 1}) {
        const float x = s * (hx - 0.05f), xs = s * (sw + 0.008f);
        h.railing({v3(x, dy, -0.05f), v3(x, dy, zf + 0.05f), v3(xs, dy, zf + 0.05f), v3(xs, 0.0f, zb + 0.02f),
                   v3(xs, 0.0f, zb - 0.35f)},
                  1.5f, M_PASLI);
    }
}

void portal(Hall& h) {
    // the portal seen from the hall: the hall's front wall z = -44 (facing -z) round the gallery's 24 x 20 m opening,
    // and a stepped frame standing out of it (the gallery is a frame within the frame)
    const Xform t = axes(v3(0, 0, -44), v3(-1, 0, 0), v3(0, 1, 0), v3(0, 0, -1));   // u = -x
    Formwork f;
    f.pu = 0.0f;
    f.pv = 0.0f;
    h.formworkFace(t, -30, -14.6f, 0, 26, f, M_DUVAR);
    h.formworkFace(t, 14.6f, 30, 0, 26, f, M_DUVAR);
    h.formworkFace(t, -14.6f, 14.6f, 22.6f, 26, f, M_DUVAR);
    for (int s : {-1, 1}) {
        h.box(v3(s * 12.8f, 10.8f, -44.5f), v3(0.8f, 10.8f, 0.5f), 0.06f, M_ANIT, 3.0f);
        h.box(v3(s * 14.1f, 11.3f, -44.25f), v3(0.5f, 11.3f, 0.25f), 0.05f, M_ANIT, 3.0f);
    }
    h.box(v3(0, 20.8f, -44.5f), v3(12.0f, 0.8f, 0.5f), 0.06f, M_ANIT, 3.0f);
    h.box(v3(0, 22.1f, -44.25f), v3(13.6f, 0.5f, 0.25f), 0.05f, M_ANIT, 3.0f);
}

void exitDoor(Hall& h) {
    // a steel door in the gallery's left wall near the portal, its exit sign flag-mounted above, facing the landing
    const float x = -12.0f, z = -40.6f;
    h.box(v3(x + 0.05f, 1.1f, z), v3(0.05f, 1.15f, 0.6f), 0.015f, M_KOYU, 0.5f);      // frame
    h.box(v3(x + 0.12f, 1.06f, z), v3(0.025f, 1.05f, 0.5f), 0.01f, M_PASLI, 0.5f);    // leaf
    h.rod(v3(x + 0.17f, 0.95f, z + 0.38f), v3(x + 0.17f, 1.15f, z + 0.38f), 0.016f, M_KOYU);
    for (float y : {0.35f, 1.75f}) h.box(v3(x + 0.12f, y, z - 0.53f), v3(0.03f, 0.09f, 0.03f), 0.01f, M_KOYU, 0.2f);
    // the sign: a lit box 1.6 x 0.6 x 0.15 out from the wall on a bracket, its face towards +z
    const float3 c = v3(x + 0.18f + 0.8f, 2.75f, z);
    h.box(v3(x + 0.09f, 2.75f, z), v3(0.09f, 0.1f, 0.05f), 0.01f, M_KOYU, 0.3f);
    h.box(c, v3(0.8f, 0.3f, 0.075f), 0.02f, M_KOYU, 0.5f);
    h.levha("cikis_1", "cikis_1", c + v3(0, 0, 0.077f), v3(0, 0, 1), 1.45f, 0.48f, M_EKRAN);
    h.anchor("cikis_1", "tik", Xform::at(c), v3(0.85f, 0.35f, 0.15f));
    h.cagedLamp(v3(x, 3.6f, z + 1.3f), v3(1, 0, 0), kBulbBoard);
}

}   // namespace

void buildGallery(Hall& h) {
    sideWalls(h);
    backWallAndTunnel(h);
    floorAndCeiling(h);
    shaft(h);
    landing(h);
    portal(h);
    exitDoor(h);
    // a lamp over the tunnel mouth: the landing is not black behind the camera
    h.cagedLamp(v3(0, 8.4f, 0), v3(0, 0, -1), kBulbBoard);
}

}   // namespace salon::hall
