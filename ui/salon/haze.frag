// The haze pass (docs/SALON.md, "The live renderer", 3): per pixel of a reduced target, a march from the eye to the
// scene's depth through the baked volumes. In-scatter per group Ls = M + 3 g (F . r) M / lum(M) times C_g k_g, extinction
// sigma times the live density rho(x, t). Steps are fixed in metres (no jitter): a cell of the finest volume the point
// is in, ending exactly on every fine volume's boundary and on the depth, so nothing jumps as the camera moves.
// Output: in-scattered light (rgb) and transmittance (a).
// The reflection's variant (uMirror): the mirrored ray from where it meets the floor, through the outer volume only.
// COMMON
in vec2 vUv;
layout(location = 0) out vec4 outHaze;
uniform sampler2D uDepth;      // the scene's depth (its own resolution)
uniform vec2 uDepthRatio;      // depth texels per haze texel
uniform vec2 uSize;            // this target's size
uniform float uSigma;          // the oven's extinction (1/m)
uniform float uDensity;        // live scale of the density
uniform float uTime;           // seconds (the haze's own clock)
uniform float uStepFactor;     // 1: a cell; smaller is finer
uniform int uMaxSteps;
uniform float uMirror;
uniform sampler3D uNoise;      // smooth tiled noise, 64^3, period 1 in texture coordinates
uniform int uFans;
uniform vec4 uFan[2];          // centre, strength 0..1
uniform vec4 uFanDir[2];       // the jet's direction (into the gallery), rotor radius
uniform mat3 uFanM[2];         // the jet's churn at uTime: q (from the centre) to the noise's frame, turned and carried
uniform vec3 uFanOff[2];       //   c = uFanM q + uFanOff (salon.js, fanChurn)

// rho(x, t): 1 on average, a gentle height falloff and a slow large drift; in each fan's jet more air, churned:
// tiled noise moved rigidly along the jet and turned about its axis (no shear, so it never winds up into fine
// streaks), its speed and amount following the fan's strength.
float density(vec3 p) {
    float n = texture(uNoise, p * (1.0 / 56.0) + vec3(0.0041, 0.0007, 0.0029) * uTime).r;
    float rho = (0.78 + 0.44 * n) * exp(-max(p.y - 1.0, 0.0) * 0.022);
    for (int i = 0; i < 2; i++) {
        if (i >= uFans) break;
        vec3 a = uFanDir[i].xyz;
        float R = uFanDir[i].w;
        vec3 q = p - uFan[i].xyz;
        float along = dot(q, a);
        vec3 rad = q - a * along;
        float rr = length(rad);
        float width = R * 1.05 + 0.2 * max(along, 0.0);
        float cone = smoothstep(-1.5, 0.8, along) * (1.0 - smoothstep(10.0, 24.0, along)) *
                     (1.0 - smoothstep(0.55 * width, width, rr));
        if (cone <= 0.0) continue;
        float s = uFan[i].w;
        vec3 c = uFanM[i] * q + uFanOff[i];
        // billows of a few metres (the noise's lattice: 16 texels = 3.75 m here), strongly contrasted
        float m = texture(uNoise, c * (1.0 / 15.0) + vec3(0.31 * float(i))).r;
        rho += cone * s * (0.3 + 7.0 * smoothstep(0.38, 0.78, m));
    }
    return rho * uDensity;
}

vec2 boxT(vec3 o, vec3 d, vec3 lo, vec3 hi) {
    vec3 inv = 1.0 / mix(d, vec3(1e-9), lessThan(abs(d), vec3(1e-9)));
    vec3 a = (lo - o) * inv, b = (hi - o) * inv;
    vec3 mn = min(a, b), mx = max(a, b);
    return vec2(max(max(mn.x, mn.y), mn.z), min(min(mx.x, mx.y), mx.z));
}

void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    vec2 uv = (vec2(px) + 0.5) / uSize;
    float d = texelFetch(uDepth, ivec2((vec2(px) + 0.5) * uDepthRatio), 0).r;
    vec3 rd = viewRay(uv);
    float dist = viewZ(d) / max(dot(rd, uCamF), 1e-4);
    vec3 ro = uEye;
    float t0 = 0.0;
    int first = 0;
    if (uMirror > 0.5) {
        // in the mirrored world the ray continues below the floor: its real path goes up from where it met the floor,
        // the camera ray mirrored (origin and direction), from the floor on
        if (rd.y > -1e-4) { outHaze = vec4(0.0, 0.0, 0.0, 1.0); return; }
        t0 = ro.y / -rd.y;
        first = NV - 1;
        ro.y = -ro.y;
        rd.y = -rd.y;
    }
    // clip to the outer volume, find each fine volume's interval along the ray
    int outer = NV - 1;
    vec2 ob = boxT(ro, rd, uVolLo[outer].xyz, uVolLo[outer].xyz + uVolN[outer].xyz * uVolLo[outer].w);
    float t = max(t0, ob.x), t1 = min(dist, ob.y);
    float tin[NV], tout[NV];
    for (int i = 0; i < NV; i++) {
        vec2 b = boxT(ro, rd, uVolLo[i].xyz, uVolLo[i].xyz + uVolN[i].xyz * uVolLo[i].w);
        bool use = i < outer && i >= first && b.y > b.x;
        tin[i] = use ? b.x : 1e9;
        tout[i] = use ? b.y : -1e9;
    }
    vec3 L = vec3(0.0);
    float T = 1.0;
    float coarse = uVolLo[outer].w * uStepFactor;
    for (int k = 0; k < uMaxSteps; k++) {
        if (t >= t1 - 1e-4 || T < 0.002) break;
        float ds = coarse;
        int fine = NV - 1;
        for (int i = NV - 2; i >= 0; i--) {
            if (t >= tin[i] - 1e-4 && t < tout[i] - 1e-4) { ds = min(ds, uVolLo[i].w * uStepFactor); fine = i; }
            else if (tin[i] > t + 1e-4) ds = min(ds, tin[i] - t);
        }
        ds = min(ds, t1 - t);
        vec3 p = ro + rd * (t + 0.5 * ds);
        Air air = lightAt(p, max(first, fine));
        vec3 Ls = max(air.M + 3.0 * uPhaseG * vec3(dot(air.Kr, rd), dot(air.Kg, rd), dot(air.Kb, rd)), vec3(0.0));
        float tr = exp(-uSigma * density(p) * air.open * ds);
        L += T * (1.0 - tr) * Ls;
        T *= tr;
        t += ds;
    }
    outHaze = vec4(safe3(L), clamp(T, 0.0, 1.0));
}
