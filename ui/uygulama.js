// Kontrol Merkezi: the window. One diegetic scene, the underground hall (docs/SALON.md): there is no UI layer, every
// control and every text is an object in the world. This file talks to the host (WebView2) or to the simulated
// service, keeps the state, turns it into the world (light colours, rotors, levers, haze, the texts on signs, desks and
// the arch's display), flies the camera between the two places and picks what the mouse points at. The renderer is
// ui/salon/salon.js, the texts are drawn by ui/salon/levha.js.
'use strict';
(() => {
// ==================================================================== helpers
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len3 = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len3(a) || 1; return mul(a, 1 / l); };
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const approach = (x, target, dt, tau) => x + (target - x) * (1 - Math.exp(-dt / tau));
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const lin = c => { c = c / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const linRgb = c => [lin(c[0]), lin(c[1]), lin(c[2])];
const fmtN = n => new Intl.NumberFormat('tr-TR').format(Math.round(n));
const fmt1 = n => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
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
const D = { link: host ? 'baslatiliyor' : 'bagli', durum: null, isik: null };
const M = {
  t: 0, introT: 0, closing: 0,
  visible: true, focused: true,
  place: 'fanlar',                 // where the journey goes (fanlar | rgb)
  s: 0, v: 0,                      // the camera's arc length along the journey and its speed (m, m/s)
  rot: { fan_kasa_rotor: 0, fan_gpu_rotor: 0 }, w: { fan_kasa_rotor: 0, fan_gpu_rotor: 0 },
  lever: { kol_kasa: 0, kol_gpu: 0, kol_rgb: 0 }, leverV: { kol_kasa: 0, kol_gpu: 0, kol_rgb: 0 },
  hover: null, down: null, focus: 0, // focus: 0 kasa, 1 gpu, 2 rgb (keyboard)
  temp: 40,
  pend: { kasa: 0, gpu: 0, rgb: 0 },
  col: { temp: [1, 1, 1], arch: [0, 0, 0] },
};
const sound = window.KM_SES;
let S = null;                      // the renderer
let journey = null;                // the camera path (built from the pack's views)

// ==================================================================== the journey
// The path is the pack's centre line from the fanlar eye to the rgb eye; the camera's look is a function of where it
// is (s), so going back is the same picture in reverse: a slow pull back from the monument, the arch receding.
function buildJourney(views) {
  const P = (views.yol && views.yol.length >= 2) ? views.yol.slice() : [views.fanlar.goz, views.rgb.goz];
  const pts = [P[0], ...P, P[P.length - 1]];
  const seg = (i, t) => {                       // Catmull-Rom (uniform) between pts[i+1] and pts[i+2]
    const p0 = pts[i], p1 = pts[i + 1], p2 = pts[i + 2], p3 = pts[i + 3];
    const t2 = t * t, t3 = t2 * t;
    return [0, 1, 2].map(k => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
  };
  const table = [];                             // arc length -> point, fine samples
  let acc = 0, prev = seg(0, 0);
  for (let i = 0; i < P.length - 1; i++) {
    for (let j = 0; j < 24; j++) {
      const q = seg(i, (j + (i === 0 && j === 0 ? 0 : 0)) / 24);
      acc += len3(sub(q, prev)); prev = q;
      table.push({ s: acc, p: q });
    }
  }
  const last = seg(P.length - 2, 1);
  acc += len3(sub(last, prev));
  table.push({ s: acc, p: last });
  const total = acc;
  const at = s => {
    s = clamp(s, 0, total);
    let lo = 0, hi = table.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (table[m].s < s) lo = m; else hi = m; }
    const a = table[lo], b = table[hi], f = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
    return mix3(a.p, b.p, f);
  };
  const f0 = views.fanlar, f1 = views.rgb;
  return {
    total,
    at,
    // eye, look direction and fov at arc length s
    pose(s) {
      const eye = at(s);
      const d0 = norm(sub(f0.hedef, eye)), d1 = norm(sub(f1.hedef, eye));
      const ahead = norm(sub(add(at(s + 32), [0, 0.6, 0]), eye));
      // through the middle the lane's view across the rows (the hall's width); as the path crosses back through a gap
      // of the inner row the look swings onto the arch, revealed between the columns, and stays on it, growing
      const u = s / total, onArch = smooth((u - 0.6) / 0.16);
      const w0 = 1 - smooth(s / 45), w1 = Math.max(onArch, smooth((s - (total - 70)) / 70));
      let dir = add(add(mul(d0, w0 * (1 - w1)), mul(d1, w1)), mul(ahead, Math.max(0, 1 - w0 - w1)));
      if (s >= total - 1e-3) dir = d1;
      // in the lane between the rows the camera turns across them (up to ~22 degrees towards the aisle), so the view
      // opens diagonally over the forest of columns instead of down a second corridor; it gives way to the arch
      const lane = clamp((eye[0] - 6) / 8, 0, 1);
      const yaw = -0.38 * smooth(lane) * Math.sign(eye[0] || 1) * (1 - onArch);
      const cy = Math.cos(yaw), sy = Math.sin(yaw), d = norm(dir);
      dir = [d[0] * cy - d[2] * sy, d[1], d[0] * sy + d[2] * cy];
      return { eye, dir: norm(dir), fov: lerp(f0.fov || 50, f1.fov || 50, smooth(s / total)) };
    },
  };
}
// speed profile: accelerate, cruise, brake exactly onto the goal; a smoothed velocity so nothing jerks
const VMAX = 38, AMAX = 11;
function stepJourney(dt) {
  if (!journey) return;
  const goal = M.place === 'rgb' ? journey.total : 0;
  const d = goal - M.s;
  const brake = Math.sqrt(2 * AMAX * Math.abs(d) * 0.8);
  const vt = Math.sign(d) * Math.min(VMAX, brake, Math.abs(d) * 3.2);
  const dv = clamp(vt - M.v, -AMAX * dt, AMAX * dt);
  M.v += dv;
  M.s += M.v * dt;
  if (Math.abs(goal - M.s) < 0.02 && Math.abs(M.v) < 0.05) { M.s = goal; M.v = 0; }
  M.s = clamp(M.s, 0, journey.total);
}
const travelling = () => journey && (M.v !== 0 || (M.place === 'rgb' ? M.s < journey.total : M.s > 0));
const atPlace = p => !travelling() && M.place === p;

// the resting camera's slow steady drift (two incommensurate periods, a few centimetres)
function drift(pose) {
  const t = M.t;
  const r = norm([pose.dir[2], 0, -pose.dir[0]]);
  const o = add(mul(r, 0.16 * Math.sin(t * 2 * Math.PI / 23)), [0, 0.07 * Math.sin(t * 2 * Math.PI / 31 + 1.3), 0]);
  const look = add(mul(r, 0.010 * Math.sin(t * 2 * Math.PI / 29 + 0.4)), [0, 0.006 * Math.sin(t * 2 * Math.PI / 37), 0]);
  return { eye: add(pose.eye, o), dir: norm(add(pose.dir, look)), fov: pose.fov };
}

// exposure along the journey: the middle of the hall stays dark (the eye only half adapts), the arch is bright
function exposureAt(s) {
  if (!journey) return 0;
  const u = s / journey.total;
  return lerp(0, 1.6, smooth(u / 0.45)) - lerp(0, 2.4, smooth((u - 0.55) / 0.45));
}

// ==================================================================== state -> world
const NEUTRAL_LAMP = [1.0, 0.78, 0.52];
// each light group's intensity against its baked white (the bake's units are each group's own); #k0=..&k1=..&k2=..
// overrides them for tuning
const GK = [30, 12, 6].map((d, i) => (params.has('k' + i) ? +params.get('k' + i) : d));
function stops() { return (D.durum && D.durum.rgb && D.durum.rgb.duraklar && D.durum.rgb.duraklar.length >= 2) ? D.durum.rgb.duraklar : null; }
const linked = () => D.link === 'bagli';
const rgbOn = () => !!(linked() && D.durum && D.durum.rgb && D.durum.rgb.acik);

function updateLights(dt) {
  const iz = D.isik;
  const it = M.introT;
  // the opening: the shaft's light strikes (a quick partial, then full), the haze lights with it; the arch follows
  const strike = it < 0.25 ? 0 : smooth((it - 0.25) / 0.18) * 0.45 + smooth((it - 0.5) / 0.9) * 0.55;
  const archIn = smooth((it - 0.7) / 1.1);
  const close = M.closing ? Math.exp(-(M.t - M.closing) / 0.12) : 1;
  const tc = iz && iz.onizleme ? linRgb(iz.onizleme) : M.col.temp;
  M.col.temp = mix3(M.col.temp, tc, 1 - Math.exp(-dt / 0.3));
  const out = iz && iz.cikis && rgbOn() ? linRgb(iz.cikis) : [0, 0, 0];
  M.col.arch = mix3(M.col.arch, out, 1 - Math.exp(-dt / 0.25));
  const conn = linked() ? 1 : 0.55;
  // RGB off (Özcan, 11-16): the whole hall sinks into a darkness you can still see in, slowly, a little unsettling:
  // the shaft and the arch fall to a faint ember of the temperature colour, the service lamps keep the silhouettes
  M.lit = approach(M.lit == null ? 1 : M.lit, rgbOn() || !linked() ? 1 : 0, dt, rgbOn() ? 0.5 : 1.4);
  if (!S) return;
  S.setGroup(0, M.col.temp, GK[0] * strike * conn * close * lerp(0.07, 1, M.lit));
  // the heat core: brighter and more alive as it gets hotter (0 at the coldest stop, 1 at the hottest), breathing
  // slowly (a 7 s period, a few percent); the shimmer in the opening's air grows with it. Bounded: never blows out
  const st = stops(), c0 = st ? st[0].c : 52, c1 = st ? st[st.length - 1].c : 80.5;
  M.heat = approach(M.heat == null ? 0 : M.heat, linked() ? clamp((M.temp - c0 + 6) / (c1 - c0 + 6), 0, 1) : 0, dt, 1.5);
  const breath = 1 + (0.03 + 0.05 * M.heat) * Math.sin(M.t * 2 * Math.PI / 7);
  S.setGroup(1, add(M.col.arch, mul(M.col.temp, 0.06)), GK[1] * archIn * conn * close * lerp(0.75, 1.45, M.heat) * breath);
  if (S.setHeat) S.setHeat(M.heat * (rgbOn() ? 1 : 0.3));
  S.setGroup(2, NEUTRAL_LAMP, GK[2] * smooth((it - 0.1) / 0.5) * close * lerp(0.7, 1, M.lit));
}

// rotors: the giant fans turn at a share of the real fans' speed, with the inertia of their size
const FAN_REV = 2.3;   // rev/s at the real fans' top speed
function rotorTarget(i) {
  const fan = D.durum && D.durum.fan;
  if (!linked() || !fan) return 0;
  if (i === 0) {
    const r = fan.kasa && fan.kasa.rpm && fan.kasa.rpm.length ? (fan.kasa.rpm.find(x => x.ad === 'CPU_FAN') || fan.kasa.rpm[0]).rpm : 0;
    return r > 50 ? FAN_REV * Math.pow(clamp(r / 2003, 0, 1.15), 1.35) : 0;
  }
  const g = fan.gpu && fan.gpu.rpm && fan.gpu.rpm.length ? fan.gpu.rpm.reduce((a, b) => a + b, 0) / fan.gpu.rpm.length : 0;
  return g > 50 ? FAN_REV * Math.pow(clamp(g / 3000, 0, 1.15), 1.35) : 0;
}
function stepRotors(dt) {
  [['fan_kasa_rotor', 0], ['fan_gpu_rotor', 1]].forEach(([n, i]) => {
    const wt = rotorTarget(i) * 2 * Math.PI;
    M.w[n] = approach(M.w[n], wt, dt, wt > M.w[n] ? 2.4 : 4.2);
    M.rot[n] = (M.rot[n] + M.w[n] * dt) % (Math.PI * 2 * 90);
  });
}
// levers: down (pulled) = max / lights on; a spring that answers the hand at once and the state when it comes
function stepLevers(dt) {
  const fan = linked() && D.durum && D.durum.fan;
  const want = {
    kol_kasa: (M.down === 'fan_kasa' || M.down === 'masa_kasa' ? 0.25 : 0) + (fan && fan.kasa && fan.kasa.durum === 'max' ? 1 : 0),
    kol_gpu: (M.down === 'fan_gpu' || M.down === 'masa_gpu' ? 0.25 : 0) + (fan && fan.gpu && fan.gpu.durum === 'max' ? 1 : 0),
    kol_rgb: (M.down === 'anahtar_rgb' ? 0.25 : 0) + (rgbOn() ? 1 : 0),
  };
  const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;   // explicit steps are unstable above ~1/60 s at this stiffness
  for (const k of Object.keys(want)) {
    const target = clamp(want[k], 0, 1);
    const kk = 160, c = 2 * Math.sqrt(kk) * 0.8;
    for (let i = 0; i < n; i++) {
      M.leverV[k] += (kk * (target - M.lever[k]) - c * M.leverV[k]) * h;
      M.lever[k] += M.leverV[k] * h;
    }
    if (S) S.setLever(k, M.lever[k] * 1.05);   // positive about the hinge's x: the handle comes out of the wall
  }
}

// ==================================================================== the texts in the world
// Each texture is redrawn only when what it shows changes (KM_LEVHA.draw is deterministic).
const levhaKeys = {};
// a redraw costs 15-35 ms of the main thread and each one cost a frame (the real window, 11-16: 55 ms frames among
// 30 ms ones): at most one per frame, and none while the camera travels (no text can be read in flight; whatever
// changed is drawn on arrival)
let levhaBudget = 1;
function putLevha(name, data, opts) {
  if (!S || !window.KM_LEVHA || !KM_LEVHA.sizes[name]) return;
  const key = JSON.stringify(data);
  if (levhaKeys[name] === key) return;
  if (levhaKeys[name] !== undefined && (levhaBudget <= 0 || travelling())) return;
  levhaBudget--;
  levhaKeys[name] = key;
  S.setLevha(name, KM_LEVHA.draw(name, data), opts || {});
}
const RPM_AD = ad => ad === 'CPU_FAN' ? 'İşlemci' : ad === 'PUMP_FAN' ? 'Pompa' : (/^SYS_FAN(\d+)$/.exec(ad) ? 'Kasa ' + /^SYS_FAN(\d+)$/.exec(ad)[1] : ad);
// the data shapes are levha.js' (documented at its top); a state the service did not report is never shown
const DESK_STATE = { max: 'en_yuksek', bios: 'bios', oto: 'kart', geciyor: 'geciyor', baska: 'baska' };
function fanDesk(i) {
  const fan = D.durum && D.durum.fan ? (i ? D.durum.fan.gpu : D.durum.fan.kasa) : null;
  const isi = (D.durum && D.durum.isi) || {};
  const v = { durum: 'bilgi_yok', hover: i ? (M.hover === 'fan_gpu' || M.hover === 'masa_gpu') : (M.hover === 'fan_kasa' || M.hover === 'masa_kasa') };
  if (!linked() || !fan) {
    v.kullanilabilir = false;
    v.neden = D.link === 'baslatiliyor' ? 'SERVİS BAŞLATILIYOR' : 'SERVİSE BAĞLI DEĞİL';
    return v;
  }
  const busy = fan.durum === 'geciyor' || M.pend[i ? 'gpu' : 'kasa'] > 0;
  v.durum = busy ? 'geciyor' : (DESK_STATE[fan.durum] || 'bilgi_yok');
  v.sicaklik = i ? (isi.gpu != null ? isi.gpu : null) : (isi.cpu != null ? isi.cpu : null);
  if (!i) v.fanlar = (fan.rpm || []).map(r => ({ ad: RPM_AD(r.ad), rpm: r.rpm }));
  else {
    v.fanlar = (fan.rpm || []).map((r, k) => ({ ad: 'Fan ' + (k + 1), rpm: r }));
    v.yuzde = fan.yuzde != null ? fan.yuzde : null;
  }
  if (fan.kullanilabilir === false) { v.kullanilabilir = false; v.neden = fan.neden || 'BU KOL ŞU AN ÇALIŞAMIYOR'; }
  return v;
}
function warning(i) {
  const d = D.durum;
  if (!linked()) return 'baglanti';
  if (!d || !d.fan) return '';
  const f = i ? d.fan.gpu : d.fan.kasa;
  if (d.servis && d.servis.yonetici === false && f && f.kullanilabilir === false) return 'yetki';
  if (i && f) {
    const ab = f.afterburner || {};
    if (ab.fanKontrolu) return 'afterburner';
    if (f.durum === 'baska') return 'baska';
  }
  return '';
}
function deviceState(c) {
  if (!linked() || !c) return { durum: 'bagli_degil' };
  if (c.kilitli) return { durum: 'kilitli' };
  if (c.hata) return { durum: 'hata', hata: String(c.hata) };
  if (c.bagli) return { durum: 'bagli' };
  return { durum: 'bagli_degil' };
}
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);
function updateTexts() {
  const d = D.durum, isi = (d && d.isi) || {}, rgb = d && d.rgb;
  putLevha('masa_ekran_kasa', { ...fanDesk(0), uyari: warning(0) }, { emissive: 1 });
  putLevha('masa_ekran_gpu', { ...fanDesk(1), uyari: warning(1) }, { emissive: 1 });
  putLevha('boya_kasa', {});
  putLevha('boya_gpu', {});
  putLevha('tabela_rgb', {});
  putLevha('tabela_fanlar', {});
  putLevha('cikis_1', {}, { emissive: 1 });
  putLevha('cikis_2', {}, { emissive: 1 });
  const on = rgbOn(), idle = !!(rgb && rgb.beklemede && on);
  // the colour is passed rounded (a redraw costs 15-35 ms; the smoothed colour must not redraw every frame)
  const tc = M.col.temp.map(c => Math.round(c * 64) / 64);
  putLevha('kilit_tasi_ekran', {
    ortalama: linked() && (isi.yumusak != null || isi.ort != null) ? round1(M.temp) : null,
    cpu: linked() ? round1(isi.cpu) : null, gpu: linked() ? round1(isi.gpu) : null, renk: tc, kapali: !on,
  }, { emissive: on ? 1.6 : 0.7 });
  putLevha('plaka_rgb', {
    acik: linked() && rgb ? on : null, bosta: idle,
    beklemeDakika: idle ? (rgb.beklemeDakika ?? 15) : null, hover: M.hover === 'anahtar_rgb',
  });
  const st = (stops() || []).filter(s => !s.gizli).slice(0, STOP_LAMPS);
  const valid = linked() && (isi.yumusak != null || isi.ort != null);
  const cur = valid ? st.reduce((k, s, i) => (M.temp >= s.c ? i : k), -1) : -1;
  const slots = stopSlots(st.length), used = new Set(slots);
  st.forEach((s, i) => putLevha('durak_plaka_' + slots[i], {
    derece: s.c, ad: s.ad || '', renk: window.KM_RENK.full(window.KM_RENK.fromSrgb(s.renk)), secili: i === cur,
  }));
  for (let k = 0; k < STOP_LAMPS; k++) if (!used.has(k)) putLevha('durak_plaka_' + k, { derece: null, ad: '', renk: [0, 0, 0], secili: false });
  const devs = (rgb && rgb.cihazlar) || [];
  [['aio', 'cihaz_aio'], ['klavye', 'cihaz_klavye'], ['gpu', 'cihaz_gpu']].forEach(([k, n]) => {
    const c = devs.find(c => c.kimlik === k);
    putLevha(n, { ...deviceState(c), ad: c && c.ad });
  });
}
// the small lamps: the colour scale's stops around the arch light up to the temperature; device lamps by state
const STOP_LAMPS = 5;                 // the gauge over the arch's display: durak_0..4, cold to hot from left to right
function stopSlots(n) {               // which of the gauge's five lamps carries stop i of n
  const SLOTS = STOP_LAMPS;
  if (n >= SLOTS) return [...Array(SLOTS).keys()];
  return [...Array(n).keys()].map(i => (n === 1 ? 0 : Math.round(i * (SLOTS - 1) / (n - 1))));
}
function updateLamps() {
  if (!S) return;
  const st = (stops() || []).filter(s => !s.gizli).slice(0, STOP_LAMPS);
  const on = rgbOn(), valid = linked() && D.durum && D.durum.isi && (D.durum.isi.yumusak != null || D.durum.isi.ort != null);
  const slots = stopSlots(st.length), used = new Set(slots);
  st.forEach((s, i) => {
    const lit = valid && M.temp >= s.c ? 1 : 0;
    const part = valid && !lit && i > 0 && M.temp > st[i - 1].c ? clamp((M.temp - st[i - 1].c) / (s.c - st[i - 1].c), 0, 1) * 0.35 : 0;
    S.setLamp('durak_' + slots[i], window.KM_RENK.full(window.KM_RENK.fromSrgb(s.renk)), (0.04 + 0.96 * Math.max(lit, part)) * (on ? 3.0 : 0.6));
  });
  for (let k = 0; k < STOP_LAMPS; k++) if (!used.has(k)) S.setLamp('durak_' + k, [0, 0, 0], 0);
  const devs = (D.durum && D.durum.rgb && D.durum.rgb.cihazlar) || [];
  [['aio', 'lamba_aio'], ['klavye', 'lamba_klavye'], ['gpu', 'lamba_gpu']].forEach(([k, n]) => {
    const s = deviceState(devs.find(c => c.kimlik === k));
    const c = s.durum === 'bagli' ? [0.2, 1.0, 0.35] : s.durum === 'kilitli' ? [1.0, 0.6, 0.15] : s.durum === 'hata' ? [1.0, 0.12, 0.05] : [0, 0, 0];
    S.setLamp(n, c, linked() ? 2.0 : 0);
  });
}
function updateHaze() {
  if (!S) return;
  const st = n => clamp(0.12 + 0.88 * Math.pow(M.w[n] / (FAN_REV * 2 * Math.PI), 1.2), 0, 1);
  S.setHaze({ density: 1, fans: [{ name: 'fan_kasa', strength: st('fan_kasa_rotor') }, { name: 'fan_gpu', strength: st('fan_gpu_rotor') }] });
}

// ==================================================================== messages
function onMessage(m) {
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
  if (!m || typeof m !== 'object') return;
  switch (m.tip) {
    case 'durum': {
      const prev = D.durum;
      D.durum = m;
      for (const k of ['kasa', 'gpu']) {
        const a = prev && prev.fan && prev.fan[k], b = m.fan && m.fan[k];
        if (b && b.durum !== 'geciyor') M.pend[k] = 0;
        if (a && b && a.durum !== b.durum && (b.durum === 'max' || b.durum === 'bios' || b.durum === 'oto')) {
          sound.relay(b.durum === 'max' ? 1 : 0.7);
          sound.spool(b.durum === 'max');
        }
      }
      if (prev && prev.rgb && m.rgb && prev.rgb.acik !== m.rgb.acik) { m.rgb.acik ? sound.lightsOn() : sound.lightsOff(); }
      if (m.rgb) M.pend.rgb = 0;
      const isi = m.isi;
      const tv = isi ? (isi.yumusak != null ? isi.yumusak : isi.ort) : null;
      if (tv != null) M.temp = tv;
      break;
    }
    case 'isik': D.isik = m; break;
    case 'olay': if (m.sonuc === 'hata') { sound.error(); M.pend.kasa = M.pend.gpu = 0; } break;
    case 'baglanti': D.link = m.durum; break;
    case 'gorunur':
      M.visible = m.visible !== false; M.focused = m.focused !== false;
      if (M.visible) kick();
      break;
  }
}

// ==================================================================== interaction
// what each clickable anchor does, and where it can be used
const ACTIONS = {
  fan_kasa: { at: 'fanlar', press: () => { M.pend.kasa = M.t; send({ komut: 'fan-kasa' }); }, can: () => canFan(0) },
  fan_gpu: { at: 'fanlar', press: () => { M.pend.gpu = M.t; send({ komut: 'fan-gpu' }); }, can: () => canFan(1) },
  // the desks on the landing carry the same levers
  masa_kasa: { at: 'fanlar', press: () => { M.pend.kasa = M.t; send({ komut: 'fan-kasa' }); }, can: () => canFan(0) },
  masa_gpu: { at: 'fanlar', press: () => { M.pend.gpu = M.t; send({ komut: 'fan-gpu' }); }, can: () => canFan(1) },
  anahtar_rgb: { at: 'rgb', press: () => { M.pend.rgb = M.t; send({ komut: 'rgb', acik: !rgbOn() }); }, can: () => linked() && !!D.durum },
  git_rgb: { at: 'any', press: () => go('rgb'), can: () => true, quiet: true },
  git_fanlar: { at: 'any', press: () => go('fanlar'), can: () => true, quiet: true },
  cikis_1_tik: { at: 'any', press: () => closeSoftly(), can: () => true, quiet: true },
  cikis_2_tik: { at: 'any', press: () => closeSoftly(), can: () => true, quiet: true },
};
function canFan(i) {
  if (!linked() || !D.durum) return false;
  const f = D.durum.fan && (i ? D.durum.fan.gpu : D.durum.fan.kasa);
  return !!f && f.kullanilabilir !== false && f.durum !== 'geciyor' && !M.pend[i ? 'gpu' : 'kasa'];
}
function usable(name) {
  const a = ACTIONS[name];
  if (!a) return false;
  return a.at === 'any' || atPlace(a.at);
}
function go(place) {
  if (M.place === place) return;
  M.place = place;
  M.focus = place === 'rgb' ? 2 : (M.focus === 2 ? 0 : M.focus);
  sound.init(); sound.resume(); sound.glide();
  kick();
}
function pressDown(name) {
  sound.init(); sound.resume();
  M.down = name;
  const a = ACTIONS[name];
  if (a.quiet) return;
  if (a.can()) sound.press(); else sound.locked();
}
function pressUp(name, fire) {
  if (M.down !== name) return;
  M.down = null;
  if (!fire) return;
  const a = ACTIONS[name];
  if (!a.quiet) sound.release();
  if (!a.can()) return;
  a.press();
  kick();
}
const canvas = document.getElementById('gl');
const DRAG_STRIP = 34;            // the window's drag zone: the top strip, invisible
function hitAt(x, y) {
  if (!S || y < DRAG_STRIP) return null;
  const n = S.pick(x, y);
  return n && usable(n) ? n : null;
}
window.addEventListener('pointermove', e => {
  const n = hitAt(e.clientX, e.clientY);
  if (n !== M.hover) { M.hover = n; if (S) S.setHover(n); canvas.style.cursor = n ? 'pointer' : 'default'; }
});
window.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  sound.init(); sound.resume();
  const n = hitAt(e.clientX, e.clientY);
  if (n) {
    e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    if (n === 'fan_kasa' || n === 'masa_kasa') M.focus = 0; else if (n === 'fan_gpu' || n === 'masa_gpu') M.focus = 1; else if (n === 'anahtar_rgb') M.focus = 2;
    pressDown(n); return;
  }
  if (e.detail < 2) send('drag');
});
window.addEventListener('pointerup', e => {
  if (e.button !== 0 || !M.down) return;
  const n = hitAt(e.clientX, e.clientY);
  pressUp(M.down, n === M.down);
});
window.addEventListener('pointercancel', () => { if (M.down) pressUp(M.down, false); });
window.addEventListener('dblclick', e => { if (!hitAt(e.clientX, e.clientY)) send('maximize'); });
window.addEventListener('contextmenu', e => e.preventDefault());
function closeSoftly() {
  if (M.closing) return;
  M.closing = M.t || 0.001;
  sound.lightsOff();
  setTimeout(() => send('close'), 420);
}
let keyDown = null;
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeSoftly(); return; }
  if (e.key === 'Tab') { e.preventDefault(); go(M.place === 'fanlar' ? 'rgb' : 'fanlar'); return; }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    M.focus = clamp(M.focus + (e.key === 'ArrowRight' ? 1 : -1), 0, 2);
    go(M.focus === 2 ? 'rgb' : 'fanlar');
    return;
  }
  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
    e.preventDefault();
    const n = M.place === 'rgb' ? 'anahtar_rgb' : (M.focus === 1 ? 'fan_gpu' : 'fan_kasa');
    if (!usable(n)) return;
    keyDown = n; pressDown(n); return;
  }
  if (!host && sim && !e.ctrlKey && !e.altKey && sim.key(e)) { e.preventDefault(); kick(); }
});
window.addEventListener('keyup', e => {
  if ((e.key === ' ' || e.key === 'Enter') && keyDown) { e.preventDefault(); const n = keyDown; keyDown = null; pressUp(n, true); }
});
window.addEventListener('focus', () => { M.focused = true; kick(); });
document.addEventListener('visibilitychange', () => { if (!host) { M.visible = !document.hidden; if (M.visible) kick(); } });
window.addEventListener('resize', () => { if (S) { S.resize(); kick(); } });

