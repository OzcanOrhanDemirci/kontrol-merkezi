// The rotor's angular motion blur, analytic: a pixel's coverage is the blades' coverage averaged over the angle swept
// during the frame's exposure. salon.js projects the rotor along its axis once into a polar table (radius x angle) of
// coverage and coverage-weighted normal (axial, tangential, radial: invariant under the spin) and stores its running
// integral over the angle, so the average over any swept arc is two reads. The same frame twice gives the same image;
// at speed the blades become a smooth translucent disc and never strobe; the pixel's own angular footprint is the
// smallest arc (the edges are filtered, not stepped).
// COMMON
in vec2 vLocal;
in vec3 vP;
layout(location = 0) out vec4 outColor;
uniform sampler2D uTab;        // running integral: x = angle (NT + 1 entries over one turn), y = radius rows
uniform float uAngle;          // the blades' angle at the middle of the exposure (rad)
uniform float uSweep;          // the angle swept during the exposure (rad)
uniform float uShare;          // the disc's share (fades in over the crisp mesh as the speed rises)
uniform vec3 uAxisW, uYW, uZW; // the rotor frame in the world
uniform vec3 uEyeShade;
uniform vec3 uAlbedo;
uniform vec2 uRoughMetal;
uniform float uHover;

vec4 prefix(float turns, float r) {
    vec2 sz = vec2(textureSize(uTab, 0));
    float nt = sz.x - 1.0;
    float k = floor(turns), f = turns - k;
    float v = clamp(r, 0.0, 1.0) * (sz.y - 1.0) / sz.y + 0.5 / sz.y;
    vec4 total = texture(uTab, vec2((nt + 0.5) / sz.x, v));
    return k * total + texture(uTab, vec2((f * nt + 0.5) / sz.x, v));
}

void main() {
    vec2 l = vLocal;
    vec2 dx = dFdx(l), dy = dFdy(l);
    float r = length(l);
    if (r > 1.0) discard;
    float th = atan(l.y, l.x) / (2.0 * PI);
    // the pixel's angular footprint (turns), from the derivatives of the disc coordinates (no seam at +-pi)
    float foot = (abs(l.x * dx.y - l.y * dx.x) + abs(l.x * dy.y - l.y * dy.x)) / max(r * r, 1e-6) / (2.0 * PI);
    float a0 = fract(th - uAngle / (2.0 * PI));   // uAngle comes wrapped to one turn
    float s = max(abs(uSweep) / (2.0 * PI), max(foot, 1.0 / float(textureSize(uTab, 0).x)));
    vec4 avg = (prefix(a0 + 0.5 * s, r) - prefix(a0 - 0.5 * s, r)) / s;
    float cov = clamp(avg.x, 0.0, 1.0) * uShare;
    if (cov < 1.0 / 1024.0) discard;
    vec3 nl = avg.yzw / max(avg.x, 1e-5);
    vec3 er = normalize(l.x * uYW + l.y * uZW), et = cross(uAxisW, er);
    vec3 n = normalize(nl.x * uAxisW + nl.y * et + nl.z * er + 1e-6 * uAxisW);
    vec3 V = normalize(uEyeShade - vP);
    if (dot(n, V) < 0.0) n = reflect(n, uAxisW);      // seen from behind: the other face of the blades
    Surf su;
    su.n = n;
    su.v = V;
    su.albedo = uAlbedo * (1.0 + 0.18 * uHover);
    su.rough = clamp(uRoughMetal.x, 0.03, 1.0);
    su.metal = uRoughMetal.y;
    su.f0 = mix(vec3(0.04), su.albedo, su.metal);
    su.ao = 1.0;
    su.so = 1.0;
    outColor = vec4(safe3(shadeFromVolumes(su, vP)), cov);
}
