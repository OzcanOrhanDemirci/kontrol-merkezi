// Kontrol Merkezi: walk mode (Phase 2). Y toggles it; the journey and every control stay as they are.
//
// Walking: W/A/S/D move, the mouse looks (pointer lock), Shift walks faster, Space jumps, Escape (or Y) leaves. A click
// acts on what the centre of the screen looks at within REACH metres (there is no cursor under pointer lock). Entering
// starts from the camera's pose and eases the eye down onto the ground under it; leaving glides the camera back onto
// the journey at its nearest point, which then carries on to the nearer of the two places.
//
// Collision is against the hall's real triangles (the pack's geo.bin, fetched and parsed once in a Worker into a
// uniform grid; the rotors as solid discs). The body is a "floating" capsule: a vertical capsule of radius R from
// STEP over the feet to TOP (it collides sideways and with ceilings), and under it a sphere of radius FOOT_R cast
// straight down that finds the ground: anything up to STEP high is stepped onto, stairs and edges are rolled over
// smoothly, and a fall of any speed lands exactly (the cast covers the whole drop: no tunnelling). TOP = 1.95 keeps
// the eye (1.7) at least 0.25 m from every surface (the near plane is 0.1 m).
//
// Hooks for the later pieces (the void, the wrap): W.shift(dx, dy, dz) moves the walker and its camera by an offset
// with velocity and look kept (a seamless wrap); W.onStep(fn) is called after every physics step with the state;
// W.setFloor(y | null) sets the safety floor (default 40 m under the lowest geometry), W.onFall(fn) replaces what
// happens under it (default: back to the last ground stood on). W.config holds the constants.
'use strict';
(() => {
const C = {
  EYE: 1.7,          // eye over the feet (m)
  R: 0.3,            // body radius
  TOP: 1.95,         // body top over the feet (eye + 0.25 clearance)
  STEP: 0.42,        // highest step walked up without a jump (the arch's plinth has 0.4 m steps)
  FOOT_R: 0.28,      // the ground probe's sphere
  SNAP: 0.3,         // how far the feet follow the ground down while walking (stairs down, no hopping)
  WALK: 2.6, RUN: 6.0,   // m/s (11-17: 1.6 and 4.0 were slow for a tool he uses: "günün sonunda bu uygulama işlevsellik de içeriyor")
  ACCEL_TAU: 0.16, STOP_TAU: 0.11, AIR_TAU: 1.2,   // velocity easing (s)
  AIR: null,         // the void's fall (disari.js): steering speed across in the air (m/s, Shift x1.6); null: the walk's
  GLIDE_TAU: 3.0,    // with AIR set and no key held, the body's drift across fades this slowly (s)
  GRAVITY: 9.81,
  JUMP_H: 1.25,      // jump height (m; 0.45 could not climb out of the roof lamp's 1.44 m pit, 11-17)
  TERMINAL: 50,      // terminal fall speed (m/s; quadratic drag)
  WALKABLE: 0.64,    // ground normal's y at least this (about 50 degrees)
  LOOK: 0.0031,      // rad per mouse count (0.0022 turned slowly, 11-17)
  PITCH: 1.45,
  REACH: 4.0,        // the centre click's reach (m)
  EXIT_S: 1.1,       // glide back onto the journey (s)
  STEP_TAU: 0.09,    // the eye's lag over a step (s)
  PREFETCH_S: 8,     // the collision loads this long after the scene is ready (or at the first Y)
  CELL: 1.0,         // grid cell (m)
};
// The eye (walk mode's exposure). The renderer measures each frame's log-average luminance before exposure, L (the
// whole screen). The reference is the journey: REF is log2 L of the journey's own frame at u = i / (n - 1) (measured
// by araclar/salon_yuruyus.py olcum; re-measure after a bake). At the walker's nearest journey point s the eye wants
//   EV = exposureAt(s) + clamp(K * (REF(s) - log2 L), -DOWN, +UP),   then clamped to [MIN, MAX],
// so where the journey's frame is, walking looks as the journey does, and a frame brighter or darker than that one is
// made up by K of the difference (partial adaptation: dark places stay dark, the core does not go white), towards
// light in UP_TAU, towards the dark in DOWN_TAU. A single global fit EV = A - K log2 L missed the journey's own
// exposure by 0.6 EV rms (1.1 EV at the arch, which the journey holds darker than its brightness asks).
const EYE = {
  K: 0.4, UP: 1.0, DOWN: 2.5, MIN: -3.5, MAX: 2.2, UP_TAU: 0.3, DOWN_TAU: 1.2,
  // a frame far darker than the journey's (the passages behind the chamber: no light of their own, only their lit
  // ends) opens the eye further, up to DARK_EXTRA more over DARK_SPAN of d past DARK_FROM: one walks a black corridor
  // towards its lit end and sees the end, not a black screen. Below DARK_FROM (every lit place) nothing changes
  DARK_FROM: 2.5, DARK_SPAN: 2.0, DARK_EXTRA: 4.0,
  REF: [-5.96, -4.85, -4.55, -4.46, -4.19, -3.91, -5.18, -7.01, -7.41, -6.67, -7.64, -7.76, -6.94, -7.00, -7.75, -7.49,
        -6.34, -7.25, -7.55, -6.95, -6.12, -6.93, -7.10, -6.16, -6.26, -6.95, -6.89, -5.85, -6.52, -6.76, -6.36, -5.65,
        -6.48, -6.54, -5.76, -5.82, -6.14, -5.70, -4.50, -5.34, -5.31],
};

// ==================================================================== the collision build (Worker or main thread)
// Self-contained (it is stringified into the Worker): geo.bin -> positions, indices, a uniform grid of triangle ids.
async function buildCollision(msg) {
  const T0 = performance.now();
  const r = await fetch(msg.url);
  if (!r.ok) throw new Error(msg.url + ': HTTP ' + r.status);
  let buf;
  if (/\.z$/.test(msg.url)) buf = await new Response(r.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
  else if (/\.gz$/.test(msg.url)) buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  else buf = await r.arrayBuffer();
  const T1 = performance.now();
  const dv = new DataView(buf);
  if (buf.byteLength < 16 || dv.getUint32(0, true) !== 0x31474d4b) throw new Error('geo: KMG1 yok');
  const nv = dv.getUint32(4, true), ni = dv.getUint32(8, true);
  if (dv.getUint32(12, true) !== 40 || buf.byteLength !== 16 + nv * 40 + ni * 4) throw new Error('geo: boyut tutarsız');
  const V = new Float32Array(buf, 16, nv * 10), Isrc = new Uint32Array(buf, 16 + nv * 40, ni);
  const SEG = 32;
  const extraV = msg.discs.length * (SEG + 1);
  const P = new Float32Array((nv + extraV) * 3);
  for (let i = 0; i < nv; i++) { P[i * 3] = V[i * 10]; P[i * 3 + 1] = V[i * 10 + 1]; P[i * 3 + 2] = V[i * 10 + 2]; }
  let keep = 0;
  for (const g of msg.ranges) if (!msg.skip.includes(g.malzeme)) keep += g.sayi;
  const I = new Uint32Array(keep + msg.discs.length * SEG * 3);
  let at = 0;
  for (const g of msg.ranges) if (!msg.skip.includes(g.malzeme)) { I.set(Isrc.subarray(g.ilk, g.ilk + g.sayi), at); at += g.sayi; }
  // the rotors: a solid disc each (a SEG-gon in the plane through the centre, perpendicular to the axis)
  let vAt = nv;
  for (const d of msg.discs) {
    const ax = d.eksen, l = Math.hypot(ax[0], ax[1], ax[2]) || 1, n = [ax[0] / l, ax[1] / l, ax[2] / l];
    let u = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const k = u[0] * n[0] + u[1] * n[1] + u[2] * n[2];
    u = [u[0] - n[0] * k, u[1] - n[1] * k, u[2] - n[2] * k];
    const ul = Math.hypot(u[0], u[1], u[2]); u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const c0 = vAt;
    P.set(d.merkez, vAt * 3); vAt++;
    for (let s = 0; s < SEG; s++) {
      const a = s / SEG * Math.PI * 2, ca = Math.cos(a) * d.yaricap, sa = Math.sin(a) * d.yaricap;
      P[vAt * 3] = d.merkez[0] + u[0] * ca + w[0] * sa; P[vAt * 3 + 1] = d.merkez[1] + u[1] * ca + w[1] * sa; P[vAt * 3 + 2] = d.merkez[2] + u[2] * ca + w[2] * sa;
      vAt++;
    }
    for (let s = 0; s < SEG; s++) { I[at++] = c0; I[at++] = c0 + 1 + s; I[at++] = c0 + 1 + (s + 1) % SEG; }
  }
  const nt = at / 3;
  // bounds and grid
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < at; i++) {
    const j = I[i] * 3, x = P[j], y = P[j + 1], z = P[j + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  let cs = msg.cell;
  const vol = (x1 - x0 + 2) * (y1 - y0 + 2) * (z1 - z0 + 2);
  if (vol / (cs * cs * cs) > 8e6) cs = Math.cbrt(vol / 8e6);
  const ox = x0 - 1, oy = y0 - 1, oz = z0 - 1;
  const nx = Math.ceil((x1 - ox + 1) / cs), ny = Math.ceil((y1 - oy + 1) / cs), nz = Math.ceil((z1 - oz + 1) / cs);
  const ncell = nx * ny * nz;
  const count = new Uint32Array(ncell + 1);
  const h = cs * 0.5;
  // visit every cell a triangle's box touches that its plane crosses
  const visit = (t, fn) => {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const qx = uy * vz - uz * vy, qy = uz * vx - ux * vz, qz = ux * vy - uy * vx;
    const rr = h * (Math.abs(qx) + Math.abs(qy) + Math.abs(qz)) * 1.001 + 1e-9;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - ox) / cs)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - ox) / cs));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - oy) / cs)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - oy) / cs));
    const k0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - oz) / cs)), k1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - oz) / cs));
    const one = i0 === i1 && j0 === j1 && k0 === k1;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (!one) {
        const ccx = ox + (i + 0.5) * cs - ax, ccy = oy + (j + 0.5) * cs - ay, ccz = oz + (k + 0.5) * cs - az;
        if (Math.abs(qx * ccx + qy * ccy + qz * ccz) > rr) continue;
      }
      fn((k * ny + j) * nx + i);
    }
  };
  for (let t = 0; t < nt; t++) visit(t, c => { count[c + 1]++; });
  for (let c = 0; c < ncell; c++) count[c + 1] += count[c];
  const list = new Uint32Array(count[ncell]);
  const fill = count.slice(0, ncell);
  for (let t = 0; t < nt; t++) visit(t, c => { list[fill[c]++] = t; });
  const T2 = performance.now();
  return {
    P, I, start: count, list, grid: { ox, oy, oz, cs, nx, ny, nz, top: y1, bottom: y0 }, nt,
    ms: { fetch: Math.round(T1 - T0), build: Math.round(T2 - T1) },
  };
}
function workerSource() {
  return 'const buildCollision = ' + buildCollision.toString() + ';\n' +
    'self.onmessage = async e => { try { const r = await buildCollision(e.data);' +
    ' self.postMessage(r, [r.P.buffer, r.I.buffer, r.start.buffer, r.list.buffer]); }' +
    ' catch (err) { self.postMessage({ error: String((err && err.message) || err) }); } };';
}

