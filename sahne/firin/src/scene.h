// The hall's description: everything the oven needs to light it and the window needs to draw it.
// Built in code (scene_*.cpp) at real measures, metres, right-handed, x right, y up, the hall along -z (docs/SALON.md).
#pragma once
#include "kit/geom.h"

#include <cstdint>
#include <string>
#include <vector>

namespace salon {

using dz::Mesh;

// light groups (docs/SALON.md, "Light groups")
enum Group : int { GROUP_KUYU = 0, GROUP_KEMER = 1, GROUP_LAMBA = 2, GROUP_COUNT = 3 };

enum MatFlag : uint32_t {
    MF_EMISSIVE = 1u << 0,    // glows with its group's colour; the oven ends paths on it
    MF_NO_OCCLUDE = 1u << 1,  // not in the oven's ray structure (stencil paint, decals), its texels still baked
    MF_WET = 1u << 2,         // the floor: planar reflection, puddles
    MF_LEVHA = 1u << 3,       // carries a live-drawn texture (signs, boards, displays); uv0 runs 0..1 over the face
    MF_METAL = 1u << 4,       // metallic (specular tinted, no diffuse)
    MF_TWO_SIDED = 1u << 5,   // drawn from both sides (glTF doubleSided): no culling. The oven: a back face is inside a part
};

struct Material {
    std::string name;          // e.g. "beton_kolon"
    // Poly Haven texture files relative to sahne/varlik/ (empty: constant from tint/rough/metal)
    std::string albedo, normal, arm;
    std::string emission;      // models: the glTF emissive texture (sRGB), drawn × emitScale × the group's colour
    float uvScale = 1.0f;      // metres per texture repeat (procedural geometry stores uv0 in metres); models: 1
    float3 tint{1, 1, 1};      // multiplies the albedo (linear)
    float rough = -1.0f;       // -1: from the ARM texture
    float metal = -1.0f;       // -1: from the ARM texture
    uint32_t flags = 0;        // MatFlag
    int group = -1;            // emissive: its light group
    float emitScale = 0.0f;    // emissive radiance (white, the group's units)
    float3 meanAlbedo{0.5f, 0.5f, 0.5f};   // what light bounces with in the oven (filled from the texture by the asset step)
};

// an emitter the oven samples directly (next-event estimation). Radiance L (white) in the scene's units.
struct Emitter {
    enum Type : int { RECT = 0, SPHERE = 1, DISC = 2 } type = RECT;
    int group = GROUP_KUYU;
    float3 c{0, 0, 0};         // centre
    float3 u{1, 0, 0}, v{0, 0, 1};   // RECT: half axes; DISC: u = radius vector, v unused
    float3 n{0, -1, 0};        // RECT, DISC: the emitting side's normal
    float r = 0.0f;            // SPHERE radius
    float L = 1.0f;            // radiance (RECT, DISC: along n)
    // RECT, DISC: the intensity falls as cos^lobe about n, i.e. radiance L·cos^(lobe-1) (1: Lambertian, constant
    // radiance; higher: a more collimated shaft; values below 1 are taken as 1)
    float lobe = 1.0f;
};

// a moving part (a fan's rotor): its mesh in its own frame (axis +x, centred), placed live
struct Dynamic {
    std::string name;          // "fan_kasa_rotor", "fan_gpu_rotor"
    Mesh mesh;                 // own frame
    float3 centre{0, 0, 0}, axis{1, 0, 0};
    float radius = 1.0f;
    int blades = 7;
    float bakeTransmit = 0.6f; // in the oven the rotor is a disc letting this share of light through (the spinning average)
};

// a grid of baked light in the air
struct Volume {
    std::string name;          // "salon", "kuyu", "fan_kasa", "fan_gpu", "kemer"
    float3 lo{0, 0, 0};
    float cell = 0.5f;
    int dim[3] = {0, 0, 0};
};

// an oriented box: centre and three half axes
struct Box {
    float3 c{0, 0, 0}, x{1, 0, 0}, y{0, 1, 0}, z{0, 0, 1};
};

// something the window has to find (docs/SALON.md, "Interaction")
struct Anchor {
    std::string name;          // "fan_kasa", "pano_gpu", "tabela_rgb", "kilit_tasi_ekran", "anahtar_rgb", ...
    std::string type;          // "tik" (clickable), "levha" (a face with a live texture), "nokta" (a point)
    Box box;
    std::string atlas;         // levha: which drawn texture goes on it
    float size[2] = {0, 0};    // levha: the face's width and height (m)
    int material = -1;         // levha: the material of the face it is drawn on
};

struct View {
    float3 eye{0, 0, 0}, target{0, 0, -1};
    float fov = 50.0f;         // vertical, degrees
};

struct Scene {
    Mesh mesh;                 // the static mesh (Vtx.mat = index into mats; Vtx.chart = light map chart)
    std::vector<Material> mats;
    std::vector<Dynamic> dyn;
    std::vector<Emitter> lights;
    std::vector<Volume> vols;
    std::vector<Anchor> anchors;
    View fanlar, rgb;
    std::vector<float3> path;  // the journey's centre line from fanlar's eye to rgb's eye
    float sigma = 0.012f;      // the medium's extinction (1/m), homogeneous in the oven
    float g = 0.35f;           // its forward scattering (Henyey-Greenstein g), live
};

// Builds the hall. assetDir: sahne/varlik (Poly Haven textures and models, fetched by sahne/varlik.py)
bool build(Scene& s, const std::string& assetDir, std::string& err);

// the oven's small test room (a concrete box, a column, a ceiling opening with a shaft emitter, a rotor, a volume)
bool buildTest(Scene& s, std::string& err);

// the light map's density for a chart: metres per texel, from the chart's distance to the camera's journey
float texelFor(const Scene& s, float distanceToPath);

}   // namespace salon
