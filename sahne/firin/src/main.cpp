// salon.exe: builds the hall and bakes its light into the window's data pack (docs/SALON.md).
//   salon.exe dump [--out DIR]                  the scene as plain binaries + JSON (scene/dump.h), for the preview
//   salon.exe geo  [--out DIR]                  the scene and atlas only, no light (fast; for checking geometry)
//   salon.exe bake [--out DIR] [--samples N] [--vol-samples N] [--texel-scale X] [--bounces N] [--clamp X]
//                  [--atlas-width N] [--filter 0|1] [--compress 0|1]
//   --test 1: the oven's small test room instead of the hall (scene/test_scene.cpp); its defaults: --texel-scale 5,
//             --atlas-width 1024, --vol-samples = --samples
// DIR defaults to sahne/paket. Assets are read from sahne/varlik (sahne/varlik.py fetches them).
#include "bake.h"
#include "scene.h"
#include "scene/dump.h"
#include "atlas.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <string>

#ifndef SALON_ROOT
#define SALON_ROOT "."
#endif
#ifndef SALON_THIRD_PARTY
#define SALON_THIRD_PARTY "C:/dev/pc_graphics/third_party"
#endif

int main(int argc, char** argv) {
    try {
        if (argc < 2 || (std::strcmp(argv[1], "geo") && std::strcmp(argv[1], "bake") && std::strcmp(argv[1], "dump")) || (argc - 2) % 2) {
            std::fprintf(stderr, "usage: salon.exe dump|geo|bake [--out DIR] [--samples N] [--vol-samples N] [--texel-scale X] "
                                 "[--bounces N] [--clamp X] [--atlas-width N] [--filter 0|1] [--compress 0|1] [--test 1]\n");
            return 2;
        }
        const bool doBake = !std::strcmp(argv[1], "bake");
        const std::string root = SALON_ROOT;   // sahne/firin
        std::string out = root + "/../paket";
        salon::BakeOptions o;
        o.root = root;
        o.thirdParty = SALON_THIRD_PARTY;
        bool test = false, scaleSet = false, widthSet = false, volSet = false;
        for (int i = 2; i + 1 < argc; i += 2) {
            const std::string k = argv[i], v = argv[i + 1];
            if (k == "--out") out = v;
            else if (k == "--samples") o.samples = std::atoi(v.c_str());
            else if (k == "--vol-samples") { o.volSamples = std::atoi(v.c_str()); volSet = true; }
            else if (k == "--texel-scale") { o.texelScale = float(std::atof(v.c_str())); scaleSet = true; }
            else if (k == "--atlas-width") { o.atlasWidth = std::atoi(v.c_str()); widthSet = true; }
            else if (k == "--bounces") o.bounces = std::atoi(v.c_str());
            else if (k == "--clamp") o.clamp = float(std::atof(v.c_str()));
            else if (k == "--filter") o.filter = std::atoi(v.c_str()) != 0;
            else if (k == "--compress") o.compress = std::atoi(v.c_str()) != 0;
            else if (k == "--test") test = std::atoi(v.c_str()) != 0;
            else { std::fprintf(stderr, "unknown option %s\n", k.c_str()); return 2; }
        }
        if (test) {   // the test room bakes in seconds at its own defaults
            if (!scaleSet) o.texelScale = 5.0f;
            if (!widthSet) o.atlasWidth = 1024;
            if (!volSet) o.volSamples = o.samples;
        }
        salon::Scene s;
        std::string err;
        if (!(test ? salon::buildTest(s, err) : salon::build(s, root + "/../varlik", err))) {
            std::fprintf(stderr, "scene: %s\n", err.c_str());
            return 1;
        }
        std::printf("scene: %zu vertices, %zu triangles, %zu materials, %zu rotors, %zu lights, %zu volumes, %zu anchors\n",
                    s.mesh.v.size(), s.mesh.tris(), s.mats.size(), s.dyn.size(), s.lights.size(), s.vols.size(), s.anchors.size());
        if (!std::strcmp(argv[1], "dump")) {
            if (!salon::dumpScene(s, out, err)) {
                std::fprintf(stderr, "dump: %s\n", err.c_str());
                return 1;
            }
            std::printf("dump: %s\n", out.c_str());
            return 0;
        }
        std::vector<int> chartPage;
        const salon::Atlas a = salon::buildAtlas(s, o, chartPage);
        size_t rect = 0;
        for (const auto& c : a.charts) rect += size_t(c.w) * c.h;
        std::printf("atlas: %zu charts on %d pages of %dx%d (%.0f%% of the pages in chart rectangles)\n", a.charts.size(), a.pages,
                    a.width, a.height, a.pages ? 100.0 * rect / (double(a.width) * a.height * a.pages) : 0.0);
        if (!doBake) {   // geo: the texels a bake would light, by density zone (the hall's own, then each Scene::zones entry)
            std::vector<int> zoneOf(a.charts.size(), -1);
            for (size_t z = 0; z < s.zones.size(); ++z)
                for (uint32_t c = s.zones[z].first; c < s.zones[z].end && c < a.charts.size(); ++c) zoneOf[c] = int(z);
            std::vector<size_t> per(s.zones.size() + 1, 0);
            size_t all = 0;
            for (int page = 0; page < a.pages; ++page) {
                const salon::Raster r = salon::rasterise(s, a, chartPage, page);
                for (const salon::Texel& t : r.texels) ++per[size_t(zoneOf[t.chart] + 1)];
                all += r.texels.size();
            }
            size_t cells = 0;
            for (const salon::Volume& v : s.vols) cells += size_t(v.dim[0]) * v.dim[1] * v.dim[2];
            std::printf("geo: %.2f M texels to bake (hall %.2f M", all * 1e-6, per[0] * 1e-6);
            for (size_t z = 0; z < s.zones.size(); ++z) std::printf(", zone %zu %.3f M", z, per[z + 1] * 1e-6);
            std::printf("), %.2f M volume cells\n", cells * 1e-6);
        }
        salon::Baked baked;
        if (doBake) {
            if (!salon::bake(s, a, chartPage, o, baked, err, [](float f, const std::string& line) {
                    std::printf("\r%5.1f%% %-70s", f * 100.0f, line.c_str());
                    std::fflush(stdout);
                })) {
                std::fprintf(stderr, "\nbake: %s\n", err.c_str());
                return 1;
            }
            std::printf("baked in %.1f s\n", baked.seconds);
        }
        if (!salon::writePack(out, s, a, chartPage, doBake ? &baked : nullptr, o, err)) {
            std::fprintf(stderr, "pack: %s\n", err.c_str());
            return 1;
        }
        std::printf("pack: %s\n", out.c_str());
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "salon: %s\n", e.what());
        return 1;
    }
}
