// The outside (Phase 2): the exterior's surfaces, our facility and every other in the void (dis.vert). The baked
// light map as in scene.frag (the same L0 + L1 shading, the B-spline read close up), with each facility's own group-0
// colour (its lamp's), plus the void's light: the fog lit dimly all round, brighter from above, as an environment of
// the surfaces (silhouettes that read, nothing pitch black). The hatch's lid has no light map: lit from the baked
// volumes at its place in our own facility's frame (vLocal), the same for every facility.
// The fog itself is not here: the composite lays it over everything outside (post.frag, "the void").
// COMMON
in vec3 vP;
in vec3 vN;
in vec4 vT;
in vec2 vUv;
in vec2 vLm;
in vec3 vLocal;
flat in vec4 vInst;
layout(location = 0) out vec4 outColor;

uniform sampler2DArray uAlb, uNrm, uArm;
uniform sampler2DArray uLmA, uLmB;
uniform sampler2DArray uLmO;

layout(std140) uniform Materials {
    vec4 uMatA[64];
    vec4 uMatB[64];
    vec4 uMatC[64];
};
uniform int uMat;
uniform int uPage;
uniform float uVolLit;         // 1: lit from the volumes (the lid)
uniform float uBare;           // 1: no baked light (the void's beams and nodes: the fog's light alone)
uniform float uFener;          // 1: the lamp's globe (its emission times the instance's mesh share)
uniform float uPxScale;
uniform float uCubic;
uniform vec3 uEyeShade;
uniform vec3 uFogUp, uFogDown; // the void's light: the fog's radiance looking straight up and straight down
uniform float uAmb;            // how much of it reaches the surfaces
uniform vec3 uTexCalm;         // the far concrete's calm: from and to these distances (m), its most (0..1)

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
// the fog's radiance seen along a direction: a smooth gradient from below to above (the same in post.frag)
vec3 fogSky(float y) { float t = smoothstep(-0.9, 0.9, y); return mix(uFogDown, uFogUp, t * t); }   // light from above: the horizon a quarter of the way

void main() {
    vec4 A = uMatA[uMat], B = uMatB[uMat], C = uMatC[uMat];
    vec3 V = normalize(uEyeShade - vP);
    vec3 Ng = normalize(vN);
    if (dot(Ng, V) < 0.0) Ng = -Ng;
    vec2 lmPx = vec2(textureSize(uLmA, 0).xy);
    float texPerPx = max(length(dFdx(vLm) * lmPx), length(dFdy(vLm) * lmPx)) * uPxScale;
    float wc = uCubic * smoothstep(0.7, 0.4, texPerPx);

    Surf s;
    s.albedo = B.rgb;
    s.rough = 0.7;
    s.metal = 0.0;
    s.ao = 1.0;
    s.n = Ng;
    s.v = V;
    if (A.y >= 0.0) {
        vec3 tc = vec3(vec2(vUv.x, -vUv.y) / A.x, A.y);
        // far concrete is calm: the legs' board marks (bands 0.4 m wide) are a few pixels at 100-300 m, where they read
        // as corrugated sheet and crawl as the view turns (a fine pattern in motion, no blur). Between uTexCalm.x and
        // uTexCalm.y metres the texture gives way, by uTexCalm.z at most, to its own mean (its last mip) and the normal
        // to the face's: near, every mark; far, a face of one tone, read by where it looks
        float calm = uTexCalm.z * smoothstep(uTexCalm.x, uTexCalm.y, length(uEyeShade - vP));
        s.albedo *= mix(texture(uAlb, tc).rgb, textureLod(uAlb, tc, 16.0).rgb, calm);
        vec3 arm = mix(texture(uArm, tc).rgb, textureLod(uArm, tc, 16.0).rgb, calm);
        s.ao = arm.r;
        s.rough = arm.g;
        s.metal = arm.b;
        vec3 tn = mix(texture(uNrm, tc).xyz * 2.0 - 1.0, vec3(0.0, 0.0, 1.0), calm);
        vec3 T = vT.xyz - Ng * dot(Ng, vT.xyz);
        if (dot(T, T) > 1e-10) {
            T = normalize(T);
            vec3 Bt = cross(Ng, T) * vT.w;
            s.n = normalize(T * tn.x + Bt * tn.y + Ng * max(tn.z, 0.05));
        }
    }
    if (A.z >= 0.0) s.rough = A.z;
    if (A.w >= 0.0) s.metal = A.w;
    s.rough = clamp(s.rough, 0.03, 1.0);
    s.metal = clamp(s.metal, 0.0, 1.0);
    s.f0 = mix(vec3(0.04), s.albedo, s.metal);

    vec3 g0 = vInst.rgb;           // this facility's group 0
    vec3 c = vec3(0.0);
    float open = 1.0;
    if (uVolLit > 0.5) {
        s.so = s.ao;
        // the volumes hold our own facility's light, already in our colours: the lid reads them at its place in our
        // frame, scaled by this facility's group-0 luminance against ours (exactly 1 for ours). The yaw (a few degrees)
        // is not turned back out of the normal: the light round the lid is soft
        float c0 = max(lum(uGroup[0]), 1e-6);
        c = shadeFromVolumes(s, vLocal) * (lum(g0) / c0);
        open = s.ao;
    } else if (uBare > 0.5) {
        s.so = s.ao;
    } else {
        vec4 a[3], b[3];
        for (int g = 0; g < 3; g++) {
            float layer = float(uPage * 3 + g);
            a[g] = lmRead(uLmA, vLm, layer, wc);
            b[g] = texture(uLmB, vec3(vLm, layer));
        }
        open = clamp(texture(uLmO, vec3(vLm, float(uPage))).r, 0.0, 1.0);
        s.so = open * mix(1.0, s.ao, 0.5);
        for (int g = 0; g < 3; g++) {
            vec3 L0 = max(a[g].rgb, vec3(0.0));
            vec3 dir = b[g].xyz * 2.0 - 1.0;
            float dl = length(dir);
            dir = dl > 1e-4 ? dir / dl : Ng;
            float w = clamp(b[g].w, 0.0, 1.0);
            vec3 R0 = PI * Y0 * L0;
            vec3 E = max(R0 + (2.0 * PI / 3.0) * Y1 * dot(dir, s.n) * w * (Y1 / Y0) * L0, 0.1 * R0);
            c += (g == 0 ? g0 : uGroup[g]) * shadeGroup(s, E, dir, w, w * L0 / Y0, (1.0 - w) * 2.0 * Y0 * L0);
        }
    }
    // the void's light on the surface: diffuse from the fog round the normal, the rest as a dim environment
    vec3 env = fogSky(s.n.y) * uAmb;
    float occ = max(open, 0.4) * s.ao;           // the openness is the bake's, within 0.5 m: thin edges read 0
    c += s.albedo * (1.0 - s.metal) * env * occ;
    c += fogSky(reflect(-V, s.n).y) * uAmb * envBRDF(s.f0, s.rough, max(dot(s.n, V), 1e-4)) * occ;

    vec3 emit = vec3(0.0);
    if (C.x >= 0.0) {
        int eg = int(C.x + 0.5);
        emit = (eg == 0 ? g0 : uGroup[eg]) * B.rgb * B.w;
        if (uFener > 0.5) emit *= vInst.a;
    }
    outColor = vec4(safe3(c + emit), 1.0);
}
