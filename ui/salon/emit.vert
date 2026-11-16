// The small emitters' footprints (lamp lenses; docs/SALON.md, "The live renderer", 1): one instance per emitter, a
// screen-space quad over its projected rectangle widened by 3 sigma. salon.js projects every emitter on the CPU each
// frame into a float table (uEmitTab rows uRow .. uRow + 2, see salon.js emitterTable). Its visibility: nine points
// spread over the lens' own box (rows uBoxRow ..), each projected and compared with the pass' depth there, so a lens
// half behind a column or a plinth shows half its light, and what hides it is the geometry the lens itself is drawn
// against, not the footprint's spread (the floor round a floor lamp, the ledge under a strip).
precision highp float;
precision highp sampler2D;
uniform sampler2D uEmitTab;
uniform int uRow;
uniform vec2 uTarget;          // this target's size (px)
uniform int uBoxRow;
uniform mat4 uVP;
uniform sampler2D uDepth;
uniform vec2 uNearFar;
out vec2 vPx;                  // the fragment's offset from the centre along the rectangle's axes (target px)
flat out vec3 vL;              // radiance x the footprint's share
flat out vec3 vShape;          // half sizes h1, h2 and sigma (target px)
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
    vec3 bc = texelFetch(uEmitTab, ivec2(i, uBoxRow), 0).xyz;
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
        vis += lin(texelFetch(uDepth, t, 0).r) >= h.w - (thin + 0.015 + 0.002 * h.w) ? 1.0 / 9.0 : 0.0;
    }
    if (vis <= 0.0) return;
    vL *= vis;
    int v = gl_VertexID;                                     // two triangles: corners (-1,-1) (1,-1) (1,1) (-1,1)
    vec2 s = vec2(v == 1 || v == 2 || v == 4 ? 1.0 : -1.0, v == 2 || v == 4 || v == 5 ? 1.0 : -1.0);
    vPx = s * (vec2(a.z, a.w) + 3.0 * sig);
    vec2 p = a.xy + e1 * vPx.x + e2 * vPx.y;
    gl_Position = vec4(p / uTarget * 2.0 - 1.0, 0.0, 1.0);
}
