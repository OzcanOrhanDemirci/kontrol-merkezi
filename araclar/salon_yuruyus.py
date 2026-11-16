"""Walk mode (ui/yuruyus.js) in the real page: scripted walks against the hall's collision, and stills from walking
eye height (headless Edge, real GPU, the simulated service). Nothing touches the app's window.

    python araclar/salon_yuruyus.py [--paket C:/dev/kontrol-merkezi/sahne/paket] [--out DIR] [--yalniz yuru|kare]
                                    [--w 2560 --h 1440] [--olcek 2]

Writes yuruyus.json (every scenario's path, one row per frame: x, foot, z, vy, grounded) and a summary on stdout;
kare_<place>.png/.jpg for the stills.
"""
import argparse
import json
import math
import os
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LOCK = Path('C:/dev/kontrol-merkezi/.tmp/pencere.lock')   # the lead measures the real window: no GPU work meanwhile


def wait_lock():
    import time
    said = False
    while LOCK.exists():
        if not said:
            print('pencere.lock var: bekleniyor', flush=True)
            said = True
        time.sleep(30)

# scenarios: (name, start, frames of [keys, seconds]) with start = (x, foot, z, yaw_deg, pitch_deg[, vy]); yaw 0 looks
# along -z (towards the arch), 90 along +x
SCEN = [
    ('merdiven_in', (0, None, -2.6, 0, 0), [({'w': 1}, 9)]),
    ('merdiven_cik', (0, 0, -13.5, 180, 0), [({'w': 1}, 9)]),
    ('duvar_dik', (-8, 0, -16, -90, 0), [({'w': 1}, 4)]),
    ('duvar_kayarak', (-9, 0, -16, -60, 0), [({'w': 1, 'shift': 1}, 4)]),
    ('duvar_boyu', (-9, 0, -40, -135, 0), [({'w': 1, 'shift': 1}, 4)]),
    ('kose_ve_geri', (-9, 0, -3, -135, 0), [({'w': 1, 'shift': 1}, 3), ({'s': 1}, 2)]),
    ('merdiven_kosarak', (0, 0, -13.5, 180, 0), [({'w': 1, 'shift': 1}, 3.5)]),
    ('kolon_on', (-8, 0, -52, 0, 0), [({'w': 1, 'shift': 1}, 4)]),
    ('kolon_kayarak', (-6.5, 0, -52, -12, 0), [({'w': 1, 'shift': 1}, 6)]),
    ('kemer_kapi_altindan', (6.3, 0, -236, 0, 0), [({'w': 1, 'shift': 1}, 11)]),
    ('ziplama', (0, 0, -150, 0, 0), [({'jump': 1}, 1.6)]),
    ('dusus_24m', (0, 24, -150, 0, 0), [({}, 3.5)]),
    ('dusus_hizli', (0, 25, -150, 0, 0, -50), [({}, 1.5)]),
    ('dunya_disi', (100, 5, -100, 0, 0), [({}, 4.5)]),
    ('masa_hedef', (-1.6, None, -4.2, -27, -35), [({}, 0.5)]),
    ('kemer_rgb_kolu', (-3.7, 0, -238.6, 180 + 180, -38), [({}, 0.5)]),
]

STILLS = [
    # name, eye (x, foot, z), yaw, pitch
    ('zemin', (3.0, 0, -30), 0, -42),
    ('kolon_dibi', (-4.2, 0, -66), -70, -12),
    ('kolon_lamba', (-11.2, 0, -64), 90 + 60, -5),
    ('kemer_meydan', (5.0, 0, -238.0), -8, 6),
    ('plinth_basamak', (2.0, 0, -245.0), 0, -18),
    ('oda', (0.0, 1.2, -266.0), 0, 10),
    ('oda_cekirdek_yakin', (-4.5, 1.2, -281.0), 35, 8),
    ('sahanlik_masa', (-1.6, 3.0, -4.2), -27, -35),
    ('merdiven', (0.0, 0, -12.0), 180, 12),
    ('galeri_fan', (-6.0, 0, -28.0), -75, 12),
    ('galeri_kuyu_isigi', (2.0, 0, -27.0), 20, -30),
]

# the eye exactly d metres from a surface (camera set directly, no body): the haze/near-plane check near concrete.
# name, eye, look target
NEAR = []
for d in (0.3, 0.5, 1.0):
    # the inner column at x = -8, z = -80: its aisle face at x = -7
    NEAR.append((f'kolon_{d}_bakis', (-7 + d, 1.7, -76.0), (-7 + d - 3, 1.5, -80.0)))
    NEAR.append((f'kolon_{d}_boyunca', (-7 + d, 1.7, -74.0), (-7 + d, 1.6, -90.0)))
    # the hall's left wall x = -30 at z = -110 (between pilasters)
    NEAR.append((f'duvar_{d}_bakis', (-30 + d, 1.7, -110.0), (-30 + d - 3, 1.6, -111.0)))
    NEAR.append((f'duvar_{d}_boyunca', (-30 + d, 1.7, -105.0), (-30 + d, 1.6, -125.0)))

