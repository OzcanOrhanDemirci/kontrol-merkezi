"""Runs araclar/salon_tur.js (Phase 2's whole loop, walked through walk mode's own physics) in the page: headless Edge
on the real GPU with the simulated service, or the real window over CDP (start the window with
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS containing --remote-debugging-port=PORT; salon-denetim.ps1 -Bolum tur does).

    python araclar/salon_tur.py [--cdp 9229] [--paket DIR] [--out DIR] [--kareler] [--yonlu]

Writes tur.json (the steps' log, the path every 0.1 s, where it got stuck) and, headless with --kareler, a still at
each step that has a name.
"""
import argparse
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FROM = None
STEER = False
JS = (ROOT / 'araclar' / 'salon_tur.js').read_text(encoding='utf-8')


def run(pg, out, stills):
    pg.evaluate('(async () => { await window.__km.W.load(); })()')
    if not pg.evaluate('!!window.__km.W.ready'):
        print('yürüyüş çarpışması yüklenmedi', flush=True)
    if FROM:
        pg.evaluate('f => { window.__turFrom = f; }', FROM)
    if STEER:
        pg.evaluate('window.__turSteer = true')
    pg.evaluate(JS)
    seen = 0
    t0 = time.time()
    while True:
        time.sleep(0.25)
        st = pg.evaluate('({ done: window.__tur.done, n: window.__tur.log.length, log: window.__tur.log.slice(%d) })' % seen)
        for e in st['log']:
            print(f"  {e['t']:7.2f}s  {e['m']:<28} x {e['x']:7.2f} ayak {e['foot']:8.2f} z {e['z']:8.2f}", flush=True)
            if stills:
                pg.screenshot(path=str(out / f"tur_{seen:02d}.jpg"), type='jpeg', quality=85)
            seen += 1
        if st['done'] or time.time() - t0 > 600:
            break
    res = pg.evaluate('({ log: window.__tur.log, path: window.__tur.path, stuck: window.__tur.stuck })')
    (out / 'tur.json').write_text(json.dumps(res), encoding='utf-8')
    print('takılma:', len(res['stuck']), json.dumps(res['stuck']), flush=True)
    feet = [p[2] for p in res['path']]
    print('en alçak ayak (sarma dahil):', min(feet), 'süre', res['path'][-1][0], flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cdp', type=int, default=0)
    ap.add_argument('--paket', default=str(ROOT / 'sahne' / 'paket'))
    ap.add_argument('--out', default=str(ROOT / '.tmp' / 'tur'))
    ap.add_argument('--kareler', action='store_true')
    ap.add_argument('--olcek', default='2.5')
    ap.add_argument('--yonlu', action='store_true', help='steer the fall outward (Shift+W) to the next facility')
    ap.add_argument('--bas', default='', help='JSON [step, x, foot, z]: start there (tests)')
    a = ap.parse_args()
    global FROM, STEER
    STEER = a.yonlu
    if a.bas:
        v = json.loads(a.bas); FROM = {'i': v[0], 'put': v[1:] or None}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        if a.cdp:
            b = p.chromium.connect_over_cdp(f'http://127.0.0.1:{a.cdp}')
            pg = next(pg for c in b.contexts for pg in c.pages if 'index.html' in pg.url)
            # the journey to the arch first (Tab), as the window's own RGB tab does
            pg.evaluate("window.__km.go && window.__km.go('rgb')")
            time.sleep(9)
            run(pg, out, False)
            b.close()
        else:
            sys.path.insert(0, str(ROOT / 'sahne' / 'araclar'))
            import salon_test
            httpd, port = salon_test.serve(Path(a.paket).resolve())
            b = p.chromium.launch(channel='msedge', headless=True, args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
            pg = b.new_page(viewport={'width': 1280, 'height': 720}, device_scale_factor=1)
            pg.on('pageerror', lambda e: print('  [sayfa hatasi] ' + str(e)[:400], flush=True))
            pg.goto(f'http://127.0.0.1:{port}/ui/index.html#paket=/sahne/&olcek={a.olcek}')
            pg.wait_for_function("window.__km && window.__km.S && window.__km.S.ready", timeout=600000)
            time.sleep(6)
            pg.evaluate("window.__km.go && window.__km.go('rgb')")
            time.sleep(12)
            run(pg, out, a.kareler)
            b.close()


if __name__ == '__main__':
    main()
