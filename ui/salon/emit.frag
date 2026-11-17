// A small emitter's footprint: its projected rectangle convolved with a Gaussian of sigma (target px). The value is
// the share of the rectangle a sample "sees" through the Gaussian, so its sum over the sample grid is the rectangle's
// area wherever the lens sits between samples: the lens keeps its energy and its shape at every sub-pixel phase
// (a box or the lens' own geometry is hit or missed by each sample and blinks as the camera moves). Added (ONE, ONE)
// to the pass' radiance, so haze, bloom and the tonemap treat it like the lens it replaces.
// What covers it: a small lens takes the share of points on it that are seen (emit.vert); along a long strip each
// fragment takes the nearest point of the strip's axis and is seen if the farthest depth round that point (3 x 3
// texels) is not in front of the strip there. The axis, not the fragment's own texel: the spread round a lens lying on
// a floor seen at a grazing angle covers floor nearer by metres per texel, which hides nothing.
precision highp float;
precision highp sampler2D;
in vec2 vPx;
flat in vec3 vL;
flat in vec3 vShape;
flat in vec4 vSeg;
flat in vec3 vZ;
flat in float vVis;
uniform sampler2D uDepth;
uniform vec2 uNearFar;
float lin(float d) { float n = uNearFar.x, f = uNearFar.y; return 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n)); }
layout(location = 0) out vec4 outColor;
float erf1(float x) {          // Abramowitz and Stegun 7.1.26 (|error| < 1.5e-7)
    float a = abs(x), t = 1.0 / (1.0 + 0.3275911 * a);
    float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
    return x < 0.0 ? -y : y;
}
float boxGauss(float x, float h, float s) { float k = 0.70710678 / s; return 0.5 * (erf1((x + h) * k) - erf1((x - h) * k)); }
void main() {
    vec2 f = gl_FragCoord.xy, d = vSeg.zw - vSeg.xy;
    float seen = vVis, wl = smoothstep(3.0, 8.0, length(d));
    if (wl > 0.0) {
        float t = clamp(dot(f - vSeg.xy, d) / max(dot(d, d), 1e-6), 0.0, 1.0);
        float z = 1.0 / mix(vZ.x, vZ.y, t);                 // 1 / depth is linear on screen
        ivec2 c = ivec2(floor(vSeg.xy + d * t)), sz = textureSize(uDepth, 0);
        float far = 0.0;
        for (int k = 0; k < 9; k++) far = max(far, lin(texelFetch(uDepth, clamp(c + ivec2(k % 3 - 1, k / 3 - 1), ivec2(0), sz - 1), 0).r));
        seen = mix(vVis, far >= z - vZ.z ? 1.0 : 0.0, wl);
    }
    if (seen <= 0.0) discard;
    float h1 = vShape.x, h2 = vShape.y, s = vShape.z;
    // the rectangle's area per sample: a lens thinner than sigma keeps its area, spread (the sum stays h1 h2 4)
    float v = boxGauss(vPx.x, h1, s) * boxGauss(vPx.y, h2, s);
    outColor = vec4(vL * (v * seen), 0.0);
}
