"""The outside (Phase 2, ui/disari.js) in the real page: stills on the roof and of the void, the fall and its wrap,
a slow pan for the distant lamps' steadiness, the hatch. Headless Edge on the real GPU, the simulated service; nothing
touches the app's window.

    python araclar/salon_disari.py --paket C:/dev/kontrol-merkezi/.tmp/paket-on2 [--out DIR] [--yalniz kare,bosluk,kayma,dusus,pan,kapak,zaman]
                                   [--w 2560 --h 1440] [--olcek 2]

kare_<name>.jpg: stills; dusus/: the fall's frames and dusus.json (its path, the wrap); sarma_*.png: the wrap's frame
pair; pan.json: each lamp's peak luminance frame by frame over a slow pan; zaman.json: GPU ms per pass.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LOCKS = [Path('C:/dev/kontrol-merkezi/.tmp/pencere.lock'), Path('C:/dev/kontrol-merkezi/.tmp/gpu-tempo.lock')]


def wait_lock():
    # the real window's runs (pencere.lock) and another helper's timing (gpu-tempo.lock): no GPU work meanwhile
    said = False
    while any(l.exists() for l in LOCKS):
        if not said:
            print('kilit var (pencere/gpu-tempo): bekleniyor', flush=True)
            said = True
        time.sleep(20)


# still: name, (x, foot, z), yaw deg (0: -z, 90: +x), pitch deg
STILLS = [
    ('kapak_ust', (-1.5, 35.0, -334.0), 0, -14),        # standing by the hatch, looking at it and the mast
    ('cati_boyunca', (3.0, 35.0, -330.0), 180, -4),        # along the roof towards the far end (the lamp's pit)
    ('kuyu_lamba', (9.0, 35.0, -22.0), -45, -22),        # the roof's lamp close up (the pit at x 0, z -31)
    ('kenar_disari', (56.0, 35.0, -170.0), 90, 2),       # at the edge, looking out at the void
    ('kenar_asagi', (57.0, 35.0, -170.0), 90, -55),      # over the edge, down along the columns
    ('ufuk_capraz', (52.0, 35.0, -356.0), 60, 0),        # the corner, diagonal into the void
    ('merdiven_yukari', (0.0, 30.0, -333.5), 0, 30),   # on the stair under the open hatch, looking up
]

# views from the void (--yalniz bosluk): name, eye, target; our facility's middle is (0, 10, -171), its deck y 35
VOID_STILLS = [
    ('yakin_150', (115.0, 25.0, 79.0), (0.0, 5.0, -171.0)),        # ours from the gap between the rows, 80-250 m
    ('komsu_300', (115.0, 40.0, 79.0), (230.0, 5.0, -171.0)),      # the neighbour at x 230 from ~280 m, a little above
    ('sira_uzak', (115.0, 20.0, 79.0), (-500.0, 15.0, 20.0)),      # along the gap: ends of facilities at 100-600 m
    ('ustten', (115.0, 150.0, 79.0), (0.0, 10.0, -171.0)),         # ours from above
    ('alttan', (100.0, -150.0, 60.0), (0.0, 0.0, -171.0)),         # ours from below, falling past it
    # the long side square on, from 260 m: the silhouette. Ours alone: a neighbour stands where this eye is
    ('yan_cephe', (330.0, -10.0, -171.0), (0.0, -10.0, -171.0), 'tek'),
    ('uc_cephe', (0.0, -10.0, 260.0), (0.0, -10.0, 0.0), 'tek'),   # the short end square on, ours alone
    ('dugum_alttan', (104.0, -92.0, -86.0), (52.0, -22.0, -30.0)), # a leg meeting the mass, from below beside it
]

JS_PUT = r"""async ([x, foot, z, yaw, pitch, n]) => {
  const km = window.__km, W = km.W;
  if (!W.active) W.enter({ noLock: true });
  W.debug.put(x, foot, z, 0);
  W.debug.look(yaw * Math.PI / 180, pitch * Math.PI / 180);
  for (let i = 0; i < (n || 30); i++) { km.step(1 / 30); if (i % 3 === 0) { km.S.render(1 / 30, 1 / 30); await new Promise(r => requestAnimationFrame(r)); } }
  km.S.render(1 / 30, 1 / 30);
  await new Promise(r => requestAnimationFrame(r));
  return { s: W.state(), v: km.S.voidState(), d: km.V.state() };
}"""


def shot(pg, path):
    pg.screenshot(path=str(path))
    im = Image.open(path).convert('RGB')
    im.resize((1600, round(1600 * im.height / im.width)), Image.LANCZOS).save(path.with_suffix('.jpg'), quality=92)
    return np.asarray(im).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--paket', default='C:/dev/kontrol-merkezi/sahne/paket')
    ap.add_argument('--out', default=str(ROOT / '.tmp' / 'disari'))
    ap.add_argument('--yalniz', default='kare')
    ap.add_argument('--olcek', default='2')
    ap.add_argument('--w', type=int, default=2560)
    ap.add_argument('--h', type=int, default=1440)
    ap.add_argument('--js', default='', help='extra JS run once after load (tuning)')
    ap.add_argument('--varyant', default='', help='JSON list of fog settings: the stills once per setting')
    ap.add_argument('--kareler', default='', help='only these stills')
    ap.add_argument('--kayma-goz', default='58,36.7,-170', help='kayma: the eye')
    ap.add_argument('--kayma-hedef', default='240,10,-190', help='kayma: what it looks at at mid turn')
    ap.add_argument('--kayma-px', type=float, default=0.4)
    ap.add_argument('--kayma-n', type=int, default=36)
    a = ap.parse_args()
    only = set(a.yalniz.split(','))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT / 'sahne' / 'araclar'))
    import salon_test
    httpd, port = salon_test.serve(Path(a.paket).resolve())
    wait_lock()
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True, args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
        pg = b.new_page(viewport={'width': a.w, 'height': a.h}, device_scale_factor=1)
        pg.on('console', lambda m: m.type in ('error', 'warning') and print('  [sayfa] ' + m.type + ': ' + m.text[:400], flush=True))
        pg.on('pageerror', lambda e: print('  [sayfa hatasi] ' + str(e)[:400], flush=True))
        pg.goto(f'http://127.0.0.1:{port}/ui/index.html#paket=/sahne/&olcek={a.olcek}&still=0')
        pg.wait_for_function("window.__km && ((window.__km.S && window.__km.S.ready) || document.body.classList.contains('nogl'))", timeout=600000)
        pg.evaluate('(async () => { await window.__km.still(0, { settle: 6 }); })()')
        pg.evaluate('(async () => { await window.__km.W.load(); })()')
        if a.js:
            pg.evaluate(a.js)
        res = {}
        if 'kare' in only:
            variants = json.loads(a.varyant) if a.varyant else [None]
            names = set(a.kareler.split(',')) if a.kareler else None
            for vi, fog in enumerate(variants):
              if fog is not None:
                  pg.evaluate('(f) => window.__km.S.setVoid({ fog: f })', fog)
              tag = f'_v{vi}' if fog is not None else ''
              for name, (x, f, z), yaw, pitch in STILLS:
                if names and name not in names:
                    continue
                wait_lock()
                if name == 'merdiven_yukari':
                    pg.evaluate('window.__km.V.setOpen(true)')
                    f = pg.evaluate(f'window.__km.W.debug.groundAt({x}, {z}, 33, 20)')
                    pg.evaluate(JS_PUT, [x, f, z, yaw, pitch, 60])
                r = pg.evaluate(JS_PUT, [x, f, z, yaw, pitch, 90])
                shot(pg, out / f'kare_{name}{tag}.png')
                print('kare', name, 'goz', [round(v, 2) for v in r['s']['eye']], 'void', json.dumps(r['v']['drawn']), 'lamba', r['v']['lamps'], 'ev', pg.evaluate('JSON.stringify([window.__km.W.eye().ev, window.__km.W.eye().target])'), flush=True)
        if 'zaman' in only:
            res['zaman'] = {}
            for name, (x, f, z), yaw, pitch in [STILLS[1], STILLS[3], STILLS[5]]:
                wait_lock()
                pg.evaluate(JS_PUT, [x, f, z, yaw, pitch, 5])
                st = pg.evaluate("""(async () => { const km = window.__km; for (let i = 0; i < 40; i++) { km.S.render(1/30, 1/30);
                   await new Promise(r => requestAnimationFrame(r)); } return km.S.stats(); })()""")
                res['zaman'][name] = st['passes']
                print('zaman', name, json.dumps(st['passes']), 'toplam', round(sum(st['passes'].values()), 2), flush=True)
        if 'kapak' in only:
            wait_lock()
            d = out / 'kapak'
            d.mkdir(exist_ok=True)
            pg.evaluate(JS_PUT, [0.0, 35.0, -337.5, 180, -30, 10])
            pg.evaluate('window.__km.V.setOpen(true)')
            rows = []
            for i in range(54):
                r = pg.evaluate("""(async () => { const km = window.__km; km.step(1/30); km.S.render(1/30, 1/30);
                    await new Promise(r => requestAnimationFrame(r)); return km.V.state().hatch.angle; })()""")
                rows.append(r)
                if i % 6 == 5:
                    shot(d, d / f'acilis_{i:02d}.png') if False else shot(pg, d / f'acilis_{i:02d}.png')
            res['kapak'] = rows
            print('kapak acilis aci', [round(math.degrees(v), 1) for v in rows[::6]], flush=True)
            # down the stair through the open hatch, and back up (collision follows the lid)
            r = pg.evaluate("""(async () => { const km = window.__km, W = km.W; W.debug.put(0, 35, -347.4, 0); W.debug.look(Math.PI, -0.3);
                W.debug.keys({ w: 1 }); const rows = []; for (let i = 0; i < 150; i++) { km.step(1/30); const s = W.state(); rows.push([+s.z.toFixed(2), +s.foot.toFixed(2)]); }
                W.debug.keys({}); return rows; })()""")
            print('kapaktan inis: z, ayak', r[::15], flush=True)
            # closed: climbing must stop under the lid
            pg.evaluate('window.__km.V.setOpen(false)')
            r = pg.evaluate("""(async () => { const km = window.__km, W = km.W; for (let i = 0; i < 60; i++) km.step(1/30);
                const g = W.debug.groundAt(0, -337, 33, 20); W.debug.put(0, g, -337, 0); W.debug.look(0, 0.2);
                W.debug.keys({ w: 1 }); const rows = []; for (let i = 0; i < 150; i++) { km.step(1/30); const s = W.state(); rows.push([+s.z.toFixed(2), +s.foot.toFixed(2)]); }
                W.debug.keys({}); return rows; })()""")
            print('kapali kapaga tirmanis: z, ayak', r[::15], 'en yuksek ayak', max(x[1] for x in r), flush=True)
        if 'dusus' in only:
            wait_lock()
            d = out / 'dusus'
            d.mkdir(exist_ok=True)
            pg.evaluate(JS_PUT, [46.0, 35.0, -170.0, 90, -10, 10])
            pg.evaluate("window.__km.W.debug.keys({ w: 1 })")
            rows, shots = [], 0
            for i in range(30 * 50):
                r = pg.evaluate("""(async (i) => { const km = window.__km, W = km.W; if (i === 45) W.debug.keys({});
                    if (i > 60 && i < 400) W.debug.look(Math.PI / 2, -0.4 - 0.5 * Math.min(1, (i - 60) / 200));
                    if (i >= 400) W.debug.look(Math.PI / 2 + 0.3, -1.0);
                    km.step(1/30); const s = W.state(), f = km.V.state().fall; return [+s.x.toFixed(2), +s.foot.toFixed(2), +s.z.toFixed(2), +s.vy.toFixed(2), s.grounded ? 1 : 0, f.wraps, f.falling ? 1 : 0]; })""", i)
                rows.append(r)
                if i > 50 and r[4] == 1 and r[6] == 0:
                    break
            print('dusus: kare', len(rows), 'saniye', round(len(rows) / 30, 1), 'son', rows[-1], 'sarma', rows[-1][5], flush=True)
            print('dusus izi', rows[::60], flush=True)
            (d / 'dusus.json').write_text(json.dumps(rows))
            res['dusus'] = rows
        if 'dusus_kare' in only:
            # the fall as a sequence of frames (camera from the recorded path): every 1.5 s
            d = out / 'dusus'
            rows = json.loads((d / 'dusus.json').read_text())
            for i in range(0, len(rows), 45):
                wait_lock()
                x, f, z = rows[i][0], rows[i][1], rows[i][2]
                pitch = -10 if i < 60 else -45 if i < 400 else -57
                pg.evaluate("""(async ([x, f, z, p]) => { const km = window.__km, S = km.S; const e = [x, f + 1.7, z];
                    const d = [Math.cos(p * Math.PI / 180), Math.sin(p * Math.PI / 180), 0]; km.step(1/30); S.setCamera(e, [e[0] + d[0], e[1] + d[1], e[2] + d[2]], 50);
                    km.V.step(1/30, e); S.render(1/30, 1/30); await new Promise(r => requestAnimationFrame(r)); })""", [x, f, z, pitch])
                shot(pg, d / f'dusus_{i:04d}.png')
            print('dusus kareleri yazildi', flush=True)
        if 'sarma' in only:
            # the wrap's frame pair: the same camera relative to the lattice, before (D/2 below our roof) and after
            wait_lock()
            D = pg.evaluate('window.__km.V.config.D')
            imgs = []
            for dy in (0, D):
                pg.evaluate("""(async ([dy]) => { const km = window.__km, S = km.S; const e = [62, 35 - 430.5 + dy, -150];
                    S.setCamera(e, [e[0] - 0.5, e[1] - 1, e[2] - 0.2], 50); km.V.step(0, e); S.render(1/30, 1/30); await new Promise(r => requestAnimationFrame(r)); })""", [dy])
                imgs.append(shot(pg, out / f'sarma_{"once" if dy == 0 else "sonra"}.png'))
            diff = np.abs(imgs[0] - imgs[1])
            print('sarma: en buyuk fark', diff.max(), 'ortalama', round(float(diff.mean()), 4), 'farkli piksel', int((diff.max(axis=2) > 1).sum()), flush=True)
        if 'bosluk' in only:
            # the facility seen from the void: free cameras (eye, target), ours at the origin (its middle at z -171)
            names = set(a.kareler.split(',')) if a.kareler else None
            for name, e, t, *how in VOID_STILLS:
                if names and name not in names:
                    continue
                wait_lock()
                pg.evaluate("""(async ([e, t, solo]) => { const km = window.__km, S = km.S; S.setVoid({ force: true });
                    for (let i = 0; i < 4; i++) { S.setCamera(e, t, 50); km.V.step(1/30, e);
                    if (solo) S.setVoid({ list: km.V.facilities(e).filter(f => f.home) });
                    S.render(1/30, 1/30);
                    await new Promise(r => requestAnimationFrame(r)); } })""", [list(e), list(t), 'tek' in how])
                shot(pg, out / f'bos_{name}.png')
                print('bosluk', name, flush=True)
            pg.evaluate("window.__km.S.setVoid({ force: null })")
        if 'kayma' in only:
            # the neighbours' concrete in motion: a slow turn (--kayma-px display pixels a frame) from the roof's edge
            # towards the next facility (its legs 100-300 m off in the fog). Frames under kayma/, and the mean second
            # difference of the luma over time (a steady drift cancels in it; crawling stripes do not)
            wait_lock()
            kd = out / 'kayma'
            kd.mkdir(exist_ok=True)
            e, t0 = [float(v) for v in a.kayma_goz.split(',')], [float(v) for v in a.kayma_hedef.split(',')]
            ls = []
            for i in range(a.kayma_n):
                pg.evaluate("""(async ([e, t, i, px, n]) => { const km = window.__km, S = km.S; S.setVoid({ force: true });
                    const H = S.stats().size[1], da = (i - n / 2) * px * 2 * Math.tan(25 * Math.PI / 180) / H;
                    const d = [t[0] - e[0], t[1] - e[1], t[2] - e[2]], c = Math.cos(da), s = Math.sin(da);
                    const f = [c * d[0] + s * d[2], d[1], -s * d[0] + c * d[2]];
                    for (let k = 0; k < (i ? 1 : 6); k++) { S.setCamera(e, [e[0] + f[0], e[1] + f[1], e[2] + f[2]], 50); km.V.step(0, e); S.render(0, 1/30);
                    await new Promise(r => requestAnimationFrame(r)); } })""", [e, t0, i, a.kayma_px, a.kayma_n])
                pth = kd / f'k_{i:03d}.png'
                pg.screenshot(path=str(pth))
                im = np.asarray(Image.open(pth).convert('RGB')).astype(np.float32) / 255
                ls.append(im @ np.array([0.2126, 0.7152, 0.0722], np.float32))
            pg.evaluate("window.__km.S.setVoid({ force: null })")
            ls = np.stack(ls)
            d2 = np.abs(ls[2:] - 2 * ls[1:-1] + ls[:-2])
            d1 = np.abs(np.diff(ls, axis=0))
            hm = d2.mean(0)
            Image.fromarray(np.clip(hm / 0.01 * 255, 0, 255).astype(np.uint8)).save(out / 'kayma_isi.png')
            res['kayma'] = {'d2_ort': float(d2.mean()), 'd2_p999': float(np.percentile(d2, 99.9)), 'd1_ort': float(d1.mean()),
                            'd2_piksel_p999': float(np.percentile(hm, 99.9)), 'd2_piksel_max': float(hm.max())}
            print('kayma (luma 0..1):', json.dumps(res['kayma']), flush=True)
        if 'pan' in only:
            # a slow pan from the roof's edge: each distant lamp's peak luminance frame by frame (it must not blink)
            wait_lock()
            pg.evaluate(JS_PUT, [44.0, 35.0, -170.0, 60, 1, 5])
            # the lamps alone (a mast's line under a lamp would be cut by the window's whole-pixel edge)
            pg.evaluate("window.__km.S.setVoid({ mastsOff: true })")
            frames = []
            pd = out / 'pan'
            pd.mkdir(exist_ok=True)
            for i in range(48):
                yaw = 60 + i * 0.05
                r = pg.evaluate("""(async ([yaw]) => { const km = window.__km, S = km.S, W = km.W; W.debug.look(yaw * Math.PI / 180, 1 * Math.PI / 180);
                    km.step(1/30); S.render(1/30, 1/30); await new Promise(r => requestAnimationFrame(r));
                    const lamps = km.V.facilities(W.state().eye).filter(f => !f.home).map(f => { const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
                      const p = [2.6, 53.17, -348], q = [0, -275.25, -171];
                      const rx = (v) => [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
                      const rq = rx(q), rp = rx(p); const off = [f.o[0] + q[0] - rq[0], f.o[1], f.o[2] + q[2] - rq[2]];
                      const w = [rp[0] + off[0], rp[1] + off[1], rp[2] + off[2]]; return [w, S.project(w)]; });
                    return lamps.filter(l => l[1].z > 0).map(l => [l[0][0], l[0][1], l[0][2], l[1].x, l[1].y, l[1].z, S.voidGlow(l[1].x, l[1].y, 12)]); })""", [yaw])
                pth = pd / f'pan_{i:02d}.png'
                pg.screenshot(path=str(pth))
                im = np.asarray(Image.open(pth).convert('L')).astype(np.float32)
                # the same frame without the sprites: the difference is the lamps' own light (nothing of the background)
                pg.evaluate("""(async () => { const km = window.__km, S = km.S; S.setVoid({ lampsOff: true }); S.render(0, 0);
                    await new Promise(r => requestAnimationFrame(r)); })()""")
                pg.screenshot(path=str(pd / 'pan_bos.png'))
                pg.evaluate("window.__km.S.setVoid({ lampsOff: false })")
                bare = pg.evaluate("""(async (pts) => { const km = window.__km, S = km.S; S.setVoid({ lampsBare: true }); S.render(0, 0);
                    await new Promise(r => requestAnimationFrame(r)); const g = pts.map(p => S.voidGlow(p[0], p[1], 12)); S.setVoid({ lampsBare: false }); return g; })""", [[l[3], l[4]] for l in r])
                # in the display's linear light (sRGB decoded, x255): a dot below the eye's acuity is seen by the light
                # it sends, and an sRGB sum would favour a dot spread over two pixels over the same light in one
                def lin(a):
                    a = a / 255.0
                    return 255.0 * np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
                lit = lin(im) - lin(np.asarray(Image.open(pd / 'pan_bos.png').convert('L')).astype(np.float32))
                peaks = {}
                for (wx, wy, wz, x, y, z, g), gb in zip(r, bare):
                    xi, yi = int(round(x)), int(round(y))
                    if 12 <= xi < a.w - 12 and 12 <= yi < a.h - 12:
                        win = lit[yi - 6:yi + 7, xi - 6:xi + 7]
                        peaks[(round(wx), round(wy), round(wz))] = [round(z), float(im[yi - 4:yi + 5, xi - 4:xi + 5].max()), float(win.sum()), xi, yi, round(x, 2), round(y, 2), g, gb]
                frames.append(peaks)
            # per lamp (keyed by its world position, present in every frame): frame-to-frame relative change of the
            # sum of the lamp's own light (the frame minus the same frame without sprites) over 13x13 px
            keys = set(frames[0])
            for f in frames[1:]:
                keys &= set(f)
            worst = []
            for k in keys:
                sums = np.array([f[k][2] for f in frames]); pk = np.array([f[k][1] for f in frames])
                if sums.mean() < 20:
                    continue
                worst.append((frames[0][k][0], round(float(np.abs(np.diff(sums)).max() / sums.mean()), 4), round(float(pk.max() - pk.min()), 1), round(float(sums.mean()))))
            worst.sort(key=lambda t: -t[1])
            # the same from the lamps' own float light (the glow target, before the canvas' 8 bits): exact. The change
            # is measured against the lamp's full light (unhidden, lampsBare): a lamp nine tenths behind a column is
            # judged by what a step of its visible tenth is worth beside its whole light
            gw = []
            for k in keys:
                g = np.array([f[k][7] or 0.0 for f in frames]); gb = np.array([f[k][8] or 0.0 for f in frames])
                if gb.mean() > 1e-3 and g.mean() > 1e-4:
                    gw.append((frames[0][k][0], round(float(np.abs(np.diff(g)).max() / gb.mean()), 4), round(float(np.abs(np.diff(g)).max() / g.mean()), 4),
                               round(float(g.mean() / gb.mean()), 2), round(float(gb.mean()), 4), round(float(np.abs(np.diff(gb)).max() / gb.mean()), 4)))
            gw.sort(key=lambda t: -t[1])
            res['pan_float'] = gw
            pg.evaluate("window.__km.S.setVoid({ mastsOff: false })")
            print('pan float: (uzaklik m, degisim / tam isik, degisim / gorunen, gorunen pay, tam isik, ortulmeden degisim) lamba', len(gw), gw[:14], flush=True)
            for k in sorted(keys, key=lambda k: -np.std([f[k][7] or 0 for f in frames]))[:4]:
                print('pan float dizi', frames[0][k][0], [(round(f[k][7] or 0, 3), f[k][5]) for f in frames[:12]], flush=True)
            kw = {}
            for k in keys:
                kw[k] = next((t for t in worst if t[0] == frames[0][k][0] and abs(t[3] - round(float(np.mean([f[k][2] for f in frames])))) < 1), None)
            res['pan'] = {'lamps': len(keys), 'measured': len(worst), 'worst': worst}
            print('pan: lamba sayisi', len(keys), 'olculen', len(worst), flush=True)
            print('pan: (uzaklik m, toplamin kareden kareye en buyuk bagil degisimi, tepe araligi /255, ortalama isik)', worst[:15], flush=True)
            # frame-by-frame scan: a strip of 21x21 crops per lamp (rows: lamps; columns: frames), x2
            # the strip: the 16 worst measured lamps (rows, worst first), then the 8 brightest
            meas = [k for k in keys if kw[k]]
            sel = sorted(meas, key=lambda k: -kw[k][1])[:16] + sorted(meas, key=lambda k: -kw[k][3])[:8]
            for k in sel[:3]:
                print('pan dizi', frames[0][k][0], [(round(f[k][2]), f[k][5], f[k][6]) for f in frames[:9]], flush=True)
            print('pan seridi satirlari', [kw[k] + tuple(frames[0][k][3:5]) for k in sel], flush=True)
            if sel:
                cs = 21
                strip = np.zeros((len(sel) * cs, len(frames) * cs), np.float32)
                for ci, f in enumerate(frames):
                    im = np.asarray(Image.open(pd / f'pan_{ci:02d}.png').convert('L')).astype(np.float32)
                    for ri, k in enumerate(sel):
                        _, _, _, xi, yi = f[k][:5]
                        strip[ri * cs:(ri + 1) * cs, ci * cs:(ci + 1) * cs] = im[yi - 10:yi + 11, xi - 10:xi + 11]
                Image.fromarray(np.clip(strip, 0, 255).astype(np.uint8)).resize((len(frames) * cs * 2, len(sel) * cs * 2), Image.NEAREST).save(out / 'pan_tarama.png')
        (out / 'sonuc.json').write_text(json.dumps(res))
        b.close()
    httpd.shutdown()


if __name__ == '__main__':
    main()
