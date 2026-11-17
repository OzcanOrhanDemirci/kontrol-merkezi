"""The loading screen's pictures (ui/acilis/), made from the scene itself. Run again after every bake or change to the
scene's first view:

    python araclar/acilis_kareler.py [--paket sahne/paket] [--kalite 92] [--out .tmp/acilis-kareler]

The loading screen (ui/acilis.js) is the hall in the dark whose lighting circuits strike one by one, front to back;
its last picture has to be the live scene's first frame to the pixel, so the pictures are that frame:

1. The real page is opened in headless Edge on the real GPU at 2560x1440 with #ilk, which holds the scene's first
   frame (ui/uygulama.js): service lamps on, shaft and arch not yet struck, displays dark, the eye undrifted. That
   frame is the last picture. Nothing in it depends on the service's state or the temperature.
2. The same frame is drawn again with the service lamps at an ember (EMBER of their strength): the first picture,
   which the window also paints before the page exists (src/Pencere/Acilis.cs reads ui/acilis/taban.jpg).
3. The light between the two is split into CIRCUITS by where it falls: the surfaces by their world z (the mesh
   rasterised from the same eye, araclar/acilis/derinlik.html) in bands around each row of lamps, the haze's share
   (the difference the frames without haze leave) spread softly. The gallery's band is cut in two, left and right.
4. Each circuit's picture is the frame as it stands once that circuit and all before it are on, cropped to where the
   circuit changes it: laid over the earlier ones it needs only opacity. With the last one on, the stack is frame 1.

Writes ui/acilis/taban.jpg, d00..dNN.jpg and katman.js (the crops' places), prints their bytes and how far the decoded
stack is from the live frame. The frames it worked from are left in --out for a look.
"""
import argparse
import base64
import io
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright
from scipy.ndimage import gaussian_filter, zoom

ROOT = Path(__file__).resolve().parents[1]
W, H = 2560, 1440
EMBER = 0.06
# the lamp rows along the hall (world z, metres; docs/SALON.md): the landing, the gallery, the nine column rows, the
# far end. EDGES are the borders between neighbouring rows' light
EDGES = [-12, -50] + [-70 - 20 * i for i in range(9)]
# the circuits, front to back: (name, rows it takes, side of the frame: 0 all, -1 left, +1 right)
CIRCUITS = [('sahanlik', [0], 0), ('galeri-sol', [1], -1), ('galeri-sag', [1], 1), ('sira-1', [2], 0), ('sira-2', [3], 0),
            ('sira-3', [4], 0), ('sira-4', [5], 0), ('sira-5', [6], 0), ('sira-6-7', [7, 8], 0), ('dip', [9, 10, 11], 0)]


def pack_dir(arg):
    if arg:
        return Path(arg).resolve()
    p = ROOT / 'sahne' / 'paket'
    if not (p / 'sahne.json').exists() and '.claude' in ROOT.parts:      # a worktree: the pack is in the main folder
        p = Path(*ROOT.parts[:ROOT.parts.index('.claude')]) / 'sahne' / 'paket'
    return p


def shot(pg):
    return np.asarray(Image.open(io.BytesIO(pg.screenshot())).convert('RGB')).astype(np.float32)


