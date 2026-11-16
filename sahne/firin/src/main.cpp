// salon.exe: builds the hall and bakes its light into the window's data pack (docs/SALON.md).
//   salon.exe geo  [--out DIR]                  the scene and atlas only, no light (fast; for checking geometry)
//   salon.exe bake [--out DIR] [--samples N] [--vol-samples N] [--texel-scale X] [--bounces N] [--clamp X]
//                  [--atlas-width N] [--filter 0|1] [--compress 0|1]
//   --test 1: the oven's small test room instead of the hall (scene/test_scene.cpp); its defaults: --texel-scale 5,
//             --atlas-width 1024, --vol-samples = --samples
// DIR defaults to sahne/paket. Assets are read from sahne/varlik (sahne/varlik.py fetches them).
#include "bake.h"
#include "scene.h"

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
        if (argc < 2 || (std::strcmp(argv[1], "geo") && std::strcmp(argv[1], "bake")) || (argc - 2) % 2) {
            std::fprintf(stderr, "usage: salon.exe geo|bake [--out DIR] [--samples N] [--vol-samples N] [--texel-scale X] "
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
        std::vector<int> chartPage;
        const salon::Atlas a = salon::buildAtlas(s, o, chartPage);
        size_t rect = 0;
        for (const auto& c : a.charts) rect += size_t(c.w) * c.h;
        std::printf("atlas: %zu charts on %d pages of %dx%d (%.0f%% of the pages in chart rectangles)\n", a.charts.size(), a.pages,
                    a.width, a.height, a.pages ? 100.0 * rect / (double(a.width) * a.height * a.pages) : 0.0);
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
