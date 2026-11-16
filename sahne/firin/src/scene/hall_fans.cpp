// The two wall fans of the entrance gallery (docs/SALON.md): left = CPU + case at x = -12, right = GPU at x = +12,
// centre y 8.5, z -24, 10 m across, axis along x. Each: a square concrete recess 2.5 m deep with a chamfered frame,
// a steel barrel through its back into the duct, a bolted bell-mouth inlet, a welded guard grille, the motor nacelle on
// stator vanes behind the rotor, and the rotor itself (Scene::dyn, its own frame). Beside each fan on the portal side
// (the wall between the landing and the fans lies outside the fanlar view): the board on brackets turned towards the
// landing, its warning plate, the knife-switch lever box and a caged lamp; the stencilled identity above the fan.
#include "scene/hall_kit.h"

#include <algorithm>
#include <cmath>

namespace salon::hall {

namespace {

struct FanSpec {
    int side;              // -1 left, +1 right
    const char* tag;       // "kasa", "gpu"
    int paint;             // the shroud's paint
    int blades;            // 7 wide blades / 9 narrower ones
    float hubR;            // hub radius
    float chordRoot, chordTip;
    float pitchRoot, pitchTip;   // blade angle from the plane of rotation (degrees)
    float sweep;           // the tip's sweep back (radians)
    float spinnerLen;      // the spinner cone's length (a sharp one or a blunt one)
    int vanes;             // stator vanes behind the rotor
};

const FanSpec kFans[2] = {
    {-1, "kasa", M_KASA, 7, 0.95f, 1.35f, 1.05f, 46.0f, 22.0f, 0.30f, 1.15f, 8},
    {+1, "gpu", M_GPU, 9, 1.15f, 1.10f, 0.72f, 50.0f, 25.0f, 0.12f, 0.62f, 11},
};

constexpr float kTip = 4.94f;          // blade tip radius (the barrel is 5.0)
constexpr float kRotorZ = -0.95f;      // the rotor's plane, from the wall plane into the barrel

// ---- the rotor, in its own frame: axis +x, centred at the origin (the air goes +x, into the room)
void buildRotor(Dynamic& d, const FanSpec& f) {
    Kit q(d.mesh);
    q.maxEdge = 0.2f;
    // the hub and its spinner: a lathe about +x
    const Xform alongX = axes(v3(0, 0, 0), v3(0, 1, 0), v3(0, 0, 1), v3(1, 0, 0));
    q.t = alongX;
    q.mat = M_KANAT;
    const float rh = f.hubR;
    // the hub is longer than the blades' roots reach along the axis (chord x sin(pitch) at the root)
    const float hb = -0.72f, hf = 0.62f;
    std::vector<float2> prof = {{0.0f, hb}, {rh - 0.05f, hb}, {rh, hb + 0.05f}, {rh, hf - 0.03f}, {rh - 0.02f, hf},
                                {0.84f * rh, hf}, {0.82f * rh, hf + 0.03f}};
    const int ns = 12;
    for (int i = 1; i <= ns; ++i) {   // the spinner: an ogive from 0.82 rh to its point
        const float s = float(i) / ns;
        const float r = 0.82f * rh * std::pow(std::max(0.0f, 1.0f - s * s), 0.55f);
        prof.push_back({r, hf + 0.03f + f.spinnerLen * s});
    }
    q.lathe(prof);
    // the bolts holding the spinner: 12 hex heads on the hub's front ring
    for (int i = 0; i < 12; ++i) {
        const float a = 2.0f * kPi * (i + 0.5f) / 12;
        const float rr = 0.92f * rh;
        q.t = alongX * Xform::at(v3(rr * std::cos(a), rr * std::sin(a), hf));
        q.hexPrism(0.05f, 0.0f, 0.035f, 0.006f);
    }
    // the blades: cambered, twisted aerofoils (NACA 4-digit, 4 % camber at 40 %) with real chord and thickness
    q.t = Xform();
    const int nu = 48, nt = 22;
    const float r0 = rh - 0.06f;   // the root, buried in the hub
    for (int b = 0; b < f.blades; ++b) {
        const float a0 = 2.0f * kPi * b / f.blades;
        // a point on blade b: tt along the span 0..1, u round the section 0..1 (trailing edge, upper, leading, lower)
        auto pos = [&](float tt, float u) {
            const float r = r0 + (kTip - r0) * tt;
            const float span = std::clamp((r - rh) / (kTip - rh), 0.0f, 1.0f);
            const float chord = f.chordRoot + (f.chordTip - f.chordRoot) * span;
            const float beta = (f.pitchRoot + (f.pitchTip - f.pitchRoot) * span) * kPi / 180.0f;
            const float tc = 0.14f - 0.06f * span;   // thickness ratio
            const float ang = a0 - f.sweep * span * span;   // swept back against the rotation
            const float xc = 0.5f * (1.0f + std::cos(2.0f * kPi * u));   // 1 at the trailing edge, 0 at the leading
            const float yt = 5.0f * tc * (0.2969f * std::sqrt(xc) - 0.126f * xc - 0.3516f * xc * xc + 0.2843f * xc * xc * xc -
                                          0.1036f * xc * xc * xc * xc);
            const float m = 0.04f, p = 0.4f;
            const float yc = xc < p ? m / (p * p) * (2 * p * xc - xc * xc) : m / ((1 - p) * (1 - p)) * (1 - 2 * p + 2 * p * xc - xc * xc);
            const float Y = (u < 0.5f ? yc + yt : yc - yt) * chord;   // the suction side first
            const float X = (xc - 0.4f) * chord;                       // stacked at 40 % chord
            const float3 er = v3(0, std::cos(ang), std::sin(ang)), et = v3(0, -std::sin(ang), std::cos(ang)), ex = v3(1, 0, 0);
            // the chord from the leading edge to the trailing: against the rotation and downstream
            const float3 dc = et * -std::cos(beta) + ex * std::sin(beta);
            const float3 ms = (et * std::sin(beta) + ex * std::cos(beta)) * -1.0f;   // the suction side's direction
            return er * r + dc * X + ms * Y;
        };
        // the winding faces out if (d/du x d/dt) points away from the section's chord line
        const float3 pm = pos(0.5f, 0.25f), pc = 0.5f * (pos(0.5f, 0.0f) + pos(0.5f, 0.5f));
        const float3 tn = cross(pos(0.5f, 0.26f) - pos(0.5f, 0.24f), pos(0.52f, 0.25f) - pos(0.48f, 0.25f));
        const bool flip = dot(tn, pm - pc) < 0;
        auto P = [&](float tt, float u) { return pos(tt, flip ? 1.0f - u : u); };
        q.mat = M_KANAT;
        q.grid(nu, nt, [&](int i, int j) {
            const float u = float(i) / nu, tt = float(j) / nt;
            const float du = 0.25f / nu, dt = 0.25f / nt;
            float3 n = cross(P(tt, u + du) - P(tt, u - du), P(std::min(1.0f, tt + dt), u) - P(std::max(0.0f, tt - dt), u));
            const float l = length(n);
            Kit::GridPt g;
            g.p = P(tt, u);
            g.n = l > 1e-12f ? n / l : v3(1, 0, 0);
            if (i == 0 || i == nu) {   // the trailing edge: the two sides meet, the normal between them
                const float3 na = cross(P(tt, du) - P(tt, 0.0f), P(std::min(1.0f, tt + dt), 0.0f) - P(std::max(0.0f, tt - dt), 0.0f));
                const float3 nb = cross(P(tt, 1.0f) - P(tt, 1.0f - du), P(std::min(1.0f, tt + dt), 1.0f) - P(std::max(0.0f, tt - dt), 1.0f));
                g.n = normalize(normalize(na) + normalize(nb));
            }
            g.s = make_float2(u * 2.0f * f.chordRoot, tt * (kTip - r0));
            return g;
        });
        // the tip and the root (inside the hub), closed by caps: strips zipping the upper side to the lower one (a
        // thin cambered section is not star-shaped from any point), facing out along the span
        for (int end = 0; end < 2; ++end) {
            const float tt = end ? 1.0f : 0.0f;
            const float3 er = normalize(v3(0, P(tt, 0.25f).y, P(tt, 0.25f).z)) * (end ? 1.0f : -1.0f);
            const int nh = nu / 2;
            const bool rev = dot(cross(P(tt, 0.3f) - P(tt, 0.2f), P(tt, 0.75f) - P(tt, 0.25f)), er) < 0;
            q.grid(nh, 1, [&](int i, int j) {
                Kit::GridPt g;
                const float u = float(i) / nu;
                const bool lower = rev ? j == 0 : j == 1;
                g.p = lower ? P(tt, 1.0f - u) : P(tt, u);
                g.n = er;
                g.s = make_float2(u * f.chordTip, j ? 0.02f : 0.0f);
                return g;
            });
        }
    }
    // the bake sees the rotor as a disc: its open share is what the blades leave of it, spinning
    double open = 0, all = 0;
    for (int i = 0; i < 400; ++i) {
        const float r = kTip * (i + 0.5f) / 400;
        const float dA = 2.0f * kPi * r;
        all += dA;
        if (r < rh) continue;
        const float span = (r - rh) / (kTip - rh);
        const float chord = f.chordRoot + (f.chordTip - f.chordRoot) * span;
        const float beta = (f.pitchRoot + (f.pitchTip - f.pitchRoot) * span) * kPi / 180.0f;
        const float cover = std::min(1.0f, f.blades * chord * std::cos(beta) / (2.0f * kPi * r));
        open += dA * (1.0f - cover);
    }
    d.radius = kTip;
    d.blades = f.blades;
    d.bakeTransmit = float(open / all);
}

// ---- the knife-switch lever (Scene::dyn), in its own frame: x the hinge axis, y up, z out of the box; rest = closed
void buildLever(Dynamic& d, int paint) {
    Kit q(d.mesh);
    q.maxEdge = 0.2f;
    auto box = [&](float3 c, float3 hh, int mat, float e) {
        q.t = Xform::at(c);
        q.mat = uint32_t(mat);
        q.roundedBox(hh, e);
    };
    for (float x : {-0.07f, 0.07f}) box(v3(x, 0.31f, 0.0f), v3(0.006f, 0.31f, 0.022f), M_SAC, 0.003f);   // the blades
    box(v3(0, 0.55f, 0.0f), v3(0.1f, 0.025f, 0.025f), paint, 0.008f);                                     // crossbar
    // the handle out of the crossbar: an insulated grip with a knob
    q.t = Xform::frame(v3(0, 0.55f, 0.02f), v3(0, 0, 1), v3(0, 1, 0));
    q.mat = M_KABLO;
    q.roundedCylinder(0.028f, 0.0f, 0.32f, 0.01f);
    q.t = Xform::at(v3(0, 0.55f, 0.36f));
    q.mat = M_KABLO;
    q.sphere(0.045f);
    // the hinge's barrel (it turns with the blades)
    q.t = Xform::frame(v3(-0.09f, 0, 0), v3(1, 0, 0), v3(0, 1, 0));
    q.mat = M_SAC;
    q.roundedCylinder(0.025f, 0.0f, 0.18f, 0.006f);
    d.radius = 0.7f;
    d.blades = 0;
    d.bakeTransmit = 1.0f;   // not in the bake's disc model; the window draws it lit from the volumes
}

void fan(Hall& h, const FanSpec& f) {
    const int side = f.side;
    const float3 c = v3(12.0f * side, 8.5f, -24.0f), n = v3(float(-side), 0, 0);
    const Xform F = facing(c, n);   // the fan's frame: z into the room, y up, origin in the wall plane
    auto P = [&](float x, float y, float z) { return F.point(v3(x, y, z)); };
    const float A = 7.2f, B = 6.9f, ch = 0.3f, depth = 2.5f;

    // the recess: chamfered frame, four walls, the back wall round the barrel
    const float3 nIn[4] = {F.dir(v3(-1, 0, 0)), F.dir(v3(0, -1, 0)), F.dir(v3(1, 0, 0)), F.dir(v3(0, 1, 0))};
    const float2 cs[4] = {{1, 1}, {1, -1}, {-1, -1}, {-1, 1}};   // corners, clockwise from the top right
    for (int e = 0; e < 4; ++e) {
        const float2 p0 = cs[e], p1 = cs[(e + 1) % 4];
        // the edge from corner e to corner e+1: its inward normal is the one facing away from the edge's side
        const int sideIdx = e;   // 0: right (x = +), 1: bottom, 2: left, 3: top
        const float3 inward = nIn[sideIdx == 0 ? 0 : sideIdx == 1 ? 3 : sideIdx == 2 ? 2 : 1];
        h.patch(P(p0.x * A, p0.y * A, 0), P(p1.x * A, p1.y * A, 0), P(p0.x * B, p0.y * B, -ch), P(p1.x * B, p1.y * B, -ch),
                normalize(inward + F.z), M_DUVAR);
        h.patch(P(p0.x * B, p0.y * B, -ch), P(p1.x * B, p1.y * B, -ch), P(p0.x * B, p0.y * B, -depth),
                P(p1.x * B, p1.y * B, -depth), inward, M_DUVAR);
    }
    h.squareRing(F * Xform::at(v3(0, 0, -depth)), B, 5.02f, M_DUVAR);

    // the barrel: outside in the recess, inside from the duct to the bell-mouth; its flange; the duct's dark end
    h.at(F, f.paint, 0.25f).cylinderWall(5.02f, 0.0f, 2.0f * kPi, -depth, -0.64f, false);
    h.at(F, f.paint, 0.25f).cylinderWall(5.0f, 0.0f, 2.0f * kPi, -4.5f, -0.56f, true);
    h.at(F, f.paint, 0.5f).ring(5.02f, 5.7f, -0.64f, false);
    h.at(F, f.paint, 0.5f).cylinderWall(5.7f, 0.0f, 2.0f * kPi, -0.64f, -0.56f, false);
    h.at(F, f.paint, 0.5f).ring(5.0f, 5.7f, -0.56f, true);
    h.at(F, M_KOYU, 0.5f).ring(0.0f, 5.0f, -4.5f, true);
    // the bell-mouth: a rolled sheet lip from the barrel out to the room, its rim beaded
    {
        std::vector<float2> pr;
        const float cr = 5.45f, cz = -0.56f;
        for (int i = 0; i <= 12; ++i) {   // the back, from the root out to the lip
            const float th = kPi - 0.5f * kPi * i / 12;
            pr.push_back({cr + 0.435f * std::cos(th), cz + 0.435f * std::sin(th)});
        }
        for (int i = 1; i < 6; ++i) {     // the bead round the rim
            const float ph = -0.5f * kPi + kPi * i / 6;
            pr.push_back({cr + 0.0075f * std::cos(ph), -0.1175f + 0.0075f * std::sin(ph)});
        }
        for (int i = 0; i <= 12; ++i) {   // the front, back down to the root
            const float th = 0.5f * kPi + 0.5f * kPi * i / 12;
            pr.push_back({cr + 0.45f * std::cos(th), cz + 0.45f * std::sin(th)});
        }
        h.at(F, f.paint, 0.25f).lathe(pr);
    }
    for (int i = 0; i < 36; ++i) {   // the bolts round the flange (M30)
        const float a = 2.0f * kPi * (i + 0.5f) / 36;
        h.nut(F * Xform::at(v3(5.58f * std::cos(a), 5.58f * std::sin(a), -0.56f)) * Xform::rotZ(0.3f * i), 0.046f, M_KOYU);
    }

    // the guard grille: concentric rings in front of radial bars, a hub plate, standoffs to the flange
    const float gz = 0.08f;
    {
        h.at(F * Xform::at(v3(0, 0, gz)), f.paint, 0.3f).torus(5.6f, 0.022f);
        for (int i = 0; i < 12; ++i) {
            const float a = 2.0f * kPi * (i + 0.25f) / 12;
            h.rod(P(5.6f * std::cos(a), 5.6f * std::sin(a), -0.56f), P(5.6f * std::cos(a), 5.6f * std::sin(a), gz), 0.016f, f.paint);
        }
        for (float R = 0.75f; R < 5.4f; R += 0.375f) h.at(F * Xform::at(v3(0, 0, gz + 0.026f)), f.paint, 0.3f).torus(R, 0.012f);
        auto radial = [&](float a, float r0) {
            h.rod(P(r0 * std::cos(a), r0 * std::sin(a), gz), P(5.62f * std::cos(a), 5.62f * std::sin(a), gz), 0.014f, f.paint, 2.0f);
        };
        for (int i = 0; i < 12; ++i) {
            radial(2.0f * kPi * i / 12, 0.7f);
            radial(2.0f * kPi * (i + 0.5f) / 12, 1.85f);
            radial(2.0f * kPi * (i + 0.25f) / 12, 3.35f);
            radial(2.0f * kPi * (i + 0.75f) / 12, 3.35f);
        }
        h.at(F, f.paint, 0.2f).roundedCylinder(0.8f, gz - 0.015f, gz + 0.015f, 0.008f);
    }

    // the motor behind the rotor: a finned body, its tail cone, a terminal box with its cable to the barrel
    {
        const float z0 = -3.7f, z1 = -1.62f, rm = 1.05f;
        h.at(F, M_KOYU, 0.2f).roundedCylinder(rm, z0, z1, 0.05f);
        h.at(F, M_KOYU, 0.2f).lathe({{0.0f, z0 - 0.72f}, {0.5f, z0 - 0.6f}, {0.9f, z0 - 0.25f}, {rm, z0 + 0.01f}});   // up the outside
        for (int i = 0; i < 16; ++i) {
            const float a = 2.0f * kPi * (i + 0.5f) / 16;
            const float3 er = F.dir(v3(std::cos(a), std::sin(a), 0));
            h.bar(P(0, 0, z0 + 0.15f) + er * (rm + 0.035f), P(0, 0, z1 - 0.2f) + er * (rm + 0.035f), 0.02f, 0.08f, er, M_KOYU);
        }
        const float3 tb = P(0, rm + 0.18f, -2.6f);
        h.box(axes(tb, F.x, F.y, F.z), v3(0.25f, 0.16f, 0.32f), 0.02f, M_KOYU, 0.3f);
        h.tube(tb + F.y * 0.15f, P(0, 5.0f, -2.6f), 0.035f, M_KABLO, 0.5f);
    }
    // the stator vanes: flat plates from the motor to the barrel, a little turned against the swirl
    for (int i = 0; i < f.vanes; ++i) {
        const float a = 2.0f * kPi * (i + 0.5f) / f.vanes;
        const float3 er = F.dir(v3(std::cos(a), std::sin(a), 0)), et = F.dir(v3(-std::sin(a), std::cos(a), 0));
        const float tw = 12.0f * kPi / 180.0f;
        const float3 cd = normalize(F.z * std::cos(tw) + et * std::sin(tw));
        const float3 th = cross(er, cd);
        const float rc = 0.5f * (1.0f + 5.02f);
        h.box(axes(P(0, 0, -2.7f) + er * rc, th, er, cd), v3(0.007f, 0.5f * (5.02f - 1.0f), 0.35f), 0.004f, f.paint, 1.0f);
    }

    // the rotor
    {
        Dynamic d;
        d.name = std::string("fan_") + f.tag + "_rotor";
        d.centre = P(0, 0, kRotorZ);
        d.axis = n;
        buildRotor(d, f);
        h.s.dyn.push_back(std::move(d));
    }


    // ---- the board: a steel cabinet on brackets, turned 35 degrees towards the landing; its face square as its texture
    // (2048 x 2048: a 5.4 x 3.2 m face stretched the letters, review 1, B4); the details are read at the desk
    const float turn = 35.0f * kPi / 180.0f;
    const float3 nb = normalize(v3(-side * std::cos(turn), 0, std::sin(turn)));
    const Xform B0 = facing(v3(0, 0, 0), nb);
    const float3 ein = side > 0 ? -B0.x : B0.x;   // along the board from its wall end to its outer end
    const float yc = 5.3f, bw = 4.4f, bh = 4.4f, bd = 0.4f;
    const float3 E = v3(side * (12.0f - 0.3f), yc, -32.8f);   // the cabinet back's wall end
    const float3 C = E + ein * (0.5f * bw) + nb * (0.5f * bd);
    const Xform Bf = axes(C, B0.x, B0.y, B0.z);
    h.box(Bf, v3(0.5f * bw, 0.5f * bh, 0.5f * bd), 0.03f, f.paint, 1.0f);
    // the face, recessed in a bezel
    const float fw = 4.1f, fh = 4.1f;
    h.levha(std::string("pano_") + f.tag, std::string("pano_") + f.tag, C + nb * (0.5f * bd + 0.003f), nb, fw, fh, M_PANO);
    for (int s = -1; s <= 1; s += 2) {
        h.box(Bf * Xform::at(v3(0, s * (0.5f * fh + 0.075f), 0.5f * bd + 0.02f)), v3(0.5f * bw, 0.075f, 0.02f), 0.01f, f.paint, 1.0f);
        h.box(Bf * Xform::at(v3(s * (0.5f * fw + 0.075f), 0, 0.5f * bd + 0.02f)), v3(0.075f, 0.5f * fh, 0.02f), 0.01f, f.paint, 1.0f);
    }
    // a rain hood over it (water drips in a flood tunnel)
    h.box(Bf * Xform::at(v3(0, 0.5f * bh + 0.06f, 0.08f)) * Xform::rotX(0.26f), v3(0.5f * bw + 0.08f, 0.008f, 0.5f * bd + 0.12f),
          0.004f, M_SAC, 1.0f);
    // brackets: arms from the wall to the cabinet's back at both ends, top and bottom, a strut under the outer end
    for (float yy : {yc + 1.2f, yc - 1.2f})
        for (float along : {0.15f, bw - 0.15f}) {
            const float3 back = E + ein * along + v3(0, yy - yc, 0);
            const float3 wall = v3(side * 12.0f, back.y, back.z);
            h.bar(wall, back, 0.08f, 0.08f, v3(0, 1, 0), M_KOYU);
            h.box(axes(wall + v3(-side * 0.008f, 0, 0), v3(0, 0, float(side)), v3(0, 1, 0), n), v3(0.1f, 0.1f, 0.008f), 0.003f, M_KOYU, 0.3f);
        }
    {
        const float3 back = E + ein * (bw - 0.15f) + v3(0, -1.2f, 0);
        h.bar(v3(side * 12.0f, back.y - 1.2f, back.z + 0.6f), back, 0.07f, 0.07f, v3(0, 1, 0), M_KOYU);
    }
    // the warning plate under the cabinet, on two straps
    {
        const float3 pc = C + v3(0, -0.5f * bh - 0.42f, 0) + nb * 0.1f;
        h.box(axes(pc - nb * 0.008f, B0.x, B0.y, B0.z), v3(0.83f, 0.28f, 0.006f), 0.003f, M_SAC, 1.0f);
        h.levha(std::string("uyari_") + f.tag, std::string("uyari_") + f.tag, pc + nb * 0.001f, nb, 1.6f, 0.5f, M_TABELA);
        for (int s = -1; s <= 1; s += 2) {
            const float3 top = C + B0.x * (s * 0.6f) + v3(0, -0.5f * bh, 0) + nb * 0.1f;
            h.bar(top, top + v3(0, -0.2f, 0), 0.04f, 0.006f, nb, M_SAC);
        }
    }
    // the lever box on the wall below the board's wall end, its knife switch, the conduit up into the cabinet
    {
        const float zl = E.z - 0.6f;
        const float3 lb = v3(side * (12.0f - 0.15f), 1.45f, zl);
        h.box(lb, v3(0.15f, 0.6f, 0.4f), 0.03f, f.paint, 0.5f);
        const float front = side * (12.0f - 0.30f);
        // insulators: the hinge jaws below, the contact jaws above
        for (float yy : {1.1f, 1.72f})
            h.box(v3(front - side * 0.035f, yy, zl), v3(0.035f, 0.06f, 0.12f), 0.012f, M_KABLO, 0.2f);
        dz::pipeRun(h.at(Xform(), M_KOYU, 0.5f),
                    {v3(side * 11.97f, 2.05f, zl + 0.25f), v3(side * 11.97f, 2.75f, zl + 0.25f),
                     v3(side * (12.0f - 0.33f), 2.75f, zl + 0.25f), v3(side * (12.0f - 0.33f), yc - 0.5f * bh + 0.1f, zl + 0.25f)},
                    0.028f, 0.1f);
    }
    // ---- the desk on the landing: the fan's controls in the foreground (review 1, B4 and A3: the boards alone were
    // read at 33 m). A steel console by the landing's front rail in the fan's paint, its slanted top turned to the eye,
    // a display with the board's own texture, the knife switch's great lever beside it.
    {
        const float3 eye = v3(0, 4.65f, -1.6f);                      // the fanlar view's eye (hall.cpp)
        const float3 base = v3(side * 2.55f, 3.0f, -5.55f);
        const float3 t = normalize(v3(eye.x - base.x, 0, eye.z - base.z));   // towards the eye, horizontal
        const float3 up = v3(0, 1, 0);
        const float3 r = normalize(cross(up, t));                    // the desk's right
        const Xform D = axes(base, r, up, t);
        // the pedestal and the slanted top (40 degrees from level, rising away from the viewer)
        h.box(D * Xform::at(v3(0, 0.45f, 0)), v3(0.42f, 0.45f, 0.22f), 0.02f, f.paint, 0.5f);
        h.box(D * Xform::at(v3(0, 0.03f, 0)), v3(0.46f, 0.03f, 0.26f), 0.01f, M_KOYU, 0.5f);
        const float tilt = 40.0f * kPi / 180.0f;
        const float3 tn = normalize(up * std::cos(tilt) + t * std::sin(tilt));      // the top's normal
        const float3 tv = normalize(cross(tn, r));                                    // up the slope
        const float3 tc = base + up * 0.98f;
        h.box(axes(tc, r, tv, tn), v3(0.48f, 0.34f, 0.035f), 0.012f, f.paint, 0.5f);
        h.levha(std::string("masa_ekran_") + f.tag, std::string("pano_") + f.tag, tc + tn * 0.038f + tv * 0.02f, tn, 0.56f, 0.56f, M_PANO, tv);
        // the lever: hinge across the desk at its outer end, the handle rising and pulled towards the viewer
        const float3 pivot = base + up * 1.02f + r * (float(-side) * 0.6f) - t * 0.05f;   // the inner end: in frame
        h.box(pivot - up * 0.08f, v3(0.12f, 0.09f, 0.12f), 0.015f, M_KABLO, 0.2f);
        h.box(axes(base + r * (float(-side) * 0.6f) + up * 0.47f, r, up, t), v3(0.09f, 0.47f, 0.09f), 0.015f, f.paint, 0.5f);
        Dynamic d;
        d.name = std::string("kol_") + f.tag;
        d.centre = pivot;
        d.axis = r;                       // own frame: x = r, y = up, z = x × y = towards the viewer
        buildLever(d, f.paint);
        h.s.dyn.push_back(std::move(d));
        Anchor an;
        an.name = std::string("kol_") + f.tag;
        an.type = "nokta";
        an.box = {pivot + up * 0.3f + t * 0.18f, r * 0.16f, up * 0.42f, t * 0.26f};
        an.pivot = pivot;
        an.axis = r;
        h.s.anchors.push_back(an);
        h.anchor(std::string("masa_") + f.tag, "tik", D * Xform::at(v3(float(-side) * 0.1f, 0.8f, 0.0f)), v3(0.8f, 0.85f, 0.45f));
        // its lamp: a small hooded light on a stalk over the display (group 2)
        const float3 lp = tc + tv * 0.45f + tn * 0.3f;
        h.rod(tc + tv * 0.32f - tn * 0.02f, lp, 0.012f, M_KOYU);
        h.at(facing(lp, normalize(tc - lp)) * Xform::at(v3(0, 0, -0.04f)), M_KOYU, 0.1f).roundedCylinder(0.07f, -0.05f, 0.0f, 0.01f);
        Emitter e;
        e.type = Emitter::DISC;
        e.group = GROUP_LAMBA;
        e.c = lp + normalize(tc - lp) * 0.002f;
        e.u = normalize(cross(normalize(tc - lp), r)) * 0.055f;
        e.n = normalize(tc - lp);
        e.L = kDeskLampL;
        e.lobe = 3.0f;
        h.s.lights.push_back(e);
        h.at(facing(lp + normalize(tc - lp) * 0.001f, normalize(tc - lp)), M_CAM_LAMBA, 0.05f).ring(0.0f, 0.055f, 0.0f, true);
    }

    // the lamp above the board's wall end
    h.cagedLamp(v3(side * 12.0f, 7.3f, E.z + 0.6f), n, kBulbBoard);
    // the stencilled identity on the wall over its board, beside the fan (the wall above the fan lies at the fanlar
    // view's top edge)
    h.levha(std::string("boya_") + f.tag, std::string("boya_") + f.tag, v3(side * (12.0f - 0.002f), 7.9f, E.z - 2.4f), n, 5.0f,
            1.0f, M_BOYA);

    // the click box: the fan, its board and lever
    // two floor floodlights before the recess (group 2, the fixed warm light): they light the fan from below, so the
    // machine reads in the dark gallery and its blades catch a warm light against the shaft's temperature colour
    for (int q = -1; q <= 1; q += 2) {
        const float3 base = P(q * 4.6f, -8.5f, 2.2f);
        const float3 aim = normalize(P(q * 1.2f, 0.5f, 0.4f) - base);
        const Xform L = facing(base + v3(0, 0.45f, 0), aim);
        h.box(base + v3(0, 0.05f, 0), v3(0.32f, 0.05f, 0.32f), 0.01f, M_KOYU, 0.5f);           // the foot
        h.rod(base + v3(0, 0.1f, 0), base + v3(0, 0.36f, 0), 0.035f, M_KOYU);                  // the post
        h.at(L * Xform::at(v3(0, 0, -0.14f)), M_KOYU, 0.5f).roundedBox(v3(0.3f, 0.22f, 0.13f), 0.02f);   // the housing
        h.at(L * Xform::at(v3(0, 0, 0.001f)), M_CAM_LAMBA, 1.0f).quad(0.5f, 0.36f);           // its glass
        Emitter e;
        e.type = Emitter::RECT;
        e.group = GROUP_LAMBA;
        e.c = L.point(v3(0, 0, 0.002f));
        e.u = L.x * 0.25f;
        e.v = L.y * 0.18f;
        e.n = L.z;
        e.L = kFanFloodL;
        e.lobe = 10.0f;
        h.s.lights.push_back(e);
    }
    h.anchorBox(std::string("fan_") + f.tag, "tik", v3(std::min(side * 14.6f, side * 7.9f), 0.0f, -38.0f),
                v3(std::max(side * 14.6f, side * 7.9f), 15.7f, -16.8f));
}

}   // namespace

void buildFans(Hall& h) {
    for (const FanSpec& f : kFans) fan(h, f);
}

}   // namespace salon::hall
