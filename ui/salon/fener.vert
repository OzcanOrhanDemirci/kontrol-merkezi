// The outside (Phase 2): every facility's one steady lamp as a sprite, added after the fog (post.frag adds the target
// this draws into). A lamp far away is smaller than a pixel: drawn as itself it would blink as it moves across the
// pixel grid. Here its light is an energy-conserving Gaussian of at least ~0.8 pixel (the sum over the pixels is the
// lamp's flux whatever its position: no blinking), plus the light the fog scatters round it (a soft halo). Close up,
// where the globe is a few pixels wide, the mesh takes the core over (aInst1.a, the same share dis.frag uses).
// Seen through the fog it is dimmed less than a dark surface: a bright thing pierces the fog (Inside's rule).
// Occlusion: the scene's depth at a few taps over the core (a partial cover is partial, not on/off).
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
out vec2 vOff;                 // pixels from the centre
flat out vec4 vCore;           // rgb: the core's peak (radiance), a: its sigma (px)
flat out vec4 vHalo;           // rgb: the halo's scale, a: the lamp's distance (m)
flat out float vZ;             // the lamp's view depth (m)
float viewZd(float d) { float n = uNearFar.x, f = uNearFar.y; return 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n)); }
void main() {
    // two triangles: 0 (-1,-1) 1 (1,-1) 2 (-1,1) 3 (-1,1) 4 (1,-1) 5 (1,1)
    int id = gl_VertexID;
    vec2 corner = id == 0 ? vec2(-1, -1) : id == 1 ? vec2(1, -1) : id == 2 ? vec2(-1, 1) : id == 3 ? vec2(-1, 1) : id == 4 ? vec2(1, -1) : vec2(1, 1);
    vec3 q = aLamp.xyz - uEye;
    float z = dot(q, uCamF);
    float d = length(q);
    vCore = vec4(0.0); vHalo = vec4(0.0); vZ = z; vOff = vec2(0.0);
    if (z < 0.2) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec2 ndc = vec2(dot(q, uCamR) / (z * uTan.x), dot(q, uCamU) / (z * uTan.y));
    vec2 cpx = (ndc * 0.5 + 0.5) * uSize;
    float r = aLamp.w;
    float rpx = r / d / uPxAngle;
    float sig = max(0.8, rpx * 0.70710678);
    float T = exp(-uSigma * uPierce * d);
    // the core: the globe's flux L pi r^2 / d^2 (steradian-weighted radiance) spread over a Gaussian of sigma px
    float omegaPx = uPxAngle * uPxAngle;
    float energy = 3.14159265 * r * r / (d * d);
    // occlusion: five taps of the scene's depth over the core (at the scene's resolution)
    vec2 ds = vec2(textureSize(uDepth, 0));
    vec2 k = ds / uSize;
    float vis = 0.0;
    for (int i = 0; i < 5; i++) {
        vec2 o = i == 0 ? vec2(0.0) : vec2(i == 1 ? 1.0 : i == 2 ? -1.0 : 0.0, i == 3 ? 1.0 : i == 4 ? -1.0 : 0.0) * sig;
        ivec2 p = ivec2(clamp((cpx + o) * k, vec2(0.0), ds - 1.0));
        float sz = viewZd(texelFetch(uDepth, p, 0).r);
        vis += smoothstep(z - 2.0 * r - 0.6, z - r - 0.05, sz) * (i == 0 ? 0.4 : 0.15);
    }
    vCore = vec4(aCol.rgb * (aCol.a * energy * T * vis / (6.2831853 * sig * sig * omegaPx)), sig);
    // the halo: single scattering round a point of intensity I = L pi r^2 at impact parameter b: sigma I / (4 b),
    // cut off over uHaloR (the fog's own glow would carry it much further and grey the whole void)
    vHalo = vec4(aCol.rgb * (3.14159265 * r * r) * uSigma * 0.25 * T, d);
    float halo = min(uMaxPx, 3.0 * uHaloR / d / uPxAngle);
    float ext = max(4.0 * sig, halo);
    vOff = corner * ext;
    vec2 p = cpx + vOff;
    gl_Position = vec4(p / uSize * 2.0 - 1.0, 0.0, 1.0);
}
