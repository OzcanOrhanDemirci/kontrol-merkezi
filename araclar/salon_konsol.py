"""Stills of the RGB console (the plates before the arch) from the real renderer, headless Edge on the real GPU.

    python araclar/salon_konsol.py [--paket sahne/paket] [--out .tmp/konsol] [--on ONEK] [--olcek 2.5]

Per still a 2560 x 1440 PNG, and for the rgb view a crop of the console at full resolution (`*_kesit.png`):
  rgb_beyaz / rgb_mavi / rgb_sari / rgb_kirmizi   the rgb view, lights on, at the stops 52 / 58 / 64 / 80.5 C
  rgb_kapali                                      the rgb view, lights off (at 64 C)
  rgb_uzerinde                                    the rgb view with the pointer on the switch (hover)
  yakin, yakin_kapali                             the console filling the frame, on and off
  yakin_plaka                                     the switch's plate and a device plate close up
  yol_70, yol_85                                  from the journey (70 % and 85 % of the way), lights on
Also prints what a pick at the switch's and a device plate's centre returns (the click boxes).
"""
import argparse
import os
import sys
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sahne' / 'araclar'))
import salon_test  # noqa: E402  (its server maps /sahne/ to the pack, as the window host does)

STOPS = [('beyaz', 52), ('mavi', 58), ('sari', 64), ('kirmizi', 80.5)]
KESIT = (480, 1040, 2080, 1440)     # the console in the rgb view
LOCK = Path('C:/dev/kontrol-merkezi/.tmp/pencere.lock')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--paket', default='sahne/paket')
    ap.add_argument('--out', default=str(ROOT / '.tmp' / 'konsol'))
    ap.add_argument('--on', default='', help='a prefix for the file names (e.g. once_)')
    ap.add_argument('--olcek', default='2.5')
    ap.add_argument('--yalniz', default='', help='only the stills whose names contain this')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    while LOCK.exists():            # the lead's real-window measurement: no GPU work meanwhile (as salon_kipirti.py)
        print('  pencere.lock: bekleniyor', flush=True)
        time.sleep(30)
    httpd, port = salon_test.serve(Path(ROOT, a.paket.strip('/')).resolve())
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True,
                              args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
        pg = b.new_page(viewport={'width': 2560, 'height': 1440}, device_scale_factor=1)
        pg.on('console', lambda m: m.type in ('error', 'warning') and print('  [sayfa] ' + m.type + ': ' + m.text[:300], flush=True))
        pg.on('pageerror', lambda e: print('  [sayfa hatasi] ' + str(e)[:300], flush=True))
        pg.goto(f'http://127.0.0.1:{port}/ui/index.html#paket=/sahne/&olcek={a.olcek}&still=1')
        pg.wait_for_function("window.__km && ((window.__km.S && window.__km.S.ready) || document.body.classList.contains('nogl'))", timeout=600000)
        if pg.evaluate("document.body.classList.contains('nogl')"):
            print('yuklenemedi:', pg.evaluate("document.getElementById('fallback').textContent"))
            return

        def settle(u):
            # the smoothed colours settle, the worker redraws the plates, the strips upload: then the frame
            pg.evaluate(f'window.__km.still({u}, {{ settle: 8 }})')
            for _ in range(14):          # a redrawn texture goes up in strips of 4 MB a frame (the display is 16 MB)
                pg.wait_for_timeout(150)
                pg.evaluate(f'window.__km.still({u}, {{ settle: 0.2 }})')

        def shot(name, u=1, cam=None, crop=False):
            if a.yalniz and a.yalniz not in name:
                return
            settle(u)
            if cam:
                pg.evaluate(f'(() => {{ const S = window.__km.S; S.setCamera({cam[0]}, {cam[1]}, {cam[2]}); S.render(1 / 60, 1 / 60); }})()')
            path = os.path.join(a.out, a.on + name + '.png')
            pg.screenshot(path=path)
            if crop:
                Image.open(path).convert('RGB').crop(KESIT).save(os.path.join(a.out, a.on + name + '_kesit.png'))
            print(name, flush=True)

        def state(temp, on):
            pg.evaluate(f"(() => {{ const s = window.__km.sim; s.temp({temp}); if (s.S.rgb !== {str(on).lower()}) s.send({{ komut: 'rgb', acik: {str(on).lower()} }}); }})()")
            pg.wait_for_timeout(600)

        yakin = ('[0, 2.1, -231.5]', '[0, 1.25, -240.6]', 50)
        plaka = ('[-0.6, 1.75, -236.4]', '[-0.6, 1.2, -240.6]', 50)
        for name, c in STOPS:
            state(c, True)
            shot('rgb_' + name, crop=True)
            if name in ('mavi', 'kirmizi'):
                shot('yakin_' + name, cam=yakin)
        state(64, True)
        shot('yakin', cam=yakin)
        shot('yakin_plaka', cam=plaka)
        shot('yol_70', u=0.7)
        shot('yol_85', u=0.85)
        # the click boxes, and the hover's lift
        settle(1)
        for anchor in ('plaka_rgb', 'cihaz_gpu'):
            print('pick', anchor, pg.evaluate(
                f"(() => {{ const S = window.__km.S, q = S.project(S.anchors['{anchor}'].kutu.merkez); return [Math.round(q.x), Math.round(q.y), S.pick(q.x, q.y)]; }})()"))
        pg.evaluate("(() => { const k = window.__km; k.M.hover = 'anahtar_rgb'; k.S.setHover('anahtar_rgb'); })()")
        shot('rgb_uzerinde', crop=True)
        pg.evaluate("(() => { const k = window.__km; k.M.hover = null; k.S.setHover(null); })()")
        state(64, False)
        shot('rgb_kapali', crop=True)
        shot('yakin_kapali', cam=yakin)
        shot('yol_85_kapali', u=0.85)
        b.close()
    httpd.shutdown()


if __name__ == '__main__':
    main()
