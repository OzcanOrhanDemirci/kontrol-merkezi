// The hall's own building blocks (docs/SALON.md): the material ids, the emitters' radiance table, and the helpers every
// part of the hall is made with (formwork faces with seams and tie holes, lofted concrete outlines, railings, chains,
// caged lamps, plates with live textures, anchors). Built on the geometry kit (kit/geom.h): every edge is rounded.
//
// Conventions the parts follow:
//   - metres, x right (facing the arch), y up, the hall along -z; the floor at y = 0
//   - a grid's winding faces its normal (counter-clockwise seen from the side the normal points to)
//   - uv0 of procedural surfaces is in metres; a levha face's uv0 runs 0..1 over the face (u left to right, v top to
//     bottom, as a canvas is drawn) and its uv2 keeps the metres; every other vertex gets uv2 = uv0 when the hall is
//     finished (the atlas reads uv2 as chart-local metres)
#pragma once
#include "scene.h"
#include "kit/parts.h"

#include <string>
#include <vector>

namespace salon::hall {

using dz::Kit;
using dz::Mesh;
using dz::Xform;

constexpr float kPi = 3.14159265358979f;

// the hall's walls (|x|) and ceiling (y): widened and raised 11-16 for grandeur (was 30 and 26)
constexpr float kHallW = 45.0f, kHallH = 32.0f;

// ---- the emitters' radiance (white, in each group's own units; the window scales every group live). Tune here.
// One value per emissive material, so a surface seen directly glows exactly as bright as the emitter that lights.
constexpr float kKuyuL = 1.0f;       // group 0: the shaft's daylight at the well's top
constexpr float kKuyuLobe = 8000.0f; //   its collimation (cos^lobe about the slanted normal): half intensity at ~0.75 deg,
                                     //   so the grate's bars (0.89 m) stay crisp beams down to the floor 21 m below
// the emitter's radiance so its total light equals a lobe-6 emitter of radiance kKuyuL (the intensity integral is 2pi/(lobe+1))
constexpr float kKuyuEmitL = kKuyuL * (kKuyuLobe + 1.0f) / 7.0f;
// the diffuse sky through the same opening (lobe 2): twice the beam's flux, kKuyuL * 2 * (2 + 1) / 7
constexpr float kKuyuSkyL = kKuyuL * 6.0f / 7.0f;
constexpr float kKuyuTilt = 10.0f;   //   the beam's slant towards -z (degrees)
constexpr float kKemerL = 2.0f;      // group 1: kemer_isik, the glass of the piers' wash slots
constexpr float kPierWashL = 70.0f;  // group 1: each pier-wash slot's radiance (lobe 10, 0.9 x 0.36 m): a tenth of the old floods
constexpr float kCekirdekL = 8.0f;   // group 1: the heat core's heart behind the gate (cekirdek_isik and its 20 RECT
                                     //   emitters: the column's four faces 4 x 18.4 m, the fins' sides): the monument's
                                     //   one light, ~580 m2 (was 188): its power comes from area, the radiance stays
constexpr float kFanFloodL = 300.0f;  // group 2: each fan floodlight (a 0.5 x 0.36 m glass, lobe 10)
constexpr float kColUpL = 330.0f;    // group 2: each column uplight (a 0.5 x 0.3 m glass, lobe 14), dimmer than the fans'
constexpr float kSignLampL = 60.0f;  // group 2: a hanging sign's light strip (0.05 x 4 m, lobe 4) onto its face
constexpr float kDeskLampL = 25.0f;  // group 2: the fan desks' small hooded lamps over the levers (a 5.5 cm disc, lobe 6)
constexpr float kLambaL = 8.0f;      // group 2: the caged service lamps' bulbs and the lit door frame
constexpr float kBulbBoard = 0.085f; //   bulb radius by the fans' stencils, the console, the doors (m)
constexpr float kBulbHall = 0.055f;  //   bulb radius of the sparse row along the hall's walls: dimmer by the area
// Phase 2, all group 0 (kuyu): the facility's own light circuit, always in the temperature colour (group 1 is the
// arch's and falls to an ember with RGB off; group 2 is fixed warm white). The fake daylight's circuit lights the way up
constexpr float kMerdivenL = 12.0f;  // group 0: each stair lamp's lens (a 6 cm disc, Lambertian): dim pools on the treads
constexpr float kCatiL = 0.06f;      // group 0: the roof lamp's roof-side glow under its louvres (6 % of the daylight)
constexpr float kFenerL = 60.0f;     // group 0: the mast lamp's globe (r 0.1 m): a point seen far through the fog

// ---- materials: the fixed names, in id order (Vtx.mat indexes Scene::mats)
enum MatId : int {
    M_ZEMIN,         // beton_zemin: the wet floor
    M_DUVAR,         // beton_duvar: walls
    M_KOLON,         // beton_kolon: columns, pilasters
    M_TAVAN,         // beton_tavan: ceiling and beams
    M_ANIT,          // beton_anit: the arch, its plinth
    M_KASA,          // celik_boyali_kasa: the CPU + case fan's paint
    M_GPU,           // celik_boyali_gpu: the GPU fan's paint
    M_KANAT,         // celik_kanat: rotor blades and hubs
    M_PASLI,         // celik_pasli: rusty steel (grates, chains, rails, brackets)
    M_SAC,           // celik_sac: tread plate, sheet steel
    M_KOYU,          // metal_koyu: dark iron (motors, frames, housings)
    M_KABLO,         // kablo: rubber, cable jackets, grips
    M_CAM_LAMBA,     // cam_lamba: lamp bulbs (emissive, group 2)
    M_KEMER_ISIK,    // kemer_isik: the arch's light (emissive, group 1)
    M_KUYU_ISIK,     // kuyu_isik: the shaft's light (emissive, group 0)
    M_BOYA,          // boya: stencil paint (levha, no occlusion)
    M_PANO,          // pano_yuz: the fan desks' panels (levha)
    M_EKRAN,         // ekran_yuz: displays, exit signs (levha)
    M_TABELA,        // tabela_yuz: hanging signs, plates (levha)
    M_MERCEK,        // mercek: lamp lenses (levha)
    M_CEKIRDEK_ISIK, // cekirdek_isik: the heat core's heart (emissive, group 1)
    M_MERDIVEN_ISIK, // merdiven_isik: the long stair's small lamps (emissive, group 0)
    // the exterior (Phase 2): every triangle the window instances as one facility in the void, and only those, has one
    // of these. They are the hall's own sets under their own names (same textures, own draw ranges): dis_zemin is
    // beton_zemin's set without the wet flag (the roof is not the reflection pass' y = 0 plane)
    M_DIS_ZEMIN,     // dis_zemin: the roof deck
    M_DIS_DUVAR,     // dis_duvar: the block's outer walls and underside
    M_DIS_KOLON,     // dis_kolon: the columns it stands on
    M_DIS_KOYU,      // dis_koyu: steel outside (the hatch, its curb, the roof lamp's louvres and frame, the mast)
    M_DIS_ISIK,      // dis_isik: the roof lamp's faint roof-side glow (emissive, group 0)
    M_DIS_FENER,     // dis_fener: the mast lamp, the one steady lamp each facility shows (emissive, group 0)
    M_COUNT
};
constexpr int M_DIS_FIRST = M_DIS_ZEMIN, M_DIS_END = M_DIS_FENER + 1;   // the exterior's materials: [first, end)
extern const char* const kMatNames[M_COUNT];

// fills s.mats from sahne/varlik/varlik.json (the asset step's manifest); constants where an entry is missing
void loadMaterials(Scene& s, const std::string& assetDir);

// ---- formwork: the panel layout of a cast concrete face. Seams (shallow rounded grooves) run where the panels meet:
// at ou + k * pu across u and ov + k * pv across v (in the face's own coordinates, so pieces of one wall split round
// an opening keep one layout); a pitch of 0 means no seams that way. Tie holes: tiesU x tiesV per panel (the face
// must then be whole panels from its lower corner).
struct Formwork {
    float pu = 1.2f, pv = 2.4f;
    float ou = 0.0f, ov = 0.0f;
    int tiesU = 0, tiesV = 0;
    float depth = 0.012f;           // seam groove depth (m)
    float halfWidth = 0.012f;       // seam groove half width (m)
};

// the builder: a kit over the static mesh plus the scene it fills
struct Hall {
    Scene& s;
    Kit k;
    explicit Hall(Scene& sc) : s(sc), k(sc.mesh) {}

