"""The live renderer's checks in headless Edge on the real GPU (ui/salon/deneme.html against a pack).

    python sahne/araclar/salon_test.py kare        [--scale 2]          stills: view, rotor slow/fast, haze 0.15/1, rgb
    python sahne/araclar/salon_test.py zaman       [--scales 2,1.5,1]   GPU time per pass (timer queries) per scale
    python sahne/araclar/salon_test.py kararlilik  --tur kamera|pus     60 frames live + 4x-samples reference, then
                                                                        pc_graphics' tools/kararlilik.py on them
    python sahne/araclar/salon_test.py sunucu                           serve only (open the printed address)

The pack defaults to .tmp/sentetik (sahne/araclar/sentetik_paket.py); --paket sahne/paket for the oven's. The page is
served from the repository, the pack under /sahne/ of the same origin (as the window host does). Output: .tmp/salon/.
Nothing here touches the installed app or the service.
"""
import argparse
import functools
import http.server
import json
import math
import os
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.tmp' / 'salon'
KARARLILIK = Path('C:/dev/pc_graphics/tools/kararlilik.py')


class Handler(http.server.SimpleHTTPRequestHandler):
    pack = ROOT / '.tmp' / 'sentetik'

    def translate_path(self, path):
        p = unquote(urlsplit(path).path)
        if p.startswith('/sahne/'):
            base, rel = self.pack, p[len('/sahne/'):]
        else:
            base, rel = ROOT, p.lstrip('/')
        dest = (base / rel).resolve()
        return str(dest) if dest.is_relative_to(base.resolve()) else str(base / '__yok__')

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):
    def handle_error(self, request, client_address):
        pass                    # the browser closing a connection mid-file (a page that failed or closed)


