"""Stills of the hall from the real renderer (headless Edge, real GPU, the simulated service).

    python araclar/salon_kare.py [--out DIR] [--u 0,0.5,1] [--olcek 2] [--paket /sahne/paket/] [--w 2560 --h 1440]

Serves the repository over http on 127.0.0.1, opens ui/index.html with #still=<u> (the camera at that share of the
journey, the opening over, one frame), waits for it and saves a PNG and a 1600 px JPG per still, plus the renderer's
stats. The pack defaults to sahne/paket (salon.exe bake).
"""
import argparse
import functools
import http.server
import json
import os
import socketserver
import threading

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, '.tmp', 'kareler'))
    ap.add_argument('--u', default='0,0.5,1')
    ap.add_argument('--olcek', default='2')
    ap.add_argument('--paket', default='sahne/paket')
    ap.add_argument('--w', type=int, default=2560)
    ap.add_argument('--h', type=int, default=1440)
    ap.add_argument('--ek', default='', help='extra hash parameters, e.g. ev=0.5')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    import sys
    from pathlib import Path
    sys.path.insert(0, os.path.join(ROOT, 'sahne', 'araclar'))
    import salon_test                      # its server maps /sahne/ to the pack, as the window host does
    httpd, port = salon_test.serve(Path(ROOT, a.paket.strip('/')).resolve())
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True,
                              args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'])
        pg = b.new_page(viewport={'width': a.w, 'height': a.h}, device_scale_factor=1)
        logs = []
        pg.on('console', lambda m: print('  [sayfa] ' + m.type + ': ' + m.text[:300], flush=True))
        pg.on('response', lambda r: r.status >= 400 and print('  [404] ' + r.url, flush=True))
        pg.on('requestfailed', lambda r: print('  [istek basarisiz] ' + r.url + ' ' + str(r.failure), flush=True))
        pg.on('pageerror', lambda e: print('  [sayfa hatasi] ' + str(e)[:300], flush=True))
        for u in a.u.split(','):
            url = f'http://127.0.0.1:{port}/ui/index.html#paket=/sahne/&olcek={a.olcek}&still={u}' + ('&' + a.ek if a.ek else '')
            pg.goto(url)
            pg.wait_for_function("window.__km && ((window.__km.S && window.__km.S.ready) || document.body.classList.contains('nogl'))", timeout=600000)
            if pg.evaluate("document.body.classList.contains('nogl')"):
                print('yuklenemedi:', pg.evaluate("document.getElementById('fallback').textContent"))
                break
            stats = pg.evaluate(f'(async () => {{ const s = await window.__km.still({u}); await new Promise(r => requestAnimationFrame(r));'
                                f' const t = await window.__km.still({u}); return t || s; }})()')
            name = os.path.join(a.out, f'kare_u{u}')
            pg.screenshot(path=name + '.png')
            im = Image.open(name + '.png').convert('RGB')
            im.resize((1600, round(1600 * im.height / im.width)), Image.LANCZOS).save(name + '.jpg', quality=92)
            print(u, json.dumps(stats))
        b.close()
    httpd.shutdown()


if __name__ == '__main__':
    main()
