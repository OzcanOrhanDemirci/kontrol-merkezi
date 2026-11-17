"""Traps in walk mode: places one can get into and not out of (Phase 2; 11-17 Özcan fell into the roof lamp's pit and
could not climb out). Walks a grid over the facility with walk mode's own ground probe (W.debug.groundAt, the foot
sphere the physics uses): from every standing place to its four neighbours by walking (up to a step, any drop) or by
a jump (up to STEP + JUMP_H), off any edge into the void (which lands one on the deck again), and reports the standing
places that can be reached from the hall but from which the hall cannot be reached again, clustered.

    python araclar/salon_cukur.py [--paket DIR] [--adim 0.4] [--jump 1.25]

Headless Edge, the simulated service. A grid probe does not see walls thinner than its step, so it can miss a trap
behind one; it does not invent traps.
"""
import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

JS = r"""async ([cell, jump, box, all]) => {
  const km = window.__km, W = km.W, C = W.config;
  if (jump != null) C.JUMP_H = jump;
  const STEP = C.STEP, REACH = C.STEP + C.JUMP_H;
  // a standing place: a contact walk mode stands on (a steep contact, a pit's rim, is slid off, not stood on)
  const g = (x, z, top, bot) => { const h = W.debug.groundAt(x, z, top, bot); return h > -Infinity && !W.debug.groundWalkable() ? NaN : h; };
  const ix = x => Math.round(x / cell), iz = z => Math.round(z / cell);
  const id = new Map(), nodes = [];             // key -> index; nodes: [i, k, h]
  const out = [];                               // forward edges per node
  const node = (i, k, h) => {
    const key = i + ',' + k + ',' + Math.round(h * 20);
    let n = id.get(key);
    if (n === undefined) { n = nodes.length; id.set(key, n); nodes.push([i, k, h]); out.push([]); }
    return n;
  };
  const VOID = node(1e6, 1e6, -1e3);
  const starts = [];
  for (const [x, z, y] of [[0, -205, 0.5], [0, -100, 0.5], [0, -170, 36], [20, -300, 36]]) {
    const h = g(x, z, y, y - 3);
    if (h > -Infinity) starts.push(node(ix(x), iz(z), h));
  }
  out[VOID].push(...starts.filter(n => nodes[n][2] > 30));   // the fall lands one on a deck
  const queue = starts.slice(), seen = new Uint8Array(4e6);
  starts.forEach(n => { seen[n] = 1; });
  // every standing place in the box, not only those the grid's walk reaches (a pit between louvres is entered at a
  // spot no grid point hits): each cell's surfaces from the top down, a body height apart
  if (all) for (let x = box[0]; x <= box[1]; x += cell) for (let z = box[2]; z <= box[3]; z += cell) {
    let top = 60;
    for (let s = 0; s < 6; s++) {
      const h = g(x, z, top, -45);
      if (!(h === h)) { top -= 0.3; continue; }
      if (!(h > -45)) break;
      const m = node(ix(x), iz(z), h);
      if (!seen[m]) { seen[m] = 1; queue.push(m); }
      top = h - 1.0;
    }
  }
  let probes = 0;
  const t0 = performance.now();
  while (queue.length) {
    const n = queue.pop();
    if (n === VOID) continue;
    const [i, k, h] = nodes[n];
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = (i + di) * cell, z = (k + dk) * cell;
      if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) { out[n].push(VOID); continue; }
      const add = t => { const m = node(i + di, k + dk, t); out[n].push(m); if (!seen[m]) { seen[m] = 1; queue.push(m); } };
      // walking over: the highest contact under a step's height; a steep one is slid off, on to what is under it
      let walk = NaN;
      for (let top = h + STEP, q = 0; q < 25; q++) {
        const raw = W.debug.groundAt(x, z, top, h - 80); probes++;
        if (!(raw > -Infinity) || W.debug.groundWalkable()) { walk = raw; break; }
        top = raw - 0.05;
      }
      if (walk > -45) add(walk); else if (!(walk === walk)) { /* a steep contact: no place */ } else out[n].push(VOID);
      const up = g(x, z, h + REACH, h + STEP + 1e-3); probes++;
      if (up > -Infinity) add(up);                              // NaN (steep) and -Infinity add nothing
    }
    if (nodes.length > 3.5e6) break;
  }
  // which reached places can get back to a start: reverse reachability
  const rev = nodes.map(() => []);
  out.forEach((l, a) => l.forEach(b => rev[b].push(a)));
  const back = new Uint8Array(nodes.length), q = starts.slice();
  starts.forEach(n => { back[n] = 1; });
  while (q.length) { const b = q.pop(); for (const a of rev[b]) if (!back[a]) { back[a] = 1; q.push(a); } }
  // a trap: a place one cannot get back from that one can get into from a place one can get back from
  const enter = new Uint8Array(nodes.length);
  out.forEach((l, a) => { if (back[a]) l.forEach(b => { if (!back[b]) enter[b] = 1; }); });
  const inTrap = new Uint8Array(nodes.length), tq = [];
  for (let n = 0; n < nodes.length; n++) if (enter[n] && n !== VOID) { inTrap[n] = 1; tq.push(n); }
  while (tq.length) { const a = tq.pop(); for (const b of out[a]) if (!back[b] && !inTrap[b] && b !== VOID) { inTrap[b] = 1; tq.push(b); } }
  const traps = [];
  for (let n = 0; n < nodes.length; n++) if (inTrap[n]) traps.push(nodes[n]);
  return { nodes: nodes.length, probes, ms: Math.round(performance.now() - t0), traps, backVoid: !!back[VOID] };
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--paket', default=str(ROOT / 'sahne' / 'paket'))
    ap.add_argument('--adim', type=float, default=0.4)
    ap.add_argument('--jump', type=float, default=None)
    ap.add_argument('--hepsi', action='store_true', help='also every standing place in the box, reached or not')
    ap.add_argument('--kutu', default='-75,75,-380,35', help='x0,x1,z0,z1 of the facility (beyond: the void)')
    a = ap.parse_args()
    sys.path.insert(0, str(ROOT / 'sahne' / 'araclar'))
    import salon_test
    httpd, port = salon_test.serve(Path(a.paket).resolve())
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True, args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
        pg = b.new_page(viewport={'width': 640, 'height': 360})
        pg.goto(f'http://127.0.0.1:{port}/ui/index.html#paket=/sahne/&olcek=1&still=0')
        pg.wait_for_function("window.__km && window.__km.S && window.__km.S.ready", timeout=600000)
        pg.evaluate('(async () => { await window.__km.still(0, { settle: 1 }); await window.__km.W.load(); window.__km.W.enter({ noLock: true }); })()')
        r = pg.evaluate(JS, [a.adim, a.jump, [float(v) for v in a.kutu.split(',')], a.hepsi])
        b.close()
    traps = r.pop('traps')
    print(json.dumps(r), flush=True)
    # cluster the traps (neighbouring cells at nearly the same height)
    left = {(t[0], t[1], round(t[2] * 4)): t for t in traps}
    clusters = []
    while left:
        k0, t0 = left.popitem()
        stack, cl = [k0], [t0]
        while stack:
            i, k, h = stack.pop()
            for di in (-1, 0, 1):
                for dk in (-1, 0, 1):
                    for dh in (-1, 0, 1):
                        kk = (i + di, k + dk, h + dh)
                        if kk in left:
                            cl.append(left.pop(kk)); stack.append(kk)
        clusters.append(cl)
    clusters.sort(key=lambda c: -len(c))
    print(f'tuzak yerleri: {len(traps)} hücre, {len(clusters)} küme')
    for c in clusters[:30]:
        xs = [t[0] * a.adim for t in c]; zs = [t[1] * a.adim for t in c]; hs = [t[2] for t in c]
        print(f'  {len(c):6d} hücre  x {min(xs):7.1f}..{max(xs):7.1f}  z {min(zs):7.1f}..{max(zs):7.1f}  ayak {min(hs):6.2f}..{max(hs):6.2f}')
    httpd.shutdown()


if __name__ == '__main__':
    main()
