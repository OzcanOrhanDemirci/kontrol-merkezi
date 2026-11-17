"""Traps in walk mode: places one can get into and not out of (Phase 2; 11-17 Özcan fell between the louvres of the
roof lamp into its pit and, with the 0.45 m jump of then, could not climb out).

The check moves walk mode's own body (ui/yuruyus.js: W.camera's physics, driven through W.debug.put/keys/look/jump);
nothing of its physics is re-implemented here, so "can stand", "can get from here to there" and "is out" are what
the walker really does: its step, its jump and how far it carries, its capsule against walls and ceilings, its
sliding off steep contacts.

  1. Standing places. On a grid (--adim) over the outline, every surface of every column, top down, gets the body put
     on it and left alone until it rests; where it rests is a place (so a gap no grid point hits is still found when
     the body slides or drops into it). Places are cells of --adim by --adim by 0.25 m.
  2. Walking. From every place the body walks in the four directions with the key held; every cell it stands in on
     the way is reached from the one before (a drop off an edge lands where it lands). Leaving the outline, or falling
     under it, is the void: it lands one on the deck again.
  3. Free: a place from which the hall's floor, the deck or the void is reached. From every place that is not free
     and can be got into, the body tries to get out: in eight directions a walk from rest, a jump with the key held,
     the same running, and a jump after a run-up; where it comes to rest is reached. A free place within 1.2 m of
     one with no known way in (and not more than a jump under it) tries to jump into it, standing and after a short
     run-up: the ways in that need a jump.
  4. A trap: a place one can get into (walked or dropped into from a free place, jumped into, or landed on from the
     void: nothing over it) and from which no chain of those moves gets back to a free place.

    python araclar/salon_cukur.py [--paket DIR] [--jump 1.25] [--adim 0.4] [--kutu x0,x1,z0,z1] [--kareler]

--jump sets the walker's jump height for the run (the calibration: with 0.45 the roof lamp's pit must come out as a
trap, with 1.25 not). --kutu limits the scan (everything beyond it counts as the void: a way out). --kareler writes
two stills of each trap (standing in it, and from over it) beside cukur.json in --out. Headless Edge, the simulated
service; exit code 1 when a trap is found.

What it cannot see: a way in or out narrower than the grid that no walk or jump from a cell's centre happens to
take (it can miss a trap behind one, and report a place whose only exit is one); moves that need more than one key
at a time in the air; the hatch with its lid open (the scan keeps it shut); anything the collision does not hold
(the materials walk mode skips).
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

JS = r"""async (cfg) => {
  const km = window.__km, W = km.W, C = W.config, S = km.S;
  if (cfg.jump != null) C.JUMP_H = cfg.jump;
  // the walker alone: no void logic after its steps (leaving the outline is the void here), no centre pick per frame
  W.onStep(null); W.setFloor(null); S.pickRay = () => null;
  if (W.setBeams) W.setBeams(null);   // the void's beams under the columns are the void here too
  const DT = 1 / 60, JP = { eye: [0, 0, 0], dir: [0, 0, -1], fov: 50 };
  const frame = () => W.camera(DT, JP);
  const cell = cfg.cell, HB = 0.25;
  const A = S.anchors, kb = (A.dis_sinir || A.dis_blok || {}).kutu;
  const outline = kb ? [kb.merkez[0] - Math.abs(kb.x[0]), kb.merkez[0] + Math.abs(kb.x[0]), kb.merkez[2] - Math.abs(kb.z[2]), kb.merkez[2] + Math.abs(kb.z[2]),
                        kb.merkez[1] - Math.abs(kb.y[1]), kb.merkez[1] + Math.abs(kb.y[1])] : [-75, 75, -380, 35, -45, 60];
  const box = cfg.box ? [cfg.box[0], cfg.box[1], cfg.box[2], cfg.box[3], outline[4], outline[5]] : outline;
  const gone = s => s.x < box[0] || s.x > box[1] || s.z < box[2] || s.z > box[3] || s.foot < box[4] - 2;
  const T0 = performance.now(), sec = () => ((performance.now() - T0) / 1000).toFixed(0) + ' sn';
  let frames = 0;

  // ---------------------------------------------------------------- places
  const NX = [], NF = [], NZ = [], OUT = [], DONE = [], JUMPED = [], id = new Map();
  const keyOf = (x, f, z) => ((Math.round(x / cell) + 2048) * 8192 + (Math.round(z / cell) + 4096)) * 8192 + Math.round((f + 1000) / HB);
  const newNode = (x, f, z) => { NX.push(x); NF.push(f); NZ.push(z); OUT.push([]); DONE.push(0); JUMPED.push(0); return NX.length - 1; };
  const VOID = newNode(1e6, -1e6, 1e6);
  const nodeAt = s => { const k = keyOf(s.x, s.foot, s.z); let n = id.get(k); if (n === undefined) { n = newNode(s.x, s.foot, s.z); id.set(k, n); } return n; };
  // edges: target * 4 + kind (0 walked or dropped, 1 a move with a jump or from rest, 2 landed from the void)
  const edge = (a, b, kind) => { if (a === b) return; const l = OUT[a]; for (let i = 0; i < l.length; i++) if (l[i] >> 2 === b) return; l.push(b * 4 + kind); };
  const start = n => { W.debug.put(NX[n], NF[n], NZ[n]); W.debug.keys({}); };
  // left alone until it rests: the state, or null (it left, or never rested)
  const rest = max => {
    let calm = 0;
    for (let f = 0; f < max; f++) {
      frame(); frames++;
      const s = W.state();
      if (gone(s)) return null;
      if (s.grounded && s.vx * s.vx + s.vz * s.vz < 0.0025) { if (++calm >= 2) return s; } else calm = 0;
    }
    return null;
  };

  // 1. every surface of every column
  let seeds = 0;
  for (let i = Math.ceil(box[0] / cell); i * cell <= box[1]; i++) for (let k = Math.ceil(box[2] / cell); k * cell <= box[3]; k++) {
    const x = i * cell, z = k * cell;
    for (let top = box[5] + 2, q = 0; q < 40; q++) {
      const h = W.debug.groundAt(x, z, top, box[4]);
      if (!(h > -Infinity)) break;
      top = h - 0.6;
      seeds++;
      W.debug.put(x, h, z); W.debug.keys({});
      const s = rest(60);
      if (s) nodeAt(s);
    }
  }
  console.log(`yerler: ${seeds} yüzey, ${NX.length - 1} yer (${sec()})`);
  const starts = [];
  for (const [x, z, y] of cfg.starts) {
    if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue;
    const h = W.debug.groundAt(x, z, y, y - 3);
    if (!(h > -Infinity)) continue;
    W.debug.put(x, h, z); W.debug.keys({});
    const s = rest(120);
    if (s) starts.push(nodeAt(s));
  }
  const deck = starts.filter(n => NF[n] > 30);

  // 2. walking with the key held: every cell stood in on the way is reached from the one before
  const DIRS = [[0, 0, -1], [Math.PI / 2, 1, 0], [Math.PI, 0, 1], [-Math.PI / 2, -1, 0]];
  function sweep(n, d) {
    const [yaw, dx] = DIRS[d], bit = 1 << d;
    DONE[n] |= bit;
    start(n); W.debug.look(yaw, 0); W.debug.keys({ w: 1 });
    let cur = n, still = 0;
    for (let f = 0; f < 3000; f++) {
      frame(); frames++;
      const s = W.state();
      if (gone(s)) { edge(cur, VOID, 0); return; }
      if (!s.grounded) continue;
      const m = nodeAt(s);
      if (m === cur) { if (++still > 30) return; continue; }
      edge(cur, m, 0); cur = m; still = 0;
      // on this cell's own line (not slid aside): what follows from here is this cell's walk in this direction
      if (Math.abs(dx ? s.z - NZ[m] : s.x - NX[m]) < 0.12) { if (DONE[m] & bit) return; DONE[m] |= bit; }
    }
  }
  let swept = 1;
  // towards +x and +z in the order the places were made (x, then z, rising), towards -x and -z in the reverse: a walk
  // then runs on through the cells ahead of it that are still to do, instead of stopping at the first one already done
  const sweepAll = () => {
    while (swept < NX.length) {
      const a = swept, b = NX.length;
      for (let n = a; n < b; n++) for (const d of [1, 2]) if (!(DONE[n] & (1 << d))) sweep(n, d);
      for (let n = b - 1; n >= a; n--) for (const d of [0, 3]) if (!(DONE[n] & (1 << d))) sweep(n, d);
      swept = b;
    }
  };

  // 3. a move from rest: keys held (a jump at frame `at`, or none), released at the first landing after it (or after
  // `hold` frames without a jump); where the body comes to rest is reached
  function move(n, yaw, run, at, hold) {
    start(n); W.debug.look(yaw, 0); W.debug.keys({ w: 1, shift: run });
    let jumped = at < 0, air = 0;
    for (let f = 0; f < 300; f++) {
      if (f === at) { W.debug.jump(); jumped = true; }
      frame(); frames++;
      const s = W.state();
      if (gone(s)) { edge(n, VOID, 1); return; }
      if (at < 0) { if (f >= hold) break; continue; }
      if (!jumped) continue;
      if (!s.grounded) air++;
      else if (air > 2 || f > at + 12) break;
    }
    W.debug.keys({});
    const s = rest(240);
    if (!s) { if (gone(W.state())) edge(n, VOID, 1); return; }
    edge(n, nodeAt(s), 1);
  }
  // JUMPED: the directions (bits 0..7, yaw d * 45 degrees) already tried from a place; 256: all four moves in all eight
  function tryOut(n, dirs, full) {
    for (let d = 0; d < 8; d++) {
      if (!(dirs & (1 << d)) || (JUMPED[n] & (1 << d) && !full)) continue;
      const yaw = d * Math.PI / 4;
      move(n, yaw, 0, 0, 0);                    // a jump, the key held
      move(n, yaw, 1, full ? 18 : 9, 0);        // a run-up (0.3 s; into a place close by 0.15 s), then the jump
      if (!full) continue;
      move(n, yaw, 1, 0, 0);                    // a jump, running
      move(n, yaw, 0, -1, 24);                  // a walk of 0.4 s from rest
    }
    JUMPED[n] |= dirs | (full ? 256 : 0);
  }

  // 4. free, reachable, and the rounds of trying
  let back, reach, sky;
  const skyOf = n => !(W.debug.groundAt(NX[n], NZ[n], box[5] + 5, NF[n] + 0.45) > -Infinity);   // nothing over it: one lands on it from the void
  function classify() {
    const N = NX.length;
    const rev = Array.from({ length: N }, () => []);
    for (let a = 0; a < N; a++) for (const e of OUT[a]) rev[e >> 2].push(a);
    back = new Uint8Array(N); back[VOID] = 1;
    let q = [VOID, ...starts]; starts.forEach(n => { back[n] = 1; });
    while (q.length) { const b = q.pop(); for (const a of rev[b]) if (!back[a]) { back[a] = 1; q.push(a); } }
    if (!sky || sky.length < N) { const o = sky; sky = new Uint8Array(N); if (o) sky.set(o); for (let n = o ? o.length : 1; n < N; n++) sky[n] = skyOf(n) ? 1 : 0; }
    reach = new Uint8Array(N); q = [...starts];
    starts.forEach(n => { reach[n] = 1; });
    for (let n = 1; n < N; n++) if (sky[n] && !reach[n]) { reach[n] = 1; q.push(n); }
    while (q.length) { const a = q.pop(); for (const e of OUT[a]) { const b = e >> 2; if (b !== VOID && !reach[b]) { reach[b] = 1; q.push(b); } } }
  }
  // the columns within NEAR of a place, each under the one of the eight directions it lies in
  const NEAR = Math.max(1, Math.round(1.2 / cell)), col = (i, k) => (i + 2048) * 8192 + k + 4096, AROUND = [];
  for (let a = -NEAR; a <= NEAR; a++) for (let b = -NEAR; b <= NEAR; b++) if (a || b)
    AROUND.push([a, b, 1 << ((Math.round(Math.atan2(a, -b) / (Math.PI / 4)) + 8) % 8)]);
  for (let round = 1; round <= 40; round++) {
    sweepAll();
    classify();
    const N = NX.length;
    const todo = [], entry = [];
    // the lowest place in every column that is not free and has no known way in: a free place by it tries to jump
    // into it, in the directions it lies in (the ways in that need a jump)
    const low = new Map();
    let notFree = 0;
    for (let n = 1; n < N; n++) if (!back[n]) {
      notFree++;
      if (reach[n]) { if (!(JUMPED[n] & 256)) todo.push(n); continue; }
      const c = col(Math.round(NX[n] / cell), Math.round(NZ[n] / cell)), v = low.get(c);
      if (v === undefined || NF[n] < v) low.set(c, NF[n]);
    }
    if (low.size) for (let n = 1; n < N; n++) if (back[n] && reach[n]) {
      const i = Math.round(NX[n] / cell), k = Math.round(NZ[n] / cell), lim = NF[n] + C.STEP + C.JUMP_H + 0.2;
      let dirs = 0;
      for (const [a, b, bit] of AROUND) if (!(dirs & bit)) { const v = low.get(col(i + a, k + b)); if (v !== undefined && v <= lim) dirs |= bit; }
      dirs &= ~JUMPED[n];
      if (dirs) entry.push(n, dirs);
    }
    console.log(`tur ${round}: ${N - 1} yer, serbest değil ${notFree}, çıkış denenecek ${todo.length}, giriş denenecek ${entry.length / 2} (${sec()}, ${(frames / 1e6).toFixed(1)} M kare)`);
    if (!todo.length && !entry.length) break;
    for (const n of todo) tryOut(n, 255, true);
    for (let e = 0; e < entry.length; e += 2) tryOut(entry[e], entry[e + 1], false);
  }
  sweepAll(); classify();

  // the result: every place not free, with how one gets into it
  const N = NX.length, into = new Int32Array(N).fill(-1), kind = new Uint8Array(N);
  for (let a = 1; a < N; a++) if (back[a] && reach[a]) for (const e of OUT[a]) { const b = e >> 2; if (!back[b] && (into[b] < 0 || (e & 3) === 0)) { into[b] = a; kind[b] |= (e & 3) === 0 ? 1 : 2; } }
  const r3 = v => Math.round(v * 1000) / 1000;
  const traps = [], closed = [];
  for (let n = 1; n < N; n++) if (!back[n]) {
    if (!reach[n]) { closed.push([r3(NX[n]), r3(NF[n]), r3(NZ[n])]); continue; }
    const a = into[n];
    traps.push([r3(NX[n]), r3(NF[n]), r3(NZ[n]), kind[n] | (sky[n] ? 4 : 0), ...(a >= 0 ? [r3(NX[a]), r3(NF[a]), r3(NZ[a])] : [])]);
  }
  let free = 0; for (let n = 1; n < N; n++) if (back[n] && reach[n]) free++;
  return { box, jump: C.JUMP_H, step: C.STEP, places: N - 1, free, starts: starts.map(n => [r3(NX[n]), r3(NF[n]), r3(NZ[n])]), deck: deck.length,
           frames, seconds: Math.round((performance.now() - T0) / 1000), traps, closed };
}"""

# a still from the walker's eye held at a point (put there again before every step, so it does not fall)
JS_STILL = r"""async ([x, f, z, yaw, pitch]) => {
  const km = window.__km, W = km.W;
  if (!W.active) W.enter({ noLock: true });
  for (let i = 0; i < 100; i++) { W.debug.put(x, f, z); W.debug.keys({}); W.debug.look(yaw, pitch); km.step(1 / 30); }
  km.S.render(1 / 30, 1 / 30);
  await new Promise(r => requestAnimationFrame(r));
}"""

EDGE = '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'


def clusters(cells, cell):
    """Cells [x, foot, z, ...] grouped: within two cells of each other and half a metre of height (one pit under a
    grating is one cluster, not one per gap)."""
    left = {}
    for t in cells:
        left.setdefault((round(t[0] / cell), round(t[2] / cell)), []).append(t)
    out = []
    while left:
        k0 = next(iter(left))
        t0 = left[k0].pop()
        if not left[k0]:
            del left[k0]
        stack, cl = [t0], [t0]
        while stack:
            t = stack.pop()
            i, k = round(t[0] / cell), round(t[2] / cell)
            for di in (-2, -1, 0, 1, 2):
                for dk in (-2, -1, 0, 1, 2):
                    l = left.get((i + di, k + dk))
                    if not l:
                        continue
                    for u in [u for u in l if abs(u[1] - t[1]) <= 0.5]:
                        l.remove(u); cl.append(u); stack.append(u)
                    if not l:
                        del left[(i + di, k + dk)]
        out.append(cl)
    out.sort(key=lambda c: -len(c))
    return out


def span(c):
    xs, fs, zs = [t[0] for t in c], [t[1] for t in c], [t[2] for t in c]
    return f'x {min(xs):7.2f}..{max(xs):7.2f}  z {min(zs):8.2f}..{max(zs):8.2f}  ayak {min(fs):7.2f}..{max(fs):7.2f}'


def page(p, port, w, h, scale):
    b = p.chromium.launch(channel='msedge', headless=True, args=list(EDGE))
    pg = b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=1)
    pg.on('pageerror', lambda e: print('  [sayfa hatası] ' + str(e)[:400], flush=True))
    pg.goto(f'http://127.0.0.1:{port}/ui/index.html#paket=/sahne/&olcek={scale}&still=0')
    pg.wait_for_function("window.__km && window.__km.S && window.__km.S.ready", timeout=600000)
    pg.evaluate('(async () => { await window.__km.still(0, { settle: 1 }); await window.__km.W.load(); window.__km.W.enter({ noLock: true }); })()')
    return b, pg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--paket', default=str(ROOT / 'sahne' / 'paket'))
    ap.add_argument('--adim', type=float, default=0.4)
    ap.add_argument('--jump', type=float, default=None, help="the jump height for this run (default: walk mode's own)")
    ap.add_argument('--kutu', default='', help='x0,x1,z0,z1: scan only this (beyond it: the void); default the whole outline')
    ap.add_argument('--out', default=str(ROOT / '.tmp' / 'cukur'))
    ap.add_argument('--kareler', action='store_true', help='two stills of each trap')
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT / 'sahne' / 'araclar'))
    import salon_test
    httpd, port = salon_test.serve(Path(a.paket).resolve())
    t0 = time.time()
    cfg = {'cell': a.adim, 'jump': a.jump, 'box': [float(v) for v in a.kutu.split(',')] if a.kutu else None,
           # where "out" is: the hall's floor and the deck
           'starts': [[0, -205, 0.5], [0, -100, 0.5], [0, -170, 36], [20, -300, 36]]}
    with sync_playwright() as p:
        b, pg = page(p, port, 640, 360, 1)
        pg.on('console', lambda m: m.type == 'log' and print('  ' + m.text, flush=True))
        r = pg.evaluate(JS, cfg)
        b.close()
        traps, closed = r.pop('traps'), r.pop('closed')
        tc, cc = clusters(traps, a.adim), clusters(closed, a.adim)
        print(f"zıplama {r['jump']} m, basamak {r['step']} m, ızgara {a.adim} m; {r['places']} yer, {r['free']} serbest; "
              f"çıkış sayılan başlangıç {len(r['starts'])}; {r['frames'] / 1e6:.1f} M kare, {time.time() - t0:.0f} sn", flush=True)
        if not a.kutu and len(r['starts']) < 4:
            print('UYARI: salonun zemini ya da çatı başlangıç noktalarında bulunamadı; sonuç güvenilmez', flush=True)
        print(f'TUZAK: {len(traps)} yer, {len(tc)} küme (girilebilen, çıkılamayan)', flush=True)
        res = []
        for n, c in enumerate(tc):
            how = set()
            for t in c:
                how |= {s for bit, s in ((1, 'yürüyerek/düşerek'), (2, 'zıplayarak'), (4, 'boşluktan inerek')) if t[3] & bit}
            src = next((t for t in c if len(t) > 4 and t[3] & 1), None) or next((t for t in c if len(t) > 4), None)
            print(f'  {n + 1:3d}. {len(c):5d} yer  {span(c)}  giriş: {", ".join(sorted(how)) or "?"}'
                  + (f'  (ör. {src[4]:.2f}, {src[5]:.2f}, {src[6]:.2f} -> {src[0]:.2f}, {src[1]:.2f}, {src[2]:.2f})' if src else ''), flush=True)
            res.append({'cells': c, 'how': sorted(how), 'from': src[4:7] if src else None})
        print(f'girilemeyen kapalı yer: {len(closed)} yer, {len(cc)} küme (tuzak değil: içine yol yok)', flush=True)
        for c in cc[:8]:
            print(f'       {len(c):5d} yer  {span(c)}', flush=True)
        (out / 'cukur.json').write_text(json.dumps({**r, 'paket': str(Path(a.paket).resolve()), 'traps': res, 'closed': [c for c in cc]}), encoding='utf-8')
        if a.kareler and tc:
            for f in out.glob('tuzak_*.jpg'):
                f.unlink()
            b, pg = page(p, port, 1280, 720, 2)
            for n, c in enumerate(tc[:40]):
                cx, cz = sum(t[0] for t in c) / len(c), sum(t[2] for t in c) / len(c)
                t = min(c, key=lambda t: (t[1] - min(u[1] for u in c)) * 4 + math.hypot(t[0] - cx, t[2] - cz))
                src = res[n]['from']
                yaw = math.atan2(src[0] - t[0], -(src[2] - t[2])) if src else 0.0
                pg.evaluate(JS_STILL, [t[0], t[1], t[2], yaw, 0.15])
                pg.screenshot(path=str(out / f'tuzak_{n + 1:02d}_ic.jpg'), type='jpeg', quality=88)
                pg.evaluate(JS_STILL, [t[0], t[1] + 3.0, t[2] + 1.5, 0.0, -1.1])
                pg.screenshot(path=str(out / f'tuzak_{n + 1:02d}_ust.jpg'), type='jpeg', quality=88)
            b.close()
            print(f'kareler: {out}', flush=True)
    httpd.shutdown()
    sys.exit(1 if traps else 0)


if __name__ == '__main__':
    main()