// ==================================================================== walk mode
function create(o) {
  const { M, canvas } = o;
  const S = () => o.S;
  // ---------------------------------------------------------------- collision data
  let P = null, I = null, CS = null, CL = null, G = null, stamp = null, stampN = 0, loading = null, loadInfo = null;
  const CAP = 1 << 16;
  const CAND = new Int32Array(CAP);
  let candN = 0, candOver = 0;
  function load() {
    if (loading) return loading;
    const pack = S().pack;
    const mats = pack.malzemeler || [];
    const skip = mats.map((m, i) => ((m.bayrak || []).includes('noOcclude') ? i : -1)).filter(i => i >= 0);
    const msg = {
      url: new URL(pack.geometri.dosya, new URL(o.base, location.href)).href,
      ranges: pack.geometri.araliklar, skip, cell: C.CELL,
      discs: (pack.dinamik || []).filter(d => (d.kanat || 0) > 0).map(d => ({ merkez: d.merkez, eksen: d.eksen || [1, 0, 0], yaricap: d.yaricap || 1 })),
    };
    const T0 = performance.now();
    const accept = r => {
      if (r.error) throw new Error(r.error);
      P = r.P; I = r.I; CS = r.start; CL = r.list; G = r.grid;
      // room for the moving solids (setSolid: the hatch's lid) after the static triangles: their own vertices,
      // tested apart from the grid
      solidT0 = r.nt; solidV0 = P.length / 3;
      const P2 = new Float32Array(P.length + SOLID_MAX * 9), I2 = new Uint32Array(I.length + SOLID_MAX * 3);
      P2.set(P); I2.set(I);
      for (let k = 0; k < SOLID_MAX * 3; k++) I2[I.length + k] = solidV0 + k;
      P = P2; I = I2;
      stamp = new Uint32Array(r.nt + SOLID_MAX);
      writeSolids();
      floorY = G.bottom - 40;
      loadInfo = { ...r.ms, totalMs: Math.round(performance.now() - T0), triangles: r.nt, refs: CL.length,
                   cells: [G.nx, G.ny, G.nz], cell: +G.cs.toFixed(3),
                   memoryMB: +((P.byteLength + I.byteLength + CS.byteLength + CL.byteLength + stamp.byteLength) / 1048576).toFixed(1) };
      if (pendingPlace) { pendingPlace = false; placeBody(camEye); }
    };
    loading = new Promise((res, rej) => {
      let w = null;
      try { w = new Worker(URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }))); } catch (e) { w = null; }
      if (!w) { buildCollision(msg).then(r => { accept(r); res(); }, rej); return; }
      w.onmessage = e => { w.terminate(); try { accept(e.data); res(); } catch (err) { rej(err); } };
      w.onerror = e => { w.terminate(); buildCollision(msg).then(r => { accept(r); res(); }, rej); e.preventDefault(); };
      w.postMessage(msg);
    }).catch(err => { console.error('Yürüyüş: çarpışma yüklenemedi: ' + (err && err.message)); loadInfo = { error: String(err && err.message) }; });
    return loading;
  }
  // moving solids (the void's hatch lid): named triangle lists (9 floats each), world space, replaced whenever they move
  const SOLID_MAX = 64;
  const solids = new Map();
  let solidT0 = 0, solidV0 = 0, solidN = 0;
  function writeSolids() {
    solidN = 0;
    if (!G) return;
    for (const tris of solids.values()) {
      const n = Math.min(tris.length / 9, SOLID_MAX - solidN);
      P.set(tris.subarray(0, n * 9), (solidV0 + solidN * 3) * 3);
      solidN += n;
    }
  }
  // the triangles whose boxes overlap the query box (no duplicates)
  function gather(x0, y0, z0, x1, y1, z1) {
    candN = 0;
    if (!G) return 0;
    const cs = G.cs;
    const i0 = Math.max(0, Math.floor((x0 - G.ox) / cs)), i1 = Math.min(G.nx - 1, Math.floor((x1 - G.ox) / cs));
    const j0 = Math.max(0, Math.floor((y0 - G.oy) / cs)), j1 = Math.min(G.ny - 1, Math.floor((y1 - G.oy) / cs));
    const k0 = Math.max(0, Math.floor((z0 - G.oz) / cs)), k1 = Math.min(G.nz - 1, Math.floor((z1 - G.oz) / cs));
    if (i0 > i1 || j0 > j1 || k0 > k1) return 0;
    if (++stampN === 0xffffffff) { stamp.fill(0); stampN = 1; }
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
      const row = (k * G.ny + j) * G.nx;
      for (let i = i0; i <= i1; i++) {
        const c = row + i;
        for (let q = CS[c], e = CS[c + 1]; q < e; q++) {
          const t = CL[q];
          if (stamp[t] === stampN) continue;
          stamp[t] = stampN;
          const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, d = I[t * 3 + 2] * 3;
          const ax = P[a], bx = P[b], dx = P[d];
          if ((ax < x0 && bx < x0 && dx < x0) || (ax > x1 && bx > x1 && dx > x1)) continue;
          const az = P[a + 2], bz = P[b + 2], dz = P[d + 2];
          if ((az < z0 && bz < z0 && dz < z0) || (az > z1 && bz > z1 && dz > z1)) continue;
          const ay = P[a + 1], by = P[b + 1], dy = P[d + 1];
          if ((ay < y0 && by < y0 && dy < y0) || (ay > y1 && by > y1 && dy > y1)) continue;
          if (candN >= CAP) { candOver++; return candN; }
          CAND[candN++] = t;
        }
      }
    }
    for (let t = solidT0; t < solidT0 + solidN; t++) {        // the moving solids
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, d = I[t * 3 + 2] * 3;
      if (Math.max(P[a], P[b], P[d]) < x0 || Math.min(P[a], P[b], P[d]) > x1) continue;
      if (Math.max(P[a + 1], P[b + 1], P[d + 1]) < y0 || Math.min(P[a + 1], P[b + 1], P[d + 1]) > y1) continue;
      if (Math.max(P[a + 2], P[b + 2], P[d + 2]) < z0 || Math.min(P[a + 2], P[b + 2], P[d + 2]) > z1) continue;
      if (candN < CAP) CAND[candN++] = t;
    }
    return candN;
  }

  // ---------------------------------------------------------------- geometry kernels (scalars, no allocation)
  const Q = new Float64Array(8);         // closest point on a triangle -> Q[0..2]
  function closestTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { Q[0] = ax; Q[1] = ay; Q[2] = az; return; }
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { Q[0] = bx; Q[1] = by; Q[2] = bz; return; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); Q[0] = ax + abx * v; Q[1] = ay + aby * v; Q[2] = az + abz * v; return; }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { Q[0] = cx; Q[1] = cy; Q[2] = cz; return; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); Q[0] = ax + acx * w; Q[1] = ay + acy * w; Q[2] = az + acz * w; return; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      Q[0] = bx + (cx - bx) * w; Q[1] = by + (cy - by) * w; Q[2] = bz + (cz - bz) * w; return;
    }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    Q[0] = ax + abx * v + acx * w; Q[1] = ay + aby * v + acy * w; Q[2] = az + abz * v + acz * w;
  }
  // a vertical segment (x, ya..yb, z) against the edge a-b: the closest points -> Q[0..2] on the edge, Q[3] the y on
  // the segment; returns the squared distance
  function segEdge(x, ya, yb, z, ax, ay, az, bx, by, bz) {
    const d1y = yb - ya;                       // d1 = (0, d1y, 0)
    const d2x = bx - ax, d2y = by - ay, d2z = bz - az;
    const rx = x - ax, ry = ya - ay, rz = z - az;
    const a = d1y * d1y, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
    let s, t;
    if (e <= 1e-12) { t = 0; s = a > 1e-12 ? Math.min(1, Math.max(0, -(d1y * ry) / a)) : 0; }
    else {
      const c = d1y * ry, b = d1y * d2y, den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
    const sy = ya + d1y * s;
    Q[0] = ax + d2x * t; Q[1] = ay + d2y * t; Q[2] = az + d2z * t; Q[3] = sy;
    const dx = x - Q[0], dy = sy - Q[1], dz = z - Q[2];
    return dx * dx + dy * dy + dz * dz;
  }
  // closest points between the vertical segment and triangle t -> H[0..2] on the triangle, H[3] the y on the segment;
  // returns the squared distance
  const H = new Float64Array(4);
  function segTri(x, ya, yb, z, t) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
    let best = Infinity, dx, dy, dz, d;
    closestTri(x, ya, z, ax, ay, az, bx, by, bz, cx, cy, cz);
    dx = x - Q[0]; dy = ya - Q[1]; dz = z - Q[2]; d = dx * dx + dy * dy + dz * dz;
    if (d < best) { best = d; H[0] = Q[0]; H[1] = Q[1]; H[2] = Q[2]; H[3] = ya; }
    closestTri(x, yb, z, ax, ay, az, bx, by, bz, cx, cy, cz);
    dx = x - Q[0]; dy = yb - Q[1]; dz = z - Q[2]; d = dx * dx + dy * dy + dz * dz;
    if (d < best) { best = d; H[0] = Q[0]; H[1] = Q[1]; H[2] = Q[2]; H[3] = yb; }
    d = segEdge(x, ya, yb, z, ax, ay, az, bx, by, bz); if (d < best) { best = d; H[0] = Q[0]; H[1] = Q[1]; H[2] = Q[2]; H[3] = Q[3]; }
    d = segEdge(x, ya, yb, z, bx, by, bz, cx, cy, cz); if (d < best) { best = d; H[0] = Q[0]; H[1] = Q[1]; H[2] = Q[2]; H[3] = Q[3]; }
    d = segEdge(x, ya, yb, z, cx, cy, cz, ax, ay, az); if (d < best) { best = d; H[0] = Q[0]; H[1] = Q[1]; H[2] = Q[2]; H[3] = Q[3]; }
    return best;
  }
  // the highest centre height <= ytop at which a sphere of radius r on the vertical line (x, z) rests on triangle t
  // (face, edges, vertices of the triangle grown by r); the contact normal -> GN
  const GN = new Float64Array(4);     // contact normal xyz, the carrying face's normal y
  let gnx = 0, gny = 1, gnz = 0, gfy = 1;      // contact normal, and the supporting face's normal y
  let fnx = 0, fny = 1, fnz = 0;               // the current triangle's face normal
  function edgeTop(x, z, r, ytop, ax, ay, az, bx, by, bz, best) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, L2 = dx * dx + dy * dy + dz * dz;
    if (L2 < 1e-12) return best;
    const A = (dx * dx + dz * dz) / L2;
    if (A < 1e-6) return best;                 // a vertical edge: its vertices cover it
    const wx = x - ax, wz = z - az, k = wx * dx + wz * dz;
    const B = -2 * k * dy / L2, Cc = wx * wx + wz * wz - k * k / L2 - r * r;
    const disc = B * B - 4 * A * Cc;
    if (disc < 0) return best;
    const u = (-B + Math.sqrt(disc)) / (2 * A), t = (k + u * dy) / L2;
    if (t < 0 || t > 1) return best;
    const y = ay + u;
    if (y > ytop || y <= best) return best;
    const px = ax + dx * t, py = ay + dy * t, pz = az + dz * t;
    const cx = (x - px) / r, cy = (y - py) / r, cz = (z - pz) / r;
    if (cx * fnx + cy * fny + cz * fnz < -1e-3) return best;     // from behind the face: inside the part
    gnx = cx; gny = cy; gnz = cz;
    return y;
  }
  // the highest centre height <= ytop on triangle t (-Infinity if none); contact normal -> gn*, face normal y -> gfy
  function sphereTop(x, z, r, ytop, t, floor) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
    if (Math.max(ay, by, cy) + r < floor) return -Infinity;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12) return -Infinity;
    nx /= nl; ny /= nl; nz /= nl;
    fnx = nx; fny = ny; fnz = nz; gfy = ny;
    let best = -Infinity;
    // face: only one that faces up can carry (a face seen from below is the underside of a part)
    if (ny > 1e-4) {
      const y = ay + (r - nx * (x - ax) - nz * (z - az)) / ny;
      if (y <= ytop) {
        const qx = x - nx * r - ax, qy = y - ny * r - ay, qz = z - nz * r - az;
        const d00 = ux * ux + uy * uy + uz * uz, d01 = ux * vx + uy * vy + uz * vz, d11 = vx * vx + vy * vy + vz * vz;
        const d20 = qx * ux + qy * uy + qz * uz, d21 = qx * vx + qy * vy + qz * vz, den = d00 * d11 - d01 * d01;
        if (den > 1e-18) {
          const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
          if (v >= 0 && w >= 0 && v + w <= 1) { gnx = nx; gny = ny; gnz = nz; return y; }   // the face's top is the column's top here
        }
      }
    }
    best = edgeTop(x, z, r, ytop, ax, ay, az, bx, by, bz, best);
    best = edgeTop(x, z, r, ytop, bx, by, bz, cx, cy, cz, best);
    best = edgeTop(x, z, r, ytop, cx, cy, cz, ax, ay, az, best);
    const r2 = r * r;
    for (let k = 0; k < 3; k++) {
      const px = k === 0 ? ax : k === 1 ? bx : cx, py = k === 0 ? ay : k === 1 ? by : cy, pz = k === 0 ? az : k === 1 ? bz : cz;
      const dd = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (dd >= r2) continue;
      const y = py + Math.sqrt(r2 - dd);
      if (y > ytop || y <= best) continue;
      const qx = (x - px) / r, qy = (y - py) / r, qz = (z - pz) / r;
      if (qx * nx + qy * ny + qz * nz < -1e-3) continue;
      best = y; gnx = qx; gny = qy; gnz = qz;
    }
    return best;
  }
  // the ground under (x, z): the highest foot height in [fbot, ftop] (-Infinity if none); its normal -> GN
  function groundCast(x, z, ftop, fbot, r = C.FOOT_R) {
    const n = gather(x - r, fbot, z - r, x + r, ftop + 2 * r, z + r);
    let best = -Infinity, bx = 0, by = 1, bz = 0, bf = 1;
    const ytop = ftop + r;
    for (let i = 0; i < n; i++) {
      const b = sphereTop(x, z, r, ytop, CAND[i], best - 1e-5);
      if (b === -Infinity) continue;
      // ties (an edge shared by several faces): the flatter contact carries
      if (b > best + 1e-5 || (b > best - 1e-5 && gny > by)) { best = Math.max(b, best); bx = gnx; by = gny; bz = gnz; bf = gfy; }
    }
    GN[0] = bx; GN[1] = by; GN[2] = bz; GN[3] = bf;
    const f = best - r;
    return f >= fbot ? f : -Infinity;
  }

  // ---------------------------------------------------------------- the walker
  const B = { x: 0, foot: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false, yaw: 0, pitch: 0, fov: 50,
              safeX: 0, safeF: 0, safeZ: 0, eyeLag: 0, jumpT: -1, baseF: 0 };
  let active = false, paused = false, pendingPlace = false;
  let columns = [];          // [{ x, z, r, y0, y1 }] (setColumns)
  let floorY = -40, floorSet = false, fallFn = null, stepFn = null;
  const camEye = new Float64Array(3);
  const enterOff = new Float64Array(3); let enterT = 0, enterDur = 0;
  const keys = { w: 0, a: 0, s: 0, d: 0, shift: 0 };
  const pose = { eye: [0, 0, 0], dir: [0, 0, -1], fov: 50 };
  const exitFrom = { eye: [0, 0, 0], dir: [0, 0, -1], fov: 50 };
  const blendPose = { eye: [0, 0, 0], dir: [0, 0, -1], fov: 50 };
  let exitT = -1, escGrace = 0, lastLock = false;
  const timing = new Float32Array(120); let timingN = 0;
  let contactsMax = 0, timeSum = 0;

  // the body against walls and ceilings; returns the remaining deepest penetration
  function resolveBody(x0, z0) {
    const R = C.R;
    let deepest = 0;
    const ya0 = B.foot + C.STEP + R, yb0 = B.foot + C.TOP - R;
    const n = gather(B.x - R - 0.15, ya0 - R - 0.05, B.z - R - 0.15, B.x + R + 0.15, yb0 + R + 0.05, B.z + R + 0.15);
    if (n > contactsMax) contactsMax = n;
    for (let it = 0; it < 4; it++) {
      let moved = false;
      deepest = 0;
      for (let i = 0; i < n; i++) {
        const ya = B.foot + C.STEP + R, yb = B.foot + C.TOP - R;
        const d2 = segTri(B.x, ya, yb, B.z, CAND[i]);
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2);
        let nx, ny, nz;
        if (d > 1e-7) { nx = (B.x - H[0]) / d; ny = (H[3] - H[1]) / d; nz = (B.z - H[2]) / d; }
        else {                                   // touching: push away from where the body came from
          const hx = x0 - B.x, hz = z0 - B.z, hl = Math.hypot(hx, hz) || 1;
          nx = hx / hl; ny = 0; nz = hz / hl;
        }
        const pen = R - d;
        if (pen > deepest) deepest = pen;
        const hl = Math.hypot(nx, nz);
        if (ny < -0.4 && !B.grounded) {           // a ceiling while in the air: down, and the rise stops
          B.x += nx * pen; B.foot += ny * pen; B.z += nz * pen;
          if (B.vy > 0) B.vy = 0;
        } else if (hl < 0.05) {                  // straight above or below while on the ground: no way through
          B.x = x0; B.z = z0; B.vx = 0; B.vz = 0;
          if (ny > 0 && !B.grounded) B.foot += pen;
        } else {                                 // sideways (walls, edges): slide along
          const hx = nx / hl, hz = nz / hl, push = Math.min(pen / hl, 0.15) + 1e-5;
          B.x += hx * push; B.z += hz * push;
          const vn = B.vx * hx + B.vz * hz;
          if (vn < 0) { B.vx -= vn * hx; B.vz -= vn * hz; }
        }
        moved = true;
      }
      if (!moved) break;
    }
    // the void's columns where they run on below the mesh (setColumns): vertical cylinders, slid along
    for (const c of columns) {
      if (B.foot > c.y1 || B.foot + C.TOP < c.y0) continue;
      const dx = B.x - c.x, dz = B.z - c.z, d = Math.hypot(dx, dz), m = c.r + R;
      if (d >= m) continue;
      const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0;
      B.x = c.x + nx * m; B.z = c.z + nz * m;
      const vn = B.vx * nx + B.vz * nz;
      if (vn < 0) { B.vx -= vn * nx; B.vz -= vn * nz; }
      deepest = Math.max(deepest, m - d);
    }
    return deepest;
  }

  function physics(dt) {
    // the wanted velocity: WASD in the look's frame, on the ground plane
    const fwd = keys.w - keys.s, side = keys.d - keys.a;
    const sy = Math.sin(B.yaw), cy = Math.cos(B.yaw);
    let tx = fwd * sy + side * cy, tz = -fwd * cy + side * sy;
    const tl = Math.hypot(tx, tz);
    const air = !B.grounded && C.AIR != null;
    const speed = air ? C.AIR * (keys.shift ? 1.6 : 1) : keys.shift ? C.RUN : C.WALK;
    if (tl > 1e-6) { tx = tx / tl * speed; tz = tz / tl * speed; }
    const vh = Math.max(Math.hypot(B.vx, B.vz), speed * Math.min(1, tl));
    const n = Math.min(12, Math.max(Math.ceil(dt * 120), Math.ceil(vh * dt / 0.1)));
    const h = dt / n;
    const kDrag = C.GRAVITY / (C.TERMINAL * C.TERMINAL);
    for (let s = 0; s < n; s++) {
      const tau = !B.grounded ? (air && tl < 1e-6 ? C.GLIDE_TAU : C.AIR_TAU) : (tx * tx + tz * tz > B.vx * B.vx + B.vz * B.vz ? C.ACCEL_TAU : C.STOP_TAU);
      const k = 1 - Math.exp(-h / tau);
      B.vx += (tx - B.vx) * k; B.vz += (tz - B.vz) * k;
      if (B.jumpT >= 0) {
        if (B.grounded) { B.vy = Math.sqrt(2 * C.GRAVITY * C.JUMP_H); B.grounded = false; B.jumpT = -1; }
        else if ((B.jumpT += h) > 0.15) B.jumpT = -1;      // a press a moment before landing still jumps
      }
      const wasGrounded = B.grounded;
      if (!B.grounded) B.vy += (-C.GRAVITY - Math.sign(B.vy) * kDrag * B.vy * B.vy) * h;
      const x0 = B.x, z0 = B.z, f0 = B.foot;
      if (!B.grounded) B.baseF = B.foot;
      B.x += B.vx * h; B.z += B.vz * h;
      if (!B.grounded) B.foot += B.vy * h;
      resolveBody(x0, z0);
      if (B.vy > 0) {                              // rising: only never below a surface
        const g = groundCast(B.x, B.z, B.foot + C.STEP, B.foot);
        if (g > B.foot) B.foot = g;
        B.grounded = false;
      } else {
        const top = Math.max(f0, B.foot) + C.STEP, bot = B.foot - (wasGrounded ? C.SNAP : 0);
        const g = groundCast(B.x, B.z, top, bot);
        // the contact's own normal decides (a rounded pipe is not a floor); a steep contact may still be a step's
        // rounded nosing: rising, probe just past the contact for the tread; level or down, probe under the centre
        let walk = g > -Infinity && GN[1] >= C.WALKABLE;
        if (!walk && g > -Infinity) {
          const nx = GN[0], ny = GN[1], nz = GN[2], nf = GN[3], hl = Math.hypot(nx, nz);
          if (g > f0 + 1e-3) {
            if (hl > 1e-3 && g <= B.baseF + C.STEP + 1e-3) {
              const px = B.x - nx * C.FOOT_R - nx / hl * 0.06, pz = B.z - nz * C.FOOT_R - nz / hl * 0.06;
              const t = groundCast(px, pz, B.baseF + C.STEP, g - 0.15, 0.03);
              walk = t > -Infinity && GN[1] > 0.9;
            }
          } else {
            const t = groundCast(B.x, B.z, g, g - C.STEP, 0.03);
            walk = t > -Infinity && GN[1] > 0.9;
          }
          GN[0] = nx; GN[1] = ny; GN[2] = nz; GN[3] = nf;
        }
        if (g > -Infinity) {
          if (walk) {
            if (wasGrounded) B.eyeLag = Math.max(-0.5, Math.min(0.5, B.eyeLag - (g - f0)));
            B.foot = g; B.vy = 0; B.grounded = true;
            if (GN[1] > 0.9) B.baseF = g;          // on a tread, not on a nosing: the height a step is measured from
            B.safeX = B.x; B.safeF = B.foot; B.safeZ = B.z;
          } else if (g > f0 + 1e-3) {   // a steep face rising ahead: a wall, not a way up
            const hl = Math.hypot(GN[0], GN[2]);
            B.x = x0; B.z = z0;
            if (hl > 1e-6) { const hx = GN[0] / hl, hz = GN[2] / hl, vn = B.vx * hx + B.vz * hz; if (vn < 0) { B.vx -= vn * hx; B.vz -= vn * hz; } }
            else { B.vx = 0; B.vz = 0; }
            if (wasGrounded) { B.foot = f0; B.vy = 0; }
            B.grounded = wasGrounded;
          } else {                                 // too steep to stand on (or an edge over a drop): rest on it, slide off
            B.foot = g; B.vy = Math.min(0, B.vy) * 0.5; B.grounded = false;
            const hl = Math.hypot(GN[0], GN[2]) || 1;
            B.vx += GN[0] / hl * C.GRAVITY * 0.6 * h; B.vz += GN[2] / hl * C.GRAVITY * 0.6 * h;
          }
        } else B.grounded = false;
      }
      B.eyeLag *= Math.exp(-h / C.STEP_TAU);
    }
    if (floorSet !== null && B.foot < floorY) {
      if (fallFn) fallFn(api); else respawn();
    }
    if (stepFn) stepFn(api);
  }
  function respawn() {
    B.x = B.safeX; B.foot = B.safeF; B.z = B.safeZ; B.vx = B.vy = B.vz = 0; B.grounded = false; B.eyeLag = 0;
    enterOff[0] = enterOff[1] = enterOff[2] = 0;
  }
  // the body under a camera eye: on the ground below it, the eye easing down to its height
  function placeBody(e) {
    B.x = e[0]; B.z = e[2];
    const g = groundCast(B.x, B.z, e[1] - 0.2, G.bottom - 5);
    B.foot = g > -Infinity ? g : e[1] - C.EYE;
    B.vx = B.vy = B.vz = 0; B.grounded = g > -Infinity; B.eyeLag = 0;
    for (let i = 0; i < 6; i++) if (resolveBody(B.x, B.z) < 1e-3) break;
    if (B.grounded) { const g2 = groundCast(B.x, B.z, B.foot + C.STEP, B.foot - 0.5); if (g2 > -Infinity) B.foot = g2; }
    B.safeX = B.x; B.safeF = B.foot; B.safeZ = B.z; B.baseF = B.foot;
    enterOff[0] = e[0] - B.x; enterOff[1] = e[1] - (B.foot + C.EYE); enterOff[2] = e[2] - B.z;
    enterT = 0; enterDur = Math.min(1.6, 0.45 + 0.12 * Math.hypot(enterOff[0], enterOff[1], enterOff[2]));
  }

  // ---------------------------------------------------------------- the centre's target
  // the same test as a pointer pick (a fan counts only on its disc), along the view within reach
  function centreHit() {
    const n = S() && S().pickRay ? S().pickRay(pose.eye, pose.dir, C.REACH) : null;
    return n && o.actions && o.actions[n] ? n : null;   // only what walk mode can act on
  }
  function setHover(n) {
    if (M.hover === n) return;
    M.hover = n;
    if (S()) S().setHover(n);
  }

  // ---------------------------------------------------------------- the journey's nearest point
  let jS = null, jStep = 1, pinnedS = null;   // pinnedS: the void holds the eye's journey reference while outside
  function nearestS(x, y, z) {
    const J = o.journey();
    if (!jS) {
      const n = Math.max(2, Math.ceil(J.total / jStep) + 1);
      jS = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const p = J.at(Math.min(J.total, i * jStep)); jS[i * 3] = p[0]; jS[i * 3 + 1] = p[1]; jS[i * 3 + 2] = p[2]; }
    }
    if (pinnedS != null) return pinnedS;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < jS.length / 3; i++) {
      const dx = jS[i * 3] - x, dy = jS[i * 3 + 1] - y, dz = jS[i * 3 + 2] - z, d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return Math.min(J.total, bi * jStep);
  }
  let walkS = 0;
  // ---------------------------------------------------------------- the eye
  let ev = null, evJ = 0, evFrom = 0, metered = null;
  const meterOn = on => { if (S() && S().setMeter) S().setMeter(on); };   // measured only while walking
  function refAt(s) {                      // log2 L of the journey's frame at arc length s (linear between samples)
    const R = EYE.REF, f = Math.max(0, Math.min(1, s / o.journey().total)) * (R.length - 1), i = Math.min(R.length - 2, Math.floor(f));
    return R[i] + (R[i + 1] - R[i]) * (f - i);
  }
  function eyeTarget(L) {
    const d = EYE.K * (refAt(walkS) - Math.log2(Math.max(1e-6, L)));
    const lift = d > EYE.DARK_FROM ? EYE.DARK_EXTRA * smooth(Math.min(1, (d - EYE.DARK_FROM) / EYE.DARK_SPAN)) : 0;
    const t = o.exposureAt(walkS) + Math.max(-EYE.DOWN, Math.min(EYE.UP, d)) + lift;
    return Math.max(EYE.MIN, Math.min(EYE.MAX + lift, t));
  }
  function adapt(dt) {
    const m = S() && S().meter ? S().meter() : null;
    if (m && m.logAvg > 0) metered = m;
    if (!metered || ev === null) return;
    const t = eyeTarget(metered.logAvg);
    // towards light (a lower EV) fast, towards the dark slowly
    ev += (t - ev) * (1 - Math.exp(-dt / (t < ev ? EYE.UP_TAU : EYE.DOWN_TAU)));
  }
  function exposure(j) {
    evJ = j;
    if (active) { if (ev === null) ev = j; return ev; }
    if (exitT >= 0 && ev !== null) return evFrom + (j - evFrom) * smooth(exitT / C.EXIT_S);
    if (ev !== null) { ev = null; metered = null; meterOn(false); }
    return j;
  }

  // ---------------------------------------------------------------- enter, leave
  function enter(cur, opts = {}) {
    if (active) return;
    active = true; paused = false; exitT = -1;
    meterOn(true);
    camEye[0] = cur.eye[0]; camEye[1] = cur.eye[1]; camEye[2] = cur.eye[2];
    const d = cur.dir, dl = Math.hypot(d[0], d[1], d[2]) || 1;
    B.yaw = Math.atan2(d[0] / dl, -d[2] / dl); B.pitch = Math.asin(Math.max(-1, Math.min(1, d[1] / dl)));
    B.pitch = Math.max(-C.PITCH, Math.min(C.PITCH, B.pitch));
    B.fov = cur.fov || 50; B.jumpT = -1;
    keys.w = keys.a = keys.s = keys.d = keys.shift = 0;
    if (G) placeBody(camEye);
    else { pendingPlace = true; B.x = camEye[0]; B.z = camEye[2]; B.foot = camEye[1] - C.EYE; enterOff.fill(0); load(); }
    if (!opts.noLock) lock();
    walkS = nearestS(camEye[0], camEye[1], camEye[2]);
  }
  function leave() {
    if (!active) return;
    active = false; paused = false;
    exitFrom.eye[0] = pose.eye[0]; exitFrom.eye[1] = pose.eye[1]; exitFrom.eye[2] = pose.eye[2];
    exitFrom.dir[0] = pose.dir[0]; exitFrom.dir[1] = pose.dir[1]; exitFrom.dir[2] = pose.dir[2]; exitFrom.fov = pose.fov;
    exitT = 0; escGrace = performance.now() + 500;
    evFrom = ev === null ? evJ : ev;
    keys.w = keys.a = keys.s = keys.d = keys.shift = 0;
    if (downName) { o.pressUp(downName, false); downName = null; }
    setHover(null);
    if (document.pointerLockElement) try { document.exitPointerLock(); } catch (e) { /* not locked */ }
    // back on the rail at its nearest point; the journey carries on to the nearer place
    const J = o.journey(), s = nearestS(pose.eye[0], pose.eye[1], pose.eye[2]);
    M.s = s; M.v = 0;
    const place = s > J.total * 0.5 ? 'rgb' : 'fanlar';
    if (M.place !== place) o.go(place); else o.kick();
  }
  function lock() {
    try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not available */ }
  }

  // ---------------------------------------------------------------- the camera each frame
  function slerpDir(a, b, t, out) {
    const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const th = Math.acos(d);
    if (th < 1e-5) { out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; return; }
    let px = b[0] - a[0] * d, py = b[1] - a[1] * d, pz = b[2] - a[2] * d;
    let pl = Math.hypot(px, py, pz);
    if (pl < 1e-6) { px = -a[2]; py = 0; pz = a[0]; pl = Math.hypot(px, pz) || 1; }     // opposite: turn about up
    px /= pl; py /= pl; pz /= pl;
    const c = Math.cos(th * t), s = Math.sin(th * t);
    out[0] = a[0] * c + px * s; out[1] = a[1] * c + py * s; out[2] = a[2] * c + pz * s;
  }
  const smooth = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
  const last = { eye: [0, 0, 0], dir: [0, 0, -1], fov: 50 };      // the pose last shown (walk mode starts from it)
  const remember = p => { for (let i = 0; i < 3; i++) { last.eye[i] = p.eye[i]; last.dir[i] = p.dir[i]; } last.fov = p.fov; return p; };
  function camera(dt, jp) {
    if (!active) {
      if (exitT < 0) return remember(jp);
      exitT += dt;
      const t = smooth(exitT / C.EXIT_S);
      if (exitT >= C.EXIT_S) { exitT = -1; return remember(jp); }
      for (let i = 0; i < 3; i++) blendPose.eye[i] = exitFrom.eye[i] + (jp.eye[i] - exitFrom.eye[i]) * t;
      slerpDir(exitFrom.dir, jp.dir, t, blendPose.dir);
      blendPose.fov = exitFrom.fov + (jp.fov - exitFrom.fov) * t;
      return remember(blendPose);
    }
    const t0 = performance.now();
    if (G && !paused && !pendingPlace) physics(Math.min(dt, 0.1));
    adapt(Math.min(dt, 0.1));
    const cp = Math.cos(B.pitch);
    pose.dir[0] = Math.sin(B.yaw) * cp; pose.dir[1] = Math.sin(B.pitch); pose.dir[2] = -Math.cos(B.yaw) * cp;
    if (pendingPlace) { pose.eye[0] = camEye[0]; pose.eye[1] = camEye[1]; pose.eye[2] = camEye[2]; }
    else {
      enterT += dt;
      const k = enterDur > 0 ? 1 - smooth(enterT / enterDur) : 0;
      pose.eye[0] = B.x + enterOff[0] * k;
      pose.eye[1] = B.foot + C.EYE + B.eyeLag + enterOff[1] * k;
      pose.eye[2] = B.z + enterOff[2] * k;
    }
    pose.fov = B.fov;
    if (o.actions) setHover(G ? centreHit() : null);
    walkS = nearestS(pose.eye[0], pose.eye[1], pose.eye[2]);
    const tt = performance.now() - t0; timing[timingN++ % timing.length] = tt; timeSum += tt;
    return remember(pose);
  }

  // ---------------------------------------------------------------- input (capture: the app's own handlers never see
  // what walk mode takes)
  let downName = null;
  const stop = e => { e.stopImmediatePropagation(); e.stopPropagation(); };
  const KEYMAP = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', ShiftLeft: 'shift', ShiftRight: 'shift', ArrowUp: 'w', ArrowDown: 's', ArrowLeft: 'a', ArrowRight: 'd' };
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyY' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      stop(e); e.preventDefault();
      if (e.repeat || !S() || !S().ready) return;
      if (active) leave(); else enter(last);
      return;
    }
    if (!active) {
      if (e.key === 'Escape' && performance.now() < escGrace) { stop(e); e.preventDefault(); }
      return;
    }
    stop(e); e.preventDefault();
    if (e.key === 'Escape') { leave(); return; }
    const k = KEYMAP[e.code];
    if (k) keys[k] = 1;
    if (e.code === 'Space' && !e.repeat) B.jumpT = 0;
  }, true);
  window.addEventListener('keyup', e => {
    if (!active) return;
    stop(e);
    const k = KEYMAP[e.code];
    if (k) keys[k] = 0;
  }, true);
  window.addEventListener('pointermove', e => {
    if (!active) return;
    stop(e);
    if (paused) return;
    B.yaw += (e.movementX || 0) * C.LOOK;
    B.pitch = Math.max(-C.PITCH, Math.min(C.PITCH, B.pitch - (e.movementY || 0) * C.LOOK));
  }, true);
  window.addEventListener('pointerdown', e => {
    if (!active) return;
    stop(e); e.preventDefault();
    if (paused || !document.pointerLockElement) { paused = false; lock(); return; }
    if (e.button !== 0) return;
    const n = centreHit();
    if (!n) return;
    downName = n;
    o.pressDown(n);
  }, true);
  window.addEventListener('pointerup', e => {
    if (!active) return;
    stop(e);
    if (e.button !== 0 || !downName) return;
    const n = downName; downName = null;
    const fire = centreHit() === n;
    if (fire && /^git_/.test(n)) { leave(); }
    o.pressUp(n, fire);
  }, true);
  for (const t of ['dblclick', 'wheel', 'click']) window.addEventListener(t, e => { if (active) stop(e); }, { capture: true, passive: t !== 'wheel' ? undefined : true });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (active && lastLock && !locked) {
      // Escape ends the lock (the page may never see that key): leave; a lost focus (Alt+Tab) only pauses
      if (document.hasFocus()) leave();
      else { paused = true; keys.w = keys.a = keys.s = keys.d = keys.shift = 0; }
    }
    lastLock = locked;
  });
  window.addEventListener('blur', () => { keys.w = keys.a = keys.s = keys.d = keys.shift = 0; });

  setTimeout(() => load(), C.PREFETCH_S * 1000);

  // ---------------------------------------------------------------- API
  const api = {
    config: C,
    get active() { return active; },
    get ready() { return !!G; },
    camera,
    s: fallback => (active ? walkS : fallback),
    exposure,
    eye: () => ({ ev, metered, target: metered ? eyeTarget(metered.logAvg) : null, config: EYE }),
    enter: (opts) => enter(last, opts),
    leave,
    load,
    shift(dx, dy, dz) {                      // the world wraps: same velocity, same look, no visible jump
      B.x += dx; B.foot += dy; B.z += dz; B.safeX += dx; B.safeF += dy; B.safeZ += dz;
      camEye[0] += dx; camEye[1] += dy; camEye[2] += dz;
    },
    // a moving solid in the collision (the hatch's lid): Float32Array of triangles (9 floats each), or null to remove
    setSolid(name, tris) { if (tris) solids.set(name, tris instanceof Float32Array ? tris : new Float32Array(tris)); else solids.delete(name); writeSolids(); },
    // a rigid move of the world (the void re-expresses it in another facility's frame): positions through map, the
    // velocity and the look turned by th (R(th) v = (cos th x + sin th z, y, -sin th x + cos th z); a heading a -> a - th)
    remap(map, th) {
      const b = map([B.x, B.foot, B.z]), sf = map([B.safeX, B.safeF, B.safeZ]), ce = map([camEye[0], camEye[1], camEye[2]]);
      B.baseF += b[1] - B.foot;
      B.x = b[0]; B.foot = b[1]; B.z = b[2]; B.safeX = sf[0]; B.safeF = sf[1]; B.safeZ = sf[2];
      camEye[0] = ce[0]; camEye[1] = ce[1]; camEye[2] = ce[2];
      const c = Math.cos(th), sn = Math.sin(th), vx = B.vx, vz = B.vz;
      B.vx = c * vx + sn * vz; B.vz = -sn * vx + c * vz;
      B.yaw -= th;
    },
    setColumns(list) { columns = list || []; },
    // the walker's velocity (the void's fall: its brake)
    setVelocity(vx, vy, vz) { if (vx != null) B.vx = vx; if (vy != null) B.vy = vy; if (vz != null) B.vz = vz; },
    // hold the journey point the eye's exposure refers to (s in metres, null: the nearest point again)
    pinS(sv) { pinnedS = sv == null ? null : sv; },
    setFloor(y) { if (y == null) floorSet = null; else { floorSet = true; floorY = y; } },
    onFall(fn) { fallFn = fn || null; },
    onStep(fn) { stepFn = fn || null; },
    state: () => ({ x: B.x, foot: B.foot, z: B.z, vx: B.vx, vy: B.vy, vz: B.vz, grounded: B.grounded, yaw: B.yaw, pitch: B.pitch,
                    input: !!(keys.w || keys.a || keys.s || keys.d),
                    eye: pose.eye.slice(), hover: M.hover }),
    stats() {
      const a = Array.from(timing.subarray(0, Math.min(timingN, timing.length))).sort((x, y) => x - y);
      const q = f => (a.length ? +a[Math.min(a.length - 1, Math.floor(f * a.length))].toFixed(3) : null);
      return { load: loadInfo, stepMs: { mean: timingN ? +(timeSum / timingN).toFixed(4) : null, p50: q(0.5), p95: q(0.95), max: q(1) }, frames: timingN, candMax: contactsMax, candOverflow: candOver };
    },
    // tests: keys and look by script, a pose by hand
    debug: {
      keys(k) { Object.assign(keys, { w: 0, a: 0, s: 0, d: 0, shift: 0 }, k); },
      jump() { B.jumpT = 0; },
      look(yaw, pitch) { B.yaw = yaw; B.pitch = pitch; },
      put(x, foot, z, vy = 0) { B.x = x; B.foot = foot; B.baseF = foot; B.z = z; B.vx = B.vz = 0; B.vy = vy; B.grounded = false; B.eyeLag = 0; enterOff.fill(0); },
      groundAt: (x, z, top = 100, bot = -100) => groundCast(x, z, top, bot),
      journeyEv: u => o.exposureAt(u * o.journey().total),
      setEye(e) { Object.assign(EYE, e); },
      resetTiming() { timingN = 0; contactsMax = 0; timeSum = 0; },
    },
  };
  return api;
}

window.KM_YURUYUS = Object.freeze({ create, config: C });
})();
