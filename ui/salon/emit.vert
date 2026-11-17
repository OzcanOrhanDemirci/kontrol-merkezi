// The small emitters' footprints (lamp lenses; docs/SALON.md, "The live renderer", 1): one instance per emitter, a
// screen-space quad over its projected rectangle widened by 3 sigma. salon.js projects every emitter on the CPU each
// frame into a float table (uEmitTab rows uRow .. uRow + 2, see salon.js emitterTable). Its visibility: nine points
// spread over the lens' own box (rows uBoxRow ..), each projected and compared with the pass' depth there, so a lens
// half behind a column or a plinth shows half its light, and what hides it is the geometry the lens itself is drawn
// against, not the footprint's spread (the floor round a floor lamp, the ledge under a strip).
// A flat lens (a plate with one emitting side) is hidden at a point only by a surface on its emitting side: the texel
// under a point is put back in the world through its own centre's ray, and what lies behind the lens' plane (its own
// housing and the floor round it) hides nothing. Seen at a grazing angle a floor lamp's lens is a texel tall, and the
// texel under a point is as often its housing's rim or front face, nearer by more than any depth tolerance: the
// points' share stepped in ninths as the camera moved (11-17, Özcan: the floor lamps still flicker while walking).
precision highp float;
precision highp sampler2D;
uniform sampler2D uEmitTab;
uniform int uRow;
uniform vec2 uTarget;          // this target's size (px)
uniform int uBoxRow;
uniform mat4 uVP;
uniform sampler2D uDepth;
uniform vec2 uNearFar;
uniform vec3 uEye, uCamF, uCamR, uCamU;
uniform vec2 uTan;             // tan of the half field of view (x, y)
out vec2 vPx;                  // the fragment's offset from the centre along the rectangle's axes (target px)
flat out vec3 vL;              // radiance x the footprint's share
flat out vec3 vShape;          // half sizes h1, h2 and sigma (target px)
flat out vec4 vM, vMi;         // the lens on screen: its two half axes (target px) as a 2 x 2 matrix, and its inverse
flat out vec4 vO;              // its centre (target px), 1 / view depth there, the depth tolerance (m)
flat out vec2 vIw;             // the change of 1 / view depth along the two half axes
flat out vec4 vN;              // a flat lens' plane (emitting normal, offset); 0 when it is not flat
flat out float vExt;           // its larger extent on screen (target px)
flat out float vVis;           // the share of the nine points on the lens that are seen
float lin(float d) { float n = uNearFar.x, f = uNearFar.y; return 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n)); }
void main() {
    int i = gl_InstanceID;
    vec4 a = texelFetch(uEmitTab, ivec2(i, uRow), 0);        // centre (target px), h1, h2
    vec4 b = texelFetch(uEmitTab, ivec2(i, uRow + 1), 0);    // axis e1, sigma, view depth of the lens' front
    vec4 c = texelFetch(uEmitTab, ivec2(i, uRow + 2), 0);    // radiance x the footprint's share, depth tolerance (m)
    vec2 e1 = b.xy, e2 = vec2(-b.y, b.x);
    float sig = b.z;
    vShape = vec3(a.z, a.w, sig);
    vL = c.rgb;
    vPx = vec2(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);                  // culled unless it is drawn
    if (c.r + c.g + c.b <= 0.0) return;
    vec4 bw = texelFetch(uEmitTab, ivec2(i, uBoxRow), 0);
    vec3 bc = bw.xyz;
    vec3 nrm = texelFetch(uEmitTab, ivec2(i, uBoxRow + 4), 0).xyz;   // a flat lens' emitting side (bw.w = 1)
    vec3 ax[3];
    for (int k = 0; k < 3; k++) ax[k] = texelFetch(uEmitTab, ivec2(i, uBoxRow + 1 + k), 0).xyz;
    float l0 = length(ax[0]), l1 = length(ax[1]), l2 = length(ax[2]);
    // the two longest axes span the points; the shortest is the tolerance's share
    vec3 u = ax[0], w = ax[1];
    float thin = l2;
    if (l0 <= l1 && l0 <= l2) { u = ax[1]; w = ax[2]; thin = l0; }
    else if (l1 <= l0 && l1 <= l2) { u = ax[0]; w = ax[2]; thin = l1; }
    ivec2 sz = textureSize(uDepth, 0);
    float vis = 0.0;
    for (int k = 0; k < 9; k++) {
        vec3 q = bc + u * (0.6 * float(k % 3 - 1)) + w * (0.6 * float(k / 3 - 1));
        vec4 h = uVP * vec4(q, 1.0);
        if (h.w <= 0.0) continue;
        ivec2 t = clamp(ivec2(floor((h.xy / h.w * 0.5 + 0.5) * uTarget)), ivec2(0), sz - 1);
        float zt = lin(texelFetch(uDepth, t, 0).r);
        bool hid = zt < h.w - (thin + 0.015 + 0.002 * h.w);
        if (hid && bw.w > 0.5) {
            vec2 nd = (vec2(t) + 0.5) / uTarget * 2.0 - 1.0;
            vec3 p = uEye + (uCamF + uCamR * (nd.x * uTan.x) + uCamU * (nd.y * uTan.y)) * zt;
            hid = dot(nrm, p - bc) > 0.01;
        }
        vis += hid ? 0.0 : 1.0 / 9.0;
    }
    if (vis <= 0.0) return;
    // a lens a few pixels across keeps the nine points' share; a larger footprint is tested per fragment (emit.frag):
    // each fragment takes its nearest point on the lens and that point's own texel, so an edge sliding over the lens
    // uncovers it texel by texel as it would its geometry (the share of nine points stepped in thirds as a lamp came
    // out from behind a column), and one value for a 13 m strip drew its hidden part over the shutter and the grille
    vVis = vis;
    vec3 ul = length(u) >= length(w) ? u : w, us = length(u) >= length(w) ? w : u;
    vec4 h0 = uVP * vec4(bc - ul, 1.0), h1 = uVP * vec4(bc + ul, 1.0);
    vec4 hc = uVP * vec4(bc, 1.0), hs = uVP * vec4(bc + us, 1.0);
    h0.w = max(h0.w, 1e-3); h1.w = max(h1.w, 1e-3); hc.w = max(hc.w, 1e-3); hs.w = max(hs.w, 1e-3);
    vec2 p0 = (h0.xy / h0.w * 0.5 + 0.5) * uTarget, p1 = (h1.xy / h1.w * 0.5 + 0.5) * uTarget;
    vec2 ma = 0.5 * (p1 - p0);                               // the lens on screen: centre + M st, st in [-1, 1]^2
    vec2 mb = (hs.xy / hs.w - hc.xy / hc.w) * 0.5 * uTarget;
    float det = ma.x * mb.y - ma.y * mb.x;
    if (abs(det) > 1e-3 * (dot(ma, ma) + dot(mb, mb))) vMi = vec4(mb.y, -ma.y, -mb.x, ma.x) / det;   // inverse(mat2(ma, mb))
    else { mb = vec2(0.0); vMi = vec4(ma.x, 0.0, ma.y, 0.0) / max(dot(ma, ma), 1e-6); }               // edge-on: its long axis
    vM = vec4(ma, mb);
    vO = vec4(0.5 * (p0 + p1), 0.5 * (1.0 / h0.w + 1.0 / h1.w), thin + 0.015 + 0.002 * max(h0.w, h1.w));
    vIw = vec2(0.5 * (1.0 / h1.w - 1.0 / h0.w), 1.0 / hs.w - 1.0 / hc.w);
    vN = bw.w > 0.5 ? vec4(nrm, dot(nrm, bc)) : vec4(0.0);
    vExt = 2.0 * max(length(ma), length(mb));
    int v = gl_VertexID;                                     // two triangles: corners (-1,-1) (1,-1) (1,1) (-1,1)
    vec2 s = vec2(v == 1 || v == 2 || v == 4 ? 1.0 : -1.0, v == 2 || v == 4 || v == 5 ? 1.0 : -1.0);
    vPx = s * (vec2(a.z, a.w) + 3.0 * sig);
    vec2 p = a.xy + e1 * vPx.x + e2 * vPx.y;
    gl_Position = vec4(p / uTarget * 2.0 - 1.0, 0.0, 1.0);
}
