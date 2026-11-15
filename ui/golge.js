// Kontrol Merkezi: shaders.
// The scene is path traced on analytic geometry (planes, boxes, tubes, a bladed rotor plane):
// next-event estimation from every emitter (84 halo LEDs, keyboard strip, fan bore rings, toggle,
// a dim softbox), one indirect bounce, GGX glossy floor with MIS, smoked glass handled as a thin
// sheet (deterministic reflection of emitters + tinted transmission). Every frame traces a fixed
// number of jittered samples per pixel and blends them into a float accumulation buffer, so a still
// camera converges to a noise-free, brute-force supersampled image; sample time is stratified across
// the shutter, which gives the rotors true motion blur.
// FXC (ANGLE D3D11) inlines every call site, so the whole path is one loop with uniform bounds and a
// single trace() and a single shade call: first-frame compile time stays short.
'use strict';
window.KM_GOLGE = {};

KM_GOLGE.vsFull = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

KM_GOLGE.fsTrace = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;

uniform vec2 uRes;
uniform vec4 uRect;                 // pixel offset of this draw (scissor origin) and full size
uniform vec3 uCamPos, uCamR, uCamU, uCamF;
uniform float uFocal;
uniform int uSpp, uSppDyn, uIter;
uniform uint uSeed;
uniform float uAlphaA, uAlphaB;
uniform vec2 uAlphaDyn;             // history weight on each fan face (slow rotor: short, fast blur disc: longer)
uniform vec3 uHubCol;
uniform float uShutter;
uniform vec2 uRotA, uRotW;
uniform vec3 uHalo[84];
uniform float uHaloCdf[84];
uniform vec3 uKbd[10];
uniform float uLightCdf[6];
uniform vec3 uSoftCol;
uniform vec3 uRingCol[2];
uniform vec3 uTogCol;
uniform vec3 uStopCol[6];
uniform float uStopT[6];
uniform vec4 uScale;                // tMin, tMax, marker temperature, inlay brightness
uniform vec3 uMarkCol;
uniform float uFill;                // filled gauge brightness
uniform vec3 uPush;                 // button travel (cm): kasa, gpu, toggle

#define PI 3.14159265
#define TAU 6.28318531
#define EPS 0.002
#define FAR 1e9

// ---- scene (centimetres; z up, camera on -y looking +y)
const vec3 HC = vec3(0.0, 24.0, 27.5);          // halo centre
const float HR0 = 20.6, HR1 = 23.4, HD = 1.6;  // halo light guide
const float BR0 = 24.1, BR1 = 25.7, BD = 0.9;  // titanium scale band
const float TR0 = 3.3, TR1 = 4.3, TD = 1.1;    // toggle bezel
const vec3 PC = vec3(0.0, 0.0, 1.6), PH = vec3(17.5, 6.5, 1.6);   // plinth
const vec3 FCL0 = vec3(-7.6, 0.6, 9.25), FCR0 = vec3(7.6, 0.6, 9.25);
vec3 FCL, FCR;
const vec3 FH = vec3(6.0, 1.3, 6.0);
const float FBR = 5.72, RY = 0.15, HUBR = 1.95, TIPR = 5.5, GY = -1.38, GH = 5.92;
const float BANDY0 = -1.3, BANDY1 = -0.92;
const vec3 SBC = vec3(0.0, -38.0, 88.0);
const vec3 SBN = vec3(0.0, 0.3807, -0.9247);
const vec3 SBU = vec3(1.0, 0.0, 0.0), SBV = vec3(0.0, 0.9247, 0.3807);
const vec2 SBH = vec2(42.0, 16.0);
const float KX = 15.2, KZ0 = 1.18, KZ1 = 1.42, KY = -6.5;

const int M_FLOOR = 1, M_PLINTH = 2, M_FRAME = 3, M_ROTOR = 4, M_TI = 5, M_GLASS = 6, M_HALO = 7, M_BAND = 8, M_TOG = 9, M_HUB = 10;