    // the kit placed at t with material mat and the base mesh's longest edge
    Kit& at(const Xform& t, int mat, float maxEdge);

    // a rounded box centred at t's origin, half sizes h along t's axes, edge radius e
    void box(const Xform& t, float3 h, float e, int mat, float maxEdge = 2.0f);
    void box(float3 c, float3 h, float e, int mat, float maxEdge = 2.0f) { box(Xform::at(c), h, e, mat, maxEdge); }
    // a round bar from a to b, radius r, ends rounded (closed)
    void rod(float3 a, float3 b, float r, int mat, float maxEdge = 0.5f);
    // an open tube from a to b (its ends hidden in something)
    void tube(float3 a, float3 b, float r, int mat, float maxEdge = 0.5f);
    // a flat rectangle w x h in t's xy plane facing +z (one chart)
    void quad(const Xform& t, float w, float h, int mat, float maxEdge = 4.0f);
    // a hex nut / bolt head on t's xy plane standing along +z, across flats sf
    void nut(const Xform& t, float sf, int mat);
    // a flat four-cornered patch a, b, c, d (a-b one edge, c-d the opposite one, a-c a side) facing n; one chart
    void patch(float3 a, float3 b, float3 c, float3 d, float3 n, int mat, float maxEdge = 4.0f);
    // a light bar: an octagonal (chamfered) section w x h from a to b, `up` the h direction; cheap (32 triangles)
    void bar(float3 a, float3 b, float w, float h, float3 up, int mat);
    // a rolled I-beam from a to b: depth d, flange width bf, web tw, flange tf; `up` the web's direction
    void ibeam(float3 a, float3 b, float d, float bf, float tw, float tf, float3 up, int mat);

