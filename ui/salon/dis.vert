// The outside (Phase 2): the exterior's draw ranges (materials dis_*) drawn once per facility of the void, instanced.
// Every facility is ours, the same geometry and light map, under its own placement: a turn about y (yaw) and an
// offset, both per instance (aInst0); aInst1 carries its group-0 colour (C k: its lamp's colour) and the share of its
// lamp globe drawn as a mesh (the rest is the lamp's sprite). Our own facility is instance (0, 0, 0, 0): cos 0 and
// sin 0 are exact, so its positions are the static mesh's bit for bit. The prepass and the colour pass both use this
// shader (invariant: the depth test EQUAL holds).
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
out vec3 vP;
out vec3 vN;
out vec4 vT;
out vec2 vUv;
out vec2 vLm;
out vec3 vLocal;               // the position in our own facility's frame (the baked volumes are there)
flat out vec4 vInst;
invariant gl_Position;
void main() {
    vec4 w = uModel * vec4(aPos, 1.0);
    mat3 r = mat3(uModel);
    float c = cos(aInst0.w), s = sin(aInst0.w);
    mat3 yaw = mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);   // columns: x -> (c, 0, -s), z -> (s, 0, c)
    vec3 p = yaw * w.xyz + aInst0.xyz;
    vP = p;
    vLocal = w.xyz;
    vN = yaw * (r * aNrm.xyz);
    vT = vec4(yaw * (r * aTan.xyz), aTan.w < 0.0 ? -1.0 : 1.0);
    vUv = aUv;
    vLm = aLm;
    vInst = aInst1;
    gl_Position = uVP * vec4(p, 1.0);
}
