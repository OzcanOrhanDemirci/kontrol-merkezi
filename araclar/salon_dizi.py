"""A frame sequence of the hall from the real renderer (headless Edge, real GPU, simulated service), for looking at
motion frame by frame and measuring it: blinking of small lights, bursts, swimming.

    python araclar/salon_dizi.py --u0 0.85 --u1 1.0 --n 90 [--out DIR] [--olcek 2] [--ek "k1=12"] [--dt 0.0333]
                                 [--w 2560 --h 1440] [--paket sahne/paket] [--jpg]

Loads the page once, then for frame i puts the camera at u0 + (u1 - u0) * i / (n - 1) of the journey and renders one
frame with dt (the haze's clock and the scene's time advance as in the window), saving fNNN.png. Writes stats.json
(per frame: u, mean luminance of the lower half and the whole frame, the renderer's stats).
"""
import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, '.tmp', 'dizi'))
    ap.add_argument('--u0', type=float, required=True)
    ap.add_argument('--u1', type=float, required=True)
    ap.add_argument('--n', type=int, default=60)
    ap.add_argument('--dt', type=float, default=1 / 30)
    ap.add_argument('--olcek', default='2')
    ap.add_argument('--paket', default='sahne/paket')
    ap.add_argument('--w', type=int, default=2560)
    ap.add_argument('--h', type=int, default=1440)
    ap.add_argument('--ek', default='')
    ap.add_argument('--sicaklik', type=float, default=None)
    ap.add_argument('--jpg', action='store_true', help='also a 1280 px JPG per frame')
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, os.path.join(ROOT, 'sahne', 'araclar'))
    import salon_test
    httpd, port = salon_test.serve(Path(ROOT, a.paket.strip('/')).resolve())
    rows = []
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True,
                              args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
        pg = b.new_page(viewport={'width': a.w, 'height': a.h}, device_scale_factor=1)
        pg.on('pageerror', lambda e: print('  [sayfa hatasi] ' + str(e)[:300], flush=True))
        url = f'http://127.0.0.1:{port}/ui/index.html#paket=/sahne/&olcek={a.olcek}&still={a.u0}' + ('&' + a.ek if a.ek else '')
        pg.goto(url)
        pg.wait_for_function("window.__km && ((window.__km.S && window.__km.S.ready) || document.body.classList.contains('nogl'))", timeout=600000)
        if a.sicaklik is not None:
            pg.evaluate(f'window.__km.sim.temp({a.sicaklik})')
            pg.wait_for_timeout(1500)
        pg.evaluate(f'(async () => {{ await window.__km.still({a.u0}, {{ settle: 6 }}); }})()')
        for i in range(a.n):
            u = a.u0 + (a.u1 - a.u0) * i / max(1, a.n - 1)
            st = pg.evaluate(f'(async () => {{ const s = await window.__km.still({u}, {{ dt: {a.dt}, shutter: {a.dt} }});'
                             f' await new Promise(r => requestAnimationFrame(r)); return s; }})()')
            f = out / f'f{i:03d}.png'
            pg.screenshot(path=str(f))
            im = np.asarray(Image.open(f).convert('RGB'), dtype=np.float32) / 255
            L = im @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
            rows.append({'i': i, 'u': u, 'lum': float(L.mean()), 'lumLow': float(L[a.h // 2:].mean()),
                         'gpuMs': st.get('gpuMs') if st else None})
            if a.jpg:
                Image.open(f).convert('RGB').resize((1280, 720), Image.LANCZOS).save(out / f'f{i:03d}.jpg', quality=90)
            print(i, f'{u:.4f}', f"{rows[-1]['lum']:.4f}", f"{rows[-1]['lumLow']:.4f}", flush=True)
        b.close()
    httpd.shutdown()
    (out / 'stats.json').write_text(json.dumps(rows, indent=1))


if __name__ == '__main__':
    main()
