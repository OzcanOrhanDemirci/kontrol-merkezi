// Kontrol Merkezi: the window. Talks to the host (WebView2) or to the simulated service, keeps the
// state, drives the camera, the lights and the rotors, feeds the path tracer and lays the text over
// the scene. Function is three buttons; everything else is presentation.
'use strict';
(() => {
// ==================================================================== helpers
const $ = s => document.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const DEG = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const approach = (x, target, dt, tau) => x + (target - x) * (1 - Math.exp(-dt / tau));
const smoother = t => t * t * t * (t * (t * 6 - 15) + 10);
const lin = c => { c = c / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const linRgb = c => [lin(c[0]), lin(c[1]), lin(c[2])];
const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const up = s => String(s).toLocaleUpperCase('tr');
const fmtN = n => new Intl.NumberFormat('tr-TR').format(Math.round(n));
const fmt1 = n => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const params = new URLSearchParams(location.hash.slice(1));
const bootT = performance.now();

// ==================================================================== bridge
const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
let sim = null;
const send = m => {
  if (host) host.postMessage(typeof m === 'string' ? m : JSON.stringify(m));
  else if (sim && typeof m === 'object') sim.send(m);
};

// ==================================================================== state
const D = {           // last values from the service
  link: host ? 'baslatiliyor' : 'bagli',
  durum: null,
  isik: null, isikAt: 0,
};
const M = {
  tab: 'fan', camFrom: 'fan', camTo: 'fan', camT: 1, camDur: 1.55,
  t: 0, introT: 0, light: 0, closing: 0,
  visible: true, focused: true,
  rgbOn: 0,                       // 0..1 blend of the scene into the case light
  rot: [0, 0], w: [0, 0],         // rotor angle and angular speed (rad/s)
  push: [0, 0, 0], pushV: [0, 0, 0], down: -1,
  ring: [0, 0], ringBusy: [0, 0],
  focus: 0,                       // 0 kasa, 1 gpu, 2 toggle
  temp: 40, tempShown: 40,
  pend: { kasa: 0, gpu: 0, rgb: 0 },
};
// smoothed emission (linear), so 30 Hz service updates become continuous light
const L = {
  halo: new Float32Array(84 * 3), kbd: new Float32Array(30), prevHalo: new Float32Array(84 * 3), refHalo: new Float32Array(84 * 3),
  tog: [0, 0, 0], ringL: [0, 0, 0], ringR: [0, 0, 0], soft: [0, 0, 0], mark: [1, 1, 1],
  stopsLin: [], stopsT: [52, 58, 64, 74, 80.5],
};

const sound = window.KM_SES;

// ==================================================================== WebGL
const canvas = $('#gl');
let gl = null;
const R = { ok: false, progs: {}, fb: {}, w: 0, h: 0, n: 0, frame: 0, seed: 1, timer: null, queries: [], gpu: [], gpuMs: 0, compileMs: 0, firstFrameMs: 0 };

function compile(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
function program(vs, fs, name) {
  const p = gl.createProgram();
  const v = compile(gl.VERTEX_SHADER, vs), f = compile(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
  return { p, v, f, name, u: {} };
}
function U(pr, n) { if (!(n in pr.u)) pr.u[n] = gl.getUniformLocation(pr.p, n); return pr.u[n]; }
function makeTex(w, h, fmt, filter) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function makeTarget(w, h, fmt = gl.RGBA16F, filter = gl.LINEAR) {
  const t = makeTex(w, h, fmt, filter);
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  return { t, f, w, h };
}
function freeTarget(x) { if (x) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.f); } }

async function initGL() {
  gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance', desynchronized: false, preserveDrawingBuffer: !params.has('koru0') });
  if (!gl) throw new Error('WebGL2 yok');
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float yok');
  gl.getExtension('EXT_float_blend');
  R.floatLinear = !!gl.getExtension('OES_texture_float_linear');
  const par = gl.getExtension('KHR_parallel_shader_compile');
  const G = window.KM_GOLGE;
  const list = [['trace', G.fsTrace], ['down', G.fsDown], ['up', G.fsUp], ['final', G.fsFinal]];
  const progs = list.map(([n, fs]) => [n, program(G.vsFull, fs, n)]);
  if (par) {
    const t0 = performance.now();
    while (!progs.every(([, p]) => gl.getProgramParameter(p.p, par.COMPLETION_STATUS_KHR))) {
      await new Promise(r => setTimeout(r, 16));
      if (performance.now() - t0 > 60000) break;
    }
  }
  for (const [n, p] of progs) {
    if (!gl.getProgramParameter(p.p, gl.LINK_STATUS)) {
      console.error(n, gl.getShaderInfoLog(p.f), gl.getProgramInfoLog(p.p));
      throw new Error('gölgelendirici: ' + n);
    }
    R.progs[n] = p;
  }
  R.compileMs = performance.now() - bootT;
  R.vao = gl.createVertexArray();
  // GPU timer: every frame in headless measurement, every 15th frame in the window (enough for pacing),
  // with the query objects reused rather than created and deleted per frame
  R.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  R.qFree = [];
  R.ok = true;
  resize();
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(2, Math.round(canvas.clientWidth * dpr)), h = Math.max(2, Math.round(canvas.clientHeight * dpr));
  if (!gl || (w === R.w && h === R.h)) return;
  R.w = w; R.h = h; R.dpr = dpr;
  canvas.width = w; canvas.height = h;
  if (R.fb.acc) { gl.deleteTexture(R.fb.acc.a); gl.deleteTexture(R.fb.acc.b); gl.deleteFramebuffer(R.fb.acc.f); }
  (R.fb.bloom || []).forEach(freeTarget);
  const filt = R.floatLinear ? gl.LINEAR : gl.NEAREST;
  const a = makeTex(w, h, gl.RGBA32F, filt), b = makeTex(w, h, gl.RGBA32F, filt);
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, b, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  R.fb.acc = { a, b, f };
  R.fb.bloom = [];
  let bw = w, bh = h;
  for (let i = 0; i < 6; i++) { bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1); R.fb.bloom.push(makeTarget(bw, bh)); }
  R.n = 0;
  layoutDirty = true;
}

// ==================================================================== camera
const CAMS = {
  fan: { pos: [0, -112, 16], tgt: [0, 8, 24.5], fov: 30 },
  rgb: { pos: [0, -98, 87], tgt: [0, 20, 24.5], fov: 31 },
};
function camState() {
  const k = smoother(clamp(M.camT, 0, 1));
  const A = CAMS[M.camFrom], B = CAMS[M.camTo];
  let pos = mix3(A.pos, B.pos, k), tgt = mix3(A.tgt, B.tgt, k);
  const arc = Math.sin(Math.PI * k);
  const dir = M.camTo === 'rgb' ? 1 : -1;
  pos = add(pos, [7 * arc * dir, 9 * arc, -3 * arc]);    // a gentle arc: the camera swings and leans in mid-move
  tgt = add(tgt, [2.5 * arc * dir, 0, 0]);
  return { pos, tgt, fov: lerp(A.fov, B.fov, k) };
}
function camera(w, h) {
  const c = camState();
  const aspect = w / h;
  const tf = Math.tan(c.fov * DEG / 2) * Math.max(1, 1.6 / aspect);
  const F = norm(sub(c.tgt, c.pos)), Rr = norm(cross(F, [0, 0, 1])), Uu = cross(Rr, F);
  return { pos: c.pos, F, R: Rr, U: Uu, focal: 1 / tf, aspect };
}
function project(cam, p, w, h) {          // CSS pixels
  const rel = sub(p, cam.pos), z = dot(rel, cam.F);
  const x = dot(rel, cam.R) * cam.focal / z, y = dot(rel, cam.U) * cam.focal / z;
  return [(x / cam.aspect * 0.5 + 0.5) * w, (0.5 - y * 0.5) * h, z];
}
const moving = () => M.camT < 1;

// ==================================================================== scene constants mirrored from the shader
const HC = [0, 24, 27.5], FCL = [-7.6, 0.6, 9.25], FCR = [7.6, 0.6, 9.25];

// ==================================================================== lights: from the service to the shader
const NEUTRAL = [1.0, 0.93, 0.84];
let scaleMin = 32, scaleMax = 90;

function stops() { return (D.durum && D.durum.rgb && D.durum.rgb.duraklar && D.durum.rgb.duraklar.length >= 2) ? D.durum.rgb.duraklar : null; }

function updateLights(dt) {
  const iz = D.isik;
  const connected = D.link === 'bagli';
  const on = connected && D.durum && D.durum.rgb ? !!D.durum.rgb.acik : false;
  M.rgbOn = on ? 1 : approach(M.rgbOn, 0, dt, 0.22);
  const k = 1 - Math.exp(-dt / 0.045);
  const HK = 5.0;                                   // LED radiance scale
  const off = 1 - M.rgbOn;
  L.prevHalo.set(L.halo);
  // ignition: the chain lights from the top LED outward both ways (startup and RGB on)
  if (on && !L.wasOn) L.igniteT = M.t;
  L.wasOn = on;
  const ig = M.t - (L.igniteT == null ? -99 : L.igniteT);
  for (let i = 0; i < 84; i++) {
    const c = iz && iz.halka && iz.halka[i] ? iz.halka[i] : [0, 0, 0];
    const dly = Math.min(i, 84 - i) / 42 * 0.55;
    const sweep = clamp((ig - dly) / 0.12, 0, 1);
    const flash = 1 + 1.2 * Math.exp(-Math.max(0, ig - dly) / 0.09) * (ig > dly ? 1 : 0);
    for (let j = 0; j < 3; j++) {
      const target = lin(c[j]) * HK * M.rgbOn * sweep * flash + NEUTRAL[j] * 0.035 * off;
      L.halo[i * 3 + j] += (target - L.halo[i * 3 + j]) * (ig < 1.2 ? 1 - Math.exp(-dt / 0.02) : k);
    }
  }
  for (let i = 0; i < 10; i++) {
    const c = iz && iz.klavye && iz.klavye[i] ? iz.klavye[i] : [0, 0, 0];
    for (let j = 0; j < 3; j++) {
      const target = lin(c[j]) * 1.1 * M.rgbOn + NEUTRAL[j] * 0.004 * off;
      L.kbd[i * 3 + j] += (target - L.kbd[i * 3 + j]) * k;
    }
  }
  const cik = iz && iz.cikis ? linRgb(iz.cikis) : [0, 0, 0];
  L.hub = mix3(L.hub || [0, 0, 0], add(mul(cik, 3.0 * M.rgbOn), mul(NEUTRAL, 0.05 * off)), k);
  L.tog = mix3(L.tog, add(mul(cik, 7.0 * M.rgbOn), mul(NEUTRAL, 0.12 * off)), k);
  // the studio softbox: the neutral light the scene falls back to when RGB is off
  L.soft = mul(NEUTRAL, (0.042 + 0.06 * off) * (connected ? 1 : 0.7));
  // fan bore rings: state light
  const ringFor = (f, i) => {
    if (!connected || !f) return [0, 0, 0];
    if (f.kullanilabilir === false) return [0.0, 0.0, 0.0];
    const busy = f.durum === 'geciyor' || M.pend[i ? 'gpu' : 'kasa'] > 0;
    if (f.durum === 'baska') return mul([1.0, 0.55, 0.18], 0.55);
    if (busy) return mul([1.0, 0.86, 0.7], 0.5 + 0.45 * Math.sin(M.t * 10));
    if (f.durum === 'max') return mul([1.0, 0.62, 0.3], 6.0);
    return mul([0.75, 0.86, 1.0], 0.24);
  };
  const fan = D.durum && D.durum.fan;
  L.ringL = mix3(L.ringL, ringFor(fan && fan.kasa, 0), 1 - Math.exp(-dt / 0.12));
  L.ringR = mix3(L.ringR, ringFor(fan && fan.gpu, 1), 1 - Math.exp(-dt / 0.12));
  // scale
  const st = stops();
  if (st) {
    L.stopsLin = st.map(s => linRgb(s.renk));
    L.stopsT = st.map(s => s.c);
    const key = JSON.stringify(st.map(s => [s.c, s.renk]));
    if (key !== L.lutKey) { L.lutKey = key; L.lut = null; }
    scaleMin = Math.floor((st[0].c - 10) / 2) * 2; scaleMax = Math.ceil((st[st.length - 1].c + 6) / 2) * 2;
  } else if (!L.stopsLin.length) {
    L.stopsLin = [[255, 255, 255], [20, 50, 255], [255, 210, 0], [255, 110, 0], [255, 0, 0]].map(linRgb);
  }
  const isi = D.durum && D.durum.isi;
  const tv = isi ? (isi.yumusak != null ? isi.yumusak : isi.ort) : null;
  if (tv != null) M.temp = tv;
  M.tempShown = approach(M.tempShown, M.temp, dt, 0.5);
  if (!L.lut) {            // the gradient the case will actually show: the service's OKLCh palette
    const s2 = st || [38, 46, 54, 64, 74, 84].map((c, i) => ({ c, renk: [[230, 240, 255], [110, 190, 255], [20, 50, 255], [255, 210, 0], [255, 110, 0], [255, 0, 0]][i] }));
    L.lut = new Float32Array(64 * 3);
    for (let i = 0; i < 64; i++) {
      const c = window.KM_RENK.palet(s2, lerp(scaleMin, scaleMax, i / 63));
      L.lut.set(c, i * 3);
    }
  }
  const pv = iz && iz.onizleme ? linRgb(iz.onizleme) : [1, 1, 1];
  L.mark = mix3(L.mark, mul(add(mul(pv, 0.75), [0.25, 0.25, 0.25]), 3.0), k);
}

// how much the light changed this frame (relative), to steer the accumulation
function lightChange() {
  let d = 0, s = 1e-3, dr = 0;
  for (let i = 0; i < 84 * 3; i++) { d += Math.abs(L.halo[i] - L.prevHalo[i]); dr += Math.abs(L.halo[i] - L.refHalo[i]); s += L.halo[i]; }
  // the scale marker is a small emitter that moves: its travel counts too, or it would leave a trail
  const dm = Math.abs(M.tempShown - (L.prevTemp == null ? M.tempShown : L.prevTemp));
  L.prevTemp = M.tempShown;
  const mk = dm > 0.004 ? dm * 0.4 : 0;   // sensor drift of a few thousandths of a degree does not count
  // Deadband: the service's LED values jitter by a step on every message; changes under 2% against the
  // colours the image was built with are invisible and let the scene rest (otherwise it never would).
  // A larger drift or any real effect wakes the trace, which then catches up within a second or two.
  const rel = d / s, relRef = dr / s;
  if (relRef < 0.02 && rel < 0.004) return mk;
  L.refHalo.set(L.halo);
  return Math.max(rel, relRef * 0.25) + mk;
}

// ==================================================================== rotors
function rotorTargets() {
  const fan = D.durum && D.durum.fan;
  let wk = 0, wg = 0;
  if (fan && fan.kasa && fan.kasa.rpm && fan.kasa.rpm.length) {
    const cpu = fan.kasa.rpm.find(r => r.ad === 'CPU_FAN') || fan.kasa.rpm[0];
    const x = clamp((cpu.rpm - 817) / (2003 - 817), 0, 1.2);
    wk = cpu.rpm > 50 ? lerp(0.55, 15, Math.pow(x, 1.6)) : 0;
  }
  if (fan && fan.gpu && fan.gpu.rpm && fan.gpu.rpm.length) {
    const r = fan.gpu.rpm.reduce((a, b) => a + b, 0) / fan.gpu.rpm.length;
    wg = r > 50 ? lerp(0.55, 15, Math.pow(clamp(r / 3000, 0, 1.2), 1.6)) : 0;
  }
  if (D.link !== 'bagli') { wk = 0; wg = 0; }
  return [wk * 2 * Math.PI, wg * 2 * Math.PI];
}

// ==================================================================== drawing
let lastIdle = 0;
function render(dt) {
  if (!R.ok) return;
  resize();
  const w = R.w, h = R.h;
  const cam = camera(w, h);
  const P = R.progs;
  const t0 = performance.now();

  // accumulation control
  const mov = moving();
  const dl = lightChange();
  let aMin = clamp(dl * 6, 1 / 400, 0.2);
  if (mov) { R.n = 0; }
  const nEff = Math.min(R.n + 1, 1 / aMin);
  R.n = nEff;
  const alphaA = mov ? 1 : 1 / nEff;
  const alphaB = mov ? 1 : Math.max(alphaA, dl > 2e-4 ? 0.6 : 0);
  R.seed = mov ? 7 : (R.seed + 1) % 1000003;

  // resting: converged and the light steady -> only the moving rotors keep tracing
  R.idle = !mov && R.n >= 300 && dl < 3e-4 && !params.has('noidle');
  let traceOn = true, clip = [0, 0, w, h];
  gl.bindVertexArray(R.vao);
  const sampleGpu = host ? (R.frame % 15 === 0 && R.queries.length === 0) : R.queries.length < 6;
  const tq = R.timer && sampleGpu ? ((!params.has('yenisorgu') && R.qFree.pop()) || gl.createQuery()) : null;
  if (tq) gl.beginQuery(R.timer.TIME_ELAPSED_EXT, tq);

  if (R.idle) {             // both views show the rotors: keep tracing their faces only
    {
      const rs = R.fanRects || [{ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }, { left: 0, top: 0, right: 0, bottom: 0 }];
      const sx = w / window.innerWidth, sy = h / window.innerHeight;
      const x0 = Math.floor(Math.min(rs[0].left, rs[1].left) * sx) - 2, x1 = Math.ceil(Math.max(rs[0].right, rs[1].right) * sx) + 2;
      const y0 = Math.floor(Math.min(rs[0].top, rs[1].top) * sy) - 2, y1 = Math.ceil(Math.max(rs[0].bottom, rs[1].bottom) * sy) + 2;
      clip = [x0, h - y1, x1, h - y0];
    }
  }
  // 1) path trace, blended into the accumulation buffers
  gl.bindFramebuffer(gl.FRAMEBUFFER, R.fb.acc.f);
  gl.viewport(0, 0, w, h);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
  let p = P.trace; gl.useProgram(p.p);
  gl.uniform2f(U(p, 'uRes'), w, h);
  gl.uniform3fv(U(p, 'uCamPos'), cam.pos); gl.uniform3fv(U(p, 'uCamR'), cam.R);
  gl.uniform3fv(U(p, 'uCamU'), cam.U); gl.uniform3fv(U(p, 'uCamF'), cam.F);
  gl.uniform1f(U(p, 'uFocal'), cam.focal);
  // constant work per frame, focused or not: a focus change must not move the pacing (rest mode keeps an idle window cheap)
  // samples per pixel scale with the window so every size costs about the same per frame (~10 ms at the
  // normal 1770x1103 window with 10); the moving rotor faces keep their count, fewer shows as grain there
  const spp = params.has('spp') ? R.spp : clamp(Math.round(R.spp * 1.95e6 / (w * h)), 6, R.spp), sppDyn = R.sppDyn;
  R.sppNow = spp;
  gl.uniform1i(U(p, 'uSpp'), spp); gl.uniform1i(U(p, 'uSppDyn'), sppDyn);
  gl.uniform1i(U(p, 'uIter'), Math.max(spp, sppDyn) * 8);
  gl.uniform1ui(U(p, 'uSeed'), R.seed);
  gl.uniform1f(U(p, 'uAlphaA'), alphaA); gl.uniform1f(U(p, 'uAlphaB'), alphaB);
  const ad = i => (mov ? 1 : clamp(lerp(0.6, 0.14, clamp((M.w[i] - 14) / 60, 0, 1)), alphaA, 1));
  gl.uniform2f(U(p, 'uAlphaDyn'), ad(0), ad(1));
  gl.uniform3fv(U(p, 'uHubCol'), L.hub);
  gl.uniform1f(U(p, 'uShutter'), clamp(dt, 1 / 165, 1 / 24));
  gl.uniform2f(U(p, 'uRotA'), M.rot[0], M.rot[1]); gl.uniform2f(U(p, 'uRotW'), -M.w[0], -M.w[1]);
  gl.uniform3f(U(p, 'uPush'), M.push[0], M.push[1], M.push[2]);
  gl.uniform3fv(U(p, 'uHalo'), L.halo);
  // light sampling: segment and group probabilities by power
  const segW = R.segW || (R.segW = new Float32Array(84)), cdf = R.cdf || (R.cdf = new Float32Array(84));
  let tot = 0, haloPow = 0;
  for (let i = 0; i < 84; i++) {
    const l = j => lum([L.halo[j * 3], L.halo[j * 3 + 1], L.halo[j * 3 + 2]]);
    segW[i] = Math.max(l(i), l((i + 83) % 84), l((i + 1) % 84)) + 1e-4;
    tot += segW[i]; haloPow += l(i);
  }
  let acc = 0;
  for (let i = 0; i < 84; i++) { acc += segW[i] / tot; cdf[i] = acc; }
  cdf[83] = 1;
  gl.uniform1fv(U(p, 'uHaloCdf'), cdf);
  gl.uniform3fv(U(p, 'uKbd'), L.kbd);
  let kbdPow = 0; for (let i = 0; i < 10; i++) kbdPow += lum([L.kbd[i * 3], L.kbd[i * 3 + 1], L.kbd[i * 3 + 2]]);
  const pw = [
    haloPow / 84 * 380 * 1.0,
    lum(L.soft) * 2690 * 0.25,
    lum(L.ringL) * 13.7 * 1.5,
    lum(L.ringR) * 13.7 * 1.5,
    kbdPow / 10 * 15 * 0.8,
    lum(L.tog) * 34 * 0.19 * 0.8,
  ];
  const ptot = pw.reduce((a, b) => a + b, 0) + 1e-9;
  const pr = pw.map(x => (x > 1e-7 ? Math.max(x / ptot, 0.03) : 0));
  const prt = pr.reduce((a, b) => a + b, 0) || 1;
  const lcdf = new Float32Array(6); let ac = 0;
  for (let i = 0; i < 6; i++) { ac += pr[i] / prt; lcdf[i] = ac; }
  lcdf[5] = 1.0001;
  gl.uniform1fv(U(p, 'uLightCdf'), lcdf);
  gl.uniform3fv(U(p, 'uSoftCol'), L.soft);
  gl.uniform3fv(U(p, 'uRingCol'), [...L.ringL, ...L.ringR]);
  gl.uniform3fv(U(p, 'uTogCol'), L.tog);
  gl.uniform3fv(U(p, 'uScaleLut'), L.lut);
  gl.uniform4f(U(p, 'uScale'), scaleMin, scaleMax, M.tempShown, 0.32 + 0.25 * M.rgbOn);
  gl.uniform3fv(U(p, 'uMarkCol'), L.mark);
  gl.uniform1f(U(p, 'uFill'), 0.9 + 1.4 * M.rgbOn);
  if (traceOn) {
    // The trace is drawn in horizontal bands, each flushed on its own: one 14 ms draw cannot be
    // interrupted, and the desktop compositor, which needs the GPU every refresh, would miss its slot.
    const bands = R.idle ? 1 : (params.has('bant') ? +params.get('bant') : 6);
    gl.enable(gl.SCISSOR_TEST);
    for (let i = 0; i < bands; i++) {
      const y0 = Math.max(clip[1], Math.floor(h * i / bands)), y1 = Math.min(clip[3], Math.floor(h * (i + 1) / bands));
      if (y1 <= y0) continue;
      gl.scissor(clip[0], y0, Math.max(1, clip[2] - clip[0]), y1 - y0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (bands > 1) gl.flush();
    }
  }
  gl.disable(gl.BLEND);
  gl.disable(gl.SCISSOR_TEST);

  // Light rest: once resting, only the fan faces change. The canvas keeps its image (preserveDrawingBuffer),
  // so only those rectangles are re-composited and the full-screen glare is refreshed every 48th frame.
  // A steady ~30% load made the GPU cycle between power states every few seconds, and some of those
  // memory-clock switches stalled presentation for 0.3-0.7 s; this load lets it settle.
  R.idleRun = R.idle ? (R.idleRun || 0) + 1 : 0;
  const lite = !params.has('koru0') && R.idleRun > 3 && (R.idleRun % 48) !== 0;

  // 2) glare chain
  const B = R.fb.bloom;
  if (!lite) {
  p = P.down; gl.useProgram(p.p);
  let srcT = R.fb.acc.a, sw = w, sh = h;
  for (let i = 0; i < B.length; i++) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, B[i].f); gl.viewport(0, 0, B[i].w, B[i].h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcT); gl.uniform1i(U(p, 'uSrc'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, R.fb.acc.b); gl.uniform1i(U(p, 'uSrc2'), 1);
    gl.uniform1i(U(p, 'uFirst'), i === 0 ? 1 : 0);
    gl.uniform2f(U(p, 'uTexel'), 1 / sw, 1 / sh); gl.uniform2f(U(p, 'uDst'), B[i].w, B[i].h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    srcT = B[i].t; sw = B[i].w; sh = B[i].h;
  }
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  p = P.up; gl.useProgram(p.p);
  for (let i = B.length - 1; i > 0; i--) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, B[i - 1].f); gl.viewport(0, 0, B[i - 1].w, B[i - 1].h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, B[i].t); gl.uniform1i(U(p, 'uSrc'), 0);
    gl.uniform2f(U(p, 'uTexel'), 1 / B[i].w, 1 / B[i].h); gl.uniform2f(U(p, 'uDst'), B[i - 1].w, B[i - 1].h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.disable(gl.BLEND);
  }

  // 3) final
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
  p = P.final; gl.useProgram(p.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.fb.acc.a); gl.uniform1i(U(p, 'uA'), 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, R.fb.acc.b); gl.uniform1i(U(p, 'uB'), 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, B[0].t); gl.uniform1i(U(p, 'uBloom'), 2);
  gl.uniform2f(U(p, 'uRes'), w, h);
  gl.uniform1f(U(p, 'uExposure'), 1.35 * M.light);
  gl.uniform1f(U(p, 'uBloomStr'), params.has('nobloom') ? 0 : 0.06);
  if (lite) { gl.enable(gl.SCISSOR_TEST); gl.scissor(clip[0], clip[1], Math.max(1, clip[2] - clip[0]), Math.max(1, clip[3] - clip[1])); }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.SCISSOR_TEST);
  if (tq) { gl.endQuery(R.timer.TIME_ELAPSED_EXT); tq._idle = R.idle; R.queries.push(tq); }

  if (R.timer && R.queries.length) {
    const q = R.queries[0];
    if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      R.queries.shift();
      if (!gl.getParameter(R.timer.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        R.gpuMs = R.gpuMs ? R.gpuMs * 0.9 + ms * 0.1 : ms;
        if (R.gpu.length < 20000) R.gpu.push(ms);
        if (!q._idle && R.frame > 60) { PACE.full.push(ms); if (PACE.full.length > 240) PACE.full.shift(); }   // past warm-up
      }
      R.qFree.push(q);
    }
  }
  R.frame++;
  if (traceOn && !R.idle) R.rays += w * h * spp * 3.2;
  R.cpuMs = performance.now() - t0;
  if (R.frame === 1) {
    R.firstFrameMs = performance.now() - bootT;
    send('perf:ilk-kare ' + Math.round(R.firstFrameMs) + ' (derleme ' + Math.round(R.compileMs) + ' ms, ' + w + 'x' + h + ')');
  }
}

// ==================================================================== text layer
const T = {
  brandSub: 'FANLAR · IŞIKLAR · TEK PENCERE',
  fan: 'Fanlar', rgb: 'RGB',
  rpmName: ad => {
    if (ad === 'CPU_FAN') return 'İşlemci';
    if (ad === 'PUMP_FAN') return 'Pompa';
    const m = /^SYS_FAN(\d+)$/.exec(ad); if (m) return 'Kasa ' + m[1];
    return ad;
  },
};
$('#brandSub').textContent = T.brandSub;
$('#tabFan').textContent = up(T.fan);
$('#tabRgb').textContent = up(T.rgb);
$('#hMode').textContent = up('Işığın kaynağı');
$('#hDevs').textContent = up('Aygıtlar');
$('#nowL').textContent = up('Ortalama');

const state = { kasa: '', gpu: '', rgb: '', ledger: '' };

function fanView(i) {
  const fan = D.durum && D.durum.fan ? (i ? D.durum.fan.gpu : D.durum.fan.kasa) : null;
  const linked = D.link === 'bagli';
  const v = { title: i ? 'Ekran kartı fanları' : 'İşlemci ve kasa fanları', st: '', sc: '', busy: false, big: '—', unit: '', rows: [], hint: '', why: '', note: '', avail: true };
  if (!linked || !fan) {
    v.st = 'Bilgi yok'; v.sc = '160 160 160'; v.avail = false;
    v.why = D.link === 'baslatiliyor' ? 'Servis başlatılıyor…' : 'Servise bağlı değil';
    return v;
  }
  const busy = fan.durum === 'geciyor' || M.pend[i ? 'gpu' : 'kasa'] > 0;
  const isi = D.durum.isi || {};
  if (busy) { v.st = 'Geçiyor'; v.sc = '255 226 196'; v.busy = true; }
  else if (fan.durum === 'max') { v.st = 'En yüksek hızda'; v.sc = '255 160 90'; }
  else if (fan.durum === 'bios') { v.st = 'BIOS denetiminde'; v.sc = '170 205 255'; }
  else if (fan.durum === 'oto') { v.st = 'Kartın kendi denetiminde'; v.sc = '170 205 255'; }
  else if (fan.durum === 'baska') { v.st = 'Başka bir programda'; v.sc = '255 190 120'; }
  else { v.st = 'Durum bilinmiyor'; v.sc = '160 160 160'; }
  if (!i) {
    const rpm = fan.rpm || [];
    const cpu = rpm.find(r => r.ad === 'CPU_FAN') || rpm[0];
    v.big = cpu ? fmtN(cpu.rpm) : '—'; v.unit = 'DEV/DK';
    v.rows = rpm.filter(r => r !== cpu).map(r => [T.rpmName(r.ad), fmtN(r.rpm)]);
    v.rows.unshift(['İşlemci ısısı', isi.cpu != null ? fmt1(isi.cpu) + ' °C' : '—']);
  } else {
    v.big = fan.yuzde != null ? '%' + fmtN(fan.yuzde) : '—'; v.unit = '';
    (fan.rpm || []).forEach((r, k) => v.rows.push(['Fan ' + (k + 1), r > 0 ? fmtN(r) + ' dev/dk' : 'duruyor']));
    v.rows.unshift(['Kart ısısı', isi.gpu != null ? fmt1(isi.gpu) + ' °C' : '—']);
    const ab = fan.afterburner || {};
    if (ab.fanKontrolu) v.note = 'Afterburner’ın fan kontrolü açık; <em>bu düğmeyle çakışır.</em>';
    else if (fan.durum === 'baska') v.note = 'Fanları başka bir program yönetiyor; <em>bu düğmeyle çakışabilir.</em>';
  }
  if (fan.kullanilabilir === false) { v.avail = false; v.why = fan.neden || 'Bu düğme şu an çalışamıyor'; }
  else if (!busy) {
    if (fan.durum === 'max') v.hint = i ? 'Bas · <b>karta bırak</b>' : 'Bas · <b>BIOS’a bırak</b>';
    else v.hint = 'Bas · <b>en yüksek hıza al</b>';
  } else v.hint = '&nbsp;';
  return v;
}
function renderMod(el, v, focus) {
  const key = JSON.stringify(v) + focus;
  if (el._k === key) return;
  el._k = key;
  el.classList.toggle('focus', focus);
  el.style.setProperty('--sc', v.sc || 'var(--fg)');
  el.innerHTML =
    `<div class="k">${esc(up(v.title))}</div>` +
    `<div class="big">${esc(v.big)}${v.unit ? `<small>${esc(v.unit)}</small>` : ''}</div>` +
    `<div class="st${v.busy ? ' busy' : ''}"><i></i>${esc(up(v.st))}</div>` +
    `<table>${v.rows.map(([n, x]) => `<tr><td class="n">${esc(up(n))}</td><td class="v">${esc(x)}</td></tr>`).join('')}</table>` +
    (v.avail ? `<div class="hint">${v.hint}</div>` : `<div class="why">${esc(v.why)}</div>`) +
    (v.note ? `<div class="note">${v.note}</div>` : '');
}

function renderRgb() {
  const d = D.durum, linked = D.link === 'bagli';
  const rgb = d && d.rgb, isi = (d && d.isi) || {};
  const on = !!(rgb && rgb.acik && linked);
  const key = JSON.stringify([linked, rgb, isi.cpu, isi.gpu, Math.round(M.temp * 10), M.focus === 2, D.link]);
  if (state.rgb === key) return;
  state.rgb = key;
  const idle = !!(rgb && rgb.beklemede && on);
  $('#togSt').textContent = !linked ? 'Bilgi yok' : idle ? 'Işıklar beklemede' : on ? 'Işıklar açık' : 'Işıklar kapalı';
  $('#togHint').innerHTML = linked ? (idle ? 'klavyeye ya da fareye dokununca yanar' : on ? 'Bas · <b>hepsini kapat</b>' : 'Bas · <b>hepsini aç</b>') : '';
  $('#togWhy').textContent = linked ? '' : (D.link === 'baslatiliyor' ? 'Servis başlatılıyor…' : 'Servise bağlı değil');
  $('#tog').classList.toggle('focus', M.focus === 2);
  let mode = '—', modeSub = '';
  if (rgb) {
    mode = 'Bilgisayarın <i>sıcaklığı</i>';
    modeSub = `işlemci <b>${isi.cpu != null ? fmt1(isi.cpu) + '°' : '—'}</b> · ekran kartı <b>${isi.gpu != null ? fmt1(isi.gpu) + '°' : '—'}</b><br>ortalaması yumuşatılarak renge döner`;
    if (!on) modeSub = 'ışıklar kapalıyken de hesaplanıyor';
    else if (rgb.beklemede) modeSub = `${rgb.beklemeDakika || 15} dakikadır klavye ve fare kullanılmadı;<br>ışıklar yumuşakça söndü`;
  }
  $('#mode').innerHTML = mode;
  $('#modeSub').innerHTML = modeSub;
  const devs = (rgb && rgb.cihazlar) || [];
  $('#devList').innerHTML = devs.map(c => {
    let cls = 'bad', s = 'bağlı değil';
    if (c.kilitli) { cls = 'lock'; s = 'kilitli'; }
    else if (c.hata) { cls = 'bad'; s = c.hata; }
    else if (c.bagli) { cls = 'ok'; s = 'bağlı'; }
    const name = c.kimlik === 'gpu' ? c.ad.replace(/ Gaming X Trio$/, '') : c.ad;
    return `<div class="d ${cls}"><span class="a">${esc(name)}</span><span class="s"><i></i>${esc(up(s))}</span></div>` +
      (c.kilitli ? `<div class="d lock" style="margin-top:-.6em"><span class="s" style="min-width:0;letter-spacing:.06em">bu derlemede karta yol yok</span></div>` : '');
  }).join('');
  $('#nowV').innerHTML = `${fmt1(M.temp)}<small>°C</small>`;
}

// stops along the arc (HTML ticks), rebuilt when the stops change
let tickKey = '';
function buildTicks() {
  const st = (stops() || L.stopsT.map(c => ({ c }))).filter(s => !s.gizli);
  const key = st.map(s => s.c + (s.ad || '')).join(',');
  if (key === tickKey) return;
  tickKey = key;
  $('#ticks').innerHTML = st.map((s, i) => `<div class="anch"><div class="tick" data-c="${s.c}">${s.c}<small>°</small>${s.ad ? `<span class="ad">${esc(s.ad)}</span>` : ''}</div></div>`).join('');
}
const arcPoint = (c, r) => {
  const a = (c - scaleMin) / (scaleMax - scaleMin);
  const ph = 0.5 * Math.PI + 0.45 * Math.PI * (1 - 2 * a);
  return [HC[0] + r * Math.cos(ph), HC[1] - 0.9, HC[2] + r * Math.sin(ph)];
};

let layoutDirty = true, lastLayoutKey = '';
function place(el, x, y) {
  const k = x.toFixed(1) + ',' + y.toFixed(1);
  if (el._p === k) return;
  el._p = k;
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}
function placeRect(el, x0, y0, x1, y1) {
  const k = [x0, y0, x1, y1].map(v => v.toFixed(0)).join(',');
  if (el._p === k) return;
  el._p = k;
  Object.assign(el.style, { transform: `translate(${x0.toFixed(0)}px, ${y0.toFixed(0)}px)`, width: (x1 - x0).toFixed(0) + 'px', height: (y1 - y0).toFixed(0) + 'px' });
}
function layout() {
  const w = window.innerWidth, h = window.innerHeight;
  const cam = camera(w, h);
  const key = [w, h, M.camT.toFixed(4), M.camFrom, M.camTo, scaleMin, scaleMax, Math.round(M.tempShown * 20)].join('|');
  if (key === lastLayoutKey && !layoutDirty) return;
  lastLayoutKey = key; layoutDirty = false;
  const pj = p => project(cam, p, w, h);
  // fan labels: under each module, at the plinth's front foot
  // fan labels: in the empty space beside each module, vertically on the fan's centre
  const a1 = pj([FCL[0] - 6.0, FCL[1] - 1.3, FCL[2] + 4.5]), a2 = pj([FCR[0] + 6.0, FCR[1] - 1.3, FCR[2] + 4.5]);
  place($('#aKasa'), a1[0] - w * 0.03, a1[1]);
  place($('#aGpu'), a2[0] + w * 0.03, a2[1]);
  // hit areas: projected fan faces
  const rectOf = (c, hx, hz, y) => {
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => pj([c[0] + sx * hx, y, c[2] + sz * hz]));
    return [Math.min(...pts.map(q => q[0])), Math.min(...pts.map(q => q[1])), Math.max(...pts.map(q => q[0])), Math.max(...pts.map(q => q[1]))];
  };
  const showFan = M.tab === 'fan' && !moving(), showRgb = M.tab === 'rgb' && !moving();
  const rk = rectOf(FCL, 6, 6, FCL[1] - 1.3), rg = rectOf(FCR, 6, 6, FCR[1] - 1.3), rt = rectOf(HC, 4.3, 4.3, HC[1] - 1.1);
  R.fanRects = [rk, rg].map(r => ({ left: r[0], top: r[1], right: r[2], bottom: r[3] }));
  placeRect($('#hotKasa'), ...rk); placeRect($('#hotGpu'), ...rg); placeRect($('#hotTog'), ...rt);
  $('#hotKasa').style.display = showFan ? 'block' : 'none';
  $('#hotGpu').style.display = showFan ? 'block' : 'none';
  $('#hotTog').style.display = showRgb ? 'block' : 'none';
  // RGB: toggle caption under the bezel, temperature riding the marker, stops along the arc
  const tc = pj([HC[0], HC[1] - 1.1, HC[2] - 5.6]);
  place($('#aTog'), tc[0], tc[1]);
  const np = pj(arcPoint(clamp(M.tempShown, scaleMin, scaleMax), 16.8));
  place($('#aNow'), np[0], np[1]);
  document.querySelectorAll('#ticks .anch').forEach(el => {
    const c = +el.firstChild.dataset.c;
    const q = pj(arcPoint(c, 27.3));
    place(el, q[0], q[1]);
    const near = clamp((Math.abs(c - M.tempShown) - 2.5) / 3, 0, 1).toFixed(2);
    if (el._o !== near) { el._o = near; el.style.opacity = near; }
  });
  // side columns, aligned with the ring's horizontal diameter
  const lp = pj([HC[0] - 33, HC[1], HC[2] + 6]), rp = pj([HC[0] + 33, HC[1], HC[2] + 6]);
  const cl = $('#cLeft'), cr = $('#devs');
  cl.style.left = Math.max(w * 0.035, lp[0] - cl.offsetWidth) + 'px'; cl.style.top = lp[1] + 'px';
  cr.style.left = Math.min(w * 0.965 - cr.offsetWidth, rp[0]) + 'px'; cr.style.top = rp[1] + 'px';
}

function updateOverlay(dt) {
  // panel visibility follows the camera: the old tab fades out early, the new one fades in late
  const k = smoother(clamp(M.camT, 0, 1));
  const fanVis = M.camTo === 'fan' ? clamp((k - 0.55) / 0.45, 0, 1) : clamp(1 - k / 0.35, 0, 1);
  const rgbVis = M.camTo === 'rgb' ? clamp((k - 0.55) / 0.45, 0, 1) : clamp(1 - k / 0.35, 0, 1);
  const fv = M.camFrom === M.camTo ? (M.tab === 'fan' ? 1 : 0) : fanVis;
  const rv = M.camFrom === M.camTo ? (M.tab === 'rgb' ? 1 : 0) : rgbVis;
  $('#pFan').style.opacity = fv.toFixed(3); $('#pFan').style.visibility = fv > 0.001 ? 'visible' : 'hidden';
  $('#pRgb').style.opacity = rv.toFixed(3); $('#pRgb').style.visibility = rv > 0.001 ? 'visible' : 'hidden';
  renderMod($('#mKasa'), fanView(0), M.focus === 0 && M.tab === 'fan');
  renderMod($('#mGpu'), fanView(1), M.focus === 1 && M.tab === 'fan');
  renderRgb();
  buildTicks();
  layout();
  // accent: the case light, for the tab underline
  const iz = D.isik;
  const on = D.durum && D.durum.rgb && D.durum.rgb.acik && D.link === 'bagli';
  const acc = on && iz && iz.onizleme ? iz.onizleme : [200, 215, 235];
  const accS = acc.map(v => Math.round(v)).join(' ');
  if (accS !== state.acc) { state.acc = accS; document.documentElement.style.setProperty('--acc', accS); }
  const lit = clamp(M.light * 1.2, 0, 1).toFixed(3);
  if (lit !== state.lit) { state.lit = lit; document.documentElement.style.setProperty('--lit', lit); }
  // banner
  let b = '';
  if (D.link === 'yok') b = 'Servise ulaşılamıyor · düğmeler servis gelince çalışır';
  else if (D.link === 'baslatiliyor') b = 'Servis başlatılıyor…';
  else if (D.durum && D.durum.fan) {
    const off = [];
    if (D.durum.fan.kasa && D.durum.fan.kasa.kullanilabilir === false) off.push('kasa fanları');
    if (D.durum.fan.gpu && D.durum.fan.gpu.kullanilabilir === false) off.push('ekran kartı fanları');
    if (off.length && D.durum.servis && D.durum.servis.yonetici === false) b = 'Servis yönetici izni olmadan çalışıyor · ' + off.join(' ve ') + ' düğmesi kapalı';
  }
  if (b !== state.banner) { state.banner = b; $('#bannerText').textContent = b; $('#banner').classList.toggle('show', !!b); }
  // ledger: what this much light costs, for three buttons
  if (M.t - (state.ledT || -9) > 0.5) {
    state.ledT = M.t;
    const rps = R.raysPerSec || 0;
    const html = `<span>İŞLEV<b>3 DÜĞME</b></span><span>SANİYEDE IŞIN<b>${rps > 0 ? fmtN(rps / 1e6) + ' MİLYON' : '—'}</b></span><span>PİKSEL BAŞINA ÖRNEK<b>${fmtN(Math.min((R.sppNow || R.spp) * R.n, 99999))}</b></span>`;
    if (html !== state.ledger) { state.ledger = html; $('#ledger').innerHTML = html; }
  }
}

// ==================================================================== messages
function onMessage(m) {
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
  if (!m || typeof m !== 'object') return;
  switch (m.tip) {
    case 'durum': {
      const prev = D.durum;
      D.durum = m;
      for (const [k, i] of [['kasa', 0], ['gpu', 1]]) {
        const a = prev && prev.fan && prev.fan[k], b = m.fan && m.fan[k];
        if (b && b.durum !== 'geciyor') M.pend[k] = 0;
        if (a && b && a.durum !== b.durum && (b.durum === 'max' || b.durum === 'bios' || b.durum === 'oto')) {
          sound.relay(b.durum === 'max' ? 1 : 0.7);
          sound.spool(b.durum === 'max');
        }
      }
      if (prev && prev.rgb && m.rgb && prev.rgb.acik !== m.rgb.acik) { M.pend.rgb = 0; m.rgb.acik ? sound.lightsOn() : sound.lightsOff(); }
      if (m.rgb) M.pend.rgb = 0;
      break;
    }
    case 'isik': D.isik = m; D.isikAt = M.t; break;
    case 'olay': if (m.sonuc === 'hata') { sound.error(); M.pend.kasa = M.pend.gpu = 0; } break;
    case 'baglanti': D.link = m.durum; break;
    case 'gorunur':
      M.visible = m.visible !== false; M.focused = m.focused !== false;
      if (M.visible) kick();
      break;
  }
}

// ==================================================================== interaction
function setTab(t, silent) {
  if (t === M.tab) return;
  const k = smoother(clamp(M.camT, 0, 1));
  if (M.camT < 1) {           // reverse mid-move: continue from where the camera is
    M.camFrom = M.camTo; M.camTo = t; M.camT = 1 - M.camT;
  } else { M.camFrom = M.tab; M.camTo = t; M.camT = 0; }
  void k;
  M.tab = t;
  M.focus = t === 'fan' ? (M.focus === 2 ? 0 : M.focus) : 2;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  if (!silent) { sound.init(); sound.resume(); sound.glide(); }
  kick();
}
function canPress(i) {
  if (D.link !== 'bagli' || !D.durum) return false;
  if (i === 2) return true;
  const f = D.durum.fan && (i ? D.durum.fan.gpu : D.durum.fan.kasa);
  return f && f.kullanilabilir !== false && f.durum !== 'geciyor' && !M.pend[i ? 'gpu' : 'kasa'];
}
function pressDown(i) {
  sound.init(); sound.resume();
  M.down = i;
  if (canPress(i)) sound.press(); else sound.locked();
}
function pressUp(i, fire) {
  if (M.down !== i) return;
  M.down = -1;
  if (!fire) return;
  sound.release();
  if (!canPress(i)) return;
  if (i === 0) { M.pend.kasa = M.t; send({ komut: 'fan-kasa' }); }
  else if (i === 1) { M.pend.gpu = M.t; send({ komut: 'fan-gpu' }); }
  else { M.pend.rgb = M.t; send({ komut: 'rgb', acik: !(D.durum.rgb && D.durum.rgb.acik) }); }
  kick();
}
[['#hotKasa', 0], ['#hotGpu', 1], ['#hotTog', 2]].forEach(([s, i]) => {
  const el = $(s);
  el.tabIndex = -1;
  el.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.stopPropagation(); M.focus = i; el.setPointerCapture(e.pointerId); pressDown(i); });
  el.addEventListener('pointerup', e => { if (e.button !== 0) return; const r = el.getBoundingClientRect(); pressUp(i, e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom); });
  el.addEventListener('pointercancel', () => pressUp(i, false));
  el.addEventListener('pointerenter', () => { M.hover = i; });
  el.addEventListener('pointerleave', () => { M.hover = -1; });
  el.addEventListener('dblclick', e => e.stopPropagation());
});
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
document.querySelectorAll('#win button').forEach(b => b.addEventListener('click', () => (b.dataset.cmd === 'close' ? closeSoftly() : send(b.dataset.cmd))));
window.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  if (e.target.closest && e.target.closest('#win, #tabs, .hot')) return;
  sound.init(); sound.resume();
  if (e.detail < 2) send('drag');
});
window.addEventListener('dblclick', e => { if (e.target.closest && e.target.closest('#win, #tabs, .hot')) return; send('maximize'); });
window.addEventListener('contextmenu', e => e.preventDefault());
function closeSoftly() {
  if (M.closing) return;
  M.closing = M.t || 0.001;
  sound.lightsOff();
  setTimeout(() => send('close'), 420);
}
let keyDown = -1;
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeSoftly(); return; }
  if (e.key === 'Tab') { e.preventDefault(); setTab(M.tab === 'fan' ? 'rgb' : 'fan'); return; }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    // one row of controls across both tabs: kasa, gpu | toggle
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const f = clamp(M.focus + dir, 0, 2);
    M.focus = f;
    setTab(f === 2 ? 'rgb' : 'fan');
    return;
  }
  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
    e.preventDefault();
    const i = M.tab === 'rgb' ? 2 : M.focus;
    keyDown = i; pressDown(i); return;
  }
  if (!host && sim) {
    if (e.key === 'F1') { e.preventDefault(); $('#help').classList.toggle('show'); return; }
    if (!e.ctrlKey && !e.altKey && sim.key(e)) { e.preventDefault(); kick(); }
  }
});
window.addEventListener('keyup', e => {
  if ((e.key === ' ' || e.key === 'Enter') && keyDown >= 0) { e.preventDefault(); const i = keyDown; keyDown = -1; pressUp(i, true); }
});
window.addEventListener('blur', () => { if (!host) { M.focused = false; } });
window.addEventListener('focus', () => { M.focused = true; kick(); });
document.addEventListener('visibilitychange', () => { if (!host) { M.visible = !document.hidden; if (M.visible) kick(); } });
window.addEventListener('resize', () => { layoutDirty = true; if (R.ok) { resize(); kick(); } });

