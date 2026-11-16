// The full-screen passes after the scene (docs/SALON.md, "The live renderer", 2-4). One file, one PASS_* define each.
// COMMON
in vec2 vUv;
layout(location = 0) out vec4 outColor;

// ---- haze upsampling, joint-bilateral by depth: of the four nearest haze texels the ones at this pixel's depth count;
// when none is (a column's edge against the far hall), the one nearest in depth alone, so bright haze never bleeds
// onto a near edge as a halo.
#if defined(PASS_COMPOSE) || defined(PASS_REFLCOMP) || defined(PASS_BLOOMPRE)
uniform sampler2D uHaze;
uniform sampler2D uDepth;
uniform vec2 uHazeRatio;       // depth texels per haze texel
vec4 hazeAt(vec2 uv, float z) {
    vec2 hs = vec2(textureSize(uHaze, 0));
    vec2 p = uv * hs - 0.5, f = fract(p);
    ivec2 b = ivec2(floor(p)), hmax = ivec2(hs) - 1;
    vec4 sum = vec4(0.0), best = vec4(0.0, 0.0, 0.0, 1.0);
    float ws = 0.0, bd = 1e30;
    for (int k = 0; k < 4; k++) {
        ivec2 o = ivec2(k & 1, k >> 1);
        ivec2 q = clamp(b + o, ivec2(0), hmax);
        float zq = viewZ(texelFetch(uDepth, ivec2((vec2(q) + 0.5) * uHazeRatio), 0).r);
        float dz = abs(zq - z);
        vec4 h = texelFetch(uHaze, q, 0);
        float w = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y) * exp(-dz / (0.015 * z + 0.04));
        sum += h * w;
        ws += w;
        if (dz < bd) { bd = dz; best = h; }
    }
    return ws > 0.02 ? sum / ws : best;
}
#endif

// ---- the void (Phase 2, the outside): wherever a view ray runs outside our block (the hall's concrete box on its
// columns), a dense blue-grey fog, homogeneous (the world wraps: nothing in it may depend on where the camera is), its
// light a smooth gradient from below to above (the columns sink into a darker depth). Inside the block nothing changes:
// uVoidOn is 0 there, and a ray that stays inside the box has no fog. The baked haze of our own roof (uHomeHaze) fades
// with the distance from it, so a facility seen from far is the same with and without it (the wrap).
#if defined(PASS_COMPOSE) || defined(PASS_BLOOMPRE)
uniform float uVoidOn;
uniform float uFogSigma;
uniform vec3 uFogUp, uFogDown;
uniform vec3 uBlockLo, uBlockHi;
uniform float uCamInside;      // 1: the camera is in the block (the stair under the hatch)
uniform float uHomeHaze;
vec3 fogSky(float y) { return mix(uFogDown, uFogUp, smoothstep(-0.85, 0.7, y)); }
// the outside's share of a ray of length dist from the eye: its transmittance and the fog's light
vec4 voidFog(vec3 rd, float dist) {
    vec3 inv = 1.0 / mix(rd, vec3(1e-9), lessThan(abs(rd), vec3(1e-9)));
    vec3 a = (uBlockLo - uEye) * inv, b = (uBlockHi - uEye) * inv;
    vec3 mn = min(a, b), mx = max(a, b);
    float t0 = max(max(mn.x, mn.y), max(mn.z, 0.0)), t1 = min(min(mx.x, mx.y), min(mx.z, dist));
    float out_ = dist - max(t1 - t0, 0.0);
    float T = exp(-uFogSigma * max(out_, 0.0));
    return vec4(fogSky(rd.y) * (1.0 - T), T);
}
// scene colour s with its baked haze h, seen through the void
vec3 voidComposite(vec3 s, vec4 h, vec3 rd, float dist) {
    if (uVoidOn < 0.5) return s * h.a + h.rgb;
    vec4 f = voidFog(rd, dist);
    if (uCamInside > 0.5) return (s * f.a + f.rgb) * h.a + h.rgb;
    vec4 hw = mix(vec4(0.0, 0.0, 0.0, 1.0), h, uHomeHaze);
    return (s * hw.a + hw.rgb) * f.a + f.rgb;
}
float voidDist(float depth, float z, vec3 rd) { return depth >= 1.0 ? 1e6 : z / max(dot(rd, uCamF), 1e-4); }
#endif