JS_RUN = r"""async (sc) => {
  const km = window.__km, W = km.W;
  const [name, st, seq] = sc;
  if (!W.active) W.enter({ noLock: true });
  const [x, foot, z, yaw, pitch, vy] = st;
  let f = foot;
  if (f === null) f = W.debug.groundAt(x, z, 10, -5);
  W.debug.put(x, f, z, vy || 0);
  W.debug.look(yaw * Math.PI / 180, pitch * Math.PI / 180);
  const rows = [];
  const dt = 1 / 30;
  for (const [k, sec] of seq) {
    const jump = !!k.jump; const kk = Object.assign({}, k); delete kk.jump;
    W.debug.keys(kk);
    for (let i = 0; i < Math.round(sec / dt); i++) {
      if (jump && i === 2) W.debug.jump();
      km.step(dt);
      const s = W.state();
      rows.push([+s.x.toFixed(3), +s.foot.toFixed(3), +s.z.toFixed(3), +s.vy.toFixed(2), s.grounded ? 1 : 0, +s.eye[1].toFixed(3)]);
    }
  }
  W.debug.keys({});
  return { name, rows, hover: W.state().hover };
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--paket', default='C:/dev/kontrol-merkezi/sahne/paket')
    ap.add_argument('--out', default=str(ROOT / '.tmp' / 'yuruyus'))
    ap.add_argument('--yalniz', default='')
    ap.add_argument('--olcek', default='2')
    ap.add_argument('--w', type=int, default=2560)
    ap.add_argument('--h', type=int, default=1440)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT / 'sahne' / 'araclar'))
    import salon_test
    httpd, port = salon_test.serve(Path(a.paket).resolve())
    wait_lock()
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True,
                              args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
        pg = b.new_page(viewport={'width': a.w, 'height': a.h}, device_scale_factor=1)
        pg.on('console', lambda m: m.type in ('error', 'warning') and print('  [sayfa] ' + m.type + ': ' + m.text[:300], flush=True))
        pg.on('pageerror', lambda e: print('  [sayfa hatasi] ' + str(e)[:300], flush=True))
        pg.goto(f'http://127.0.0.1:{port}/ui/index.html#paket=/sahne/&olcek={a.olcek}&still=0')
        pg.wait_for_function("window.__km && ((window.__km.S && window.__km.S.ready) || document.body.classList.contains('nogl'))", timeout=600000)
        pg.evaluate('(async () => { await window.__km.still(0, { settle: 6 }); })()')
        info = pg.evaluate('(async () => { const t = performance.now(); await window.__km.W.load(); return { waitMs: performance.now() - t, ...window.__km.W.stats() }; })()')
        print('carpisma:', json.dumps(info['load']), flush=True)
        res = {'load': info['load'], 'scen': []}
        if a.yalniz in ('', 'yuru'):
            pg.evaluate('window.__km.W.debug.resetTiming()')
            for sc in SCEN:
                r = pg.evaluate(JS_RUN, [sc[0], list(sc[1]), [[k, s] for k, s in sc[2]]])
                res['scen'].append(r)
                rows = r['rows']
                f = rows[-1]
                ymax = max(x[1] for x in rows); ymin = min(x[1] for x in rows); vmin = min(x[3] for x in rows)
                import statistics
                jit = statistics.pstdev([x[5] for x in rows[-30:]])
                print(f"{r['name']:22s} titreme={jit:.4f} son x={f[0]:8.3f} ayak={f[1]:7.3f} z={f[2]:9.3f} zeminde={f[4]} ayak[min,max]=[{ymin:.3f},{ymax:.3f}] vy_min={vmin:.1f} hedef={r['hover']}", flush=True)
            st = pg.evaluate('window.__km.W.stats()')
            print('adim maliyeti:', json.dumps(st), flush=True)
            res['stats'] = st
            (out / 'yuruyus.json').write_text(json.dumps(res))
        if a.yalniz in ('', 'yakin'):
            for name, eye, tgt in NEAR:
                wait_lock()
                pg.evaluate('(async ([e, t]) => { const km = window.__km; km.step(1/30); km.S.setCamera(e, t, 50); km.S.render(1/30, 1/30);'
                            ' await new Promise(r => requestAnimationFrame(r)); })', [list(eye), list(tgt)])
                pth = out / f'yakin_{name}.png'
                pg.screenshot(path=str(pth))
                im = Image.open(pth).convert('RGB')
                im.resize((1600, round(1600 * im.height / im.width)), Image.LANCZOS).save(pth.with_suffix('.jpg'), quality=92)
                print('yakin', name, flush=True)
        if a.yalniz in ('', 'kare'):
            only = [n for n in os.environ.get('KARE', '').split(',') if n]
            for name, (x, foot, z), yaw, pitch in STILLS:
                if only and name not in only:
                    continue
                wait_lock()
                pg.evaluate(JS_RUN, [name, [x, foot, z, yaw, pitch], [[{}, 1.0]]])
                pg.evaluate('(async () => { const km = window.__km; km.S.render(1/30, 1/30); await new Promise(r => requestAnimationFrame(r)); })()')
                pth = out / f'kare_{name}.png'
                pg.screenshot(path=str(pth))
                im = Image.open(pth).convert('RGB')
                im.resize((1600, round(1600 * im.height / im.width)), Image.LANCZOS).save(pth.with_suffix('.jpg'), quality=92)
                s = pg.evaluate('window.__km.W.state()')
                print('kare', name, 'goz', [round(v, 2) for v in s['eye']], flush=True)
        b.close()
    httpd.shutdown()


if __name__ == '__main__':
    main()
