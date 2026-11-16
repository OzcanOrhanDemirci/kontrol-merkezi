// The hall (docs/SALON.md): Tokyo's G-Cans pressure-control tank as Kontrol Merkezi's window. Original procedural
// geometry at real measures, built part by part (scene/hall_*.cpp) with the hall's kit (scene/hall_kit.h); this file
// puts them together and adds what the window needs besides the mesh: the two views, the journey's centre line, the
// volumes of baked light in the air.
#include "scene.h"
#include "scene/hall_kit.h"
#include "scene/hall_props.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace salon {

namespace {

using namespace hall;

void addVolume(Scene& s, const char* name, float3 lo, float3 hi, float cell) {
    Volume v;
    v.name = name;
    v.lo = lo;
    v.cell = cell;
    v.dim[0] = int(std::ceil((hi.x - lo.x) / cell - 1e-4f));
    v.dim[1] = int(std::ceil((hi.y - lo.y) / cell - 1e-4f));
    v.dim[2] = int(std::ceil((hi.z - lo.z) / cell - 1e-4f));
    s.vols.push_back(v);
}

// the journey: a smooth line from fanlar's eye to rgb's eye, rising over the landing's railing first. In the first half
// it leaves the aisle through a gap of the inner row (x = 8) into the lane between the rows at x = 8 and 22 and runs
// down it through the middle of the hall: the rows open up diagonally and the hall's width is felt (11-16, for grandeur:
// back in the aisle the view read as a corridor again). By the column line z = -160 it crosses back through the gap
// z -163.5..-176.5, where the camera's look (ui/uygulama.js) swings onto the arch, revealed between the columns; the
// last ~50 m run down the aisle with the monument centred and growing. geo_onizle.py checks clearance.
std::vector<float3> journey(const View& a, const View& b) {
    const std::vector<float3> ctl = {a.eye,
                                     {0.0f, 5.35f, -4.2f}, {0.0f, 6.05f, -6.0f}, {0.0f, 6.6f, -10.0f}, {0.0f, 7.0f, -25.0f},
                                     {0.0f, 7.2f, -44.0f}, {0.0f, 7.6f, -66.0f}, {2.0f, 8.0f, -82.0f}, {8.0f, 8.4f, -90.0f},
                                     {14.0f, 8.8f, -98.0f}, {15.0f, 9.0f, -112.0f}, {15.0f, 9.2f, -132.0f},
                                     {15.0f, 9.1f, -150.0f}, {13.6f, 8.6f, -162.0f}, {8.0f, 7.6f, -170.0f},
                                     {2.6f, 6.7f, -177.0f}, {0.0f, 6.0f, -190.0f}, {0.0f, 4.8f, -205.0f}, {0.0f, 3.6f, -214.5f}, b.eye};
    // Catmull-Rom (centripetal enough at these spacings), sampled finely, then resampled every ~2 m of arc
    std::vector<float3> fine;
    const int n = int(ctl.size());
    for (int i = 0; i + 1 < n; ++i) {
        const float3 p0 = ctl[std::max(0, i - 1)], p1 = ctl[i], p2 = ctl[i + 1], p3 = ctl[std::min(n - 1, i + 2)];
        for (int k = 0; k < 200; ++k) {
            const float t = k / 200.0f, t2 = t * t, t3 = t2 * t;
            auto cr = [&](float q0, float q1, float q2, float q3) {
                return 0.5f * (2 * q1 + (-q0 + q2) * t + (2 * q0 - 5 * q1 + 4 * q2 - q3) * t2 + (-q0 + 3 * q1 - 3 * q2 + q3) * t3);
            };
            fine.push_back(make_float3(cr(p0.x, p1.x, p2.x, p3.x), cr(p0.y, p1.y, p2.y, p3.y), cr(p0.z, p1.z, p2.z, p3.z)));
        }
    }
    fine.push_back(b.eye);
    std::vector<float> acc(fine.size(), 0.0f);
    for (size_t i = 1; i < fine.size(); ++i) acc[i] = acc[i - 1] + length(fine[i] - fine[i - 1]);
    const int m = std::max(2, int(std::round(acc.back() / 2.0f)));
    std::vector<float3> out;
    size_t j = 0;
    for (int k = 0; k <= m; ++k) {
        const float sl = acc.back() * k / m;
        while (j + 2 < fine.size() && acc[j + 1] < sl) ++j;
        const float f = (sl - acc[j]) / std::max(1e-6f, acc[j + 1] - acc[j]);
        out.push_back(lerp3(fine[j], fine[j + 1], std::clamp(f, 0.0f, 1.0f)));
    }
    out.front() = a.eye;
    out.back() = b.eye;
    return out;
}

}   // namespace