// ---- bloom level 0: the scene box-filtered to the haze's size (Karis-weighted against fireflies), composited
#ifdef PASS_BLOOMPRE
uniform sampler2D uScene;
void main() {
    vec2 ss = vec2(textureSize(uScene, 0)), os = vec2(textureSize(uHaze, 0));
    vec2 q = 0.25 * ss / os / ss;                   // quarter of this texel's footprint, in scene uv
    vec3 c = vec3(0.0);
    float ws = 0.0;
    for (int k = 0; k < 4; k++) {
        vec2 o = vec2(k & 1, k >> 1) * 2.0 - 1.0;
        vec3 s = texture(uScene, vUv + o * q).rgb;
        float w = 1.0 / (1.0 + lum(s));
        c += s * w;
        ws += w;
    }
    c /= ws;
    vec4 h = texture(uHaze, vUv);
    float dd = uVoidOn > 0.5 ? texture(uDepth, vUv).r : 0.0;   // the void: its fog (the depth at this texel's centre)
    vec3 rd = viewRay(vUv);
    outColor = vec4(safe3(voidComposite(c, h, rd, voidDist(dd, viewZ(dd), rd))), 1.0);
}
#endif

// ---- the 13-tap downsample (Jimenez), from a level of the same texture
#ifdef PASS_DOWN
uniform sampler2D uSrc;
uniform float uLod;
void main() {
    vec2 ts = 1.0 / vec2(textureSize(uSrc, int(uLod)));
    #define T(x, y) textureLod(uSrc, vUv + ts * vec2(x, y), uLod).rgb
    vec3 a = T(-2, -2), b = T(0, -2), c = T(2, -2), d = T(-2, 0), e = T(0, 0), f = T(2, 0);
    vec3 g = T(-2, 2), h = T(0, 2), i = T(2, 2), j = T(-1, -1), k = T(1, -1), l = T(-1, 1), m = T(1, 1);
    vec3 o = (j + k + l + m) * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + e * 0.125;
    outColor = vec4(o, 1.0);
}
#endif

// ---- bloom up: a 3x3 tent of the smaller level, added (blend ONE ONE) into this one
#ifdef PASS_UP
uniform sampler2D uSrc;
uniform float uLod;
void main() {
    vec2 ts = 1.0 / vec2(textureSize(uSrc, int(uLod)));
    #define U(x, y) textureLod(uSrc, vUv + ts * vec2(x, y), uLod).rgb
    vec3 s = U(-1, -1) + 2.0 * U(0, -1) + U(1, -1) + 2.0 * U(-1, 0) + 4.0 * U(0, 0) + 2.0 * U(1, 0) + U(-1, 1) +
             2.0 * U(0, 1) + U(1, 1);
    outColor = vec4(s / 16.0, 1.0);
}
#endif

// ---- the reflection: mirrored scene times its haze's transmittance plus its in-scatter (level 0 of its mip chain)
#ifdef PASS_REFLCOMP
uniform sampler2D uScene;
void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    vec4 s = texelFetch(uScene, px, 0);
    float z = viewZ(texelFetch(uDepth, px, 0).r);
    vec4 h = hazeAt(vUv, z);
    outColor = vec4(safe3(s.rgb * h.a + h.rgb), 1.0);
}
#endif