def serve(pack):
    Handler.pack = pack
    httpd = Server(('127.0.0.1', 0), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def jpg(png, width=1600):
    im = Image.open(png).convert('RGB')
    im.resize((width, round(width * im.height / im.width)), Image.LANCZOS).save(png.with_suffix('.jpg'), quality=92)


class Page:
    def __init__(self, pw, port, w, h, scale):
        self.b = pw.chromium.launch(channel='msedge', headless=True,
                                    args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
        self.p = self.b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=1)
        self.logs = []
        self.p.on('console', lambda m: self.logs.append(m.type + ': ' + m.text))
        self.p.on('pageerror', lambda e: self.logs.append('pageerror: ' + str(e)))
        t0 = time.time()
        self.p.goto(f'http://127.0.0.1:{port}/ui/salon/deneme.html?scale={scale}#still', timeout=120000)
        self.p.wait_for_function('window.ready || window.failure', timeout=300000)
        fail = self.p.evaluate('window.failure || null')
        if fail:
            raise SystemExit('yuklenemedi: ' + fail + '\n' + '\n'.join(self.logs[-20:]))
        self.load_s = time.time() - t0
        self.gpu = self.p.evaluate("""(() => { const g = document.getElementById('gl').getContext('webgl2');
            const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; })()""")
        if '4080' not in self.gpu:
            raise SystemExit('beklenen RTX 4080 degil: ' + self.gpu)

    def ev(self, js, arg=None):
        return self.p.evaluate(js, arg)

    def shot(self, path):
        self.p.screenshot(path=str(path))

    def frames(self, n, set_js=None):
        """n frames paced by rAF (the GPU timer results need finished frames)."""
        return self.ev("""async ([n]) => { for (let i = 0; i < n; i++) { fixture.draw(3 + i / 33);
            await new Promise(r => requestAnimationFrame(r)); } await new Promise(r => setTimeout(r, 100));
            return salon.stats(); }""", [n])

    def close(self):
        self.b.close()


def cmd_kare(a, port, pw):
    out = OUT / 'kare'
    out.mkdir(parents=True, exist_ok=True)
    pg = Page(pw, port, a.w, a.h, a.scale)
    print('gpu', pg.gpu, 'yukleme', round(pg.load_s, 1), 's', flush=True)
    shots = [
        ('duragan', dict(mode='fanlar', revs=0, angle=0.3, strength=0.15), 1 / 33),
        ('rotor_yavas', dict(revs=0.3, angle=0.3, strength=0.15), 1 / 33),
        ('rotor_hizli', dict(revs=3.0, angle=0.3, strength=0.15), 1 / 55),
        ('pus_015', dict(revs=3.0, strength=0.15), 1 / 33),
        ('pus_1', dict(revs=3.0, strength=1.0), 1 / 33),
        ('yol_orta', dict(mode='yol', u=0.45, revs=0, strength=0.15), 1 / 33),
        ('rgb', dict(mode='rgb', revs=0, strength=0.15), 1 / 33),
        ('hover', dict(mode='fanlar', revs=0, strength=0.15, hover='git_rgb'), 1 / 33),
    ]
    rep = {'gpu': pg.gpu, 'yukleme_s': pg.load_s}
    for name, st, shutter in shots:
        pg.ev('(o) => fixture.set(o)', st)
        for i in range(8):
            stats = pg.ev('([t, s]) => fixture.draw(t, s)', [5.0, shutter])
        png = out / f'{name}_s{a.scale:g}.png'
        pg.shot(png)
        jpg(png)
        print(name, png.with_suffix('.jpg'), flush=True)
    pg.ev("(o) => fixture.set(o)", dict(mode='fanlar', revs=0, strength=0.15, hover=None))
    # a static camera with static haze renders the same image twice
    for i in range(30):
        pg.ev('() => fixture.draw(5)')
    a1 = pg.p.screenshot()
    pg.ev('() => fixture.draw(5)')
    a2 = pg.p.screenshot()
    rep['duragan_ayni'] = a1 == a2
    # picking: the fan's click box under its projected centre
    rep['secim'] = pg.ev("""(() => { const a = salon.anchors.fan_kasa, p = salon.project(a.kutu.merkez);
        return { nokta: p, isabet: salon.pick(p.x, p.y), bos: salon.pick(2100, 300) }; })()""")
    rep['stats'] = pg.frames(40)
    rep['log'] = pg.logs[-20:]
    (out / f'rapor_s{a.scale:g}.json').write_text(json.dumps(rep, indent=1, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(rep, indent=1, ensure_ascii=False))
    pg.close()


def measure(pg, q, fx, rounds=3, n=45):
    """GPU time per pass: the median over n frames, the lowest of a few rounds (the GPU is also the desk: another
    program's work between a timer query's begin and end counts in it, so single rounds can read high)."""
    best = None
    for r in range(rounds):
        pg.ev('(q) => salon.setQuality(q)', q)
        pg.ev('(o) => fixture.set(o)', fx)
        pg.frames(15)
        st = pg.frames(n)
        if best is None or (st['gpuMs'] or 1e9) < (best['gpuMs'] or 1e9):
            best = st
    return {'gpuMs': round(sum(best['passes'].values()), 3), 'passes': best['passes'], 'memoryMB': best['memoryMB'],
            'scene': best['scene']}


def cmd_zaman(a, port, pw):
    res = {}
    pg = Page(pw, port, a.w, a.h, 2)
    base = dict(scale=2, hazeScale=0.5, hazeStep=1, prepass=True, bands=6, cubic=True)
    fx = dict(mode='fanlar', revs=3.0, strength=1.0, animColour=False)
    for sc in [float(x) for x in a.scales.split(',')]:
        res[f'olcek_{sc:g}'] = measure(pg, dict(base, scale=sc), fx)
        print(f'olcek_{sc:g}', json.dumps(res[f'olcek_{sc:g}']), flush=True)
    for name, q in [('onkatman_yok', dict(prepass=False)), ('kubik_yok', dict(cubic=False)), ('pus_075', dict(hazeScale=0.75)),
                    ('pus_tam', dict(hazeScale=1.0)), ('pus_adim_05', dict(hazeStep=0.5))]:
        res[name] = measure(pg, dict(base, **q), fx)
        print(name, json.dumps(res[name]), flush=True)
    for mode in ['yol', 'rgb']:
        res['gorunum_' + mode] = measure(pg, base, dict(fx, mode=mode, u=0.45))
        print('gorunum_' + mode, json.dumps(res['gorunum_' + mode]), flush=True)
    res['renk_degisiyor'] = measure(pg, base, dict(fx, animColour=True))
    print('renk_degisiyor', json.dumps(res['renk_degisiyor']), flush=True)
    st = pg.ev('() => salon.stats()')
    res['compileMs'] = st['compileMs']
    res['yukleme_s'] = pg.load_s
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'zaman.json').write_text(json.dumps(res, indent=1), encoding='utf-8')
    pg.close()


def cmd_kararlilik(a, port, pw):
    folder = OUT / f'kararlilik_{a.tur}_s{a.scale:g}'
    folder.mkdir(parents=True, exist_ok=True)
    for f in folder.glob('*.png'):
        f.unlink()
    pg = Page(pw, port, a.w, a.h, a.scale)
    yaw = 0.25 * 2 * math.tan(math.radians(25)) / a.h          # 0.25 px per frame at the screen's centre
    for kind, q in [('live', dict(scale=a.scale, hazeScale=0.5, hazeStep=1)),
                    ('ref', dict(scale=a.scale * 2, hazeScale=1.0, hazeStep=0.5))]:
        pg.ev('(q) => salon.setQuality(q)', q)
        pg.ev('(o) => fixture.set(o)', dict(mode='fanlar', revs=0, angle=0.3, strength=0.15 if a.tur == 'kamera' else 1.0))
        for i in range(a.frames):
            pg.ev("""([i, yaw, tur]) => { const v = salon.views.fanlar, e = v.goz, t = v.hedef;
                const d = [t[0] - e[0], t[1] - e[1], t[2] - e[2]], a = tur === 'kamera' ? i * yaw : 0;
                const c = Math.cos(a), s = Math.sin(a);
                salon.setCamera(e, [e[0] + c * d[0] + s * d[2], e[1] + d[1], e[2] - s * d[0] + c * d[2]], v.fov);
                fixture.draw(tur === 'kamera' ? 5 : 5 + i / 33); }""", [i, yaw, a.tur])
            pg.shot(folder / f'{kind}_{i:04d}.png')
        print(kind, 'tamam', flush=True)
    pg.close()
    r = subprocess.run([sys.executable, str(KARARLILIK), str(folder), '--flip-her', '10'], capture_output=True, text=True)
    print(r.stdout[-3000:], r.stderr[-2000:])
    jpg(folder / 'live_0000.png')
    jpg(folder / 'ref_0000.png')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['kare', 'zaman', 'kararlilik', 'sunucu'])
    ap.add_argument('--paket', default=str(ROOT / '.tmp' / 'sentetik'))
    ap.add_argument('--scale', type=float, default=2)
    ap.add_argument('--scales', default='2,1.5,1')
    ap.add_argument('--tur', default='kamera', choices=['kamera', 'pus'])
    ap.add_argument('--frames', type=int, default=60)
    ap.add_argument('--w', type=int, default=2560)
    ap.add_argument('--h', type=int, default=1440)
    a = ap.parse_args()
    httpd, port = serve(Path(a.paket).resolve())
    if a.cmd == 'sunucu':
        print(f'http://127.0.0.1:{port}/ui/salon/deneme.html', flush=True)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        {'kare': cmd_kare, 'zaman': cmd_zaman, 'kararlilik': cmd_kararlilik}[a.cmd](a, port, pw)
    httpd.shutdown()


if __name__ == '__main__':
    main()
