// The hanging navigation signs (docs/SALON.md, "Interaction"): steel plates with a rolled rim on two chains of real
// links (8 cm), hung straight down from eye plates. "tabela_rgb" under the gallery's portal facing the landing (the
// way into the hall), "tabela_fanlar" in the plaza before the arch's left pylon, turned towards the rgb view (the way back).
#include "scene/hall_kit.h"

#include <cmath>

namespace salon::hall {

namespace {

void hangingSign(Hall& h, const std::string& name, const std::string& click, float3 c, float3 n, float ceilingY,
                 float hangHalf) {
    const float w = 4.5f, hh = 1.4f, a = 0.5f * w, b = 0.5f * hh;
    const Xform S = facing(c, n);
    h.box(S, v3(a, b, 0.003f), 0.002f, M_SAC, 2.0f);
    // the rolled rim: a tube round the plate's edge (its two ends meet at the bottom's middle)
    std::vector<float3> rim;
    for (float2 q : {float2{0, -b}, float2{a, -b}, float2{a, b}, float2{-a, b}, float2{-a, -b}, float2{0, -b}})
        rim.push_back(S.point(v3(q.x, q.y, 0)));
    dz::pipeRun(h.at(Xform(), M_SAC, 0.5f), rim, 0.02f, 0.06f);
    h.levha(name, name, S.point(v3(0, 0, 0.006f)), n, w - 0.12f, hh - 0.12f, M_TABELA);
    for (int s = -1; s <= 1; s += 2) {
        // the eye welded on the rim, the chain, the eye plate under the ceiling
        const float3 top = S.point(v3(s * hangHalf, b + 0.02f, 0));
        h.at(axes(top + v3(0, 0.035f, 0), S.x, v3(0, 1, 0), S.z), M_PASLI, 0.02f).torus(0.035f, 0.008f);
        const float3 cp = v3(top.x, ceilingY, top.z);
        h.box(cp - v3(0, 0.01f, 0), v3(0.1f, 0.01f, 0.1f), 0.004f, M_PASLI, 0.3f);
        for (int q = 0; q < 4; ++q)
            h.nut(axes(cp + v3(q % 2 ? 0.07f : -0.07f, -0.02f, q / 2 ? 0.07f : -0.07f), v3(1, 0, 0), v3(0, 0, 1), v3(0, -1, 0)), 0.024f,
                  M_PASLI);
        h.at(axes(cp - v3(0, 0.055f, 0), S.z, v3(0, 1, 0), -S.x), M_PASLI, 0.02f).torus(0.035f, 0.008f);
        h.chain(top + v3(0, 0.055f, 0), cp - v3(0, 0.075f, 0), 0.08f, 0.008f, M_PASLI);
    }
    // the sign's own lamp (group 2): a steel hood on two arms 0.45 m out from the plate's top edge, a light strip under
    // it shining down and back onto the face, so the way is findable in the dark (also with the lights out)
    {
        const float out = 0.45f, up = b + 0.08f, hw = a - 0.15f;
        for (int s = -1; s <= 1; s += 2) h.bar(S.point(v3(s * (hw - 0.1f), up, 0.0f)), S.point(v3(s * (hw - 0.1f), up, out)), 0.03f, 0.03f, S.y, M_KOYU);
        h.box(axes(S.point(v3(0, up + 0.04f, out)), S.x, S.y, S.z), v3(hw, 0.03f, 0.08f), 0.01f, M_KOYU, 0.5f);
        // the strip faces down and back towards the plate
        const float3 dn = normalize(S.z * -0.55f + S.y * -1.0f);
        const float3 c = S.point(v3(0, up + 0.005f, out));
        h.at(facing(c, dn, S.x * -1.0f), M_CAM_LAMBA, 1.0f).quad(0.05f, 2 * hw);
        Emitter e;
        e.type = Emitter::RECT;
        e.group = GROUP_LAMBA;
        e.c = c + dn * 0.002f;
        e.u = S.x * hw;
        e.v = normalize(cross(dn, S.x)) * 0.025f;
        e.n = dn;
        e.L = kSignLampL;
        e.lobe = 4.0f;
        h.s.lights.push_back(e);
    }
    h.anchor(click, "tik", S, v3(a + 0.05f, b + 0.05f, 0.1f));
}

}   // namespace

void buildSigns(Hall& h) {
    hangingSign(h, "tabela_rgb", "git_rgb", v3(0, 13.0f, -42.8f), v3(0, 0, 1), 20.0f, 1.8f);
    const float turn = 20.0f * kPi / 180.0f;
    hangingSign(h, "tabela_fanlar", "git_fanlar", v3(-9.0f, 8.0f, -247.0f), v3(std::sin(turn), 0, std::cos(turn)), kHallH, 1.8f);
}

}   // namespace salon::hall
