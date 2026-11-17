// The outside (Phase 2): the exterior's draw ranges (materials dis_*) drawn once per facility of the void, instanced.
// Every facility is ours, the same geometry and light map, under its own placement: a turn about y (yaw) and an
// offset, both per instance (aInst0); aInst1 carries its group-0 colour (C k: its lamp's colour) and the share of its
// lamp globe drawn as a mesh (the rest is the lamp's sprite). Our own facility is instance (0, 0, 0, 0): cos 0 and
// sin 0 are exact, so its positions are the static mesh's bit for bit. The prepass and the colour pass both use this
// shader (invariant: the depth test EQUAL holds).
// The void's beams and their nodes (uKiris) go through here too: a unit box (aPos, aNrm.xyz) scaled by its half sizes
// (aInst1.xyz, x along the beam), turned by aInst0.w and placed at aInst0.xyz, its uv in metres as the columns' (round
// the section, up the world's y); no light map (dis.frag uBare).
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aNrm;
layout(location = 2) in vec4 aTan;
layout(location = 3) in vec2 aUv;
layout(location = 4) in vec2 aLm;
layout(location = 5) in vec4 aInst0;   // offset xyz (m), yaw (rad)
layout(location = 6) in vec4 aInst1;   // group-0 colour (linear, C k), lamp globe's mesh share
uniform mat4 uVP;
uniform mat4 uModel;           // the hatch's lid: its hinge's frame; the static ranges: identity
uniform float uKolon;          // 1: the columns' range: their shaft runs on down into the cloud band under the facility
uniform vec2 uKolonY;          // the shaft's top and its bottom ring in the mesh (local y, m)
uniform vec4 uBand;            // the cloud band: centre y (this frame), half thickness, period, extinction
uniform float uKolonFoot;      // the columns' feet over the band's centre (m; in the beams' nodes, disari.js KIRIS)
uniform float uKiris;          // 1: the beams and nodes (instanced boxes)
out vec3 vP;
out vec3 vN;
out vec4 vT;
out vec2 vUv;
out vec2 vLm;
out vec3 vLocal;               // the position in our own facility's frame (the baked volumes are there)
flat out vec4 vInst;
invariant gl_Position;
void main() {
    if (uKiris > 0.5) {
        vec3 l = aPos * aInst1.xyz, n = aNrm.xyz;
        float c = cos(aInst0.w), s = sin(aInst0.w);
        mat3 yaw = mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
        vec3 t = abs(n.y) > 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(n.z, 0.0, -n.x);   // u runs along t, v along n x t (up)
        vec3 p = yaw * l + aInst0.xyz;
        vP = p;
        vLocal = l;
        vN = yaw * n;
        vT = vec4(yaw * t, 1.0);
        vUv = vec2(dot(l, t), dot(l, cross(n, t)) + (abs(n.y) > 0.5 ? 0.0 : aInst0.y));
        vLm = vec2(0.0);
        vInst = vec4(0.0);
        gl_Position = uVP * vec4(p, 1.0);
        return;
    }
    vec4 w = uModel * vec4(aPos, 1.0);
    vec2 uv = aUv;
    if (uKolon > 0.5 && w.y < uKolonY.x - 1e-3) {
        // the shaft (a constant section from uKolonY.x down to its bottom ring) stretched or shortened so that its foot
        // is in its node under this facility, where the beams meet it: the column never ends where it can be seen
        float f = uBand.x + uKolonFoot;
        float bc = f + uBand.z * floor((aInst0.y - f) / uBand.z) - aInst0.y;
        float y = uKolonY.x + (w.y - uKolonY.x) * (bc - uKolonY.x) / (uKolonY.y - uKolonY.x);
        uv.y += y - w.y;       // the concrete's texture runs on along the shaft at its own scale
        w.y = y;
    }
    mat3 r = mat3(uModel);
    float c = cos(aInst0.w), s = sin(aInst0.w);
    mat3 yaw = mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);   // columns: x -> (c, 0, -s), z -> (s, 0, c)
    vec3 p = yaw * w.xyz + aInst0.xyz;
    vP = p;
    vLocal = w.xyz;
    vN = yaw * (r * aNrm.xyz);
    vT = vec4(yaw * (r * aTan.xyz), aTan.w < 0.0 ? -1.0 : 1.0);
    vUv = uv;
    vLm = aLm;
    vInst = aInst1;
    gl_Position = uVP * vec4(p, 1.0);
}