def frames(pack, olcek):
    """The live first frame, its ember, both again without haze, and the world z under each pixel."""
    sys.path.insert(0, str(ROOT / 'sahne' / 'araclar'))
    import salon_test
    httpd, port = salon_test.serve(pack)
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True, args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
        pg = b.new_page(viewport={'width': W, 'height': H}, device_scale_factor=1)
        pg.on('pageerror', lambda e: print('  [sayfa hatasi] ' + str(e)[:300], flush=True))
        pg.goto(f'http://127.0.0.1:{port}/ui/index.html#paket=/sahne/&ilk=1' + (f'&olcek={olcek}' if olcek else ''))
        pg.wait_for_function("window.__km && (window.__km.ilk || document.body.classList.contains('nogl'))", timeout=600000)
        if pg.evaluate("document.body.classList.contains('nogl')"):
            raise SystemExit('sahne yüklenemedi: ' + pg.evaluate("document.getElementById('fallback').textContent"))
        pg.wait_for_timeout(300)
        out['son'] = shot(pg)                              # the frame the window shows at the hand-over, as it came
        # the same state drawn again through the app's own step (no time passes), its lights and camera noted
        state = pg.evaluate("""() => { const km = window.__km, S = km.S, r = {};
          const sg = S.setGroup.bind(S), sc = S.setCamera.bind(S);
          S.setGroup = (i, c, k) => { r['g' + i] = [Array.from(c), k]; sg(i, c, k); };
          S.setCamera = (e, t, f) => { r.cam = [Array.from(e), Array.from(t), f]; sc(e, t, f); };
          km.step(0); S.setGroup = sg; S.setCamera = sc; window.__sg = sg; return r; }""")
        draw = "(() => { const S = window.__km.S; for (let i = 0; i < 3; i++) S.render(0, 1 / 60); })()"
        settle = "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"
        def render(k, haze):
            pg.evaluate(f"(() => {{ const g = {json.dumps(state['g2'])}; window.__sg(2, g[0], g[1] * {k}); " +
                        ("" if haze else "window.__km.S.setHaze({ density: 0, fans: [] }); ") + "})()")
            pg.evaluate(draw); pg.evaluate(settle)
            return shot(pg)
        again = render(1, True)
        d = np.abs(again - out['son'])
        print(f'  the first frame drawn again: max difference {d.max():.0f}, mean {d.mean():.4f}')
        if d.max() > 3:
            raise SystemExit('the first frame does not redraw the same: the pictures would not match the scene')
        out['kor'] = render(EMBER, True)
        out['kor_pussuz'] = render(EMBER, False)
        out['son_pussuz'] = render(1, False)
        if state['g0'][1] or state['g1'][1]:
            raise SystemExit('the shaft or the arch is lit in the first frame: its colour would be in the pictures')
        pg.goto(f'http://127.0.0.1:{port}/araclar/acilis/derinlik.html')
        pg.wait_for_function('window.ready || window.failure', timeout=300000)
        if pg.evaluate('window.failure'):
            raise SystemExit('derinlik: ' + pg.evaluate('window.failure'))
        url = pg.evaluate(f'draw({W}, {H}, {json.dumps(state["cam"][0])}, {json.dumps(state["cam"][1])}, {state["cam"][2]})')
        a = np.asarray(Image.open(io.BytesIO(base64.b64decode(url.split(',')[1]))).convert('RGB')).astype(np.float64)
        out['z'] = ((a[..., 0] * 65536 + a[..., 1] * 256 + a[..., 2]) / 16777215 * 420 - 400).astype(np.float32)
        out['cam'] = state['cam']
        b.close()
    httpd.shutdown()
    return out


def soft(mask, sigma):
    """A wide blur at an eighth of the size (the haze's share needs no detail)."""
    if sigma < 12:
        return gaussian_filter(mask, sigma)
    small = gaussian_filter(mask[::8, ::8], sigma / 8)
    return zoom(small, 8, order=1)[:mask.shape[0], :mask.shape[1]]