    // the face between a square (half size hs) and a round hole of radius r in t's xy plane, facing +z
    void squareRing(const Xform& t, float hs, float r, int mat);
    // the face between an arch (a half circle of radius r on the x axis, springing at y = 0) and a rectangle
    // x in [-hw, hw], y in [0, top] in t's xy plane, facing +z (front = true) or -z
    void archFrame(const Xform& t, float r, float hw, float top, bool front, int mat);

    // a cast concrete face: the rectangle [u0,u1] x [v0,v1] of t's xy plane facing +z, with formwork seams and tie
    // holes (small cone recesses) per f; one chart, uv0 = (u, v) in metres
    void formworkFace(const Xform& t, float u0, float u1, float v0, float v1, const Formwork& f, int mat,
                      float maxEdge = 3.0f);

    // a rounded rectangle loft along y: rows of (y, outward offset) over a base outline of half sizes (hx, hz) and
    // corner radius rc in the xz plane, centred at c. Normals from the profile (a crease needs two points close
    // together). skipSide >= 0 leaves one flat side out (0: +x, 1: -z, 2: -x, 3: +z), as an open loft
    void loft(float3 c, float hx, float hz, float rc, const std::vector<float2>& profile, int mat, int skipSide = -1,
              float maxEdge = 3.0f);

    // a railing along a polyline of deck points (y = the deck): posts at most `pitch` apart, a top rail at 1.1 m and
    // a knee rail at 0.55 m with rounded corners, a toe plate. closedStart/End: the rail ends in a wall (no return)
    void railing(const std::vector<float3>& pts, float pitch, int mat, bool toePlate = true);

    // a chain from a to b of links of the given outer length (m) and wire radius; one chart for the whole chain
    void chain(float3 a, float3 b, float linkLength, float wire, int mat);

    // a caged service lamp on a wall: base plate at p on the wall with outward normal n, the bulb ~0.3 m out;
    // a sphere emitter (group 2) at the bulb. Returns the bulb's centre
    float3 cagedLamp(float3 p, float3 n, float bulbR);

    // a levha face: a w x h rectangle at c facing n (up = world up projected), 'lift' off its backing; uv0 0..1,
    // uv2 metres. Adds the anchor (type levha) named `name` with the atlas `atlas`. Returns the face's frame
    Xform levha(const std::string& name, const std::string& atlas, float3 c, float3 n, float w, float h, int mat,
                float3 up = make_float3(0, 1, 0));

    // anchors
    void anchor(const std::string& name, const std::string& type, const Xform& t, float3 half);
    void anchorBox(const std::string& name, const std::string& type, float3 lo, float3 hi);