// ---- composite and tonemap, per supersample: scene * T + in-scatter, the bloom (energy kept: a mix), exposure, AgX.
// Written in AgX's encoded (display gamma) form to a 10-bit target; the resolve filters in linear light.
#ifdef PASS_COMPOSE
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomMix;
uniform float uBloomLevels;
uniform float uExposure;       // multiplier
uniform sampler2D uGlow;       // the void's lamps
vec3 agxContrast(vec3 x) {
    vec3 x2 = x * x, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agxEncoded(vec3 c) {      // Denizalti's post.frag, without the final pow(2.2)
    mat3 inm = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772,
                    0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
    mat3 outm = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417,
                     -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
    const float minEv = -12.47393, maxEv = 4.026069;
    vec3 v = clamp(log2(max(inm * c, vec3(1e-10))), minEv, maxEv);
    v = agxContrast((v - minEv) / (maxEv - minEv));
    return clamp(outm * v, 0.0, 1.0);
}
// the heat in the arch's opening: the air there bends the light, a slow steady shimmer rising with the temperature.
// A view ray that crosses the opening's air (an oriented box) before reaching its surface samples the scene a little
// displaced; the displacement is a smooth sum of slow waves anchored in the air (no noise, no random numbers: nothing
// flickers), its size from the heat (0..1) and the share of the box the ray crosses.
uniform vec3 uHeatC, uHeatX, uHeatY, uHeatZ;   // the box: centre, half axes (zero size: none)
uniform float uHeat, uTime;
vec2 heatShift(vec2 uv, float dist) {
    if (uHeat <= 0.0 || dot(uHeatX, uHeatX) < 1e-6) return vec2(0.0);
    vec3 rd = viewRay(uv), o = uEye - uHeatC;
    vec3 ax[3] = vec3[3](uHeatX, uHeatY, uHeatZ);
    float t0 = 0.0, t1 = dist;
    for (int i = 0; i < 3; i++) {
        float L = length(ax[i]);
        vec3 a = ax[i] / L;
        float ro = dot(o, a), rv = dot(rd, a);
        if (abs(rv) < 1e-6) { if (abs(ro) > L) return vec2(0.0); continue; }
        float ta = (-L - ro) / rv, tb = (L - ro) / rv;
        t0 = max(t0, min(ta, tb));
        t1 = min(t1, max(ta, tb));
    }
    if (t1 <= t0) return vec2(0.0);
    vec3 p = uEye + rd * (0.5 * (t0 + t1));
    float share = clamp((t1 - t0) / (2.0 * length(uHeatZ)), 0.0, 1.0);
    // waves rising through the air, two scales; the hotter, the faster and stronger
    float rise = uTime * (0.35 + 0.9 * uHeat);
    vec2 w = vec2(sin(p.x * 0.9 + p.y * 1.7 - rise * 2.1) + 0.6 * sin(p.x * 2.3 - p.y * 2.9 - rise * 3.3),
                  sin(p.y * 1.3 - rise * 1.7 + p.x * 0.4) + 0.5 * sin(p.y * 3.1 + p.x * 1.9 - rise * 2.7));
    float px = (0.3 + 1.0 * uHeat) * uHeat * share;   // display pixels: at most ~2, heat in the air, not a bent picture
    return w * px / vec2(textureSize(uScene, 0)) * 2.0;   // the scene is supersampled (~2x the display)
}
void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    float z = viewZ(texelFetch(uDepth, px, 0).r);
    vec2 sh = heatShift(vUv, z / max(dot(viewRay(vUv), uCamF), 1e-4));
    vec3 s = sh == vec2(0.0) ? texelFetch(uScene, px, 0).rgb : texture(uScene, vUv + sh).rgb;
    vec4 h = hazeAt(vUv, z);
    vec3 rd = viewRay(vUv);
    vec3 c = voidComposite(s, h, rd, voidDist(texelFetch(uDepth, px, 0).r, z, rd));
    if (uVoidOn > 0.5) c += texture(uGlow, vUv).rgb;   // the void's lamps (fener.vert), after their fog
    vec3 b = texture(uBloom, vUv).rgb / uBloomLevels;
    c = mix(c, b, uBloomMix) * uExposure;
    outColor = vec4(agxEncoded(safe3(c)), 1.0);
}
#endif

// ---- the supersampling resolve: a separable Lanczos-2 after the tonemap, horizontal then vertical; sRGB and a fixed
// blue-noise dither of +-0.5/255 (the same tile every frame) in the second pass, straight to the canvas.
#if defined(PASS_RESOLVEH) || defined(PASS_RESOLVEV)
uniform sampler2D uSrc;
uniform float uScale;          // input pixels per output pixel along this pass' axis
uniform int uTaps;
float lanczos2(float x) {
    x = abs(x);
    if (x >= 2.0) return 0.0;
    if (x < 1e-5) return 1.0;
    float px = PI * x;
    return 2.0 * sin(px) * sin(px * 0.5) / (px * px);
}
#ifdef PASS_RESOLVEV
uniform sampler2D uDither;
#endif
void main() {
    ivec2 o = ivec2(gl_FragCoord.xy);
    ivec2 sz = textureSize(uSrc, 0);
#ifdef PASS_RESOLVEH
    float c = (float(o.x) + 0.5) * uScale - 0.5;
#else
    float c = (float(o.y) + 0.5) * uScale - 0.5;
#endif
    int i0 = int(ceil(c - 2.0 * uScale + 1e-4));
    vec3 sum = vec3(0.0);
    float ws = 0.0;
    for (int k = 0; k < uTaps; k++) {
        int i = i0 + k;
        float w = lanczos2((float(i) - c) / uScale);
#ifdef PASS_RESOLVEH
        vec3 v = texelFetch(uSrc, ivec2(clamp(i, 0, sz.x - 1), o.y), 0).rgb;
        v = pow(v, vec3(2.2));                          // AgX's encoded value to display-linear
#else
        vec3 v = texelFetch(uSrc, ivec2(o.x, clamp(i, 0, sz.y - 1)), 0).rgb;
#endif
        sum += v * w;
        ws += w;
    }
    vec3 r = max(sum / ws, vec3(0.0));
#ifdef PASS_RESOLVEH
    outColor = vec4(r, 1.0);
#else
    r = clamp(r, 0.0, 1.0);
    r = mix(12.92 * r, 1.055 * pow(r, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), r));
    r += (texelFetch(uDither, o & 63, 0).r - 0.5) / 255.0;
    if (any(isnan(r))) r = vec3(0.0);
    outColor = vec4(clamp(r, 0.0, 1.0), 1.0);
#endif
}
#endif
