// Placeholder for the oven (atlas.cpp, bake.cpp, pack.cpp replace this file).
#include "bake.h"

namespace salon {

Atlas buildAtlas(Scene& s, const BakeOptions& o, std::vector<int>& chartPage) {
    (void)s;
    (void)o;
    chartPage.clear();
    return Atlas{};
}

bool bake(const Scene&, const Atlas&, const std::vector<int>&, const BakeOptions&, Baked&, std::string& err,
          const std::function<void(float, const std::string&)>&) {
    err = "the oven is not built yet";
    return false;
}

bool writePack(const std::string&, const Scene&, const Atlas&, const std::vector<int>&, const Baked*, const BakeOptions&,
               std::string& err) {
    err = "the pack writer is not built yet";
    return false;
}

bool buildTest(Scene&, std::string& err) {
    err = "the test room is not built yet";
    return false;
}

uint16_t toHalf(float) { return 0; }
float fromHalf(uint16_t) { return 0.0f; }

}   // namespace salon
