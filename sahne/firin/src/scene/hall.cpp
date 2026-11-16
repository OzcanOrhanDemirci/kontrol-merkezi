// The hall (docs/SALON.md). Placeholder until the scene builder lands.
#include "scene.h"

namespace salon {

bool build(Scene& s, const std::string& assetDir, std::string& err) {
    (void)s;
    (void)assetDir;
    err = "the hall is not built yet (scene/hall.cpp is a placeholder)";
    return false;
}

float texelFor(const Scene& s, float d) {
    (void)s;
    const float t = 0.0016f * d;
    return t < 0.01f ? 0.01f : t > 0.25f ? 0.25f : t;
}

}   // namespace salon
