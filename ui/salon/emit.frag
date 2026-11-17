// A small emitter's footprint: its projected rectangle convolved with a Gaussian of sigma (target px). The value is
// the share of the rectangle a sample "sees" through the Gaussian, so its sum over the sample grid is the rectangle's
// area wherever the lens sits between samples: the lens keeps its energy and its shape at every sub-pixel phase
// (a box or the lens' own geometry is hit or missed by each sample and blinks as the camera moves). Added (ONE, ONE)
// to the pass' radiance, so haze, bloom and the tonemap treat it like the lens it replaces.
// What covers it: a lens a few pixels across takes the share of points on it that are seen (emit.vert); a larger one
// is tested per fragment at the nearest point of the lens (not the fragment's own texel: the spread round a lens lying
// on a floor seen at a grazing angle covers floor nearer by metres per texel, which hides nothing). A flat lens there is
// hidden by what its texel shows only if that lies on its emitting side (its own housing and the floor do not); any
// other emitter (a strip) is seen if the farthest depth round the point (3 x 3 texels) is not in front of it.
precision highp float;
precision highp sampler2D;
in vec2 vPx;
flat in vec3 vL;
flat in vec3 vShape;
flat in vec4 vM, vMi;
flat in vec4 vO;
flat in vec2 vIw;
flat in vec4 vN;
flat in float vExt;
flat in float vVis;
uniform sampler2D uDepth;
uniform vec2 uNearFar;
uniform vec2 uTarget;
uniform vec3 uEye, uCamF, uCamR, uCamU;
uniform vec2 uTan;
float lin(float d) { float n = uNearFar.x, f = uNearFar.y; return 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n)); }
layout(location = 0) out vec4 outColor;
float erf1(float x) {          // Abramowitz and Stegun 7.1.26 (|error| < 1.5e-7)
    float a = abs(x), t = 1.0 / (1.0 + 0.3275911 * a);
    float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
    return x < 0.0 ? -y : y;
}
float boxGauss(float x, float h, float s) { float k = 0.70710678 / s; return 0.5 * (erf1((x + h) * k) - erf1((x - h) * k)); }
void main() {
    vec2 f = gl_FragCoord.xy;
    float seen = vVis, wl = smoothstep(3.0, 8.0, vExt);
    if (wl > 0.0) {
        // the nearest point of the lens' parallelogram (clamping st alone is not: a grazing lens is a sheared sliver,
        // and the spread above and below it would all test one of its corners)
        vec2 d = f - vO.xy, st = mat2(vMi.xy, vMi.zw) * d;
        if (max(abs(st.x), abs(st.y)) > 1.0) {
            float best = 1e30;
            for (int e = 0; e < 4; e++) {
                float sg = (e & 1) == 0 ? -1.0 : 1.0;
                vec2 A = sg * (e < 2 ? vM.xy : vM.zw), B = e < 2 ? vM.zw : vM.xy;
                float tau = clamp(dot(d - A, B) / max(dot(B, B), 1e-6), -1.0, 1.0);
                vec2 r = d - A - B * tau;
                if (dot(r, r) < best) { best = dot(r, r); st = e < 2 ? vec2(sg, tau) : vec2(tau, sg); }
            }
        }
        vec2 q = vO.xy + mat2(vM.xy, vM.zw) * st;
        float z = 1.0 / (vO.z + dot(st, vIw));
        ivec2 c = ivec2(floor(q)), sz = textureSize(uDepth, 0);
        float hit;
        if (dot(vN.xyz, vN.xyz) > 0.5) {
            c = clamp(c, ivec2(0), sz - 1);
            float zt = lin(texelFetch(uDepth, c, 0).r);
            vec2 nd = (vec2(c) + 0.5) / uTarget * 2.0 - 1.0;
            vec3 p = uEye + (uCamF + uCamR * (nd.x * uTan.x) + uCamU * (nd.y * uTan.y)) * zt;
            hit = zt < z - vO.w && dot(vN.xyz, p) - vN.w > 0.01 ? 0.0 : 1.0;
        } else {
            float far = 0.0;
            for (int k = 0; k < 9; k++) far = max(far, lin(texelFetch(uDepth, clamp(c + ivec2(k % 3 - 1, k / 3 - 1), ivec2(0), sz - 1), 0).r));
            hit = far >= z - vO.w ? 1.0 : 0.0;
        }
        seen = mix(vVis, hit, wl);
    }
    if (seen <= 0.0) discard;
    float h1 = vShape.x, h2 = vShape.y, s = vShape.z;
    // the rectangle's area per sample: a lens thinner than sigma keeps its area, spread (the sum stays h1 h2 4)
    float v = boxGauss(vPx.x, h1, s) * boxGauss(vPx.y, h2, s);
    outColor = vec4(vL * (v * seen), 0.0);
}
