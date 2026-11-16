// The scene pass: forward shading of the hall's surfaces (docs/SALON.md, "The live renderer", 1).
// Diffuse = albedo/pi * sum_g C_g k_g E_g(n), E from the light map's L0 and L1 direction; GGX specular from that
// direction (lobe widened by the light's spread); the floor's wet reflection from the reflection pass.
// COMMON
in vec3 vP;
in vec3 vN;
in vec4 vT;
in vec2 vUv;
in vec2 vLm;
layout(location = 0) out vec4 outColor;

uniform sampler2DArray uAlb, uNrm, uArm;   // material textures, one layer per Poly Haven set
uniform sampler2DArray uLmA, uLmB;         // light map: layer = page * 3 + group
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
    if (A.y >= 0.0) {
        vec3 tc = vec3(vec2(vUv.x, -vUv.y) / A.x, A.y);    // GL convention: v up (the images are not flipped)
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
        }
    }
    if (A.z >= 0.0) s.rough = A.z;
    if (A.w >= 0.0) s.metal = A.w;
    vec3 emit = vec3(0.0);
    if (uDraw.x > 0.5) {           // the live texture: uv0 runs 0..1 over the face, v up; the canvas' top row is v = 1
        vec4 ink = texture(uLevha, vec2(vUv.x, 1.0 - vUv.y));
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

    // the wet floor: puddles (a smooth fixed mask) are near-mirrors and darker, the rest stays rough
    float puddle = 0.0;
    if (wet) {
        float m = texture(uNoise, vec3(vP.xz * 0.021, 0.37)).r * 0.65 + texture(uNoise, vec3(vP.xz * 0.083, 0.71)).r * 0.35;
        puddle = smoothstep(0.54, 0.62, m);
        s.albedo *= mix(0.85, 0.45, puddle);
        s.rough = mix(s.rough * 0.85, 0.04, puddle);
        s.n = normalize(mix(s.n, Ng, 0.85 * puddle));
    }
    s.rough = clamp(s.rough, 0.03, 1.0);
    s.metal = clamp(s.metal, 0.0, 1.0);
    s.f0 = mix(wet ? vec3(0.02) : vec3(0.04), s.albedo, s.metal);

    vec3 c = vec3(0.0);
    float open = 1.0;
    if (uDraw.w > 0.5) {
        s.so = s.ao;
        if (wet) s.so *= 1.0 - 0.9 * puddle;   // a puddle's mirror image comes from the reflection pass
        c = shadeFromVolumes(s, vP);
    } else {
        // one layer pair per group of this page
        vec4 a[3], b[3];
        for (int g = 0; g < 3; g++) {
            float layer = float(uPage * 3 + g);
            a[g] = lmRead(uLmA, vLm, layer, wc);          // L0 (the light's amount) smooth to the second derivative;
            b[g] = texture(uLmB, vec3(vLm, layer));        // its direction varies slowly: bilinear is enough
        }
        open = clamp(a[0].a, 0.0, 1.0);
        s.so = open * mix(1.0, s.ao, 0.5);
        if (wet) s.so *= 1.0 - 0.9 * puddle;
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
    if (C.x >= 0.0) emit += uGroup[int(C.x + 0.5)] * B.rgb * B.w;
    emit += uLamp * (1.0 + 0.3 * hover);

    if (wet) {
        // the mirrored scene at this pixel, blurred by roughness, distorted by the normal map; Fresnel (water's f0)
        vec2 st = gl_FragCoord.xy / uTarget + (s.n.xz - Ng.xz) * vec2(0.035, 0.05);
        float lod = uReflLevels * smoothstep(0.03, 0.75, s.rough);
        vec3 refl = textureLod(uRefl, clamp(st, vec2(0.0005), vec2(0.9995)), lod).rgb;
        float ndv = max(dot(s.n, V), 1e-4);
        float fr = 0.02 + (max(1.0 - s.rough, 0.02) - 0.02) * pow(1.0 - ndv, 5.0);
        c = c * (1.0 - fr) + refl * fr * mix(open, 1.0, puddle) * mix(0.35, 1.0, puddle);
    }
    outColor = vec4(safe3(c + emit), uAlpha);
}
