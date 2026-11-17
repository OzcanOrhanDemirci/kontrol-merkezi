// The scene pass: forward shading of the hall's surfaces (docs/SALON.md, "The live renderer", 1).
// Diffuse = albedo/pi * sum_g C_g k_g E_g(n), E from the light map's L0 and L1 direction; GGX specular from that
// direction (lobe widened by the light's spread); the floor's wet reflection from the reflection pass.
// COMMON
in vec3 vP;
in vec3 vN;
in vec4 vT;
in vec2 vUv;
in vec2 vLm;
in float vOwn;
layout(location = 0) out vec4 outColor;

uniform sampler2DArray uAlb, uNrm, uArm;   // material textures, one layer per Poly Haven set
uniform sampler2DArray uLmA, uLmB;         // light map: layer = page * 3 + group (A: L0 as RGB9_E5)
uniform sampler2DArray uLmO;               // the openness within 0.5 m, layer = page
uniform sampler2D uLevha;                  // the live texture of this draw (signs, boards, displays)
uniform sampler2D uRefl;                   // the floor's reflection (mip chain)
uniform sampler3D uNoise;                  // smooth tiled noise (the puddles)

layout(std140) uniform Materials {
    vec4 uMatA[64];   // uv scale (m per repeat), texture layer (-1: none), roughness (-1: map), metal (-1: map)
    vec4 uMatB[64];   // tint (linear), emitScale
    vec4 uMatC[64];   // emissive group (-1), flags (1 wet, 2 levha), 0, 0
};
uniform int uMat;
uniform int uPage;
uniform vec4 uDraw;            // x: live texture on, y: its emission (0: paint), z: hover 0..1, w: lit from the volumes
uniform vec4 uLensBall[12];     // the stair lamps' lenses (centre, radius): their bodies' received light is held
uniform int uLensN;
uniform vec4 uLensBox[2];        // their bounds
uniform float uLensCap;
uniform vec3 uLamp;            // a lamp lens' emission (linear radiance)
uniform float uAlpha;          // the crisp rotor's share while it fades into the blurred disc
uniform float uMirror;
uniform vec3 uEyeShade;        // the eye the surface is seen from (mirrored in the reflection pass)
uniform vec2 uTarget;          // this target's size (px)
uniform float uPxScale;        // target pixels per canvas pixel (the supersampling scale)
uniform float uReflLevels;     // mip levels of the reflection - 1
uniform float uCubic;          // 1: allow the light map's B-spline read

// ---- cubic B-spline reads from four bilinear ones (Sigg & Hadwiger), as Denizalti's common.glsl
vec4 cubicLayer(sampler2DArray t, vec2 uv, float layer) {
    vec2 sz = vec2(textureSize(t, 0).xy);
    vec2 c = uv * sz - 0.5, f = fract(c), i = c - f;
    vec2 w0 = (1.0 / 6.0) * (1.0 - f) * (1.0 - f) * (1.0 - f);
    vec2 w1 = (1.0 / 6.0) * (3.0 * f * f * f - 6.0 * f * f + 4.0);
    vec2 w2 = (1.0 / 6.0) * (-3.0 * f * f * f + 3.0 * f * f + 3.0 * f + 1.0);
    vec2 w3 = (1.0 / 6.0) * f * f * f;
    vec2 g0 = w0 + w1, h0 = w1 / g0 - 1.0, h1 = w3 / (w2 + w3) + 1.0;
    vec2 p0 = (i + h0 + 0.5) / sz, p1 = (i + h1 + 0.5) / sz;
    return mix(mix(texture(t, vec3(p1, layer)), texture(t, vec3(p0.x, p1.y, layer)), g0.x),
               mix(texture(t, vec3(p1.x, p0.y, layer)), texture(t, vec3(p0, layer)), g0.x), g0.y);
}
vec4 lmRead(sampler2DArray t, vec2 uv, float layer, float wc) {
    vec4 l = texture(t, vec3(uv, layer));
    return wc > 0.0 ? mix(l, cubicLayer(t, uv, layer), wc) : l;
}