    // light map charts: vertices from firstVertex on belong to charts from firstChart on.
    // relabel: one chart (their uv already lie apart, e.g. a face's planar coordinates)
    void oneChart(size_t firstVertex, uint32_t firstChart);
    // pack: every piece's uv box shelved apart by gap (uv0 moves with it: procedural metres, the texture just shifts)
    void packCharts(size_t firstVertex, uint32_t firstChart, float gap = 0.06f);
    size_t vmark() const { return s.mesh.v.size(); }
    uint32_t cmark() const { return s.mesh.charts; }
};

// a frame at o whose z axis is n and whose y is as near world up as can be (x = y × z: right when n faces you)
Xform facing(float3 o, float3 n, float3 up = make_float3(0, 1, 0));
// a frame from explicit axes
Xform axes(float3 o, float3 x, float3 y, float3 z);
inline float3 v3(float x, float y, float z) { return make_float3(x, y, z); }

// the parts of the hall (scene/hall_*.cpp)
void buildGallery(Hall& h);   // entrance gallery: walls, tunnel mouth, landing, stair, shaft, portal
void buildFans(Hall& h);      // the two wall fans, their rotors, boards, levers
void buildNave(Hall& h);      // the hall: floor, drains, columns, ceiling, walls, catwalk, pipes, lamps
void buildArch(Hall& h);      // the monument: plinth, arch, light chamber, keystone display, stops, console
void buildSigns(Hall& h);     // hanging signs and exit signs
void buildStair(Hall& h);     // Phase 2: the chamber's hidden passages, the space behind it, the long stair, the hatch
void buildOutside(Hall& h);   // Phase 2: the raised block, its roof deck and lamps, the columns into the fog

// ---- Phase 2: the way up (docs/SALON.md "The way up"). Shared by hall_arch.cpp (the doors in the chamber's side
// walls) and hall_stair.cpp / hall_outside.cpp
namespace up {
constexpr float kFloor = 1.2f;                // the chamber's floor (the arch's sill), the passages', the stair's foot
constexpr float kDoorZ0 = -280.0f, kDoorZ1 = -279.0f;   // the side doors, between the third and fourth portal
constexpr float kDoorTop = kFloor + 2.1f;
constexpr float kChamberHW = 12.0f;           // the chamber's side walls (|x|)
constexpr float kPassIn = 12.6f, kPassOut = 13.6f;      // a passage between |x| 12.6 and 13.6 (1 m wide)
constexpr float kPassZ0 = -278.8f;            // its closed end (towards the hall)
constexpr float kBackZ0 = -293.6f, kBackZ1 = -295.2f;   // the space behind the chamber (its back wall is z = -293)
constexpr float kCeil = 3.6f;                 // passages and back space: 2.4 m clear
constexpr float kStairHW = 0.8f;              // the stair's half width (1.6 m clear)
constexpr int kRisers = 182;                  // from the floor to the roof deck: 182 risers of 0.1857 m, goings 0.28 m
constexpr float kRoof = 35.0f;                // the roof deck (the hall's ceiling 32, its slab 3 m)
constexpr float kRise = (kRoof - kFloor) / kRisers, kGoing = 0.28f;
constexpr float kStairZ0 = kBackZ1;           // the first riser's face
constexpr float kStairTop = kStairZ0 - (kRisers - 1) * kGoing;   // the last riser's face (the top tread at deck level)
constexpr float kTopTread = kStairTop - kGoing;                  // the top tread's end: the hatch's far side
constexpr float kHead = kCeil - kFloor;       // the tunnel's ceiling over the pitch line: 2.4 m over the foot
constexpr float kSlab = 0.6f;                 // the roof slab over the stair
// the hatch's opening: from where the tunnel's ceiling meets the slab's underside to the top tread's end
constexpr float kHatchZ0 = kStairZ0 - (kRoof - kSlab - kCeil) / kRise * kGoing;
constexpr float kHatchZ1 = kTopTread;
constexpr float kCurb = 0.25f, kCurbT = 0.2f; // its curb's height over the deck and thickness
constexpr float kBlockHW = 48.0f, kBlockZ0 = 8.0f, kBlockZ1 = -350.0f, kBlockY0 = -4.0f;   // the raised block
}   // namespace up

}   // namespace salon::hall
