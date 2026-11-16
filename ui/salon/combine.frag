// The volumes combined with the light groups' live colours, one z slice of one volume per draw (see common.glsl):
// x in [0, nx): Mc and air; [nx, 2nx): K_r; [2nx, 3nx): K_g; [3nx, 4nx): K_b. Run only when a colour changes.
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler3D uRaw;        // the pack's volume: M | F along x, the groups stacked along z
uniform vec3 uGroup[3];
uniform ivec3 uN;              // cells per axis
uniform int uZ;                // the slice
layout(location = 0) out vec4 outColor;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int part = p.x / uN.x, x = p.x - part * uN.x;
    vec3 M = vec3(0.0), K = vec3(0.0);
    float open = 0.0;
    for (int g = 0; g < 3; g++) {
        vec4 m = texelFetch(uRaw, ivec3(x, p.y, uZ + g * uN.z), 0);
        vec3 f = texelFetch(uRaw, ivec3(x + uN.x, p.y, uZ + g * uN.z), 0).xyz;
        vec3 c = uGroup[g];
        M += c * m.rgb;
        if (g == 0) open = m.a;
        float l = max(dot(m.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-8);
        if (part > 0) K += c[part - 1] * (m[part - 1] / l) * f;
    }
    vec4 o = part == 0 ? vec4(M, open) : vec4(K, 0.0);
    outColor = (any(isnan(o)) || any(isinf(o))) ? vec4(0.0) : o;
}
