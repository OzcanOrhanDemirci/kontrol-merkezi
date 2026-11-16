// Phase 2, the way up (docs/SALON.md "The way up"): from the heat chamber behind the arch through two hidden doors in
// its side walls (between the third and the fourth portal, out of the hall's sight) into narrow dark passages running
// back beside it, to a narrow space behind its back wall, and from there one long straight stair, 182 risers in a
// narrow tunnel of cast concrete, ~30 s of climbing, lit by small dim lamps of the facility's own light circuit
// (group 0, the fake daylight's: in the temperature colour). At its top a heavy steel hatch in the roof deck (a
// dinamik part the window opens). Every chart built here takes its light map density from the walk (Scene::zones).
#include "scene/hall_kit.h"

#include <algorithm>
#include <cmath>

namespace salon::hall {

using namespace up;

namespace {

const float3 X = {1, 0, 0}, Y = {0, 1, 0}, Z = {0, 0, 1};

// along the stair: r = the run from the first riser's face (towards -z), the lines the tunnel follows
inline float zAt(float r) { return kStairZ0 - r; }
inline float pitchFoot(float r) { return kFloor + r * kRise / kGoing; }      // through the risers' feet
inline float nosing(float r) { return pitchFoot(r) + kRise; }                 // through the nosings
inline float ceilingAt(float r) { return kCeil + r * kRise / kGoing; }        // the tunnel's ceiling
constexpr float kRunEnd = kRisers * kGoing;                                   // the top tread's end
constexpr float kRunHatch = kStairZ0 - kHatchZ0;                              // where the ceiling meets the slab

void doorsAndPassages(Hall& h) {
    for (int s : {-1, 1}) {
        const float sx = float(s);
        auto P = [&](float ax, float y, float z) { return v3(sx * ax, y, z); };
        // the door's reveal through the 0.6 m wall
        h.patch(P(kChamberHW, kFloor, kDoorZ0), P(kPassIn, kFloor, kDoorZ0), P(kChamberHW, kDoorTop, kDoorZ0), P(kPassIn, kDoorTop, kDoorZ0), Z,
                M_DUVAR, 2.0f);
        h.patch(P(kChamberHW, kFloor, kDoorZ1), P(kPassIn, kFloor, kDoorZ1), P(kChamberHW, kDoorTop, kDoorZ1), P(kPassIn, kDoorTop, kDoorZ1), -Z,
                M_DUVAR, 2.0f);
        h.patch(P(kChamberHW, kDoorTop, kDoorZ0), P(kPassIn, kDoorTop, kDoorZ0), P(kChamberHW, kDoorTop, kDoorZ1), P(kPassIn, kDoorTop, kDoorZ1), -Y,
                M_DUVAR, 2.0f);
        h.patch(P(kChamberHW, kFloor, kDoorZ0), P(kPassIn, kFloor, kDoorZ0), P(kChamberHW, kFloor, kDoorZ1), P(kPassIn, kFloor, kDoorZ1), Y,
                M_KOLON, 2.0f);
        // a steel frame in the opening on the chamber's side (the door was taken off its hinges long ago)
        for (float z : {kDoorZ0 + 0.04f, kDoorZ1 - 0.04f})
            h.box(P(kChamberHW + 0.05f, 0.5f * (kFloor + kDoorTop), z), v3(0.05f, 0.5f * (kDoorTop - kFloor), 0.04f), 0.008f, M_KOYU, 1.0f);
        h.box(P(kChamberHW + 0.05f, kDoorTop - 0.04f, 0.5f * (kDoorZ0 + kDoorZ1)), v3(0.05f, 0.04f, 0.5f), 0.008f, M_KOYU, 1.0f);

        // the passage: 1 m wide, 2.4 m clear, from its closed end by the door back to the space behind the chamber
        h.patch(P(kPassIn, kFloor, kPassZ0), P(kPassOut, kFloor, kPassZ0), P(kPassIn, kFloor, kBackZ0), P(kPassOut, kFloor, kBackZ0), Y, M_KOLON);
        h.patch(P(kPassIn, kCeil, kPassZ0), P(kPassOut, kCeil, kPassZ0), P(kPassIn, kCeil, kBackZ0), P(kPassOut, kCeil, kBackZ0), -Y, M_TAVAN);
        const float3 nIn = v3(sx, 0, 0);   // the inner wall faces away from the chamber
        h.patch(P(kPassIn, kFloor, kBackZ0), P(kPassIn, kFloor, kDoorZ0), P(kPassIn, kCeil, kBackZ0), P(kPassIn, kCeil, kDoorZ0), nIn, M_DUVAR);
        h.patch(P(kPassIn, kFloor, kDoorZ1), P(kPassIn, kFloor, kPassZ0), P(kPassIn, kCeil, kDoorZ1), P(kPassIn, kCeil, kPassZ0), nIn, M_DUVAR);
        h.patch(P(kPassIn, kDoorTop, kDoorZ0), P(kPassIn, kDoorTop, kDoorZ1), P(kPassIn, kCeil, kDoorZ0), P(kPassIn, kCeil, kDoorZ1), nIn, M_DUVAR);
        h.patch(P(kPassOut, kFloor, kBackZ1), P(kPassOut, kFloor, kPassZ0), P(kPassOut, kCeil, kBackZ1), P(kPassOut, kCeil, kPassZ0), -nIn, M_DUVAR);
        h.patch(P(kPassIn, kFloor, kPassZ0), P(kPassOut, kFloor, kPassZ0), P(kPassIn, kCeil, kPassZ0), P(kPassOut, kCeil, kPassZ0), -Z, M_DUVAR);
        // a cable on brackets along the outer wall, the passage's only furniture
        for (int c = 0; c < 2; ++c) {
            const float y = kCeil - 0.25f - 0.07f * c;
            h.tube(P(kPassOut - 0.08f, y, kPassZ0), P(kPassOut - 0.08f, y, kBackZ1 + 0.3f), 0.02f, M_KABLO, 4.0f);
        }
        for (float z = kPassZ0 - 1.2f; z > kBackZ1 + 0.5f; z -= 2.4f)
            h.box(P(kPassOut - 0.05f, kCeil - 0.32f, z), v3(0.05f, 0.11f, 0.02f), 0.006f, M_KOYU, 0.2f);
    }
    // the space behind the chamber: 1.6 m deep, across both passages' ends; the stair leaves from its middle
    h.patch(v3(-kPassOut, kFloor, kBackZ0), v3(kPassOut, kFloor, kBackZ0), v3(-kPassOut, kFloor, kBackZ1), v3(kPassOut, kFloor, kBackZ1), Y, M_KOLON);
    h.patch(v3(-kPassOut, kCeil, kBackZ0), v3(kPassOut, kCeil, kBackZ0), v3(-kPassOut, kCeil, kBackZ1), v3(kPassOut, kCeil, kBackZ1), -Y, M_TAVAN);
    h.patch(v3(-kPassIn, kFloor, kBackZ0), v3(kPassIn, kFloor, kBackZ0), v3(-kPassIn, kCeil, kBackZ0), v3(kPassIn, kCeil, kBackZ0), -Z, M_DUVAR);
    for (int s : {-1, 1})
        h.patch(v3(s * kStairHW, kFloor, kBackZ1), v3(s * kPassOut, kFloor, kBackZ1), v3(s * kStairHW, kCeil, kBackZ1), v3(s * kPassOut, kCeil, kBackZ1), Z,
                M_DUVAR);
}

// a small lamp on a wall: a dark iron cup with a hood, a glowing lens (merdiven_isik) and its disc emitter (group 0),
// tilted down onto the treads
void stairLamp(Hall& h, float3 p, float3 wallN) {
    const float3 n = normalize(wallN + v3(0, -0.55f, 0));
    h.box(facing(p + wallN * 0.006f, wallN), v3(0.07f, 0.07f, 0.006f), 0.003f, M_KOYU, 0.1f);
    const float3 c = p + wallN * 0.07f;
    h.at(facing(c, n), M_KOYU, 0.05f).roundedCylinder(0.085f, -0.06f, 0.0f, 0.01f);
    h.at(facing(c, n), M_KOYU, 0.05f).cylinderWall(0.088f, 0.15f * kPi, 0.85f * kPi, 0.0f, 0.05f, false);   // the hood
    h.at(facing(c, n), M_KOYU, 0.05f).cylinderWall(0.085f, 0.15f * kPi, 0.85f * kPi, 0.0f, 0.05f, true);
    h.at(facing(c + n * 0.002f, n), M_MERDIVEN_ISIK, 0.05f).ring(0.0f, 0.06f, 0.0f, true);
    Emitter e;
    e.type = Emitter::DISC;
    e.group = GROUP_KUYU;
    e.c = c + n * 0.004f;
    e.u = normalize(cross(n, Y)) * 0.06f;
    e.n = n;
    e.L = kMerdivenL;
    e.lobe = 1.0f;
    h.s.lights.push_back(e);
}

void stair(Hall& h) {
    // the flight: one surface of treads and risers, its corners rounded 12 mm (a sawtooth's sharp corners would bend
    // Phong's normals across whole treads), from the back space's floor to the top tread at the roof deck's level
    {
        std::vector<float2> corner = {{0.0f, kFloor}};
        for (int i = 0; i < kRisers; ++i) {
            corner.push_back(make_float2(i * kGoing, kFloor + (i + 1) * kRise));
            corner.push_back(make_float2((i + 1) * kGoing, kFloor + (i + 1) * kRise));
        }
        // rounded: each inner point becomes three (in, on the round, out); the ends stay
        const float e = 0.012f;
        std::vector<float2> pts = {corner.front()};
        for (size_t k = 1; k + 1 < corner.size(); ++k) {
            const float2 a = corner[k - 1], p = corner[k], b = corner[k + 1];
            float2 da = make_float2(a.x - p.x, a.y - p.y), db = make_float2(b.x - p.x, b.y - p.y);
            const float la = std::hypot(da.x, da.y), lb = std::hypot(db.x, db.y);
            da = make_float2(da.x / la, da.y / la);
            db = make_float2(db.x / lb, db.y / lb);
            const float2 pa = make_float2(p.x + da.x * e, p.y + da.y * e), pb = make_float2(p.x + db.x * e, p.y + db.y * e);
            // the round's middle: half way between the cut points, pulled a little towards the corner
            const float2 pm = make_float2(0.5f * (pa.x + pb.x) * 0.6f + p.x * 0.4f, 0.5f * (pa.y + pb.y) * 0.6f + p.y * 0.4f);
            pts.push_back(pa);
            pts.push_back(pm);
            pts.push_back(pb);
        }
        pts.push_back(corner.back());
        const int n = int(pts.size());
        std::vector<float2> nrm(n);
        std::vector<float> arc(n, 0.0f);
        for (int k = 0; k < n; ++k) {
            const float2 a = pts[std::max(0, k - 1)], p = pts[k], b = pts[std::min(n - 1, k + 1)];
            // the edges' normals, length weighted: (-dy, dx) faces up the treads and back down the risers
            const float nx = -(p.y - a.y) - (b.y - p.y), ny = (p.x - a.x) + (b.x - p.x);
            const float l = std::hypot(nx, ny);
            nrm[k] = make_float2(nx / l, ny / l);
            if (k) arc[k] = arc[k - 1] + std::hypot(p.x - a.x, p.y - a.y);
        }
        h.at(Xform(), M_KOLON, 1.0f).grid(n - 1, 1, [&](int i, int j) {
            Kit::GridPt g;
            const float x = kStairHW - 2.0f * kStairHW * float(j);
            g.p = v3(x, pts[i].y, zAt(pts[i].x));
            g.n = v3(0, nrm[i].y, -nrm[i].x);
            g.s = make_float2(arc[i], x);
            return g;
        });
    }
    // steel nosings: an angle on every tread's edge, the stair's rhythm in the lamps' light (one packed chart)
    {
        const size_t vm = h.vmark();
        const uint32_t cm = h.cmark();
        for (int i = 0; i + 1 < kRisers; ++i) {
            const float r = i * kGoing, y = kFloor + (i + 1) * kRise;
            h.bar(v3(-kStairHW + 0.01f, y - 0.004f, zAt(r) - 0.025f), v3(kStairHW - 0.01f, y - 0.004f, zAt(r) - 0.025f), 0.05f, 0.01f, Y, M_KOYU);
        }
        h.packCharts(vm, cm, 0.02f);
    }
    // the tunnel: its side walls (below the treads, up to the ceiling; under the hatch up to the deck), its ceiling
    // parallel to the pitch, 2.4 m over the risers' feet, and the slab's edge where the hatch opens
    const float rb = -0.3f;   // the walls start below the treads
    for (int s : {-1, 1}) {
        const float x = s * kStairHW;
        const float3 n = v3(float(-s), 0, 0);
        h.patch(v3(x, pitchFoot(0) - 0.3f, zAt(0)), v3(x, pitchFoot(kRunHatch) - 0.3f, zAt(kRunHatch)), v3(x, ceilingAt(0), zAt(0)),
                v3(x, ceilingAt(kRunHatch), zAt(kRunHatch)), n, M_DUVAR, 6.0f);
        h.patch(v3(x, pitchFoot(kRunHatch) - 0.3f, zAt(kRunHatch)), v3(x, pitchFoot(kRunEnd) - 0.3f, zAt(kRunEnd)), v3(x, kRoof, zAt(kRunHatch)),
                v3(x, kRoof, zAt(kRunEnd)), n, M_DUVAR, 6.0f);
    }
    (void)rb;
    {
        const float3 nc = normalize(v3(0, -kGoing, -kRise));
        h.patch(v3(-kStairHW, ceilingAt(0), zAt(0)), v3(kStairHW, ceilingAt(0), zAt(0)), v3(-kStairHW, ceilingAt(kRunHatch), zAt(kRunHatch)),
                v3(kStairHW, ceilingAt(kRunHatch), zAt(kRunHatch)), nc, M_TAVAN, 6.0f);
        h.patch(v3(-kStairHW, kRoof - kSlab, kHatchZ0), v3(kStairHW, kRoof - kSlab, kHatchZ0), v3(-kStairHW, kRoof, kHatchZ0), v3(kStairHW, kRoof, kHatchZ0),
                -Z, M_DUVAR, 2.0f);
    }
    // the handrail on the left wall, 0.9 m over the nosings, on brackets every ~1.7 m; it ends under the slab
    {
        const float xr = -kStairHW + 0.085f, r0 = 0.25f, r1 = (kRoof - kSlab - 0.1f - 0.9f - nosing(0)) * kGoing / kRise;
        const float3 a = v3(xr, nosing(r0) + 0.9f, zAt(r0)), b = v3(xr, nosing(r1) + 0.9f, zAt(r1));
        h.rod(a, b, 0.024f, M_PASLI, 2.0f);
        const int nb = int(std::ceil((r1 - r0) / 1.7f));
        for (int q = 0; q <= nb; ++q) {
            const float r = r0 + 0.15f + (r1 - r0 - 0.3f) * q / nb, y = nosing(r) + 0.9f;
            h.bar(v3(-kStairHW, y - 0.06f, zAt(r)), v3(xr, y - 0.06f, zAt(r)), 0.02f, 0.02f, Y, M_PASLI);
            h.box(facing(v3(-kStairHW + 0.005f, y - 0.06f, zAt(r)), X), v3(0.04f, 0.06f, 0.005f), 0.002f, M_PASLI, 0.1f);
        }
    }
    // the lamps: on the right wall every 6 m of run, 2 m over the nosings; and one at the foot on the back space's front
    // wall, seen round the corner from the passages
    for (float r = 3.0f; r < kRunHatch - 1.0f; r += 6.0f) stairLamp(h, v3(kStairHW, nosing(r) + 2.0f, zAt(r)), v3(-1, 0, 0));
    stairLamp(h, v3(0.0f, kCeil - 0.6f, kBackZ0), v3(0, 0, -1));
}

// the hatch: a concrete curb round the opening in the roof deck, the lid (a dinamik part, closed as built), its hinges
void hatch(Hall& h) {
    const float zo0 = kHatchZ0 + kCurbT, zo1 = kHatchZ1 - kCurbT, xo = kStairHW + kCurbT, yt = kRoof + kCurb;
    const float yb = kRoof - 0.02f, ym = 0.5f * (yb + yt), hy = 0.5f * (yt - yb);
    for (int s : {-1, 1}) h.box(v3(s * (kStairHW + 0.5f * kCurbT), ym, 0.5f * (zo0 + zo1)), v3(0.5f * kCurbT, hy, 0.5f * (zo0 - zo1)), 0.02f, M_DIS_DUVAR, 2.0f);
    h.box(v3(0, ym, kHatchZ0 + 0.5f * kCurbT), v3(kStairHW, hy, 0.5f * kCurbT), 0.02f, M_DIS_DUVAR, 2.0f);
    h.box(v3(0, ym, kHatchZ1 - 0.5f * kCurbT), v3(kStairHW, hy, 0.5f * kCurbT), 0.02f, M_DIS_DUVAR, 2.0f);
    // a steel angle round the curb's top (the lid's seat)
    for (int s : {-1, 1}) h.box(v3(s * (xo - 0.01f), yt + 0.006f, 0.5f * (zo0 + zo1)), v3(0.01f, 0.006f, 0.5f * (zo0 - zo1)), 0.003f, M_DIS_KOYU, 2.0f);
    // the hinges on the curb's +x side: three knuckle blocks; the lid turns about the line through them
    const float lt = 0.07f;                            // the lid's thickness
    const float3 pivot = v3(xo + 0.05f, yt + 0.5f * lt, 0.5f * (zo0 + zo1));
    const float len = (zo0 - zo1) + 0.1f, wid = 2.0f * xo + 0.1f;
    for (int q = -1; q <= 1; ++q) {
        const float z = pivot.z + q * (0.5f * len - 0.4f);
        h.box(v3(xo + 0.03f, yt - 0.1f, z), v3(0.03f, 0.12f, 0.12f), 0.006f, M_DIS_KOYU, 0.3f);
        h.rod(v3(pivot.x, pivot.y, z - 0.1f), v3(pivot.x, pivot.y, z + 0.1f), 0.035f, M_DIS_KOYU, 0.3f);
    }
    // the lid: own frame x = the hinge (world -z), y = up, z = x × y = world +x; it lies towards own -z (world -x).
    // Opening is a turn about x by +angle (right hand): its free edge rises
    Dynamic d;
    d.name = "kapak";
    d.centre = pivot;
    d.axis = v3(0, 0, -1);
    Kit q(d.mesh);
    q.mat = M_DIS_KOYU;
    q.maxEdge = 1.0f;
    q.t = Xform::at(v3(0, 0, -0.5f * wid - 0.02f));
    q.roundedBox(v3(0.5f * len, 0.5f * lt, 0.5f * wid), 0.012f);
    // stiffeners on top: two along it, five across; a handle bar at the free edge
    q.maxEdge = 2.0f;
    for (float zz : {-0.3f * wid, -0.75f * wid}) {
        q.t = Xform::at(v3(0, 0.5f * lt + 0.04f, zz));
        q.roundedBox(v3(0.5f * len - 0.15f, 0.04f, 0.025f), 0.008f);
    }
    for (int k = 0; k < 5; ++k) {
        q.t = Xform::at(v3(-0.5f * len + 0.3f + (len - 0.6f) * k / 4.0f, 0.5f * lt + 0.035f, -0.5f * wid - 0.02f));
        q.roundedBox(v3(0.025f, 0.035f, 0.5f * wid - 0.12f), 0.008f);
    }
    for (int k = -1; k <= 1; k += 2) {
        q.t = Xform::at(v3(k * 0.35f, 0.5f * lt + 0.08f, -wid + 0.08f));
        q.roundedBox(v3(0.02f, 0.08f, 0.02f), 0.006f);
    }
    q.t = Xform::frame(v3(-0.37f, 0.5f * lt + 0.15f, -wid + 0.08f), v3(1, 0, 0), v3(0, 1, 0));
    q.roundedCylinder(0.02f, 0.0f, 0.74f, 0.006f);
    // its own knuckles between the curb's
    for (int k = -1; k <= 1; k += 2) {
        q.t = Xform::frame(v3(k * 0.25f * len - 0.12f, 0, 0), v3(1, 0, 0), v3(0, 1, 0));
        q.roundedCylinder(0.035f, 0.0f, 0.24f, 0.008f);
    }
    d.radius = 0.5f * std::hypot(len, wid) + 0.2f;
    d.blades = 0;
    d.bakeTransmit = 1.0f;   // not in the bake (a dinamik part is lit from the volumes): the roof's light is the open hatch's
    h.s.dyn.push_back(std::move(d));
    Anchor an;
    an.name = "kapak";
    an.type = "nokta";
    an.box = {pivot + v3(-0.5f * wid - 0.02f, 0.05f, 0), v3(0.5f * wid + 0.05f, 0, 0), v3(0, 0.12f, 0), v3(0, 0, 0.5f * len)};
    an.pivot = pivot;
    an.axis = v3(0, 0, -1);
    h.s.anchors.push_back(an);
    // the hand's reach: from under it on the top treads, and from the deck beside it
    h.anchorBox("kapak_tik", "tik", v3(-xo - 0.3f, kRoof - 1.4f, zo1 - 0.2f), v3(xo + 0.3f, yt + 0.6f, zo0 + 0.2f));
    h.anchorBox("merdiven", "nokta", v3(-kStairHW, kFloor, kTopTread), v3(kStairHW, kRoof, kStairZ0));
}

}   // namespace

void buildStair(Hall& h) {
    DensityZone z;
    z.first = h.cmark();
    z.journey = false;
    z.dMin = 10.0f;  // 4 cm texels at --texel-scale 2.5 where you walk (the landing's are 2.5 cm)
    doorsAndPassages(h);
    stair(h);
    hatch(h);
    z.end = h.cmark();
    h.s.zones.push_back(z);
    // where the walker goes, at eye height: through each door and passage to the back space, up the stair, out
    const float e = 1.6f;
    for (int s : {-1, 1}) {
        const float x = s * 0.5f * (kPassIn + kPassOut);
        h.s.walk.push_back({v3(s * 9.0f, kFloor + e, 0.5f * (kDoorZ0 + kDoorZ1)), v3(x, kFloor + e, 0.5f * (kDoorZ0 + kDoorZ1)),
                            v3(x, kFloor + e, 0.5f * (kBackZ0 + kBackZ1)), v3(0, kFloor + e, 0.5f * (kBackZ0 + kBackZ1))});
    }
    h.s.walk.push_back({v3(0, kFloor + e, kStairZ0 + 0.4f), v3(0, nosing(kRunEnd - kGoing) + e, kTopTread)});
}

}   // namespace salon::hall
