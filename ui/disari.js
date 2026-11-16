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
// The fall. Off the deck the walker falls (gravity, quadratic drag to a terminal speed of TERMINAL m/s), the hatch
// shuts behind (heavy, slowly; by then the roof's slab hides it). Beside our columns the body keeps clear of them;
// below their feet, in the open gap above the roof below, the air carries it gently onto that roof (a few m/s across,
// never seen as a swerve) and brakes it over the last BRAKE_H metres (it lands at ~LAND m/s).
'use strict';
(() => {
const L = {
  PX: 230, PZ: 500,          // the stacks' spacing (m): rows along x, rows staggered by PX/2 (the block is 96 x 358 m)
  JIT: 22,                   // jitter of a stack's place (m)
  YAW: 0.1,                  // its turn (rad, at most)
  D: 860,                    // the vertical period (m): our stack repeats every D; the fall from one roof to the next
  R: 2600,                   // the facilities handed to the renderer: within this distance (it culls by its fog)
  ROOF: 35,                  // the deck (m)
  TERMINAL: 30,              // terminal fall speed in the void (m/s)
  BRAKE_H: 140, LAND: 6,     // the brake over the last BRAKE_H metres down to LAND m/s
  INSET: 9,                  // the landing keeps this far from the deck's edge (m)
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
    // the height: anywhere in the period, but none level with ours within a few metres (roofs side by side at the
    // same height read as a pattern)
    let h = home ? 0 : (hash(i, j, 3) - 0.5) * L.D;
    s = { x, z, h, yaw: home ? 0 : (hash(i, j, 4) * 2 - 1) * L.YAW, t: hash(i, j, 5), home, col: null };
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
  const list = [];
  function facilities(eye) {
    list.length = 0;
    const R = L.R, j0 = Math.floor((eye[2] - R) / L.PZ) - 1, j1 = Math.ceil((eye[2] + R) / L.PZ) + 1;
    for (let j = j0; j <= j1; j++) {
      const i0 = Math.floor((eye[0] - R) / L.PX) - 1, i1 = Math.ceil((eye[0] + R) / L.PX) + 1;
      for (let i = i0; i <= i1; i++) {
        const s = stack(i, j);
        const dx = s.x - eye[0], dz = s.z - 171 - eye[2];
        if (dx * dx + dz * dz > (R + 400) * (R + 400)) continue;
        const k0 = Math.floor((eye[1] - R - 60 - s.h) / L.D), k1 = Math.ceil((eye[1] + R + 610 - s.h) / L.D);
        for (let k = k0; k <= k1; k++) {
          const y = s.h + k * L.D;
          if (y + 60 < eye[1] - R || y - 610 > eye[1] + R) continue;
          list.push({ o: [s.x, y, s.z], yaw: s.yaw, col: s.home ? [1, 1, 1] : colourOf(s), home: s.home });
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
  const F = { falling: false, wraps: 0, t0: 0, t: 0, lastFall: null, savedTerminal: null };
  let footprint = null;      // the block's x, z bounds
  function onStep(w) {
    const st = w.state();
    if (!footprint) {
      const b = S().anchors.dis_blok && S().anchors.dis_blok.kutu;
      if (!b) return;
      footprint = { x0: b.merkez[0] - b.x[0], x1: b.merkez[0] + b.x[0], z0: b.merkez[2] - b.z[2], z1: b.merkez[2] + b.z[2] };
    }
    const fp = footprint;
    const outXZ = st.x < fp.x0 || st.x > fp.x1 || st.z < fp.z0 || st.z > fp.z1;
    if (!F.falling && !st.grounded && outXZ && st.foot < L.ROOF - 2) {
      F.falling = true; F.t = 0; F.wraps = 0;
      if (F.savedTerminal == null) { F.savedTerminal = w.config.TERMINAL; w.config.TERMINAL = L.TERMINAL; }
    }
    if (!F.falling) return;
    F.t += lastDt;
    if (st.grounded) {         // landed
      F.falling = false; F.lastFall = { seconds: +F.t.toFixed(2), wraps: F.wraps, x: st.x, z: st.z };
      if (F.savedTerminal != null) { w.config.TERMINAL = F.savedTerminal; F.savedTerminal = null; }
      return;
    }
    if (st.foot < L.ROOF - 20) setOpen(false);                    // the hatch shuts behind (unseen: under the slab)
    // the wrap: halfway down, the roof below becomes ours
    if (st.foot < L.ROOF - L.D / 2) { w.shift(0, L.D, 0); F.wraps++; return; }
    // height over the roof one will land on
    const hT = st.foot >= L.ROOF ? st.foot - L.ROOF : st.foot - L.ROOF + L.D;
    const colTop = L.D - 39, colBottom = L.D - 39 - 600 - 12;     // our columns (and their capitals), in hT
    let vx = st.vx, vz = st.vz, vy = st.vy;
    if (hT > colBottom) {
      // beside the columns: stay outside the footprint (with the capitals' reach), never drift far out
      const cx = Math.max(fp.x0, Math.min(fp.x1, st.x)), cz = Math.max(fp.z0, Math.min(fp.z1, st.z));
      const dx = st.x - cx, dz = st.z - cz, d = Math.hypot(dx, dz);
      if (d > 1e-6) {
        const nx = dx / d, nz = dz / d, vn = vx * nx + vz * nz;
        const want = d < 4 ? 1.5 : d > 28 ? -1.5 : vn;            // outward speed wanted
        const k = 1 - Math.exp(-lastDt / 0.8);
        vx += (want - vn) * nx * k; vz += (want - vn) * nz * k;
      }
    } else {
      // the gap: carried onto the roof below, the landing point the nearest within the inset (not the lamp's pit)
      let px = Math.max(fp.x0 + L.INSET, Math.min(fp.x1 - L.INSET, st.x));
      let pz = Math.max(fp.z0 + L.INSET, Math.min(fp.z1 - L.INSET - 6, st.z));
      if (Math.abs(px) < 8 && pz > -40 && pz < -22) px = px < 0 ? -8 : 8;
      const tLeft = Math.max(1.5, hT / Math.max(L.LAND, -vy));
      const wx = (px - st.x) / tLeft * 1.15, wz = (pz - st.z) / tLeft * 1.15;
      const k = 1 - Math.exp(-lastDt / 1.2);
      vx += (wx - vx) * k; vz += (wz - vz) * k;
    }
    if (hT < L.BRAKE_H) {        // the brake: the air thickens over the last metres
      const want = -(L.LAND + (L.TERMINAL - L.LAND) * smooth(hT / L.BRAKE_H));
      if (vy < want) vy += (want - vy) * (1 - Math.exp(-lastDt / 0.35));
    }
    w.setVelocity(vx, vy, vz);
  }

  // ---------------------------------------------------------------- each frame
  let lastDt = 1 / 60, hooked = false, outside = false;
  function step(dt, eye) {
    lastDt = Math.max(1e-4, Math.min(0.1, dt));
    const s = S(), w = W();
    if (!s || !s.setVoid) return;
    if (w && !hooked) { hooked = true; w.onStep(onStep); w.setFloor(null); }
    const moved = stepHatch(dt);
    if (w && w.setSolid && (moved || !H.sent)) { H.sent = true; w.setSolid('kapak', lidTriangles()); }
    s.setVoid({ list: facilities(eye), lid: H.angle });
    // the eye: while outside (or falling) its exposure refers to one fixed journey point, the same before and after
    // the wrap (the nearest point would jump with the walker's height)
    const out = !!w && w.active && (F.falling || eye[1] > L.ROOF - 0.5 || eye[1] < -4);
    if (out !== outside) { outside = out; if (w.pinS) w.pinS(out ? L.EV_U * o.journeyTotal() : null); }
  }
  return {
    config: L, step, toggle, setOpen, facilities,
    state: () => ({ hatch: { open: H.open, angle: H.angle, moving: H.moving }, fall: { ...F }, outside }),
  };
}
window.KM_DISARI = Object.freeze({ create, config: L });
})();