void main() {
    vec4 A = uMatA[uMat], B = uMatB[uMat], C = uMatC[uMat];
    int flags = int(C.y + 0.5);
    bool wet = (flags & 1) != 0 && uMirror < 0.5;
    vec3 V = normalize(uEyeShade - vP);
    vec3 Ng = normalize(vN);
    if (dot(Ng, V) < 0.0) Ng = -Ng;
    // the light map's texel size on screen: the B-spline read where a texel spans over ~2 canvas pixels, blended over
    // a band so a surface moving through the threshold does not switch (derivatives taken in uniform control flow)
    vec2 lmPx = vec2(textureSize(uLmA, 0).xy);
    float texPerPx = max(length(dFdx(vLm) * lmPx), length(dFdy(vLm) * lmPx)) * uPxScale;
    float wc = uCubic * smoothstep(0.7, 0.4, texPerPx);
    if (uMirror > 0.5 && vP.y < 0.002) discard;          // the reflection keeps only what is above the floor

    Surf s;
    s.albedo = B.rgb;
    s.rough = 0.7;
    s.metal = 0.0;
    s.ao = 1.0;
    s.n = Ng;
    s.v = V;
    // what the wet floor reads at a fixed, coarse scale (the puddles' outline and the reflection's distortion): the
    // maps at no finer than ~2.3 cm a texel (level 4) and never finer than a canvas pixel, so neither crawls as the
    // camera moves or as the distance changes the mip level
    float roughCoarse = 0.7;
    vec3 nCoarse = Ng;
    if (A.y >= 0.0) {
        vec3 tc = vec3(vec2(vUv.x, -vUv.y) / A.x, A.y);    // GL convention: v up (the images are not flipped)
        vec2 tpx = tc.xy * 2048.0;
        float lodPx = log2(max(max(length(dFdx(tpx)), length(dFdy(tpx))) / uPxScale, 1.0));
        float lodC = max(lodPx + 1.0, 4.0);
        s.albedo *= texture(uAlb, tc).rgb;
        vec3 arm = texture(uArm, tc).rgb;
        s.ao = arm.r;
        s.rough = arm.g;
        s.metal = arm.b;
        vec3 tn = texture(uNrm, tc).xyz * 2.0 - 1.0;
        vec3 T = vT.xyz - Ng * dot(Ng, vT.xyz);
        if (dot(T, T) > 1e-10) {
            T = normalize(T);
            vec3 Bt = cross(Ng, T) * vT.w;
            s.n = normalize(T * tn.x + Bt * tn.y + Ng * max(tn.z, 0.05));
            if ((flags & 1) != 0) {
                vec3 tnc = textureLod(uNrm, tc, lodC).xyz * 2.0 - 1.0;
                nCoarse = normalize(T * tnc.x + Bt * tnc.y + Ng * max(tnc.z, 0.05));
            }
        }
        if ((flags & 1) != 0) roughCoarse = textureLod(uArm, tc, lodC).g;
    }
    if (A.z >= 0.0) s.rough = A.z;
    if (A.w >= 0.0) s.metal = A.w;
    vec3 emit = vec3(0.0);
    if (uDraw.x > 0.5) {           // the live texture: uv0 runs 0..1 over the face, u right, v down (canvas order, as the
                                   // builder writes it; the canvas is uploaded unflipped, its top row at v = 0)
        vec4 ink = texture(uLevha, vUv);
        if (uDraw.y > 0.0) emit += ink.rgb * ink.a * uDraw.y;
        else {
            s.albedo = mix(s.albedo, ink.rgb, ink.a);
            s.rough = mix(s.rough, 0.6, ink.a);
            s.metal = mix(s.metal, 0.0, ink.a);
        }
    }
    float hover = uDraw.z;
    s.albedo *= 1.0 + 0.18 * hover;
    emit *= 1.0 + 0.3 * hover;

    // the wet floor: puddles (a smooth fixed mask) are near-mirrors and darker, the rest stays rough. Their outline
    // follows the concrete's own low, smooth spots (its roughness map: water gathers where the surface is worn smooth),
    // so the edges are irregular, not noise blobs; round each puddle a damp margin: darker, glossier concrete
    float puddle = 0.0;
    if (wet) {
        float m = texture(uNoise, vec3(vP.xz * 0.021, 0.37)).r * 0.65 + texture(uNoise, vec3(vP.xz * 0.083, 0.71)).r * 0.35;
        m += (0.55 - roughCoarse) * 0.16;
        // the outline's edge at least a canvas pixel wide (the mask's own change across the pixel)
        float fw = 0.5 * fwidth(m) / uPxScale;
        puddle = smoothstep(0.595 - max(0.02, fw), 0.595 + max(0.02, fw), m);
        float damp = smoothstep(0.50, 0.575, m) * (1.0 - puddle);
        s.albedo *= mix(mix(0.85, 0.6, damp), 0.45, puddle);
        s.rough = mix(mix(s.rough * 0.85, s.rough * 0.45, damp), 0.04, puddle);
        s.n = normalize(mix(s.n, Ng, 0.85 * puddle + 0.3 * damp));
        nCoarse = normalize(mix(nCoarse, Ng, 0.85 * puddle + 0.3 * damp));
    }
    // geometric specular antialiasing (Tokuyoshi and Kaplanyan 2019): the normal's change across a canvas pixel
    // widens the lobe (alpha^2 += min(2 sigma^2 |dn|^2, kappa), sigma^2 = 1/2pi, kappa = 0.18), so a highlight on a
    // normal-mapped edge or a column's chamfer is the pixel's average, not a glint a sample catches or misses
    vec3 dnx = dFdx(s.n), dny = dFdy(s.n);
    float k2 = min(2.0 * 0.15915494 * (dot(dnx, dnx) + dot(dny, dny)) / (uPxScale * uPxScale), 0.18);
    float r2 = s.rough * s.rough;
    s.rough = sqrt(sqrt(r2 * r2 + k2));
    s.rough = clamp(s.rough, 0.03, 1.0);
    s.metal = clamp(s.metal, 0.0, 1.0);
    s.f0 = mix(wet ? vec3(0.02) : vec3(0.04), s.albedo, s.metal);

    vec3 c = vec3(0.0);
    float open = 1.0;
    if (uDraw.w > 0.5) {
        s.so = s.ao;
        if (wet) s.so *= 1.0 - puddle;         // a puddle's mirror image comes from the reflection pass
        c = shadeFromVolumes(s, vP);
    } else {
        // one layer pair per group of this page
        vec4 a[3], b[3];
        for (int g = 0; g < 3; g++) {
            float layer = float(uPage * 3 + g);
            a[g] = lmRead(uLmA, vLm, layer, wc);          // L0 (the light's amount) smooth to the second derivative;
            b[g] = texture(uLmB, vec3(vLm, layer));        // its direction varies slowly: bilinear is enough
        }
        open = clamp(texture(uLmO, vec3(vLm, float(uPage))).r, 0.0, 1.0);
        s.so = open * mix(1.0, s.ao, 0.5);
        if (wet) s.so *= 1.0 - puddle;          // the lights' mirror images are in the reflection pass (no double count)
        for (int g = 0; g < 3; g++) {
            vec3 L0 = max(a[g].rgb, vec3(0.0));
            float l0 = max(lum(L0), 1e-8);
            vec3 dir = b[g].xyz * 2.0 - 1.0;
            float dl = length(dir);
            dir = dl > 1e-4 ? dir / dl : Ng;
            float w = clamp(b[g].w, 0.0, 1.0);
            vec3 R0 = PI * Y0 * L0;
            vec3 E = max(R0 + (2.0 * PI / 3.0) * Y1 * dot(dir, s.n) * w * (Y1 / Y0) * L0, 0.1 * R0);
            c += uGroup[g] * shadeGroup(s, E, dir, w, w * L0 / Y0, (1.0 - w) * 2.0 * Y0 * L0);
        }
    }
    // a lens drawn at a fraction of its baked radiance (salon.js LENS): the light its own face received in the bake
    // (its emitter sits on it) would keep it a white disc, so it shows its emission only
    if ((flags & 4) != 0) c = vec3(0.0);
    if (all(greaterThan(vP, uLensBox[0].xyz)) && all(lessThan(vP, uLensBox[1].xyz))) for (int i = 0; i < 12; i++) {
        if (i >= uLensN) break;
        vec3 d = vP - uLensBall[i].xyz;
        if (dot(d, d) < uLensBall[i].w * uLensBall[i].w) {
            float l = lum(c), cap = uLensCap * lum(uGroup[0]);
            if (l > cap) c *= cap / l;
        }
    }
    // a small lens' emission goes partly or wholly to its footprint (emit.frag): what is left of it here
    float own = vOwn;
    if (C.x >= 0.0) emit += own * uGroup[int(C.x + 0.5)] * B.rgb * B.w;
    emit += own * uLamp * (1.0 + 0.3 * hover);

    if (wet) {
        // the mirrored scene at this pixel, blurred by roughness, distorted by the normal map; Fresnel (water's f0)
        vec2 st = gl_FragCoord.xy / uTarget + (nCoarse.xz - Ng.xz) * vec2(0.035, 0.05);
        float lod = uReflLevels * smoothstep(0.03, 0.75, s.rough);
        vec3 refl = textureLod(uRefl, clamp(st, vec2(0.0005), vec2(0.9995)), lod).rgb;
        float ndv = max(dot(s.n, V), 1e-4);
        float fr = 0.02 + (max(1.0 - s.rough, 0.02) - 0.02) * pow(1.0 - ndv, 5.0);
        c = c * (1.0 - fr) + refl * fr * mix(open, 1.0, puddle) * mix(0.35, 1.0, puddle);
    }
    outColor = vec4(safe3(c + emit), uAlpha);
}