bool build(Scene& s, const std::string& assetDir, std::string& err) {
    try {
        s = Scene{};
        loadMaterials(s, assetDir);
        Hall h(s);
        auto stage = [&](const char* name, auto fn) {
            const size_t t0 = s.mesh.tris();
            const uint32_t c0 = s.mesh.charts;
            fn();
            std::printf("hall %-8s %9zu triangles %6u charts\n", name, s.mesh.tris() - t0, s.mesh.charts - c0);
        };
        stage("gallery", [&] { buildGallery(h); });
        stage("fans", [&] { buildFans(h); });
        stage("nave", [&] { buildNave(h); });
        stage("arch", [&] { buildArch(h); });
        stage("signs", [&] { buildSigns(h); });
        stage("props", [&] { buildProps(h, assetDir); });
        stage("stair", [&] { buildStair(h); });
        stage("outside", [&] { buildOutside(h); });
        for (const Dynamic& d : s.dyn) std::printf("hall dyn %-16s %7zu triangles\n", d.name.c_str(), d.mesh.tris());

        // the views: on the landing at eye height (1.65 m over the deck) looking down the gallery into the hall; at the
        // plaza, low (3 m, 35 m before the piers), the monument centred and filling the frame's height at 50 degrees:
        // the ceiling over the hoist bay at the top, the console's plates at the bottom, the gap under the gate over it
        s.fanlar = {make_float3(0, 4.65f, -1.6f), make_float3(0, 7.5f, -60.0f), 50.0f};   // back on the landing: the desks by its rail in frame
        s.rgb = {make_float3(0, 3.0f, -220.0f), make_float3(0, 13.9f, -256.0f), 50.0f};   // low: the monument towers
        s.path = journey(s.fanlar, s.rgb);

        // baked light in the air: the whole hall coarse; finer round the shaft's beam, the fans and the arch
        addVolume(s, "salon", make_float3(-kHallW - 0.5f, -0.5f, -294.0f), make_float3(kHallW + 0.5f, kHallH + 1.0f, 5.5f), 0.5f);
        addVolume(s, "kuyu", make_float3(-5.2f, 0.0f, -43.0f), make_float3(5.2f, 33.6f, -25.5f), 0.15f);   // 0.1 m was 6.1 M cells (~290 MB for 3 groups)
        addVolume(s, "fan_kasa", make_float3(-16.6f, 2.0f, -31.0f), make_float3(-4.0f, 15.2f, -17.0f), 0.2f);
        addVolume(s, "fan_gpu", make_float3(4.0f, 2.0f, -31.0f), make_float3(16.6f, 15.2f, -17.0f), 0.2f);
        // the monument: the chamber, the opening, the hoist bay and the air in front where its glow rises, up to the ceiling
        // (0.33 m: 2.1 M cells; 0.3 m was 2.9 M)
        addVolume(s, "kemer", make_float3(-21.0f, 0.0f, -294.0f), make_float3(21.0f, kHallH, -238.0f), 0.33f);
        // Phase 2 (the walk): the long stair's tunnel, the space behind the chamber (the passages are inside "kemer"),
        // the roof round the hatch (the hatch is a dinamik part: lit from the volumes). With them the window's limit of
        // eight volumes is reached
        addVolume(s, "merdiven", make_float3(-1.2f, up::kFloor - 0.2f, up::kTopTread - 0.6f), make_float3(1.2f, up::kRoof + 1.0f, up::kBackZ1 + 0.3f), 0.3f);
        addVolume(s, "arka", make_float3(-14.0f, up::kFloor - 0.2f, up::kBackZ1 - 0.3f), make_float3(14.0f, up::kCeil + 0.2f, up::kBackZ0 + 0.2f), 0.3f);
        addVolume(s, "cati", make_float3(-4.0f, up::kRoof - 0.2f, -350.5f), make_float3(9.0f, up::kRoof + 6.0f, up::kHatchZ0 + 2.5f), 0.3f);

        // finishing: displacement normals and tangents; the light map's chart coordinates (levha faces keep the metres
        // their builder put in uv2, their uv0 runs 0..1; models, whose materials follow the hall's own, keep their
        // xatlas charts)
        dz::finishMesh(s.mesh);
        for (dz::Vtx& v : s.mesh.v)
            if (v.mat < M_COUNT && !(s.mats[v.mat].flags & MF_LEVHA)) v.uv2 = v.uv;
        for (Dynamic& d : s.dyn) {
            dz::finishMesh(d.mesh);
            for (dz::Vtx& v : d.mesh.v) v.uv2 = make_float2(0, 0);
        }
        // sanity: no NaN, every triangle inside one chart
        for (const dz::Vtx& v : s.mesh.v)
            if (!std::isfinite(v.p.x + v.p.y + v.p.z + v.n.x + v.n.y + v.n.z + v.uv.x + v.uv.y + v.uv2.x + v.uv2.y))
                throw std::runtime_error("hall: a vertex is not finite");
        for (size_t k = 0; k + 2 < s.mesh.idx.size(); k += 3) {
            const uint32_t c = s.mesh.v[s.mesh.idx[k]].chart;
            if (s.mesh.v[s.mesh.idx[k + 1]].chart != c || s.mesh.v[s.mesh.idx[k + 2]].chart != c)
                throw std::runtime_error("hall: a triangle crosses light map charts");
        }
        size_t cells = 0;
        for (const Volume& v : s.vols) cells += size_t(v.dim[0]) * v.dim[1] * v.dim[2];
        std::printf("hall: %zu triangles, %u charts, %zu lights, %zu anchors, %zu path points, %zu volume cells\n",
                    s.mesh.tris(), s.mesh.charts, s.lights.size(), s.anchors.size(), s.path.size(), cells);
        return true;
    } catch (const std::exception& e) {
        err = e.what();
        return false;
    }
}

float texelFor(const Scene& s, float d) {
    (void)s;
    const float t = 0.0016f * d;
    return t < 0.01f ? 0.01f : t > 0.25f ? 0.25f : t;
}

}   // namespace salon
