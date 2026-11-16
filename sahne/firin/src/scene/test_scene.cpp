// The oven's test room (salon.exe ... --test 1): a concrete box 20 x 12 x 30 m with everything the hall asks of the
// oven, small enough to bake in seconds: a column, a ceiling opening with a short well and a steel grate under a
// collimated emitter (group 0, the shaft), an emissive panel on the far wall (group 1), a small sphere lamp (group 2),
// a rotor in a wall recess, a red wall and a green block (colour bleeding), a glTF model, two volumes, a journey.
// Room interior: x [-10, 10], y [0, 12], z [-30, 0].
#include "model.h"
#include "scene.h"

#include <filesystem>

namespace salon {

bool buildTest(Scene& s, std::string& err) {
    auto material = [&](const char* name, float3 albedo) {
        Material m;
        m.name = name;
        m.tint = m.meanAlbedo = albedo;
        m.rough = 0.8f;
        m.metal = 0.0f;
        s.mats.push_back(m);
        return uint32_t(s.mats.size() - 1);
    };
    const uint32_t concrete = material("test_beton", make_float3(0.48f, 0.46f, 0.43f));
    const uint32_t red = material("test_kirmizi", make_float3(0.60f, 0.045f, 0.025f));
    const uint32_t steel = material("test_celik", make_float3(0.12f, 0.13f, 0.14f));
    const uint32_t green = material("test_yesil", make_float3(0.06f, 0.42f, 0.12f));
    const uint32_t panel = material("test_panel", make_float3(0.8f, 0.8f, 0.8f));
    s.mats[panel].flags = MF_EMISSIVE;
    s.mats[panel].group = GROUP_KEMER;
    s.mats[panel].emitScale = 5.0f;
    const uint32_t bulb = material("test_lamba", make_float3(0.8f, 0.8f, 0.8f));
    s.mats[bulb].flags = MF_EMISSIVE;
    s.mats[bulb].group = GROUP_LAMBA;
    s.mats[bulb].emitScale = 200.0f;

    dz::Kit kit(s.mesh);
    kit.maxEdge = 2.0f;
    auto box = [&](float3 c, float3 h, uint32_t mat) {
        kit.mat = mat;
        kit.t = dz::Xform::at(c);
        kit.roundedBox(h, 0.025f);
    };
    // the shell: floor, near and far walls, the red right wall (walls 0.6 m thick: the volumes' inside test needs solids)
    box(make_float3(0, -0.3f, -15), make_float3(10.6f, 0.3f, 15.6f), concrete);
    box(make_float3(0, 6, 0.3f), make_float3(10.6f, 6, 0.3f), concrete);
    box(make_float3(0, 6, -30.3f), make_float3(10.6f, 6, 0.3f), concrete);
    box(make_float3(10.3f, 6, -15), make_float3(0.3f, 6, 15), red);
    // the left wall around a 4 x 4 m opening (z [-16, -12], y [3, 7]) into a recess 1.5 m deep that holds the rotor
    box(make_float3(-10.3f, 6, -6), make_float3(0.3f, 6, 6), concrete);
    box(make_float3(-10.3f, 6, -23), make_float3(0.3f, 6, 7), concrete);
    box(make_float3(-10.3f, 1.5f, -14), make_float3(0.3f, 1.5f, 2), concrete);
    box(make_float3(-10.3f, 9.5f, -14), make_float3(0.3f, 2.5f, 2), concrete);
    box(make_float3(-11.8f, 5, -14), make_float3(0.3f, 2.2f, 2.2f), concrete);   // the recess' back
    box(make_float3(-11.05f, 2.8f, -14), make_float3(0.45f, 0.2f, 2.2f), concrete);
    box(make_float3(-11.05f, 7.2f, -14), make_float3(0.45f, 0.2f, 2.2f), concrete);
    box(make_float3(-11.05f, 5, -11.8f), make_float3(0.45f, 2, 0.2f), concrete);
    box(make_float3(-11.05f, 5, -16.2f), make_float3(0.45f, 2, 0.2f), concrete);
    // the ceiling (y [12, 12.6]) around a 4 x 4 m opening x [-2, 2], z [-14, -10]
    box(make_float3(-6, 12.3f, -15), make_float3(4, 0.3f, 15), concrete);
    box(make_float3(6, 12.3f, -15), make_float3(4, 0.3f, 15), concrete);
    box(make_float3(0, 12.3f, -5), make_float3(2, 0.3f, 5), concrete);
    box(make_float3(0, 12.3f, -22), make_float3(2, 0.3f, 8), concrete);
    // the well above it, 4 m tall, open at the top (where the emitter is)
    box(make_float3(-2.25f, 14, -12), make_float3(0.25f, 2, 2.5f), concrete);
    box(make_float3(2.25f, 14, -12), make_float3(0.25f, 2, 2.5f), concrete);
    box(make_float3(0, 14, -9.75f), make_float3(2, 2, 0.25f), concrete);
    box(make_float3(0, 14, -14.25f), make_float3(2, 2, 0.25f), concrete);
    // the grate in the opening: five bars along z (0.15 m wide, 0.75 m apart) and one across
    for (int i = -2; i <= 2; ++i) box(make_float3(i * 0.75f, 12.0f, -12), make_float3(0.075f, 0.12f, 2.0f), steel);
    box(make_float3(0, 11.9f, -12), make_float3(2.0f, 0.06f, 0.075f), steel);
    // a column floor to ceiling, a green block on the floor
    box(make_float3(4, 6, -20), make_float3(0.8f, 6, 1.2f), concrete);
    box(make_float3(-5, 1.5f, -23), make_float3(1.5f, 1.5f, 1.5f), green);
    // the far wall's glowing panel (5 x 4 m, 2 cm off the wall)
    kit.mat = panel;
    kit.t = dz::Xform::at(make_float3(0, 6, -29.98f));
    kit.quad(5, 4);
    // the sphere lamp on a rod from the ceiling
    kit.maxEdge = 0.05f;
    kit.mat = bulb;
    kit.t = dz::Xform::at(make_float3(-5, 7, -19));
    kit.sphere(0.2f);
    kit.mat = steel;
    kit.t = dz::Xform::frame(make_float3(-5, 7, -19), make_float3(0, 1, 0), make_float3(1, 0, 0));
    kit.roundedCylinder(0.02f, 0.19f, 5.0f, 0.005f, false, false);
    // the rod the model hangs from (the model itself is imported last)
    kit.t = dz::Xform::frame(make_float3(-6, 9, -15), make_float3(0, 1, 0), make_float3(1, 0, 0));
    kit.roundedCylinder(0.015f, 0.0f, 3.0f, 0.004f, false, false);
    dz::finishMesh(s.mesh);

    // the shaft: the well's whole top, light falling almost straight down (tilted 7 degrees towards -z) with a lobe
    // narrow enough that the grate's bars are crisp on the floor 12 m below (half intensity at 0.7 degrees)
    Emitter shaft;
    shaft.group = GROUP_KUYU;
    shaft.c = make_float3(0, 15.95f, -12);
    shaft.u = make_float3(1.99f, 0, 0);
    shaft.v = make_float3(0, 0, 1.99f);
    shaft.n = normalize(make_float3(0, -1, -0.12f));
    shaft.L = 12000.0f;
    shaft.lobe = 10000.0f;
    s.lights.push_back(shaft);
    Emitter glow;
    glow.group = GROUP_KEMER;
    glow.c = make_float3(0, 6, -29.97f);
    glow.u = make_float3(2.5f, 0, 0);
    glow.v = make_float3(0, 2, 0);
    glow.n = make_float3(0, 0, 1);
    glow.L = s.mats[panel].emitScale;
    glow.lobe = 1.0f;
    s.lights.push_back(glow);
    Emitter lamp;
    lamp.type = Emitter::SPHERE;
    lamp.group = GROUP_LAMBA;
    lamp.c = make_float3(-5, 7, -19);
    lamp.r = 0.21f;   // just outside the bulb's mesh: shadow rays to it never meet the bulb itself
    lamp.L = s.mats[bulb].emitScale;
    s.lights.push_back(lamp);

    // the rotor: seven blades in its own frame (axis +x), in the recess
    Dynamic rotor;
    rotor.name = "test_rotor";
    rotor.centre = make_float3(-10.9f, 5, -14);
    rotor.axis = make_float3(1, 0, 0);
    rotor.radius = 1.8f;
    rotor.blades = 7;
    rotor.bakeTransmit = 0.55f;
    {
        dz::Kit rk(rotor.mesh);
        rk.mat = steel;
        rk.maxEdge = 0.5f;
        for (int i = 0; i < rotor.blades; ++i) {
            rk.t = dz::Xform::rotX(float(i) * 2.0f * M_PIf / float(rotor.blades));
            rk.t.o = rk.t.dir(make_float3(0, 1.0f, 0));
            rk.roundedBox(make_float3(0.04f, 0.75f, 0.2f), 0.02f);
        }
        rk.t = dz::Xform::frame(make_float3(-0.15f, 0, 0), make_float3(1, 0, 0), make_float3(0, 1, 0));
        rk.roundedCylinder(0.25f, 0.0f, 0.3f, 0.03f);   // the hub
        dz::finishMesh(rotor.mesh);
    }
    s.dyn.push_back(rotor);

    // a coarse volume over the room and a fine one around the shaft
    Volume room;
    room.name = "test_oda";
    room.lo = make_float3(-12, 0, -30);   // the recess too (the rotor is lit from the volumes)
    room.cell = 1.0f;
    room.dim[0] = 22; room.dim[1] = 12; room.dim[2] = 30;
    s.vols.push_back(room);
    Volume well;
    well.name = "test_kuyu";
    well.lo = make_float3(-3, 0, -16);
    well.cell = 0.125f;
    well.dim[0] = 48; well.dim[1] = 128; well.dim[2] = 64;   // x [-3, 3], y [0, 16], z [-16, -8]
    s.vols.push_back(well);

    s.fanlar.eye = make_float3(0, 4, -2);
    s.fanlar.target = make_float3(0, 4.5f, -20);
    s.fanlar.fov = 65;
    s.rgb.eye = make_float3(7, 3.5f, -5);
    s.rgb.target = make_float3(-5, 3.5f, -22);
    s.rgb.fov = 65;
    s.path = {s.fanlar.eye, make_float3(0, 4.5f, -14), s.rgb.eye};

    Anchor a;
    a.name = "test_rotor";
    a.type = "tik";
    a.box.c = rotor.centre;
    a.box.x = make_float3(0.3f, 0, 0);
    a.box.y = make_float3(0, 1.8f, 0);
    a.box.z = make_float3(0, 0, 1.8f);
    s.anchors.push_back(a);
    a = Anchor{};
    a.name = "test_panel";
    a.type = "levha";
    a.atlas = "test_panel";
    a.box.c = make_float3(0, 6, -29.97f);
    a.box.x = make_float3(2.5f, 0, 0);
    a.box.y = make_float3(0, 2, 0);
    a.box.z = make_float3(0, 0, 0.01f);
    a.size[0] = 5;
    a.size[1] = 4;
    a.material = int(panel);
    s.anchors.push_back(a);

    // a Poly Haven model hung 3 m under the ceiling on the rod above (CC0, https://polyhaven.com/a/caged_hanging_light, 2k glTF)
    const std::string model = std::string(SALON_ROOT) + "/../varlik/model/caged_hanging_light/caged_hanging_light_2k.gltf";
    if (!std::filesystem::exists(model)) {
        err = "the test model is missing: fetch the 2k glTF of https://api.polyhaven.com/files/caged_hanging_light into "
              "sahne/varlik/model/caged_hanging_light/";
        return false;
    }
    return importModel(s, model, dz::Xform::at(make_float3(-6, 9, -15)), 2.0f, err);
}

}   // namespace salon
