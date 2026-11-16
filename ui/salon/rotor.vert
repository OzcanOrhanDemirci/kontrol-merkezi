// The spinning rotor as a disc in its plane: a quad of half size uRadius around the hub, in the rotor's frame
// (x = axis, y and z span the disc), placed by uModel (no spin: the blades' angle is applied in rotor.frag).
precision highp float;
uniform mat4 uVP;
uniform mat4 uModel;
uniform float uRadius;
uniform float uPlane;          // the blades' mean axial position (own frame, m)
uniform float uMirror;
out vec2 vLocal;               // disc coordinates in units of the radius
out vec3 vP;
void main() {
    int id = gl_VertexID;      // two triangles
    vec2 c = id == 0 ? vec2(-1, -1) : id == 1 ? vec2(1, -1) : id == 2 ? vec2(-1, 1) :
             id == 3 ? vec2(1, -1) : id == 4 ? vec2(1, 1) : vec2(-1, 1);
    vLocal = c;
    vec4 w = uModel * vec4(uPlane, c.x * uRadius, c.y * uRadius, 1.0);
    vP = w.xyz;
    gl_Position = uVP * vec4(w.x, uMirror > 0.5 ? -w.y : w.y, w.z, 1.0);
}