uint gS;
float gTime;
uint pcg() { gS = gS * 747796405u + 2891336453u; uint w = ((gS >> ((gS >> 28u) + 4u)) ^ gS) * 277803737u; return (w >> 22u) ^ w; }
float rnd() { return float(pcg() >> 8) * (1.0 / 16777216.0); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float sat(float x) { return clamp(x, 0.0, 1.0); }

// ---- intersection helpers
vec3 safeInv(vec3 d) { return 1.0 / mix(d, vec3(1e-9), lessThan(abs(d), vec3(1e-9))); }

vec2 boxT(vec3 ro, vec3 inv, vec3 c, vec3 h, out vec3 n) {
  vec3 o = ro - c;
  vec3 t1 = (-h - o) * inv, t2 = (h - o) * inv;
  vec3 tn = min(t1, t2), tf = max(t1, t2);
  float a = max(max(tn.x, tn.y), tn.z), b = min(min(tf.x, tf.y), tf.z);
  n = -sign(inv) * step(tn.yzx, tn.xyz) * step(tn.zxy, tn.xyz);
  return vec2(a, b);
}
// infinite cylinder around an axis; o and d are the 2D components perpendicular to it
vec2 cylT(vec2 o, vec2 d, float r) {
  float a = dot(d, d), b = dot(o, d), c = dot(o, o) - r * r;
  if (a < 1e-12) return c < 0.0 ? vec2(-FAR, FAR) : vec2(FAR, -FAR);
  float h = b * b - a * c;
  if (h < 0.0) return vec2(FAR, -FAR);
  h = sqrt(h);
  return vec2(-b - h, -b + h) / a;
}
// hollow tube along y: radius r0..r1 (r0 <= 0: solid), half length hd
float tubeY(vec3 ro, vec3 rd, vec3 c, float r0, float r1, float hd, out vec3 n) {
  vec3 o = ro - c;
  float iy = 1.0 / (abs(rd.y) < 1e-9 ? 1e-9 : rd.y);
  float ya = (-hd - o.y) * iy, yb = (hd - o.y) * iy;
  float sa = min(ya, yb), sb = max(ya, yb);
  vec2 to = cylT(o.xz, rd.xz, r1);
  float a0 = max(sa, to.x), a1 = min(sb, to.y);
  n = vec3(0.0);
  if (a0 > a1 || a1 < EPS) return FAR;
  vec2 ti = r0 > 0.0 ? cylT(o.xz, rd.xz, r0) : vec2(FAR, -FAR);
  float t;
  if (a0 > EPS && !(a0 > ti.x && a0 < ti.y)) {
    t = a0;
    if (sa > to.x) n = vec3(0.0, -sign(rd.y), 0.0);
    else { vec3 p = o + rd * t; n = vec3(p.x, 0.0, p.z) / r1; }
  } else {
    t = ti.y;
    if (t <= EPS || t >= a1) return FAR;
    vec3 p = o + rd * t; n = -vec3(p.x, 0.0, p.z) / r0;
  }
  return t;
}
// fan frame: box minus a bore along y
float frameT(vec3 ro, vec3 rd, vec3 inv, vec3 c, out vec3 n) {
  vec3 bn;
  vec2 tb = boxT(ro, inv, c, FH, bn);
  n = vec3(0.0);
  if (tb.x > tb.y || tb.y < EPS) return FAR;
  vec3 o = ro - c;
  vec2 tc = cylT(o.xz, rd.xz, FBR);
  if (tb.x > EPS && !(tb.x > tc.x && tb.x < tc.y)) { n = bn; return tb.x; }
  float s0 = max(tb.x, EPS);
  if (tc.y > s0 && tc.y < tb.y) { vec3 p = o + rd * tc.y; n = -vec3(p.x, 0.0, p.z) / FBR; return tc.y; }
  return FAR;
}
// rotor blades: a pitched, swept, 7-bladed plane; angle depends on the sample time
float rotorT(vec3 ro, vec3 rd, vec3 c, float ang, out vec3 n) {
  n = vec3(0.0);
  float t = (c.y + RY - ro.y) / (abs(rd.y) < 1e-9 ? 1e-9 : rd.y);
  if (t < 0.01) return FAR;
  vec3 q = ro + rd * t - c;
  float r = length(q.xz);
  if (r < HUBR - 0.05 || r > TIPR) return FAR;
  float ph = atan(q.z, q.x);
  float x = (r - HUBR) / (TIPR - HUBR);
  float sweep = 0.55 * x * x + 0.18 * x;
  float u = fract((ph - ang + sweep) * (7.0 / TAU));
  float cov = mix(0.66, 0.52, x);
  float tipRound = sqrt(max(0.0, 1.0 - pow(max(0.0, (r - (TIPR - 0.6)) / 0.6), 2.0)));
  float lo = 0.5 * cov * (1.0 - tipRound), hi = cov - lo;
  if (u < lo || u > hi) return FAR;
  float s = (u - lo) / max(1e-4, hi - lo);
  vec2 tg = vec2(-sin(ph), cos(ph));
  float pitch = mix(0.95, 0.35, s) * mix(1.0, 0.75, x);
  n = normalize(vec3(tg.x * sin(pitch), -cos(pitch), tg.y * sin(pitch)));
  return t;
}
float glassT(vec3 ro, vec3 rd, vec3 c) {
  float t = (c.y + GY - ro.y) / (abs(rd.y) < 1e-9 ? 1e-9 : rd.y);
  if (t < EPS) return FAR;
  vec3 q = ro + rd * t - c;
  vec2 d = abs(q.xz) - vec2(GH - 0.9);
  float sd = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - 0.9;
  return sd < 0.0 ? t : FAR;
}
// spoke along x through the toggle: infinite x-cylinder, clipped in x
float spokeT(vec3 ro, vec3 rd, out vec3 n) {
  n = vec3(0.0);
  vec2 o = ro.yz - HC.yz;
  vec2 tc = cylT(o, rd.yz, 0.3);
  float t = tc.x;
  if (t < EPS || t > 1e8) return FAR;
  float x = abs(ro.x + rd.x * t - HC.x);
  if (x < TR1 - 0.1 || x > HR0 + 0.1) return FAR;
  vec2 p = o + rd.yz * t;
  n = vec3(0.0, p / 0.3);
  return t;
}

// result of trace
float hT; vec3 hN; int hM; int hF;
void take(float t, vec3 n, int m, int f) { if (t < hT) { hT = t; hN = n; hM = m; hF = f; } }

void trace(vec3 ro, vec3 rd, float tmax) {
  hT = tmax; hM = 0; hF = 0; hN = vec3(0.0, 0.0, 1.0);
  vec3 inv = safeInv(rd);
  vec3 n;
  if (rd.z < 0.0) take(-ro.z / rd.z, vec3(0.0, 0.0, 1.0), M_FLOOR, 0);
  // fan group bounding box
  vec3 bn;
  vec2 gb = boxT(ro, inv, vec3(0.0, 0.0, 7.7), vec3(17.6, 6.6, 7.8), bn);
  if (gb.x < gb.y && gb.y > 0.0 && gb.x < hT) {
    vec2 tb = boxT(ro, inv, PC, PH, bn);
    if (tb.x < tb.y && tb.x > EPS) take(tb.x, bn, M_PLINTH, 0);
    take(frameT(ro, rd, inv, FCL, n), n, M_FRAME, 0);
    take(frameT(ro, rd, inv, FCR, n), n, M_FRAME, 1);
    take(rotorT(ro, rd, FCL, uRotA.x + uRotW.x * gTime, n), n, M_ROTOR, 0);
    take(rotorT(ro, rd, FCR, uRotA.y + uRotW.y * gTime, n), n, M_ROTOR, 1);
    take(tubeY(ro, rd, FCL + vec3(0.0, RY - 0.25, 0.0), 0.0, HUBR, 0.42, n), n, M_HUB, 0);
    take(tubeY(ro, rd, FCR + vec3(0.0, RY - 0.25, 0.0), 0.0, HUBR, 0.42, n), n, M_HUB, 1);
    take(glassT(ro, rd, FCL), vec3(0.0, -1.0, 0.0), M_GLASS, 0);
    take(glassT(ro, rd, FCR), vec3(0.0, -1.0, 0.0), M_GLASS, 1);
  }
  // halo group bounding box
  vec2 hb = boxT(ro, inv, HC, vec3(BR1 + 0.1, HD + 0.1, BR1 + 0.1), bn);
  if (hb.x < hb.y && hb.y > 0.0 && hb.x < hT) {
    take(tubeY(ro, rd, HC, HR0, HR1, HD, n), n, M_HALO, 0);
    take(tubeY(ro, rd, HC, BR0, BR1, BD, n), n, M_BAND, 0);
    take(tubeY(ro, rd, HC, TR0, TR1, TD, n), n, M_TI, 0);
    take(tubeY(ro, rd, HC + vec3(0.0, 0.25 + uPush.z, 0.0), 0.0, TR0, 0.35, n), n, M_TOG, 0);
    take(spokeT(ro, rd, n), n, M_TI, 1);
  }
}

// ---- emission
float haloX(vec3 p) {        // continuous LED index 0..84, LED 0 at the top, clockwise seen from the front
  float ph = atan(p.z - HC.z, p.x - HC.x);
  return fract(0.25 - ph / TAU) * 84.0;
}
vec3 haloLed(float x) {
  float y = x - 0.5;
  float k = floor(y), f = y - k;
  int i0 = int(mod(k, 84.0)), i1 = int(mod(k + 1.0, 84.0));
  vec3 c = mix(uHalo[i0], uHalo[i1], f * f * (3.0 - 2.0 * f));
  return c * (0.86 + 0.14 * cos(TAU * f));
}
vec3 haloEmit(vec3 p, vec3 n) {
  vec3 c = haloLed(haloX(p));
  float r = length(p.xz - HC.xz);
  float m = (r - HR0) / (HR1 - HR0);
  float prof = abs(n.y) > 0.5 ? 0.62 + 0.38 * (1.0 - pow(2.0 * m - 1.0, 2.0)) : 0.45;
  return c * prof;
}
float scaleTemp(vec3 p) {   // temperature at a point on the band (arc over the top, cold on the left)
  float ph = atan(p.z - HC.z, p.x - HC.x);
  float a = (ph - 0.5 * PI) / (0.45 * PI);     // +1 left end, -1 right end
  return mix(uScale.x, uScale.y, 0.5 - 0.5 * a);
}
vec3 stopColor(float t) {
  vec3 c = uStopCol[0];
  for (int i = 1; i < 6; i++) {
    float k = sat((t - uStopT[i - 1]) / max(0.01, uStopT[i] - uStopT[i - 1]));
    c = mix(c, uStopCol[i], k * k * (3.0 - 2.0 * k));
  }
  return c;
}
// band: titanium with a lacquer-filled gradient inlay and engraved ticks; returns emission (inlay)
vec3 bandEmit(vec3 p, vec3 n, out float tick) {
  tick = 0.0;
  if (n.y > -0.5) return vec3(0.0);
  float r = length(p.xz - HC.xz);
  float ph = atan(p.z - HC.z, p.x - HC.x);
  float a = (ph - 0.5 * PI) / (0.45 * PI);
  if (abs(a) > 1.0 || p.z < HC.z) return vec3(0.0);
  float t = scaleTemp(p);
  // ticks every 1 C, longer every 5 C, at the outer part of the band
  float tc = t - floor(t + 0.5);
  float tw = 0.06 * (r / 25.0);
  float major = step(abs(mod(floor(t + 0.5), 5.0)), 0.01);
  if (abs(tc) < tw * (1.0 + major) && r > (major > 0.5 ? 24.85 : 25.15) && r < 25.55) tick = 1.0;
  if (r > 24.3 && r < 24.65) {
    vec3 c = stopColor(t) * uScale.w;
    float fill = t < uScale.z ? uFill : 0.0;
    c *= 1.0 + fill;
    float dm = abs(t - uScale.z);
    c += uMarkCol * smoothstep(0.55, 0.25, dm) * 1.0;
    return c;
  }
  // marker notch above the inlay
  float dm = abs(t - uScale.z);
  if (r > 24.65 && r < 25.6 && dm < 0.22) return uMarkCol * 1.4;
  return vec3(0.0);
}
vec3 kbdEmit(vec3 p) {
  float x = clamp((p.x + KX) / (2.0 * KX), 0.0, 0.9999) * 10.0;
  float k = floor(x), f = x - k;
  vec3 c = uKbd[int(k)];
  return c * (0.75 + 0.25 * sin(PI * f));
}
float glyph(vec2 q) {          // power symbol on the toggle, q in toggle radii
  float r = length(q);
  float ring = abs(r - 0.42) - 0.045;
  float gap = abs(atan(q.x, q.y)) < 0.62 ? 1.0 : 0.0;
  float d = max(ring, -1.0) + gap * 1.0;
  float bar = max(abs(q.x) - 0.045, abs(q.y - 0.3) - 0.2);
  return step(min(d, bar), 0.0);
}

// emission seen along a ray hitting (m, p, n); nee = true if this emitter is covered by NEE
vec3 emission(int m, int f, vec3 p, vec3 n, out bool nee, out bool pure) {
  nee = false; pure = false;
  if (m == M_HALO) { pure = true; nee = abs(n.y) > 0.5; return haloEmit(p, n); }
  if (m == M_TOG) {
    pure = true;
    if (n.y > -0.5) return vec3(0.0);
    nee = true;
    vec2 q = (p.xz - HC.xz) / TR0;
    float g = glyph(q);
    float rr = length(q);
    return uTogCol * (0.55 + 0.45 * rr * rr) * (1.0 - 0.8 * g) + uTogCol * g * 0.0 + vec3(1.0, 0.97, 0.92) * g * (0.06 + 0.5 * lum(uTogCol));
  }
  if (m == M_PLINTH && n.y < -0.5 && abs(p.x) < KX && p.z > KZ0 && p.z < KZ1) { pure = true; nee = true; return kbdEmit(p); }
  if (m == M_FRAME) {
    vec3 c = f == 0 ? FCL : FCR;
    float ly = p.y - c.y;
    if (ly > BANDY0 && ly < BANDY1 && length(p.xz - c.xz) < FBR + 0.01) { pure = true; nee = true; return uRingCol[f]; }
  }
  if (m == M_HUB && n.y < -0.5) {
    float r = length(p.xz - (f == 0 ? FCL.xz : FCR.xz));
    if (r > 1.18 && r < 1.42) { pure = true; return uHubCol; }
  }
  if (m == M_BAND) { float tk; vec3 e = bandEmit(p, n, tk); if (max(e.x, max(e.y, e.z)) > 0.0) { pure = true; return e; } }
  return vec3(0.0);
}

// ---- light sampling (NEE). Returns radiance; wi, dist, pdf (solid angle, includes group choice)
const float BANDLEN = BANDY1 - BANDY0;
float groupP(int g) { return uLightCdf[g] - (g > 0 ? uLightCdf[g - 1] : 0.0); }
float haloSegP(int k) { return uHaloCdf[k] - (k > 0 ? uHaloCdf[k - 1] : 0.0); }

vec3 sampleLight(vec3 p, out vec3 wi, out float dist, out float pdf) {
  pdf = 0.0; wi = vec3(0.0, 0.0, 1.0); dist = 0.0;
  float u0 = rnd(), u1 = rnd(), u2 = rnd();
  int g = 0;
  for (int i = 0; i < 5; i++) if (u0 > uLightCdf[i]) g = i + 1;
  vec3 q, nl, Le;
  float pa;
  if (g == 0) {
    int lo = 0, hi = 83;
    for (int i = 0; i < 7; i++) { int mid = (lo + hi) >> 1; if (u1 > uHaloCdf[mid]) lo = mid + 1; else hi = mid; }
    int k = lo;
    float x = float(k) + u2;
    float ph = TAU * (0.25 - x / 84.0);
    float r = sqrt(mix(HR0 * HR0, HR1 * HR1, rnd()));
    float s = p.y < HC.y ? -1.0 : 1.0;
    q = HC + vec3(r * cos(ph), s * HD, r * sin(ph));
    nl = vec3(0.0, s, 0.0);
    Le = haloEmit(q, nl);
    pa = haloSegP(k) / ((TAU / 84.0) * 0.5 * (HR1 * HR1 - HR0 * HR0));
  } else if (g == 1) {
    q = SBC + SBU * (2.0 * u1 - 1.0) * SBH.x + SBV * (2.0 * u2 - 1.0) * SBH.y;
    nl = SBN; Le = uSoftCol; pa = 1.0 / (4.0 * SBH.x * SBH.y);
  } else if (g == 2 || g == 3) {
    vec3 c = g == 2 ? FCL : FCR;
    float th = TAU * u1;
    q = c + vec3(FBR * cos(th), BANDY0 + BANDLEN * u2, FBR * sin(th));
    nl = -vec3(cos(th), 0.0, sin(th));
    Le = uRingCol[g - 2]; pa = 1.0 / (TAU * FBR * BANDLEN);
  } else if (g == 4) {
    q = vec3(-KX + 2.0 * KX * u1, KY, mix(KZ0, KZ1, u2));
    nl = vec3(0.0, -1.0, 0.0); Le = kbdEmit(q); pa = 1.0 / (2.0 * KX * (KZ1 - KZ0));
  } else {
    float r = TR0 * sqrt(u1), th = TAU * u2;
    q = HC + vec3(r * cos(th), 0.25 - 0.35, r * sin(th));
    nl = vec3(0.0, -1.0, 0.0);
    bool a, b;
    Le = emission(M_TOG, 0, q, nl, a, b);
    pa = 1.0 / (PI * TR0 * TR0);
  }
  vec3 d = q - p;
  float d2 = dot(d, d);
  dist = sqrt(d2);
  wi = d / dist;
  float cl = -dot(wi, nl);
  if (cl <= 1e-4) return vec3(0.0);
  pdf = groupP(g) * pa * d2 / cl;
  return Le;
}
// pdf with which sampleLight would produce the point p on emitter (m, f) seen from x
float lightPdf(int m, int f, vec3 p, vec3 n, vec3 x) {
  vec3 d = p - x; float d2 = dot(d, d);
  float cl = abs(dot(normalize(d), n));
  if (cl < 1e-4) return 0.0;
  float pa = 0.0;
  if (m == M_HALO) {
    int k = int(floor(haloX(p)));
    pa = groupP(0) * haloSegP(min(k, 83)) / ((TAU / 84.0) * 0.5 * (HR1 * HR1 - HR0 * HR0));
  } else if (m == M_TOG) pa = groupP(5) / (PI * TR0 * TR0);
  else if (m == M_PLINTH) pa = groupP(4) / (2.0 * KX * (KZ1 - KZ0));
  else if (m == M_FRAME) pa = groupP(2 + f) / (TAU * FBR * BANDLEN);
  return pa * d2 / cl;
}

// ---- materials
float gTr;   // diffuse transmission weight of the current material (frosted blades)
void material(int m, int f, vec3 p, inout vec3 n, out vec3 alb, out vec3 F0, out float a) {
  alb = vec3(0.02); F0 = vec3(0.04); a = 0.3; gTr = 0.0;
  if (m == M_FLOOR) {
    vec2 w = p.xy * 0.045;
    float sm = sin(w.x * 1.7 + sin(w.y * 1.3)) * sin(w.y * 1.9 + 0.7 * sin(w.x * 2.3));
    alb = vec3(0.006); F0 = vec3(0.045); a = 0.028 + 0.012 * sm;
  } else if (m == M_PLINTH || m == M_FRAME) {
    vec3 c = m == M_PLINTH ? PC : (f == 0 ? FCL : FCR);
    vec3 h = m == M_PLINTH ? PH : FH;
    vec3 q = p - c;
    // machined bevel: round the normal near box edges
    vec3 e = smoothstep(h - 0.14, h, abs(q)) * sign(q) * (1.0 - abs(n));
    if (dot(abs(n), vec3(1.0)) > 0.99 && abs(n.x) + abs(n.y) + abs(n.z) < 1.01) n = normalize(n + 1.4 * e);
    alb = vec3(0.014, 0.0145, 0.016); F0 = vec3(0.05); a = m == M_PLINTH ? 0.16 : 0.12;
    if (m == M_FRAME && length(q.xz) < FBR + 0.02) { a = 0.32; alb = vec3(0.01); }
  } else if (m == M_ROTOR) {
    alb = vec3(0.30, 0.31, 0.33); F0 = vec3(0.045); a = 0.22; gTr = 0.72;   // frosted, translucent like ARGB fan blades
  } else if (m == M_HUB || m == M_TI) {
    alb = vec3(0.0); F0 = vec3(0.56, 0.52, 0.47); a = m == M_HUB ? 0.07 : 0.11;
    if (m == M_HUB && n.y < -0.5) {           // domed cap with concentric machining
      vec2 q = p.xz - (f == 0 ? FCL.xz : FCR.xz);
      float r = length(q);
      n = normalize(n + vec3(q.x, 0.0, q.y) / HUBR * 0.75);
      a = 0.06 + 0.05 * (0.5 + 0.5 * sin(r * 60.0));
    }
  } else if (m == M_BAND) {
    alb = vec3(0.0); F0 = vec3(0.5, 0.47, 0.43); a = 0.13;
    float tk; bandEmit(p, n, tk);
    if (tk > 0.5) { alb = vec3(0.55); F0 = vec3(0.04); a = 0.5; }
  } else if (m == M_HALO || m == M_TOG) {
    alb = vec3(0.5); F0 = vec3(0.04); a = 0.6;
  }
}

vec3 bsdf(vec3 n, vec3 v, vec3 l, vec3 alb, vec3 F0, float a, float ps, out float pdf) {
  pdf = 0.0;
  float NL = dot(n, l), NV = dot(n, v);
  if (NV <= 0.0) return vec3(0.0);
  if (NL <= 0.0) {                       // light through a translucent sheet
    if (gTr <= 0.0) return vec3(0.0);
    pdf = (1.0 - ps) * gTr * -NL / PI;
    return alb * gTr * (1.0 / PI) * -NL;
  }
  vec3 h = normalize(v + l);
  float NH = max(dot(n, h), 0.0), VH = max(dot(v, h), 1e-4);
  float a2 = a * a;
  float dd = NH * NH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = a * 0.5;
  float G = NL / (NL * (1.0 - k) + k) * NV / (NV * (1.0 - k) + k);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VH, 5.0);
  vec3 spec = D * G * F / (4.0 * NL * NV);
  vec3 diff = alb * (1.0 / PI) * (1.0 - F);
  pdf = ps * D * NH / (4.0 * VH) + (1.0 - ps) * (1.0 - gTr) * NL / PI;
  return (spec + diff * (1.0 - gTr)) * NL;
}
vec3 sampleDir(vec3 n, vec3 v, float a, float ps) {
  vec3 t = normalize(abs(n.z) < 0.9 ? cross(n, vec3(0.0, 0.0, 1.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(n, t);
  float u1 = rnd(), u2 = rnd(), ph = TAU * u2;
  if (rnd() < ps) {
    float ct = sqrt((1.0 - u1) / (1.0 + (a * a - 1.0) * u1));
    float st = sqrt(max(0.0, 1.0 - ct * ct));
    vec3 h = t * (st * cos(ph)) + b * (st * sin(ph)) + n * ct;
    return reflect(-v, h);
  }
  float r = sqrt(u1);
  float side = rnd() < gTr ? -1.0 : 1.0;
  return t * (r * cos(ph)) + b * (r * sin(ph)) + n * (side * sqrt(max(0.0, 1.0 - u1)));
}

// emitters seen in a mirror direction (smoked glass): halo, toggle, keyboard strip
vec3 mirrorEmit(vec3 ro, vec3 rd) {
  trace(ro, rd, FAR);
  if (hM == M_HALO || hM == M_TOG || hM == M_BAND || hM == M_PLINTH || hM == M_FRAME) {
    vec3 p = ro + rd * hT; bool a, b;
    return emission(hM, hF, p, hN, a, b);
  }
  return vec3(0.0);
}

void main() {
  FCL = FCL0 + vec3(0.0, uPush.x, 0.0); FCR = FCR0 + vec3(0.0, uPush.y, 0.0);
  vec2 pix = gl_FragCoord.xy;
  gS = (uint(pix.x) * 1973u + uint(pix.y) * 9277u + uSeed * 26699u) | 1u;
  pcg(); pcg();
  // pixels showing the fan faces hold moving rotors: more samples, short history
  vec2 c0 = (2.0 * pix - uRes) / uRes.y;
  vec3 d0 = normalize(uCamF * uFocal + uCamR * c0.x + uCamU * c0.y);
  bool dynL = glassT(uCamPos, d0, FCL) < FAR, dynR = glassT(uCamPos, d0, FCR) < FAR;
  bool dyn = dynL || dynR;
  float aDyn = dynL ? uAlphaDyn.x : uAlphaDyn.y;
  int spp = dyn ? uSppDyn : uSpp;

  vec3 accA = vec3(0.0), accB = vec3(0.0);
  int s = 0;
  bool fresh = true, camRay = true, shadow = false, endAfterShadow = false;
  vec3 ro = vec3(0.0), rd = vec3(0.0), thr = vec3(1.0);
  float tmax = FAR;
  vec3 shC = vec3(0.0);          // shadow ray contribution if unoccluded
  vec3 nRo = vec3(0.0), nRd = vec3(0.0); // resume ray after shadow
  int depth = 0;
  float prevPdf = 0.0;
  vec3 prevP = vec3(0.0);

  for (int it = 0; it < uIter; it++) {
    if (fresh) {
      if (s >= spp) break;
      vec2 j = vec2(rnd(), rnd());
      vec2 c = (2.0 * (pix + j - 0.5) - uRes) / uRes.y;
      ro = uCamPos;
      rd = normalize(uCamF * uFocal + uCamR * c.x + uCamU * c.y);
      gTime = uShutter * ((float(s) + rnd()) / float(spp) - 0.5);
      thr = vec3(1.0); depth = 0; camRay = true; shadow = false; endAfterShadow = false;
      tmax = FAR; prevPdf = 0.0; fresh = false;
    }
    trace(ro, rd, tmax);
    if (shadow) {
      if (hM == M_GLASS) {                      // thin smoked glass lets shadow rays through, tinted
        shC *= vec3(0.30, 0.31, 0.33);
        ro = ro + rd * (hT + EPS); tmax -= hT + EPS;
        continue;
      }
      if (hM == 0) accA += shC;
      shadow = false;
      if (endAfterShadow) { s++; fresh = true; continue; }
      ro = nRo; rd = nRd; tmax = FAR;
      continue;
    }
    if (hM == 0) {                              // the velvet void
      s++; fresh = true; continue;
    }
    vec3 p = ro + rd * hT;
    vec3 n = hN;
    if (dot(n, rd) > 0.0) n = -n;
    if (hM == M_GLASS) {
      float cv = abs(dot(rd, n));
      float F = 0.04 + 0.96 * pow(1.0 - cv, 5.0);
      vec3 e = mirrorEmit(p + n * EPS, reflect(rd, n));
      if (camRay) accB += thr * F * e; else accA += thr * F * e;
      thr *= (1.0 - F) * vec3(0.30, 0.31, 0.33);
      ro = p + rd * EPS; tmax = FAR;
      continue;
    }
    bool nee, pure;
    vec3 E = emission(hM, hF, p, n, nee, pure);
    if (max(E.x, max(E.y, E.z)) > 0.0) {
      if (camRay) accB += thr * E;
      else {
        float w = 1.0;
        if (nee && depth == 1) { float pl = lightPdf(hM, hF, p, hN, prevP); w = prevPdf * prevPdf / (prevPdf * prevPdf + pl * pl); }
        vec3 c = thr * E * w;
        float lc = lum(c);
        accA += lc > 6.0 ? c * (6.0 / lc) : c;
      }
    }
    if (pure || depth >= 2) { s++; fresh = true; continue; }
    // shading vertex
    vec3 alb, F0; float a;
    material(hM, hF, p, n, alb, F0, a);
    vec3 v = -rd;
    float NV = max(dot(n, v), 1e-4);
    vec3 Fv = F0 + (1.0 - F0) * pow(1.0 - NV, 5.0);
    float ps = clamp(lum(Fv) / max(1e-4, lum(Fv) + lum(alb)), 0.15, 0.98);
    vec3 wi; float ld, lpdf;
    vec3 Le = sampleLight(p, wi, ld, lpdf);
    shC = vec3(0.0);
    if (lpdf > 0.0 && max(Le.x, max(Le.y, Le.z)) > 0.0) {
      float bp;
      vec3 f = bsdf(n, v, wi, alb, F0, a, ps, bp);
      float w = depth == 0 ? lpdf * lpdf / (lpdf * lpdf + bp * bp) : 1.0;
      shC = thr * f * Le * (w / lpdf);
      float lc = lum(shC);
      float cap = depth > 0 ? 6.0 : 30.0;
      if (lc > cap) shC *= cap / lc;
    }
    // next bounce
    vec3 nd = sampleDir(n, v, a, ps);
    float bp;
    vec3 f = bsdf(n, v, nd, alb, F0, a, ps, bp);
    bool cont = depth == 0 && bp > 1e-6 && max(f.x, max(f.y, f.z)) > 0.0;
    if (cont) { thr *= f / bp; prevPdf = bp; prevP = p; }
    depth++;
    camRay = false;
    if (max(shC.x, max(shC.y, shC.z)) > 0.0) {
      shadow = true; endAfterShadow = !cont;
      nRo = p + n * (dot(nd, n) > 0.0 ? EPS : -EPS); nRd = nd;
      ro = p + n * (dot(wi, n) > 0.0 ? EPS : -EPS); rd = wi; tmax = ld * (1.0 - 1e-3) - EPS;
    } else if (cont) {
      ro = p + n * (dot(nd, n) > 0.0 ? EPS : -EPS); rd = nd; tmax = FAR;
    } else { s++; fresh = true; }
  }
  float inv = 1.0 / float(max(spp, 1));
  accA *= inv; accB *= inv;
  if (any(isnan(accA)) || any(isinf(accA))) accA = vec3(0.0);
  if (any(isnan(accB)) || any(isinf(accB))) accB = vec3(0.0);
  oA = vec4(accA, dyn ? max(uAlphaA, aDyn) : uAlphaA);
  oB = vec4(accB, dyn ? max(uAlphaB, aDyn) : uAlphaB);
}`;

// Downsample for the glare chain: the first pass adds the fresh emission buffer to the accumulated one.
KM_GOLGE.fsDown = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uSrc, uSrc2;
uniform int uFirst;
uniform vec2 uTexel;
uniform vec2 uDst;
vec3 tap(vec2 uv) {
  vec3 c = texture(uSrc, uv).rgb;
  if (uFirst == 1) c += texture(uSrc2, uv).rgb;
  return c;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uDst;
  vec2 t = uTexel;
  vec3 c = tap(uv) * 0.25
    + (tap(uv + vec2(-t.x, -t.y)) + tap(uv + vec2(t.x, -t.y)) + tap(uv + vec2(-t.x, t.y)) + tap(uv + vec2(t.x, t.y))) * 0.125
    + (tap(uv + vec2(-2.0 * t.x, 0.0)) + tap(uv + vec2(2.0 * t.x, 0.0)) + tap(uv + vec2(0.0, -2.0 * t.y)) + tap(uv + vec2(0.0, 2.0 * t.y))) * 0.0625;
  if (uFirst == 1) c = max(c - 0.6, 0.0);
  o = vec4(c, 1.0);
}`;

KM_GOLGE.fsUp = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uDst;
void main() {
  vec2 uv = gl_FragCoord.xy / uDst;
  vec2 t = uTexel;
  vec3 c = texture(uSrc, uv).rgb * 4.0
    + (texture(uSrc, uv + vec2(-t.x, 0.0)).rgb + texture(uSrc, uv + vec2(t.x, 0.0)).rgb + texture(uSrc, uv + vec2(0.0, -t.y)).rgb + texture(uSrc, uv + vec2(0.0, t.y)).rgb) * 2.0
    + (texture(uSrc, uv + vec2(-t.x, -t.y)).rgb + texture(uSrc, uv + vec2(t.x, -t.y)).rgb + texture(uSrc, uv + vec2(-t.x, t.y)).rgb + texture(uSrc, uv + vec2(t.x, t.y)).rgb);
  o = vec4(c / 16.0, 1.0);
}`;

KM_GOLGE.fsFinal = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uA, uB, uBloom;
uniform vec2 uRes;
uniform float uExposure, uBloomStr;
vec3 tonemap(vec3 x) {           // smooth filmic shoulder, keeps saturated LEDs from clipping to flat white
  x = max(x, 0.0);
  vec3 a = x * (2.51 * x + 0.03), b = x * (2.43 * x + 0.59) + 0.14;
  return clamp(a / b, 0.0, 1.0);
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = texture(uA, uv).rgb + texture(uB, uv).rgb;
  c += texture(uBloom, uv).rgb * uBloomStr;
  c *= uExposure;
  vec2 q = uv - 0.5;
  c *= 1.0 - 0.28 * dot(q, q) * 2.0;
  c = tonemap(c);
  c = pow(c, vec3(1.0 / 2.2));
  c += (ign(gl_FragCoord.xy) - 0.5) / 255.0;   // static dither: no banding, no crawl
  o = vec4(c, 1.0);
}`;