def circuits(f):
    """The light between ember and frame, split: a list of (name, float image) whose sum is exactly son - kor."""
    z = f['z']
    sig = lambda x: 1 / (1 + np.exp(-np.clip(x / 1.5, -40, 40)))
    cum = [np.ones_like(z)] + [sig(e - z) for e in EDGES] + [np.zeros_like(z)]
    rows = [cum[i] - cum[i + 1] for i in range(len(EDGES) + 1)]            # a partition of unity along z
    left = (1 / (1 + np.exp((np.arange(W, dtype=np.float32) - W / 2) / 90)))[None, :]
    total = f['son'] - f['kor']
    surface = np.clip(f['son_pussuz'] - f['kor_pussuz'], 0, None)           # the lamps' light on the surfaces
    parts = []
    for name, take, side in CIRCUITS:
        w = sum(rows[i] for i in take) * (left if side < 0 else 1 - left if side > 0 else 1)
        parts.append((name, w))
    sharp = [soft(w, 5)[..., None] for _, w in parts]
    wide = [soft(w, 160)[..., None] for _, w in parts]
    wsum = np.maximum(sum(wide), 1e-4)
    lit = [surface * m for m in sharp]
    air = np.clip(total - sum(lit), 0, None)                               # what the haze adds
    layers = [lit[i] + air * wide[i] / wsum for i in range(len(parts))]
    rest = total - sum(layers)                                             # what is left (small): to the gallery
    for i, (name, _) in enumerate(parts):
        if name.startswith('galeri'):
            layers[i] = layers[i] + rest * (left if name.endswith('sol') else 1 - left)[..., None]
    return [(parts[i][0], layers[i]) for i in range(len(parts))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--paket', default='')
    ap.add_argument('--olcek', default='', help="the renderer's supersampling; default: the app's own")
    ap.add_argument('--kalite', type=int, default=92)
    ap.add_argument('--out', default=str(ROOT / '.tmp' / 'acilis-kareler'))
    a = ap.parse_args()
    t0 = time.time()
    pack = pack_dir(a.paket)
    print('paket:', pack)
    f = frames(pack, a.olcek)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    for k in ('son', 'kor', 'son_pussuz', 'kor_pussuz'):
        Image.fromarray(f[k].astype(np.uint8)).save(out / (k + '.png'))
    dst = ROOT / 'ui' / 'acilis'; dst.mkdir(exist_ok=True)
    for old in list(dst.glob('d[0-9][0-9].jpg')) + [dst / 'taban.jpg']:
        old.unlink(missing_ok=True)
    save = lambda im, name: Image.fromarray(np.clip(im + 0.5, 0, 255).astype(np.uint8)).save(dst / name, quality=a.kalite, subsampling=0, optimize=True)
    save(f['kor'], 'taban.jpg')
    acc = f['kor'].copy(); meta = []
    stack = np.asarray(Image.open(dst / 'taban.jpg').convert('RGB')).astype(np.float32)
    parts = circuits(f)
    # where each circuit shows (its light above one level, padded); the faint rest of it outside that box goes to the
    # gallery's two circuits, which are cut down the middle and so cover the frame: the stack stays exact everywhere
    boxes = []
    left = (1 / (1 + np.exp((np.arange(W, dtype=np.float32) - W / 2) / 90)))[None, :, None]
    for i, (name, layer) in enumerate(parts):
        ys, xs = np.where(np.abs(layer).max(axis=2) > 1.0)
        pad = 24
        x0, y0 = max(0, xs.min() - pad) // 8 * 8, max(0, ys.min() - pad) // 8 * 8
        x1, y1 = min(W, xs.max() + pad), min(H, ys.max() + pad)
        if name == 'sahanlik' or x1 - x0 > W * 0.9: x0, x1 = 0, W
        if name == 'sahanlik' or y1 - y0 > H * 0.9: y0, y1 = 0, H
        if name == 'galeri-sol': x0, y0, y1 = 0, 0, H
        if name == 'galeri-sag': x1, y0, y1 = W, 0, H
        boxes.append((x0, y0, x1, y1))
    gl, gr = [i for i, (n, _) in enumerate(parts) if n == 'galeri-sol'][0], [i for i, (n, _) in enumerate(parts) if n == 'galeri-sag'][0]
    lx1, rx0 = boxes[gl][2], boxes[gr][0]
    share = np.clip((rx0 + lx1) / 2 - np.arange(W, dtype=np.float32), -0.5, 0.5)[None, :, None] + 0.5 if lx1 > rx0 else left
    for i, (name, layer) in enumerate(parts):
        if i in (gl, gr): continue
        x0, y0, x1, y1 = boxes[i]
        outside = layer.copy(); outside[y0:y1, x0:x1] = 0
        layer[...] = layer - outside
        # (the gallery strikes before every circuit behind it, so that light is a little early, never missing)
        if i > gr:
            parts[gl][1][...] += outside * share; parts[gr][1][...] += outside * (1 - share)
        else:
            parts[i + 1 if i + 1 != gl else gl][1][...] += outside
    # the two gallery pictures overlap in the middle; each must hold all of its own light inside its box
    for i, j in ((gl, gr), (gr, gl)):
        x0, y0, x1, y1 = boxes[i]
        outside = parts[i][1].copy(); outside[y0:y1, x0:x1] = 0
        parts[i][1][...] -= outside; parts[j][1][...] += outside
    for i, (name, layer) in enumerate(parts):
        acc = acc + layer
        x0, y0, x1, y1 = boxes[i]
        fn = f'd{i:02d}.jpg'
        save(acc[y0:y1, x0:x1], fn)
        stack[y0:y1, x0:x1] = np.asarray(Image.open(dst / fn).convert('RGB')).astype(np.float32)
        meta.append([fn, int(x0), int(y0), int(x1 - x0), int(y1 - y0), name])
    js = ('// Made by araclar/acilis_kareler.py: the loading screen\'s circuits, front to back. Each: file, x, y, width,\n'
          '// height in the frame, name. A circuit\'s picture is the frame once it and all before it are on.\n'
          f'window.KM_ACILIS_KATMAN = {{ w: {W}, h: {H}, d: [\n' + ''.join('  ' + json.dumps(m) + ',\n' for m in meta) + '] };\n')
    (dst / 'katman.js').write_text(js, encoding='utf-8', newline='\n')
    Image.fromarray(stack.astype(np.uint8)).save(out / 'yigin.png')
    err = np.abs(stack - f['son'])
    print(f'the exact stack against the live frame: max {np.abs(acc - f["son"]).max():.3f}')
    print(f'the shipped (decoded JPEG) stack against the live frame: mean {err.mean():.3f}, 99.9 % under {np.percentile(err, 99.9):.1f}, max {err.max():.0f} (of 255)')
    Image.fromarray(np.clip(err * 16, 0, 255).astype(np.uint8)).save(out / 'fark_x16.png')
    total = 0
    for p in sorted(dst.glob('*.jpg')):
        total += p.stat().st_size
        print(f'  {p.name:10s} {p.stat().st_size:8d}')
    print(f'{len(meta) + 1} pictures, {total} bytes, {time.time() - t0:.0f} s; camera {json.dumps(f["cam"])}')


if __name__ == '__main__':
    main()
