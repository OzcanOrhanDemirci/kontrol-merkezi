// The depth prepass: depth only, so the scene pass shades each pixel once (depth test EQUAL).
precision highp float;
uniform float uMirror;
in vec3 vP;
void main() {
    if (uMirror > 0.5 && vP.y < 0.002) discard;   // the reflection keeps only what is above the floor
}
