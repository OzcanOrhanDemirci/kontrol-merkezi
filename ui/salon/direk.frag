// The far masts (direk.vert): each pixel covered by the exact share of it the line crosses (its area: across the
// pixel's width times along its height), over what is behind it (premultiplied: blend ONE, ONE_MINUS_SRC_ALPHA; the
// resolve lays the target over the frame, post.frag). What stands in front of the mast hides it.
precision highp float;
in vec2 vP;
flat in vec4 vShape;
flat in vec3 vCol;
layout(location = 0) out vec4 outColor;
uniform vec2 uNearFar;
uniform vec2 uSize;
uniform sampler2D uDepth;      // the scene's depth (its own resolution)
float viewZd(float d) { float n = uNearFar.x, f = uNearFar.y; return 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n)); }
void main() {
    float hw = vShape.x, L = vShape.y, z = vShape.z;
    float ax = clamp(min(vP.x + 0.5, hw) - max(vP.x - 0.5, -hw), 0.0, 1.0);
    float ay = clamp(min(vP.y + 0.5, L) - max(vP.y - 0.5, 0.0), 0.0, 1.0);
    vec2 ds = vec2(textureSize(uDepth, 0));
    float sz = viewZd(texelFetch(uDepth, ivec2(clamp(gl_FragCoord.xy / uSize * ds, vec2(0.0), ds - 1.0)), 0).r);
    float eps = 3.0 * z * z / (uNearFar.x * 16777216.0);   // the depth's step there (fener.vert)
    float a = ax * ay * smoothstep(z - 6.0 - eps, z - 2.0 - eps, sz);
    outColor = vec4(vCol * a, a);
}
