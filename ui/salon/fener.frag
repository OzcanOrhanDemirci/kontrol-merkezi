// The lamps' sprites (fener.vert): the energy-conserving core and the fog's halo round it, added (blend ONE ONE).
precision highp float;
in vec2 vOff;
flat in vec4 vCore;
flat in vec4 vHalo;
flat in float vZ;
flat in vec2 vHaloVis;
layout(location = 0) out vec4 outColor;
uniform vec2 uNearFar;
uniform vec2 uSize;
uniform float uPxAngle;
uniform float uHaloR;
uniform float uHaloK;         // the halo's gain over plain single scattering (art)
uniform sampler2D uDepth;
float erf1(float x) {          // Abramowitz and Stegun 7.1.26 (|error| < 1.5e-7), as in emit.frag
    float a = abs(x), t = 1.0 / (1.0 + 0.3275911 * a);
    float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
    return x < 0.0 ? -y : y;
}
// the share of a unit Gaussian (sigma s) that falls in the pixel [x - 0.5, x + 0.5]
float pixGauss(float x, float s) { float k = 0.70710678 / s; return 0.5 * (erf1((x + 0.5) * k) - erf1((x - 0.5) * k)); }
float viewZd(float d) { float n = uNearFar.x, f = uNearFar.y; return 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n)); }
// the halo at b metres from the lamp across the view: sigma I / (4 (b + b0)) e^(-b / R), b0 at least half a pixel
// there (a far lamp's halo is a pixel or two wide: a sharper cusp would be hit or missed by the pixel centres)
float haloAt(vec2 off) {
    float pm = uPxAngle * vHalo.a;                     // metres per pixel at the lamp
    float b = length(off) * pm;
    return uHaloK / (b + max(0.35, 0.5 * pm)) * exp(-b / (0.33 * uHaloR));
}
void main() {
    // the core integrated over the pixel's area, not sampled at its centre: the pixels' sum is the lamp's flux and the
    // brightest pixel changes less with the lamp's place between pixels (what a moving dot's twinkle is made of)
    float sg = vCore.a;
    vec3 c = vCore.rgb * (6.2831853 * sg * sg) * pixGauss(vOff.x, sg) * pixGauss(vOff.y, sg);
    // the halo, averaged over the pixel's area (4 x 4 points) where it is a few pixels wide, so it too keeps its sum
    // wherever the lamp sits between pixels; one point where it is wide; what stands in front of the lamp (nearer than
    // it by more than the halo's reach) hides it: read once for a far lamp (fener.vert), pixel by pixel for a near one
    float h = 0.0;
    if (vHalo.a * uPxAngle * 6.0 > 0.33 * uHaloR) {
        for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) h += haloAt(vOff + (vec2(float(i), float(j)) - 1.5) * 0.25);
        h *= 1.0 / 16.0;
    } else h = haloAt(vOff);
    vec2 ds = vec2(textureSize(uDepth, 0));
    float sz = viewZd(texelFetch(uDepth, ivec2(clamp(gl_FragCoord.xy / uSize * ds, vec2(0.0), ds - 1.0)), 0).r);
    float eps = 3.0 * vZ * vZ / (uNearFar.x * 16777216.0);   // the depth's step there (fener.vert)
    float front = mix(vHaloVis.x, smoothstep(vZ - uHaloR - eps, vZ - 0.3 * uHaloR - eps, sz), vHaloVis.y);
    c += vHalo.rgb * h * front;
    outColor = vec4(c, 0.0);   // added over the masts (salon.js): no cover of its own
}