// ==================================================================== simulation step
function step(dt) {
  M.t += dt;
  M.introT += dt;
  const it = M.introT;
  M.light = it < 0.25 ? 0 : 1 - Math.exp(-(it - 0.25) / 0.35);
  if (M.light > 0.999) M.light = 1;
  if (M.closing) M.light *= Math.exp(-(M.t - M.closing) / 0.12);
  if (!M.ignited && it > 0.25) { M.ignited = true; sound.init(); sound.ignition(); document.body.classList.add('lit'); }
  if (M.camT < 1) { M.camT = Math.min(1, M.camT + dt / M.camDur); layoutDirty = true; }
  // rotors: inertia toward the speed the measured rpm implies
  const wt = rotorTargets();
  for (let i = 0; i < 2; i++) {
    M.w[i] = approach(M.w[i], wt[i], dt, wt[i] > M.w[i] ? 0.9 : 1.6);
    M.rot[i] = (M.rot[i] + M.w[i] * dt) % (Math.PI * 2 * 7);
  }
  // button travel: a damped spring (0.35 cm when held)
  for (let i = 0; i < 3; i++) {
    const target = M.down === i ? 0.32 : 0;
    const k = 900, c = 2 * Math.sqrt(k) * 0.7;
    M.pushV[i] += (k * (target - M.push[i]) - c * M.pushV[i]) * dt;
    M.push[i] += M.pushV[i] * dt;
  }
  // pending commands give up after 8 s without an answer
  for (const k of ['kasa', 'gpu', 'rgb']) if (M.pend[k] && M.t - M.pend[k] > 8) M.pend[k] = 0;
  updateLights(dt);
}

