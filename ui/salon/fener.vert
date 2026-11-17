// The outside (Phase 2): every facility's one steady lamp as a sprite, added after the fog (post.frag adds the target
// this draws into). A lamp far away is smaller than a pixel: drawn as itself it would blink as it moves across the
// pixel grid. Here its light is an energy-conserving Gaussian of at least 1 pixel, integrated over each pixel, (the sum over the pixels is the
// lamp's flux whatever its position: no blinking), plus the light the fog scatters round it (a soft halo). Close up,
// where the globe is a few pixels wide, the mesh takes the core over (aInst1.a, the same share dis.frag uses).
// Seen through the fog it is dimmed less than a dark surface: a bright thing pierces the fog (Inside's rule).
// Occlusion: the scene's depth over a smooth kernel round the core (a partial cover is partial, not on/off).
// It is drawn in display light, tonemapped as a whole (below), so that its light on screen does not depend on where
// it sits between pixels.
precision highp float;
layout(location = 0) in vec4 aLamp;    // centre xyz (m), globe radius (m)
layout(location = 1) in vec4 aCol;     // radiance (linear, scene units), share of the core drawn here (1 - mesh)
uniform vec3 uEye, uCamF, uCamR, uCamU;
uniform vec2 uTan;
uniform vec2 uNearFar;
uniform vec2 uSize;            // this target (canvas pixels)
uniform float uPxAngle;        // radians per canvas pixel
uniform float uSigma;          // the fog's extinction (1/m)
uniform float uPierce;         // the share of the extinction a lamp's light sees
uniform float uHaloR;          // the halo's reach round the lamp (m)
uniform float uMaxPx;          // the largest sprite (pixels)
uniform sampler2D uDepth;      // the scene's depth (its own resolution)
uniform float uOcc;            // 1: the scene hides the lamps (0: tests, the lamps' full light)
uniform float uExposure;       // the composite's exposure x the scene's share beside the bloom (post.frag)
uniform vec3 uFogUp, uFogDown; // the void's sky (the background a distant lamp is seen against)
uniform vec4 uBand;            // the cloud band (band.glsl)
// BAND
out vec2 vOff;                 // pixels from the centre
flat out vec4 vCore;           // rgb: the core's peak (radiance), a: its sigma (px)
flat out vec4 vHalo;           // rgb: the halo's scale, a: the lamp's distance (m)
flat out float vZ;             // the lamp's view depth (m)
flat out vec2 vHaloVis;        // the halo's cover for the whole lamp, and the share of the per-pixel test (wide halos)
vec3 agxContrast(vec3 x) {
    vec3 x2 = x * x, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agxDisplay(vec3 c) {      // post.frag's agxEncoded, then to display light (the resolve's pow 2.2)
    mat3 inm = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772,
                    0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
    mat3 outm = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417,
                     -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
    const float minEv = -12.47393, maxEv = 4.026069;
    vec3 v = clamp(log2(max(inm * c, vec3(1e-10))), minEv, maxEv);
    v = agxContrast((v - minEv) / (maxEv - minEv));
    return pow(clamp(outm * v, 0.0, 1.0), vec3(2.2));
}
float erf1(float x) {          // Abramowitz and Stegun 7.1.26 (|error| < 1.5e-7)
    float a = abs(x), t = 1.0 / (1.0 + 0.3275911 * a);
    float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
    return x < 0.0 ? -y : y;
}
float pixGauss(float x, float s) { float k = 0.70710678 / s; return 0.5 * (erf1((x + 0.5) * k) - erf1((x - 0.5) * k)); }
vec3 fogSky(float y) { float t = smoothstep(-0.9, 0.9, y); return mix(uFogDown, uFogUp, t * t); }   // post.frag's
float viewZd(float d) { float n = uNearFar.x, f = uNearFar.y; return 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n)); }
void main() {
    // two triangles: 0 (-1,-1) 1 (1,-1) 2 (-1,1) 3 (-1,1) 4 (1,-1) 5 (1,1)
    int id = gl_VertexID;
    vec2 corner = id == 0 ? vec2(-1, -1) : id == 1 ? vec2(1, -1) : id == 2 ? vec2(-1, 1) : id == 3 ? vec2(-1, 1) : id == 4 ? vec2(1, -1) : vec2(1, 1);
    vec3 q = aLamp.xyz - uEye;
    float z = dot(q, uCamF);
    float d = length(q);
    vCore = vec4(0.0); vHalo = vec4(0.0); vZ = z; vOff = vec2(0.0); vHaloVis = vec2(0.0);
    if (z < 0.2) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec2 ndc = vec2(dot(q, uCamR) / (z * uTan.x), dot(q, uCamU) / (z * uTan.y));
    vec2 cpx = (ndc * 0.5 + 0.5) * uSize;
    float r = aLamp.w;
    float rpx = r / d / uPxAngle;
    float sig = max(1.0, rpx * 0.70710678);
    float T = exp(-(uSigma * d + bandTau(uEye.y, q.y / d, d)) * uPierce);
    // the core: the globe's flux L pi r^2 / d^2 (steradian-weighted radiance) spread over a Gaussian of sigma px
    float omegaPx = uPxAngle * uPxAngle;
    float energy = 3.14159265 * r * r / (d * d);
    // occlusion: the share of the scene's depth texels round the core that do not hide it, each weighted by a
    // Gaussian of 8 texels (4 canvas px at the default supersampling) centred on the lamp's exact place. The depth
    // is a raster: a column's edge in it moves in whole texels while the lamp moves smoothly. A few point taps flip
    // between hidden and seen as the edge passes (a lamp blinking beside a column on a slow pan, 11-17); over a
    // smooth kernel of many texels one texel column's flip is a step of at most 0.05 of the lamp's light. Only the
    // two provoking vertices (2 and 5: the flat outputs are theirs) pay for it.
    float vis = 1.0, visH = 1.0;
    // the depth buffer's own step at the lamp's distance (32-bit float depth, standard projection: z^2 / (near 2^24),
    // 2.4 m at 2 km): a surface a metre behind the lamp can read as in front of it, so the tolerance carries a few
    float eps = 3.0 * z * z / (uNearFar.x * 16777216.0);
    float zLo = z - 2.0 * r - 0.6 - eps, zHi = z - r - 0.05 - 0.5 * eps;
    if ((id == 2 || id == 5) && uOcc > 0.5) {
        vec2 ds = vec2(textureSize(uDepth, 0));
        vec2 k = ds / uSize;
        vec2 tc = cpx * k - 0.5;                           // the lamp in texel coordinates (texel centres whole)
        float sk = max(8.0, sig * k.x * 2.0);              // the kernel's sigma (texels)
        float sp = sk / 8.0;                               // the spacing of its taps (texels: 1 for distant lamps)
        ivec2 hi = ivec2(ds) - 1;
        vec2 base = floor(tc / sp) * sp;
        float acc = 0.0, accH = 0.0, wsum = 0.0;
        float hLo = z - uHaloR - eps, hHi = z - 0.3 * uHaloR - eps;   // the halo's reach (fener.frag's test)
        for (int j = -20; j <= 20; j++) for (int i = -20; i <= 20; i++) {
            vec2 t = base + vec2(float(i), float(j)) * sp;
            vec2 dd = (t - tc) / sk;
            float w = exp(-0.5 * dot(dd, dd));
            ivec2 p = clamp(ivec2(floor(t + 0.5)), ivec2(0), hi);
            float sz = viewZd(texelFetch(uDepth, p, 0).r);
            acc += w * smoothstep(zLo, zHi, sz);
            accH += w * smoothstep(hLo, hHi, sz);
            wsum += w;
        }
        vis = acc / wsum;
        visH = accH / wsum;
    }
    vCore = vec4(aCol.rgb * (aCol.a * energy * T * vis / (6.2831853 * sig * sig * omegaPx)), sig);
    // the halo: single scattering round a point of intensity I = L pi r^2 at impact parameter b: sigma I / (4 b),
    // cut off over uHaloR (the fog's own glow would carry it much further and grey the whole void)
    vHalo = vec4(aCol.rgb * (3.14159265 * r * r) * uSigma * 0.25 * T, d);
    // display light. The tonemap (AgX, a log curve) is not linear even for faint light: run per pixel over a lamp
    // a pixel or two wide, the lamp's light on screen would change with its place between pixels (the brighter its
    // brightest pixel, the more it is compressed), and a distant lamp twinkles on a slow pan. So the lamp is
    // tonemapped once as a whole, here: its gain from scene light to display light is that of its core laid
    // centred on a pixel over the sky behind it (7 x 7 pixels), and every pixel of it is that gain times its scene
    // light. The sum on screen is then the lamp's light at any sub-pixel place; post.frag adds it after the resolve.
    vec3 bg = fogSky(q.y / d) * uExposure;
    vec3 flux = vCore.rgb * (6.2831853 * sig * sig) * uExposure;   // the core's light (the halo takes its gain)
    vec3 dsum = vec3(0.0), lsum = vec3(0.0), base0 = agxDisplay(bg);
    for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
        vec3 v = flux * (pixGauss(float(i), sig) * pixGauss(float(j), sig));
        dsum += agxDisplay(bg + v) - base0;
        lsum += v;
    }
    vec3 eps3 = vec3(1e-6) * uExposure;
    vec3 slope = (agxDisplay(bg + eps3) - base0) / eps3;       // the gain for light far below the background's
    vec3 gain = mix(slope, dsum / max(lsum, vec3(1e-12)), step(vec3(1e-5), lsum)) * uExposure;
    vCore.rgb *= gain;
    vHalo.rgb *= gain;
    // a far lamp's halo is a few pixels wide: what hides it is read once for the lamp, over the same smooth kernel as
    // the core (a test per pixel flips at a column's edge as the lamp moves between pixels); a near lamp's halo is
    // wide and is cut pixel by pixel, at the edge itself
    float haloPx = 0.33 * uHaloR / d / uPxAngle;
    vHaloVis = vec2(visH, smoothstep(6.0, 12.0, haloPx));
    float halo = min(uMaxPx, 3.0 * uHaloR / d / uPxAngle);
    float ext = max(4.0 * sig, halo);
    vOff = corner * ext;
    vec2 p = cpx + vOff;
    gl_Position = vec4(p / uSize * 2.0 - 1.0, 0.0, 1.0);
}
