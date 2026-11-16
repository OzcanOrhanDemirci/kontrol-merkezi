// The meshes: the static hall (world positions) and the moving parts (own frame, placed by uModel).
// uMirror: the reflection pass draws the world mirrored in the floor (y -> -y) from the real camera, so the floor shows
// the reflection at its own screen position; shading uses the unmirrored position and normal.
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aNrm;
layout(location = 2) in vec4 aTan;
layout(location = 3) in vec2 aUv;
layout(location = 4) in vec2 aLm;
uniform mat4 uVP;
uniform mat4 uModel;
uniform float uMirror;         // 1 in the reflection pass
out vec3 vP;
out vec3 vN;
out vec4 vT;
out vec2 vUv;
out vec2 vLm;
invariant gl_Position;
void main() {
    vec4 w = uModel * vec4(aPos, 1.0);
    mat3 r = mat3(uModel);
    vP = w.xyz;
    vN = r * aNrm.xyz;
    vT = vec4(r * aTan.xyz, aTan.w < 0.0 ? -1.0 : 1.0);
    vUv = aUv;
    vLm = aLm;
    gl_Position = uVP * vec4(w.x, uMirror > 0.5 ? -w.y : w.y, w.z, 1.0);
}
