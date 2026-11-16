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
    ap.add_argument('--paket', default='/sahne/paket/')
    ap.add_argument('--w', type=int, default=2560)
    ap.add_argument('--h', type=int, default=1440)
    ap.add_argument('--ek', default='', help='extra hash parameters, e.g. ev=0.5')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    handler = functools.partial(Quiet, directory=ROOT)
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True,
                              args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'])
        pg = b.new_page(viewport={'width': a.w, 'height': a.h}, device_scale_factor=1)
        logs = []
        pg.on('console', lambda m: logs.append(m.type + ': ' + m.text))
        for u in a.u.split(','):
            url = f'http://127.0.0.1:{port}/ui/index.html#paket={a.paket}&olcek={a.olcek}&still={u}' + ('&' + a.ek if a.ek else '')
            pg.goto(url)
            pg.wait_for_function('window.__km && window.__km.S && window.__km.S.ready', timeout=600000)
            stats = pg.evaluate(f'(async () => {{ const s = await window.__km.still({u}); await new Promise(r => requestAnimationFrame(r));'
                                f' const t = await window.__km.still({u}); return t || s; }})()')
            name = os.path.join(a.out, f'kare_u{u}')
            pg.screenshot(path=name + '.png')
            im = Image.open(name + '.png').convert('RGB')
            im.resize((1600, round(1600 * im.height / im.width)), Image.LANCZOS).save(name + '.jpg', quality=92)
            print(u, json.dumps(stats))
        for l in logs[-30:]:
            print(l)
        b.close()
    httpd.shutdown()


if __name__ == '__main__':
    main()
