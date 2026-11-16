// The lamps' sprites (fener.vert): the energy-conserving core and the fog's halo round it, added (blend ONE ONE).
precision highp float;
in vec2 vOff;
flat in vec4 vCore;
flat in vec4 vHalo;
flat in float vZ;
layout(location = 0) out vec4 outColor;
uniform vec2 uNearFar;
uniform vec2 uSize;
uniform float uPxAngle;
uniform float uHaloR;
uniform float uHaloK;         // the halo's gain over plain single scattering (art)
uniform sampler2D uDepth;
float viewZd(float d) { float n = uNearFar.x, f = uNearFar.y; return 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n)); }
void main() {
    float r2 = dot(vOff, vOff);
    vec3 c = vCore.rgb * exp(-0.5 * r2 / (vCore.a * vCore.a));
    // the halo: b metres from the lamp across the view, sigma I / (4 (b + b0)) e^(-b / R); what stands in front of
    // the lamp (nearer than it by more than the halo's reach) hides it
    float b = sqrt(r2) * uPxAngle * vHalo.a;
    vec2 ds = vec2(textureSize(uDepth, 0));
    float sz = viewZd(texelFetch(uDepth, ivec2(clamp(gl_FragCoord.xy / uSize * ds, vec2(0.0), ds - 1.0)), 0).r);
    float front = smoothstep(vZ - uHaloR, vZ - 0.3 * uHaloR, sz);
    c += vHalo.rgb * uHaloK / (b + 0.35) * exp(-b / (0.33 * uHaloR)) * front;
    outColor = vec4(c, 1.0);
}
