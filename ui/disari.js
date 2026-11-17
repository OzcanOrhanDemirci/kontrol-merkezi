// Kontrol Merkezi: the outside (Phase 2, docs/SALON.md "The way up"). Up the long stair, through the hatch, onto the
// facility's roof: an endless foggy void in which identical facilities stand on their columns. From the roof one can
// jump in any direction, fall ~30 s between the columns and land on a roof below: it is our own facility again (the
// world wraps; there is no other facility). This file holds the void's logic; the renderer draws it (salon.js setVoid,
// dis.vert/dis.frag, fener.vert, the fog in post.frag), walk mode (yuruyus.js) moves the body.
//
// The lattice. The facilities stand in stacks: stack (i, j) at x = i PX (+ PX/2 on odd rows), z = j PZ, with a small
// fixed jitter, a slight turn about y and a height offset, all hashed from (i, j) (deterministic, never random at run
// time); each stack repeats straight down and up every D metres. Ours is stack (0, 0), offset 0, turn 0. So the world
// is periodic under a shift of D in y: falling from our roof one lands, D below, on our own stack's next facility, and
// a shift of the walker by +D at mid-fall (W.shift) makes that roof ours without anything on screen changing (every
// facility of our stack wears our colours and its hatch is shut). Each other stack's one steady lamp has its own fixed
// temperature colour, hashed from the service's palette (ui/renk.js); ours shows the real one.
//
// The band. Every period D a cloud band (salon.js VOID.band, band.glsl): the columns of every facility run on down into
// the band below it and end inside it, unseen (dis.vert stretches their shaft), so no column ever stops in the air;
// the stacks' heights keep every facility in the clear air between two bands. The fall passes through a band, and
// the wrap happens in its middle, where nothing can be seen.
//
// The fall. Off the deck the walker falls (gravity, quadratic drag to TERMINAL m/s) and steers itself: WASD in the
// look's frame moves it across at up to AIR m/s (Shift faster); nothing pulls it anywhere (11-17, Özcan: "beni zorla
// yönlendirmesin. İlüzyonu bozuyor"). Over a roof the air thickens over the last BRAKE_H metres (it lands at ~LAND
// m/s). Every facility is a roof one can land on: when the walker comes nearer another facility than ours, the world
// is re-expressed in that facility's frame (a rigid move of everything: nothing on screen changes) and it becomes the
// home, whose hall is under its hatch; its lamps keep their own colour until one is inside, then wear ours. One who
// lets go (no steering for RECOVER_S before the wrap) comes out of the band over the home's roof: the move is made
// inside the cloud, where it cannot be seen, and only for one who is not steering.
'use strict';
(() => {
const L = {
  PX: 230, PZ: 500,          // the stacks' spacing (m): rows along x, rows staggered by PX/2 (the outline within x +-70, z -372..30)
  JIT: 22,                   // jitter of a stack's place (m)
  YAW: 0.1,                  // its turn (rad, at most)
  D: 860,                    // the vertical period (m): every stack repeats every D, and so does the band
  H_MIN: -260, H_MAX: 220,   // the other stacks' heights against ours (m): every facility in the clear air between bands
  R: 2600,                   // the facilities handed to the renderer: within this distance (it culls by its fog)
  ROOF: 35,                  // the deck (m)
  BAND: { y: -440, hw: 55, sigma: 0.2 },    // the band under our deck: centre, half thickness, extinction at its middle
                             // (1/m; an optical depth of 6 from its middle to its edges: nothing is seen in it)
  KOLON_TOP: -40,            // the columns' shaft starts here (local y; hall_outside.cpp)
  TERMINAL: 42,              // terminal fall speed in the void (m/s; it was 30: Özcan wanted the fall faster)
  AIR: 10, AIR_TAU: 0.9,     // steering in the air: speed across (m/s, Shift x1.6) and its easing (s)
  BRAKE_H: 120, LAND: 6,     // over a roof, the brake over the last BRAKE_H metres down to LAND m/s
  REBASE: 12,                // another facility becomes the home when it is this much nearer than ours (m)
  RECOVER_S: 6,              // no steering for this long before the wrap: one comes out of the band over the home's roof
  RECOVER_INSET: 14,         // that far inside the deck's edge
  OPEN: 105 * Math.PI / 180, // the lid stands open at this angle
  OPEN_S: 1.5, CLOSE_S: 1.25,// its swing (s)
  EV_U: 0.0,                 // the journey point (share of its length) the eye's exposure refers to while outside
};

function hash(i, j, k) {     // 0..1, from integers (the same every run)
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(k | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const smooth = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

function create(o) {         // { S: () => renderer, W: () => walk mode, stops: () => palette stops | null }
  const S = () => o.S(), W = () => o.W();
  // ---------------------------------------------------------------- the stacks
  const stackCache = new Map();
  let paletteKey = '';
  function stack(i, j) {
    const key = i + ',' + j;
    let s = stackCache.get(key);
    if (s) return s;
    const home = i === 0 && j === 0;
    const x = i * L.PX + (j & 1 ? L.PX / 2 : 0) + (home ? 0 : (hash(i, j, 1) * 2 - 1) * L.JIT);
    const z = j * L.PZ + (home ? 0 : (hash(i, j, 2) * 2 - 1) * L.JIT);
    // the height: anywhere in the clear air between two bands, but none level with ours within a few metres (roofs
    // side by side at the same height read as a pattern)
    let h = home ? 0 : L.H_MIN + hash(i, j, 3) * (L.H_MAX - L.H_MIN);
    if (!home && Math.abs(h) < 8) h = h < 0 ? h - 16 : h + 16;
    s = { i, j, key, x, z, h, yaw: home ? 0 : (hash(i, j, 4) * 2 - 1) * L.YAW, t: hash(i, j, 5), home, col: null };
    stackCache.set(key, s);
    return s;
  }
  function colourOf(s) {
    const st = o.stops ? o.stops() : null;
    const key = st ? JSON.stringify(st) : '';
    if (key !== paletteKey) { paletteKey = key; for (const v of stackCache.values()) v.col = null; }
    if (s.col) return s.col;
    if (st && window.KM_RENK) {
      const c0 = st[0].c, c1 = st[st.length - 1].c;
      s.col = window.KM_RENK.palet(st, c0 + (c1 - c0) * s.t);
    } else {                 // no palette yet: cold to hot of the service's default scale (blue, cyan, amber, red)
      const k = [[0.25, 0.45, 1], [0.2, 0.9, 1], [1, 0.62, 0.2], [1, 0.2, 0.12]];
      const f = s.t * 3, n = Math.min(2, Math.floor(f)), u = f - n;
      s.col = k[n].map((v, q) => v + (k[n + 1][q] - v) * u);
    }
    return s.col;
  }
  // ---------------------------------------------------------------- the home: the facility the world is drawn in
  // Lattice space: stack (i, j) at (x, h + k D, z), turned by its yaw about the facility's centre c (the renderer's
  // bounds centre, salon.js bCentre). The world (the renderer's and walk mode's frame) is the home facility's own
  // frame: p_world = R(-yaw_H) (p_lattice - c - o_H) + c, R(a) p = (cos a x + sin a z, y, -sin a x + cos a z).
  let homeKey = '0,0', oursKey = '0,0';
  let C0 = null;             // c
  const rot = (a, v) => { const c = Math.cos(a), sn = Math.sin(a); return [c * v[0] + sn * v[2], v[1], -sn * v[0] + c * v[2]]; };
  function centre() {
    if (C0) return C0;
    const b = S() && S().anchors.dis_sinir && S().anchors.dis_sinir.kutu;
    if (!b) return [0, 0, -171];
    C0 = b.merkez.slice();
    return C0;
  }
  const homeStack = () => { const [i, j] = homeKey.split(',').map(Number); return stack(i, j); };
  function toLattice(p) {
    const H = homeStack(), c = centre();
    const r = rot(H.yaw, [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
    return [r[0] + c[0] + H.x, r[1] + c[1] + H.h, r[2] + c[2] + H.z];
  }
  // a facility of stack s at lattice height y as the renderer places it in the world: offset o, yaw
  function placed(s, y) {
    const H = homeStack();
    const o = rot(-H.yaw, [s.x - H.x, y - H.h, s.z - H.z]);
    return { o, yaw: s.yaw - H.yaw };
  }
  // the band's middle under the home's deck, in the world: wrap there (and the renderer's band, any period)
  function bandBelow() {
    const H = homeStack();
    let y = L.BAND.y - H.h;
    y -= L.D * Math.ceil((y - L.ROOF) / L.D);
    return y;
  }
  const list = [];
  function facilities(eye) {
    list.length = 0;
    const R = L.R, e = toLattice(eye), c = centre();
    const j0 = Math.floor((e[2] - R) / L.PZ) - 1, j1 = Math.ceil((e[2] + R) / L.PZ) + 1;
    for (let j = j0; j <= j1; j++) {
      const i0 = Math.floor((e[0] - R) / L.PX) - 1, i1 = Math.ceil((e[0] + R) / L.PX) + 1;
      for (let i = i0; i <= i1; i++) {
        const s = stack(i, j);
        const dx = s.x + c[0] - e[0], dz = s.z + c[2] - e[2];
        if (dx * dx + dz * dz > (R + 400) * (R + 400)) continue;
        const k0 = Math.floor((e[1] - R - 60 - s.h) / L.D), k1 = Math.ceil((e[1] + R + 610 - s.h) / L.D);
        for (let k = k0; k <= k1; k++) {
          const y = s.h + k * L.D;
          if (y + 60 < e[1] - R || y - 610 > e[1] + R) continue;
          const pl = placed(s, y);
          const ours = s.key === oursKey;
          list.push({ o: pl.o, yaw: pl.yaw, col: ours ? [1, 1, 1] : colourOf(s), home: s.key === homeKey, ours, key: s.key });
        }
      }
    }
    return list;
  }

  // ---------------------------------------------------------------- the hatch
  const H = { open: false, angle: 0, t: 0, from: 0, moving: false, tris: new Float32Array(12 * 9) };
  function toggle() { setOpen(!H.open); }
  function setOpen(v) {
    if (H.open === v) return;
    H.open = v; H.from = H.angle; H.t = 0; H.moving = true;
  }
  // a heavy lid: it starts slowly and settles (opening), falls under its weight and thuds with a small rebound (closing)
  function stepHatch(dt) {
    if (!H.moving) return false;
    H.t += dt;
    if (H.open) {
      const u = Math.min(1, H.t / L.OPEN_S);
      const e = u * u * u * (u * (u * 6 - 15) + 10);                 // smootherstep: no jolt at either end
      H.angle = H.from + (L.OPEN - H.from) * e;
      if (u >= 1) { H.angle = L.OPEN; H.moving = false; }
    } else {
      const T = L.CLOSE_S * Math.sqrt(Math.max(0.05, H.from / L.OPEN));
      const u = H.t / T;
      if (u < 1) H.angle = H.from * (1 - u * u);                      // falling shut, faster and faster
      else {                                                          // the thud: one small rebound of ~1.5 degrees
        const r = (H.t - T) / 0.22;
        H.angle = r < 1 ? 0.026 * Math.sin(Math.PI * r) * (1 - r) : 0;
        if (r >= 1) { H.angle = 0; H.moving = false; }
      }
    }
    return true;
  }
  // the lid's box (anchor kapak) turned about its hinge (the dinamik entry's merkez, eksen) into twelve triangles
  let lidDef = null, lidBox = null;
  function lidTriangles() {
    const s = S();
    if (!lidDef) { lidDef = (s.dyn || []).find(d => d.ad === 'kapak') || null; lidBox = s.anchors.kapak && s.anchors.kapak.kutu; }
    if (!lidDef || !lidBox) return null;
    const ax = lidDef.eksen, al = Math.hypot(ax[0], ax[1], ax[2]), a = [ax[0] / al, ax[1] / al, ax[2] / al];
    const c = Math.cos(H.angle), sn = Math.sin(H.angle), hc = lidDef.merkez;
    const rot = v => {        // Rodrigues about a
      const d = a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
      const cr = [a[1] * v[2] - a[2] * v[1], a[2] * v[0] - a[0] * v[2], a[0] * v[1] - a[1] * v[0]];
      return [0, 1, 2].map(i => v[i] * c + cr[i] * sn + a[i] * d * (1 - c));
    };
    const k = lidBox, P = [];
    for (let q = 0; q < 8; q++) {
      const sx = q & 1 ? 1 : -1, sy = q & 2 ? 1 : -1, sz = q & 4 ? 1 : -1;
      const p = [0, 1, 2].map(i => k.merkez[i] + sx * k.x[i] + sy * k.y[i] + sz * k.z[i] - hc[i]);
      const r = rot(p);
      P.push([r[0] + hc[0], r[1] + hc[1], r[2] + hc[2]]);
    }
    const F = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    let n = 0;
    for (const f of F) for (const t of [[f[0], f[1], f[2]], [f[0], f[2], f[3]]]) for (const v of t) { H.tris.set(P[v], n); n += 3; }
    return H.tris;
  }

  // ---------------------------------------------------------------- the fall
  const F = { falling: false, wraps: 0, t: 0, lastFall: null, saved: null, still: 0, rebases: 0, recovered: 0 };
  let box = null;            // the block's and the deck's x, z bounds (local)
  function bounds() {
    if (box) return box;
    const a = S().anchors, b = a.dis_blok && a.dis_blok.kutu, d = (a.dis_cati && a.dis_cati.kutu) || b;
    if (!b) return null;
    const xz = k => ({ x0: k.merkez[0] - Math.abs(k.x[0]) - Math.abs(k.z[0]), x1: k.merkez[0] + Math.abs(k.x[0]) + Math.abs(k.z[0]),
                       z0: k.merkez[2] - Math.abs(k.z[2]) - Math.abs(k.x[2]), z1: k.merkez[2] + Math.abs(k.z[2]) + Math.abs(k.x[2]) });
    box = { block: xz(b), deck: xz(d) };
    return box;
  }
  const outside = (q, p, m = 0) => p[0] < q.x0 - m || p[0] > q.x1 + m || p[2] < q.z0 - m || p[2] > q.z1 + m;
  const distXZ = (q, x, z) => Math.hypot(Math.max(q.x0 - x, 0, x - q.x1), Math.max(q.z0 - z, 0, z - q.z1));
  // our columns (anchors dis_kolon_<i>; without them the eight of the first exterior) for walk mode: from the shaft's
  // top down to the band, where the wrap takes the walker before it could reach their end
  let cols = null;
  function columns() {
    if (cols) return cols;
    const a = S().anchors;
    cols = Object.keys(a).filter(n => /^dis_kolon_/.test(n)).map(n => {
      const k = a[n].kutu; return { x: k.merkez[0], z: k.merkez[2], r: Math.max(Math.abs(k.x[0]) + Math.abs(k.z[0]), Math.abs(k.x[2]) + Math.abs(k.z[2])) };
    });
    if (!cols.length) for (const x of [-30, 30]) for (const z of [-21, -121, -221, -321]) cols.push({ x, z, r: 6 });
    return cols;
  }
  function sendColumns(w) {
    if (!w.setColumns) return;
    const y0 = bandBelow() - 2;
    w.setColumns(columns().map(c => ({ x: c.x, z: c.z, r: c.r, y0, y1: L.KOLON_TOP })));
  }
  // the walker re-expressed in facility s's frame: the nearest of the stack's copies, its height in the period
  // over that facility's band; a rigid move of everything (the renderer's list follows from the new home)
  function rebase(w, s) {
    const st = w.state(), c = centre();
    const pL = toLattice([st.x, st.foot, st.z]);
    const H = homeStack(), th = H.yaw - s.yaw;
    const r = rot(-s.yaw, [pL[0] - c[0] - s.x, 0, pL[2] - c[2] - s.z]);
    let y = pL[1] - s.h;
    let band = L.BAND.y - s.h; band -= L.D * Math.ceil((band - L.ROOF) / L.D);
    y -= L.D * Math.floor((y - band) / L.D);              // in (band, band + D]
    const to = [r[0] + c[0], y, r[2] + c[2]];
    // walk mode: the same rigid move for the body, its safe point and the camera; velocity and look turned by th
    w.remap(p => {
      const q = toLattice(p), rr = rot(-s.yaw, [q[0] - c[0] - s.x, 0, q[2] - c[2] - s.z]);
      return [rr[0] + c[0], p[1] + (to[1] - st.foot), rr[2] + c[2]];
    }, th);
    homeKey = s.key;
    F.rebases++;
    sendColumns(w);
  }
  function onStep(w) {
    const st = w.state(), bx = bounds();
    if (!bx) return;
    const p = [st.x, st.foot, st.z];
    if (!F.falling && !st.grounded && outside(bx.block, p) && st.foot < L.ROOF - 2) {
      F.falling = true; F.t = 0; F.wraps = 0; F.still = 0;
      if (!F.saved) {
        const cf = w.config;
        F.saved = { TERMINAL: cf.TERMINAL, AIR: cf.AIR, AIR_TAU: cf.AIR_TAU };
        cf.TERMINAL = L.TERMINAL; cf.AIR = L.AIR; cf.AIR_TAU = L.AIR_TAU;
      }
    }
    // inside the home's block, under its deck: its lamps wear our colours from now on (nothing outside is seen)
    if (oursKey !== homeKey && st.grounded && !outside(bx.block, p) && st.foot < L.ROOF - 3) oursKey = homeKey;
    if (!F.falling) return;
    F.t += lastDt;
    F.still = st.input ? 0 : F.still + lastDt;
    if (st.grounded) {         // landed
      F.falling = false; F.lastFall = { seconds: +F.t.toFixed(2), wraps: F.wraps, x: st.x, z: st.z, home: homeKey, rebases: F.rebases };
      if (F.saved) { Object.assign(w.config, F.saved); F.saved = null; }
      return;
    }
    if (st.foot < L.ROOF - 20) setOpen(false);                    // the hatch shuts behind (unseen: under the slab)
    // the wrap: in the band's middle (nothing can be seen there), the next facility below becomes this one
    if (st.foot < bandBelow()) {
      w.shift(0, L.D, 0); F.wraps++;
      if (F.still >= L.RECOVER_S) {                               // let go: out of the cloud over the home's deck
        const d = bx.deck, m = L.RECOVER_INSET;
        const x = Math.max(d.x0 + m, Math.min(d.x1 - m, st.x)), z = Math.max(d.z0 + m, Math.min(d.z1 - m, st.z));
        if (x !== st.x || z !== st.z) { w.shift(x - st.x, 0, z - st.z); w.setVelocity(0, null, 0); F.recovered++; }
      }
      return;
    }
    // the nearest facility: when another is nearer than ours by REBASE metres, it becomes the home
    const pL = toLattice(p), ci = Math.round(pL[0] / L.PX), cj = Math.round(pL[2] / L.PZ), c = centre();
    let best = null, bd = distXZ(bx.block, st.x, st.z) - L.REBASE;
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 2; i <= ci + 2; i++) {
      const s = stack(i, j);
      if (s.key === homeKey) continue;
      const r = rot(-s.yaw, [pL[0] - c[0] - s.x, 0, pL[2] - c[2] - s.z]);
      const d = distXZ(bx.block, r[0] + c[0], r[2] + c[2]);
      if (d < bd) { bd = d; best = s; }
    }
    if (best) { rebase(w, best); return; }
    // the brake: over the deck the air thickens over the last metres (the only force not one's own: a soft landing)
    const hT = st.foot - L.ROOF;
    if (hT > -1 && hT < L.BRAKE_H && !outside(bx.deck, p, 3)) {
      const want = -(L.LAND + (L.TERMINAL - L.LAND) * smooth(hT / L.BRAKE_H));
      if (st.vy < want) w.setVelocity(null, st.vy + (want - st.vy) * (1 - Math.exp(-lastDt / 0.35)), null);
    }
  }

  // ---------------------------------------------------------------- each frame
  let lastDt = 1 / 60, hooked = false, outsideNow = false;
  function step(dt, eye) {
    lastDt = Math.max(1e-4, Math.min(0.1, dt));
    const s = S(), w = W();
    if (!s || !s.setVoid) return;
    if (w && !hooked) { hooked = true; w.onStep(onStep); w.setFloor(null); }
    if (w && !cols && s.anchors) sendColumns(w);
    const moved = stepHatch(dt);
    if (w && w.setSolid && (moved || !H.sent)) { H.sent = true; w.setSolid('kapak', lidTriangles()); }
    const B = L.BAND;
    s.setVoid({ list: facilities(eye), lid: H.angle, band: { y: bandBelow(), hw: B.hw, D: L.D, sigma: B.sigma } });
    // the eye: while outside (or falling) its exposure refers to one fixed journey point, the same before and after
    // the wrap (the nearest point would jump with the walker's height)
    const out = !!w && w.active && (F.falling || eye[1] > L.ROOF - 0.5 || eye[1] < -4);
    if (out !== outsideNow) { outsideNow = out; if (w.pinS) w.pinS(out ? L.EV_U * o.journeyTotal() : null); }
  }
  return {
    config: L, step, toggle, setOpen, facilities,
    state: () => ({ hatch: { open: H.open, angle: H.angle, moving: H.moving }, fall: { ...F, saved: undefined }, outside: outsideNow,
                    home: homeKey, ours: oursKey, band: bandBelow() }),
  };
}
window.KM_DISARI = Object.freeze({ create, config: L });
})();