// ==================================================================== one frame
function step(dt) {
  M.t += dt;
  M.introT += dt;
  if (!M.ignited && M.introT > 0.25) { M.ignited = true; sound.init(); sound.ignition(); }
  for (const k of ['kasa', 'gpu', 'rgb']) if (M.pend[k] && M.t - M.pend[k] > 8) M.pend[k] = 0;
  stepJourney(dt);
  stepRotors(dt);
  stepLevers(dt);
  updateLights(dt);
  if (!S) return;
  const pose = drift(journey.pose(M.s));
  S.setCamera(pose.eye, add(pose.eye, pose.dir), pose.fov);
  // the eye half adapts to the dark when the lights are out
  S.setExposure(exposureAt(M.s) + 0.8 * (1 - (M.lit == null ? 1 : M.lit)) + (params.has('ev') ? +params.get('ev') : 0));
  for (const n of Object.keys(M.rot)) S.setRotor(n, M.rot[n], M.w[n]);
  updateHaze();
  updateLamps();
  levhaBudget = 1;
  updateTexts();
}

// ==================================================================== pacing (unchanged from the path-traced window)
// The scene renders at an even cadence of k display refreshes, scheduled against absolute time targets (counting rAF
// ticks drifts: Chromium drops ticks while the GPU is busy). The refresh period is measured all the time from the
// shortest rAF intervals; k comes from the median GPU time, with hysteresis.
let raf = 0, lastT = 0;
let perfWin = [], perfAt = performance.now(), lastFrameNow = 0;
const GPU = [];
const PACE = { ticks: [], tc: 0, lastTick: 0, refresh: 1000 / 60, k: 3, last: 0, up: 0, n: 0, recent: [], down: 0 };
function tickRefresh(now) {
  if (PACE.lastTick) {
    const d = now - PACE.lastTick;
    if (d > 2 && d < 60) { PACE.ticks.push(d); if (PACE.ticks.length > 240) PACE.ticks.shift(); }
  }
  PACE.lastTick = now;
  if (PACE.ticks.length >= 12 && (++PACE.tc % 12) === 0) {
    const a = PACE.ticks.slice().sort((x, y) => x - y);
    const r0 = a[Math.floor(a.length * 0.1)];
    const one = a.filter(x => x > r0 * 0.75 && x < r0 * 1.3);
    const est = clamp(one.reduce((x, y) => x + y, 0) / one.length, 1000 / 360, 1000 / 24);
    if (Math.abs(est - PACE.refresh) / PACE.refresh > 0.01) PACE.refresh = est;
  }
}
function measureRefresh(now) { if (S && S.ready) return; tickRefresh(now); requestAnimationFrame(measureRefresh); }
requestAnimationFrame(measureRefresh);
PACE.lt = { n: 0, max: 0 };
try { new PerformanceObserver(l => l.getEntries().forEach(e => { PACE.lt.n++; if (e.duration > PACE.lt.max) { PACE.lt.max = e.duration; PACE.lt.at = (e.startTime - bootT) / 1000; } })).observe({ type: 'longtask' }); } catch (e) { /* not supported */ }
function choosePace() {
  // never faster than ~30 fps (Özcan, 11-16: "2K da 30 fps yeterli"; there is no free movement): the largest whole
  // number of refreshes that still gives 30+ (165 Hz: 5 = 33 fps; 60 Hz: 2); the GPU time this frees goes to quality
  const cap = Math.max(1, Math.floor(1000 / 30 / PACE.refresh + 0.02));
  const g = GPU.slice(-60);
  if (g.length >= 12) {
    const s2 = g.slice().sort((x, y) => x - y), med = s2[s2.length >> 1];
    const k = Math.max(cap, clamp(Math.ceil((med * 1.3 + 2.0) / PACE.refresh - 0.02), 1, 8));
    if (!PACE.decided) { PACE.decided = true; PACE.k = k; return; }
    if (k > PACE.k) { PACE.down = 0; if (++PACE.up >= 2) { PACE.k = k; PACE.up = 0; } }
    else if (k < PACE.k && (med * 1.3 + 2.0) < (PACE.k - 1) * PACE.refresh * 0.85) { PACE.up = 0; if (++PACE.down >= 3) { PACE.k = k; PACE.down = 0; } }
    else { PACE.up = 0; PACE.down = 0; }
    return;
  }
  if (!PACE.decided) { PACE.decided = true; PACE.k = cap; PACE.recent.length = 0; return; }
  const iv = PACE.recent.splice(0);
  if (iv.length < 20) return;
  const miss = iv.filter(x => x > (PACE.k + 0.5) * PACE.refresh).length / iv.length;
  if (miss > 0.04) { if (++PACE.up >= 2) { PACE.k = Math.min(cap + 3, PACE.k + 1); PACE.up = 0; } } else PACE.up = 0;
}
function reportPerf() {
  const a = perfWin.slice().sort((x, y) => x - y);
  perfWin = [];
  if (a.length < 10) return;
  const q = f => a[Math.min(a.length - 1, Math.floor(f * a.length))];
  const med = q(0.5), long = a.filter(x => x > 2 * med).length;
  const g = GPU.slice(-120), gm = g.length ? g.slice().sort((x, y) => x - y)[g.length >> 1] : null;
  send(`perf:kare p50=${med.toFixed(1)} p95=${q(0.95).toFixed(1)} p99=${q(0.99).toFixed(1)} max=${a[a.length - 1].toFixed(1)} uzun=${long}` +
       (gm != null ? ` gpu=${gm.toFixed(1)}ms` : '') + ` n=${a.length} k=${PACE.k} yenileme=${PACE.refresh.toFixed(2)} yer=${M.place} s=${M.s.toFixed(0)}` +
       ` uzun-gorev=${PACE.lt.n}${PACE.lt.n ? '/' + PACE.lt.max.toFixed(0) + 'ms@' + PACE.lt.at.toFixed(2) + 's' : ''}`);
  PACE.lt = { n: 0, max: 0 };
}
function frame(now) {
  raf = 0;
  if (!M.visible) { lastFrameNow = 0; return; }
  tickRefresh(now);
  if (!params.has('nopace')) {
    if (PACE.last && now - PACE.last < (PACE.k - 0.5) * PACE.refresh) { raf = requestAnimationFrame(frame); return; }
    PACE.last = now;
  }
  if (++PACE.n % 60 === 0) choosePace();
  const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
  lastT = now;
  step(dt);
  S.render(dt, Math.min(dt, PACE.k * PACE.refresh / 1000));
  const st = S.stats();
  if (st && st.gpuMs > 0) { GPU.push(st.gpuMs); if (GPU.length > 240) GPU.shift(); }
  if (lastFrameNow) { const iv = now - lastFrameNow; perfWin.push(iv); PACE.recent.push(iv); }
  lastFrameNow = now;
  if (host && now - perfAt > 10000) { perfAt = now; reportPerf(); }
  if (window.__km && window.__km.onFrame) window.__km.onFrame(now);
  raf = requestAnimationFrame(frame);
}
function kick() { if (!raf && M.visible && S && S.ready && !params.has('still')) { lastT = 0; raf = requestAnimationFrame(frame); } }

