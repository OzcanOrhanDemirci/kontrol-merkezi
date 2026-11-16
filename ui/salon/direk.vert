// The outside (Phase 2): the masts of the far facilities, under their lamps. A mast is 0.15-0.22 m thick: beyond
// ~260 m it is under a pixel and its mesh would be hit or missed by the samples, crawling as the view moves. Here it
// is a line of its true width laid over the frame in display light, like the lamps (fener.vert): each pixel is
// covered by the exact share of it the line crosses, so the line's darkening summed across it is the same at any
// sub-pixel place. Its colour is the mast's own (dark steel lit by the fog) seen through the fog to it, tonemapped
// once for the whole line. Drawn only for facilities whose mesh leaves the mast out (salon.js, the void's detail).
precision highp float;
layout(location = 0) in vec4 aLamp;    // the lamp's centre xyz (m), its globe's radius (m)
layout(location = 1) in vec4 aCol;     // (the lamp's colour: not used here)
layout(location = 2) in vec4 aMast;    // x: 1 when this facility's mast is drawn here
uniform vec3 uEye, uCamF, uCamR, uCamU;
uniform vec2 uTan;
uniform vec2 uSize;            // this target (canvas pixels)
uniform float uPxAngle;        // radians per canvas pixel
uniform float uSigma;          // the fog's extinction (1/m)
uniform float uExposure;       // as fener.vert's
uniform vec3 uFogUp, uFogDown;
uniform vec3 uMastL;           // the mast's own radiance, lit by the fog (scene units)
uniform vec3 uMastS;           // its length below the lamp's centre (m), its width (m), the lamp's foot (m)
out vec2 vP;                   // pixels across the mast's axis, pixels along it from its foot
flat out vec4 vShape;          // the half width (px), the length (px), the mast's view depth (m), -
flat out vec3 vCol;            // a fully covered pixel's display light
vec3 agxContrast(vec3 x) {
    vec3 x2 = x * x, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agxDisplay(vec3 c) {      // post.frag's agxEncoded, then to display light (as fener.vert)
    mat3 inm = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772,
                    0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
    mat3 outm = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417,
                     -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
    const float minEv = -12.47393, maxEv = 4.026069;
    vec3 v = clamp(log2(max(inm * c, vec3(1e-10))), minEv, maxEv);
    v = agxContrast((v - minEv) / (maxEv - minEv));
    return pow(clamp(outm * v, 0.0, 1.0), vec3(2.2));
}
vec3 fogSky(float y) { float t = smoothstep(-0.9, 0.9, y); return mix(uFogDown, uFogUp, t * t); }   // post.frag's
vec2 toPx(vec3 q, float z) { return (vec2(dot(q, uCamR) / (z * uTan.x), dot(q, uCamU) / (z * uTan.y)) * 0.5 + 0.5) * uSize; }
void main() {
    int id = gl_VertexID;      // two triangles: 0 (-1,-1) 1 (1,-1) 2 (-1,1) 3 (-1,1) 4 (1,-1) 5 (1,1)
    vec2 corner = id == 0 ? vec2(-1, -1) : id == 1 ? vec2(1, -1) : id == 2 ? vec2(-1, 1) : id == 3 ? vec2(-1, 1) : id == 4 ? vec2(1, -1) : vec2(1, 1);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vP = vec2(0.0); vShape = vec4(0.0); vCol = vec3(0.0);
    vec3 top = aLamp.xyz - vec3(0.0, aLamp.w + uMastS.z, 0.0);
    vec3 foot = aLamp.xyz - vec3(0.0, uMastS.x, 0.0);
    vec3 qt = top - uEye, qf = foot - uEye;
    float zt = dot(qt, uCamF), zf = dot(qf, uCamF);
    if (aMast.x < 0.5 || zt < 1.0 || zf < 1.0) return;
    vec2 pt = toPx(qt, zt), pf = toPx(qf, zf);
    vec2 ax = pt - pf;
    float L = length(ax);
    if (L < 1e-3) return;
    vec2 u = ax / L, n = vec2(-u.y, u.x);
    vec3 qm = 0.5 * (qt + qf);
    float d = length(qm);
    float hw = 0.5 * uMastS.y / d / uPxAngle;
    // its light: the steel through the fog to it, over the fog's own light along the view (the background it hides)
    float T = exp(-uSigma * d);
    vCol = agxDisplay((uMastL * T + fogSky(qm.y / d) * (1.0 - T)) * uExposure);
    vShape = vec4(hw, L, dot(qm, uCamF), 0.0);
    // the quad: the segment, a pixel and a half wider each side and a pixel longer each end (the coverage's reach)
    float across = corner.x * (hw + 1.5), along = corner.y > 0.0 ? L + 1.0 : -1.0;
    vP = vec2(across, along);
    vec2 p = pf + u * along + n * across;
    gl_Position = vec4(p / uSize * 2.0 - 1.0, 0.0, 1.0);
}