let raf = 0, lastT = 0, rayWin = { t: 0, rays: 0 };
let perfWin = [], perfAt = performance.now(), lastFrameNow = 0, perfGpu0 = 0;
// every 10 s while visible: rAF interval percentiles, count over 2x median, GPU time (host logs it)
function reportPerf() {
  const a = perfWin.slice().sort((x, y) => x - y);
  perfWin = [];
  if (a.length < 10) return;
  const q = f => a[Math.min(a.length - 1, Math.floor(f * a.length))];
  const med = q(0.5), long = a.filter(x => x > 2 * med).length;
  const g = R.gpu.slice(perfGpu0); perfGpu0 = R.gpu.length;
  const gm = g.length ? g.slice().sort((x, y) => x - y)[g.length >> 1] : null;
  send(`perf:kare p50=${med.toFixed(1)} p95=${q(0.95).toFixed(1)} p99=${q(0.99).toFixed(1)} max=${a[a.length - 1].toFixed(1)} uzun=${long}` +
       (gm != null ? ` gpu=${gm.toFixed(1)}ms` : '') + ` n=${a.length} spp=${R.sppNow}/${R.sppDyn}` +
       ` k=${PACE.k} yenileme=${PACE.refresh.toFixed(2)} odak=${M.focused ? 1 : 0} ${R.w}x${R.h}` +
       (R.slow ? ` js-en-yavas=${R.slow.total.toFixed(0)}(adim ${R.slow.step.toFixed(0)}, cizim ${R.slow.render.toFixed(0)}, yazi ${R.slow.overlay.toFixed(0)})` : '') +
       (PACE.worst ? ` en-uzun-aralik@${PACE.worst.t.toFixed(1)}s:${PACE.worst.what}` : '') +
       ` uzun-gorev=${PACE.lt.n}${PACE.lt.n ? '/' + PACE.lt.max.toFixed(0) + 'ms@' + PACE.lt.at.toFixed(2) + 's' : ''}`);
  R.slow = null; PACE.worst = null; PACE.lt = { n: 0, max: 0 };
}
R.rays = 0;
// Pacing. The scene renders at an even cadence of k display refreshes, scheduled against absolute time
// targets (counting rAF ticks drifts: Chromium drops ticks while the GPU is busy). The refresh period is
// measured all the time from the shortest rAF intervals; k comes from the median GPU time of full frames
// (resting frames, which only trace the rotors, do not count), with hysteresis, so it does not change
// while nothing changes in the scene. Cadence never exceeds ~64 fps.
const PACE = { ticks: [], tc: 0, lastTick: 0, refresh: 1000 / 60, k: 3, last: 0, up: 0, n: 0, full: [], recent: [], down: 0 };
function tickRefresh(now) {
  if (PACE.lastTick) {
    const d = now - PACE.lastTick;
    if (d > 2 && d < 60) { PACE.ticks.push(d); if (PACE.ticks.length > 240) PACE.ticks.shift(); }
  }
  PACE.lastTick = now;
  if (PACE.ticks.length >= 12 && (++PACE.tc % 12) === 0) {
    const a = PACE.ticks.slice().sort((x, y) => x - y);
    // intervals are whole multiples of the refresh, with jitter: average the cluster of single refreshes
    const r0 = a[Math.floor(a.length * 0.1)];
    const one = a.filter(x => x > r0 * 0.75 && x < r0 * 1.3);
    const est = clamp(one.reduce((x, y) => x + y, 0) / one.length, 1000 / 360, 1000 / 24);
    if (Math.abs(est - PACE.refresh) / PACE.refresh > 0.01) PACE.refresh = est;
  }
}
function measureRefresh(now) {                  // during startup, before frames are drawn
  if (R.ok) return;
  tickRefresh(now);
  requestAnimationFrame(measureRefresh);
}
requestAnimationFrame(measureRefresh);
PACE.lt = { n: 0, max: 0 };   // main-thread long tasks since the last perf line (tells a page stall from a GPU/compositor one)
try { new PerformanceObserver(l => l.getEntries().forEach(e => { PACE.lt.n++; if (e.duration > PACE.lt.max) { PACE.lt.max = e.duration; PACE.lt.at = (e.startTime - bootT) / 1000; } })).observe({ type: 'longtask' }); } catch (e) { /* not supported */ }
function choosePace() {
  const cap = Math.max(1, Math.ceil(15.6 / PACE.refresh - 0.02));            // never faster than ~64 fps
  if (R.timer) {
    // from the median GPU time of full frames (resting frames do not count), with hysteresis
    const g = PACE.full.slice(-60);
    if (g.length < 12) return;
    const s2 = g.slice().sort((x, y) => x - y), med = s2[s2.length >> 1];
    const k = Math.max(cap, clamp(Math.ceil((med * 1.3 + 2.0) / PACE.refresh - 0.02), 1, 8));
    if (!PACE.decided) { PACE.decided = true; PACE.k = k; return; }
    if (k > PACE.k) { PACE.down = 0; if (++PACE.up >= 2) { PACE.k = k; PACE.up = 0; } }
    else if (k < PACE.k && (med * 1.3 + 2.0) < (PACE.k - 1) * PACE.refresh * 0.85) { PACE.up = 0; if (++PACE.down >= 3) { PACE.k = k; PACE.down = 0; } }
    else { PACE.up = 0; PACE.down = 0; }
    return;
  }
  // no timer: from what the display shows; raise k after two windows where >4% of frames came a refresh late
  if (!PACE.decided) { PACE.decided = true; PACE.k = cap; PACE.recent.length = 0; return; }
  const iv = PACE.recent.splice(0);
  if (iv.length < 20) return;
  const miss = iv.filter(x => x > (PACE.k + 0.5) * PACE.refresh).length / iv.length;
  if (miss > 0.04) { if (++PACE.up >= 2) { PACE.k = Math.min(cap + 3, PACE.k + 1); PACE.up = 0; } } else PACE.up = 0;
}
function frame(now) {
  raf = 0;
  if (!M.visible) { lastFrameNow = 0; return; }
  tickRefresh(now);
  if (!params.has('nopace')) {
    // due k refreshes after the frame that actually ran: half a refresh of tolerance absorbs rAF jitter,
    // and an error in the refresh estimate cannot accumulate into a slipped vsync
    if (PACE.last && now - PACE.last < (PACE.k - 0.5) * PACE.refresh) { raf = requestAnimationFrame(frame); return; }
    PACE.last = now;
  }
  if (++PACE.n % 60 === 0) choosePace();
  const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
  lastT = now;
  const p0 = performance.now();
  step(dt);
  const p1 = performance.now();
  render(dt);
  const p2 = performance.now();
  updateOverlay(dt);
  const p3 = performance.now();
  if (p3 - p0 > (R.slow ? R.slow.total : 8)) R.slow = { total: p3 - p0, step: p1 - p0, render: p2 - p1, overlay: p3 - p2, t: M.t, tab: M.tab, camT: M.camT };
  if (R.frame > 1 && lastFrameNow) {
    const iv = now - lastFrameNow;
    perfWin.push(iv);
    if (!R.timer) PACE.recent.push(iv);
    if (!PACE.worst || iv > PACE.worst.iv) PACE.worst = { iv, t: M.t, what: [M.tab, M.camT < 1 ? 'kamera' : '', R.idle ? 'dinlenme' : 'tam', 'n' + Math.round(R.n), 'js' + (p3 - p0).toFixed(0)].filter(Boolean).join('/') };
  }
  lastFrameNow = now;
  if (host && now - perfAt > 10000) { perfAt = now; reportPerf(); }
  if (now - rayWin.t > 1000) { R.raysPerSec = (R.rays - rayWin.rays) / ((now - rayWin.t) / 1000); rayWin = { t: now, rays: R.rays }; }
  if (window.__km && window.__km.onFrame) window.__km.onFrame(now);
  raf = requestAnimationFrame(frame);
}
function kick() { if (!raf && M.visible && R.ok && !params.has('still')) { lastT = 0; raf = requestAnimationFrame(frame); } }

// ==================================================================== start
R.spp = +(params.get('spp') || 10); R.sppDyn = +(params.get('sppdyn') || 18);
if (host) {
  host.addEventListener('message', e => onMessage(e.data));
} else {
  sim = window.KM_BENZETIM(onMessage);
  $('#help').innerHTML = '<div class="h">BENZETİM · KISAYOLLAR</div>' + sim.help.map(([k, t]) => `<div><b>${esc(k)}</b>${esc(t)}</div>`).join('');
}
window.__km = { M, R, D, L, setTab, get sim() { return sim; }, step, render, updateOverlay, onMessage };

(async () => {
  try {
    await document.fonts.ready;
    sound.init();             // build the reverb and noise buffers now, while the shaders compile, not on the first frames
    await initGL();
  } catch (err) {
    console.error(err);
    document.body.classList.add('nogl', 'lit');
    send('perf:webgl-failed ' + (err && err.message));
  }
  if (host) send('ready'); else sim.connect();
  kick();
})();
})();