// ==================================================================== start
if (host) host.addEventListener('message', e => onMessage(e.data));
else sim = window.KM_BENZETIM(onMessage);
window.__km = {
  M, D, get S() { return S; }, go, step, onMessage, get sim() { return sim; },
  // measurement and stills: put the camera somewhere on the journey (0..1) and draw one frame
  async still(u, opts = {}) {
    const pin = () => { M.s = clamp(u, 0, 1) * journey.total; M.v = 0; M.place = u >= 1 ? 'rgb' : 'fanlar'; };
    pin();
    if (opts.introT != null) M.introT = opts.introT; else M.introT = 99;
    // let the smoothed colours, rotors and levers settle (seconds of simulated time, the camera held in place)
    for (let i = 0, n = Math.round((opts.settle || 0) / 0.05); i < n; i++) { step(0.05); pin(); }
    step(opts.dt || 1 / 60);
    S.render(opts.dt || 1 / 60, opts.shutter || 1 / 60);
    return S.stats();
  },
};

(async () => {
  const base = host ? '/sahne/' : (params.get('paket') || '../sahne/paket/');
  try {
    await document.fonts.ready;
    sound.init();
    if (window.KM_LEVHA) await KM_LEVHA.ready;
    S = await window.KM_SALON.create(canvas, { base, scale: +(params.get('olcek') || 2) });
    journey = buildJourney(S.views);
    S.ready = true;
  } catch (err) {
    console.error(err);
    send('perf:sahne-yuklenemedi ' + (err && err.message));
    document.body.classList.add('nogl');
    const fb = document.getElementById('fallback');
    if (fb) fb.textContent = 'Sahne yüklenemedi: ' + (err && err.message);
  }
  if (host) send('ready'); else sim.connect();
  kick();
  if (params.has('still') && S) window.__km.still(+(params.get('still') || 0));
})();
})();
