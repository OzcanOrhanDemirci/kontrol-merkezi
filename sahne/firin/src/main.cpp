// salon.exe: builds the hall and bakes its light into the window's data pack (docs/SALON.md).
//   salon.exe dump [--out DIR]                  the scene as plain binaries + JSON (scene/dump.h), for the preview
//   salon.exe geo  [--out DIR]                  the scene and atlas only, no light (fast; for checking geometry)
//   salon.exe bake [--out DIR] [--samples N] [--vol-samples N] [--texel-scale X] [--bounces N]
//   --test 1: the oven's small test room instead of the hall (scene/test_scene.cpp)
// DIR defaults to sahne/paket. Assets are read from sahne/varlik (sahne/varlik.py fetches them).
#include "bake.h"
#include "scene.h"
#include "scene/dump.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#ifndef SALON_ROOT
#define SALON_ROOT "."
#endif
#ifndef SALON_THIRD_PARTY
#define SALON_THIRD_PARTY "C:/dev/pc_graphics/third_party"
#endif

int main(int argc, char** argv) {
    if (argc < 2 || (std::strcmp(argv[1], "geo") && std::strcmp(argv[1], "bake") && std::strcmp(argv[1], "dump"))) {
        std::fprintf(stderr, "usage: salon.exe dump|geo|bake [--out DIR] [--samples N] [--vol-samples N] [--texel-scale X] [--bounces N]\n");
        return 2;
    }
    const bool doBake = !std::strcmp(argv[1], "bake");
    const std::string root = SALON_ROOT;   // sahne/firin
    std::string out = root + "/../paket";
    salon::BakeOptions o;
    bool test = false;
    o.root = root;
    o.thirdParty = SALON_THIRD_PARTY;
    for (int i = 2; i + 1 < argc; i += 2) {
        const std::string k = argv[i], v = argv[i + 1];
        if (k == "--out") out = v;
        else if (k == "--samples") o.samples = std::atoi(v.c_str());
        else if (k == "--vol-samples") o.volSamples = std::atoi(v.c_str());
        else if (k == "--texel-scale") o.texelScale = float(std::atof(v.c_str()));
        else if (k == "--bounces") o.bounces = std::atoi(v.c_str());
        else if (k == "--test") test = std::atoi(v.c_str()) != 0;
        else { std::fprintf(stderr, "unknown option %s\n", k.c_str()); return 2; }
    }
    salon::Scene s;
    std::string err;
    if (!(test ? salon::buildTest(s, err) : salon::build(s, root + "/../varlik", err))) { std::fprintf(stderr, "scene: %s\n", err.c_str()); return 1; }
    std::printf("scene: %zu vertices, %zu triangles, %zu materials, %zu rotors, %zu lights, %zu anchors\n", s.mesh.v.size(),
                s.mesh.tris(), s.mats.size(), s.dyn.size(), s.lights.size(), s.anchors.size());
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
    std::printf("atlas: %d pages of %dx%d, %zu texels used\n", a.pages, a.width, a.height, a.usedTexels);
    salon::Baked baked;
    if (doBake) {
        if (!salon::bake(s, a, chartPage, o, baked, err, [](float f, const std::string& line) {
                std::printf("\r%5.1f%% %s        ", f * 100.0f, line.c_str());
                std::fflush(stdout);
            })) {
            std::fprintf(stderr, "\nbake: %s\n", err.c_str());
            return 1;
        }
        std::printf("\nbaked in %.1f s\n", baked.seconds);
    }
    if (!salon::writePack(out, s, a, chartPage, doBake ? &baked : nullptr, o, err)) {
        std::fprintf(stderr, "pack: %s\n", err.c_str());
        return 1;
    }
    std::printf("pack: %s\n", out.c_str());
    return 0;
}
