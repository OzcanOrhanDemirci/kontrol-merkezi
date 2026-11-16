"""The outside (Phase 2, ui/disari.js) in the real page: stills on the roof and of the void, the fall and its wrap,
a slow pan for the distant lamps' steadiness, the hatch. Headless Edge on the real GPU, the simulated service; nothing
touches the app's window.

    python araclar/salon_disari.py --paket C:/dev/kontrol-merkezi/.tmp/paket-on2 [--out DIR] [--yalniz kare,dusus,pan,kapak,zaman]
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
LOCK = Path('C:/dev/kontrol-merkezi/.tmp/pencere.lock')


def wait_lock():
    said = False
    while LOCK.exists():
        if not said:
            print('pencere.lock var: bekleniyor', flush=True)
            said = True
        time.sleep(20)


# still: name, (x, foot, z), yaw deg (0: -z, 90: +x), pitch deg
STILLS = [
    ('kapak_ust', (-1.5, 35.0, -334.0), 0, -14),        # standing by the hatch, looking at it and the mast
    ('cati_boyunca', (3.0, 35.0, -330.0), 180, -4),        # along the roof towards the far end (the lamp's pit)
    ('kuyu_lamba', (9.0, 35.0, -22.0), -125, -22),       # the roof's lamp close up
    ('kenar_disari', (44.0, 35.0, -170.0), 90, 2),       # at the edge, looking out at the void
    ('kenar_asagi', (46.5, 35.0, -120.0), 90, -55),      # over the edge, down along the columns
    ('ufuk_capraz', (40.0, 35.0, -330.0), 135, 0),       # the corner, diagonal into the void
    ('merdiven_yukari', (0.0, 30.0, -333.5), 0, 30),   # on the stair under the open hatch, looking up
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
    ap.add_argument('--paket', default='C:/dev/kontrol-merkezi/.tmp/paket-on2')
    ap.add_argument('--out', default=str(ROOT / '.tmp' / 'disari'))
    ap.add_argument('--yalniz', default='kare')
    ap.add_argument('--olcek', default='2')
    ap.add_argument('--w', type=int, default=2560)
    ap.add_argument('--h', type=int, default=1440)
    ap.add_argument('--js', default='', help='extra JS run once after load (tuning)')
    ap.add_argument('--varyant', default='', help='JSON list of fog settings: the stills once per setting')
    ap.add_argument('--kareler', default='', help='only these stills')
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
        if 'pan' in only:
            # a slow pan from the roof's edge: each distant lamp's peak luminance frame by frame (it must not blink)
            wait_lock()
            pg.evaluate(JS_PUT, [44.0, 35.0, -170.0, 60, 1, 5])
            frames = []
            for i in range(48):
                yaw = 60 + i * 0.05
                r = pg.evaluate("""(async ([yaw]) => { const km = window.__km, S = km.S, W = km.W; W.debug.look(yaw * Math.PI / 180, 1 * Math.PI / 180);
                    km.step(1/30); S.render(1/30, 1/30); await new Promise(r => requestAnimationFrame(r));
                    const lamps = km.V.facilities(W.state().eye).filter(f => !f.home).map(f => { const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
                      const p = [2.6, 53.17, -348], q = [0, -275.25, -171];
                      const rx = (v) => [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
                      const rq = rx(q), rp = rx(p); const off = [f.o[0] + q[0] - rq[0], f.o[1], f.o[2] + q[2] - rq[2]];
                      const w = [rp[0] + off[0], rp[1] + off[1], rp[2] + off[2]]; return [w, S.project(w)]; });
                    return lamps.filter(l => l[1].z > 0).map(l => [l[1].x, l[1].y, l[1].z]); })""", [yaw])
                pth = out / 'pan.png'
                pg.screenshot(path=str(pth))
                im = np.asarray(Image.open(pth).convert('L')).astype(np.float32)
                peaks = []
                for (x, y, z) in r:
                    xi, yi = int(round(x)), int(round(y))
                    if 6 <= xi < a.w - 6 and 6 <= yi < a.h - 6:
                        win = im[yi - 4:yi + 5, xi - 4:xi + 5]
                        peaks.append([round(z), float(win.max()), float(win.sum())])
                frames.append(peaks)
            # per lamp (by distance, the list order is stable): frame-to-frame relative change of the windowed sum
            res['pan'] = frames
            n = min(len(f) for f in frames) if frames else 0
            worst = []
            for k in range(n):
                sums = np.array([f[k][2] for f in frames]); pk = np.array([f[k][1] for f in frames])
                if sums.mean() < 1:
                    continue
                worst.append((frames[0][k][0], round(float(np.abs(np.diff(sums)).max() / max(1.0, sums.mean())), 4), round(float(pk.max() - pk.min()), 1)))
            worst.sort(key=lambda t: -t[1])
            print('pan: lamba (uzaklik m, toplamin kareden kareye en buyuk bagil degisimi, tepe araligi /255)', worst[:12], flush=True)
        (out / 'sonuc.json').write_text(json.dumps(res))
        b.close()
    httpd.shutdown()


if __name__ == '__main__':
    main()
