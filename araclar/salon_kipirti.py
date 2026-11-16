"""Steadiness of the hall in slow motion: the real renderer (headless Edge, real GPU) on a controlled camera move,
live (scale 2) against a reference (scale 4), the same moments, the world frozen (or only its clock running).

    python araclar/salon_kipirti.py --gorunum fanlar --hareket pan --px 0.5 --n 48 [--olcek 2 --ref 4]
                                    [--paket C:/dev/kontrol-merkezi/sahne/paket] [--out DIR] [--etiket once]

--gorunum: fanlar | rgb | yol:<i> (the journey's i-th point, looking 3 points ahead) | goz=x,y,z;hedef=x,y,z
--hareket: pan (yaw, --px display pixels per frame at the centre), dolly (forward, --m metres per frame),
           zaman (camera still, the scene's clock advancing by --dt: haze and the arch's heat shimmer)
Writes live_NNN.png / ref_NNN.png, olcu.json and crops (kirp_*.png: per lamp, frames side by side, zoomed x8).

Measures (as pc_graphics tools/kararlilik.py and titreme.py; luminance = Rec.709 luma of the 8-bit sRGB values / 255):
  excess change   e_t = (L_t - L_t-1) - (R_t - R_t-1): mean, p99, p99.9, and on 8x8 block means
  second diff     mean |L_t+1 - 2 L_t + L_t-1| live over reference (smooth motion cancels, blinking does not)
  lamps           per lamp lens on screen (cam_lamba, from geo.bin): the peak luma and the linear energy in a 9 px
                  window round its projected centre, over time; blink = mean |second difference| of the peak, and the
                  energy's relative frame-to-frame variation, live and reference
"""
import argparse
import json
import math
import os
import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def lamp_centres(paket):
    """Centres of the cam_lamba (floor uplights and small lenses) clusters, from the pack's geometry."""
    p = json.loads(Path(paket, 'sahne.json').read_text(encoding='utf-8'))
    lens = [i for i, m in enumerate(p['malzemeler']) if 'emissive' in (m.get('bayrak') or []) and m.get('grup') == 2]
    b = zlib.decompress(Path(paket, p['geometri']['dosya']).read_bytes())
    nv, ni = np.frombuffer(b[4:12], np.uint32)
    V = np.frombuffer(b[16:16 + nv * 40], np.float32).reshape(nv, 10)[:, :3]
    I = np.frombuffer(b[16 + nv * 40:16 + nv * 40 + ni * 4], np.uint32)
    out = []
    for r in p['geometri']['araliklar']:
        if r['malzeme'] not in lens:
            continue
        c = V[I[r['ilk']:r['ilk'] + r['sayi']]].reshape(-1, 3, 3).mean(1)
        groups = []                      # greedy: a triangle joins the first cluster within 0.8 m
        for q in c:
            for gq in groups:
                if np.linalg.norm(gq[0] / gq[1] - q) < 0.8:
                    gq[0] += q; gq[1] += 1; break
            else:
                groups.append([q.astype(np.float64).copy(), 1])
        out += [(gq[0] / gq[1]).tolist() for gq in groups]
    return out


def luma8(path):
    a = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32) / 255
    return a @ np.array([0.2126, 0.7152, 0.0722], np.float32), a


def lin(a):
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


LOCK = Path('C:/dev/kontrol-merkezi/.tmp/pencere.lock')   # the lead's real-window measurement: no GPU work meanwhile


def wait_lock():
    import time
    while LOCK.exists():
        print('  pencere.lock: bekleniyor', flush=True)
        time.sleep(30)


def run(a, scale, prefix, out, lamps, port):
    wait_lock()
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True,
                              args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
        pg = b.new_page(viewport={'width': a.w, 'height': a.h}, device_scale_factor=1)
        pg.on('pageerror', lambda e: print('  [sayfa hatasi] ' + str(e)[:300], flush=True))
        pg.on('console', lambda m: m.type == 'error' and print('  [konsol] ' + m.text[:300], flush=True))
        u0 = 1 if a.gorunum == 'rgb' else 0
        pg.goto(f'http://127.0.0.1:{port}/ui/index.html#paket=/sahne/&olcek={scale}&still={u0}' + ('&' + a.ek if a.ek else ''))
        pg.wait_for_function("window.__km && ((window.__km.S && window.__km.S.ready) || document.body.classList.contains('nogl'))", timeout=600000)
        pg.evaluate(f'(async () => {{ await window.__km.still({u0}, {{ settle: 6 }}); }})()')
        pg.evaluate('window.__lamps = ' + json.dumps(lamps))
        g = a.gorunum
        pg.evaluate("""([g, mode, px, m, dt, n, heat]) => {
          const S = window.__km.S, V = S.views;
          let eye, tgt, fov = 50;
          if (g === 'fanlar' || g === 'rgb') { eye = V[g].goz; tgt = V[g].hedef; fov = V[g].fov || 50; }
          else if (g.startsWith('yol:')) { const i = +g.slice(4); eye = V.yol[i]; tgt = V.yol[Math.min(V.yol.length - 1, i + 3)]; }
          else { const q = Object.fromEntries(g.split(';').map(s => s.split('='))); eye = q.goz.split(',').map(Number); tgt = q.hedef.split(',').map(Number); }
          const d = [tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]], L = Math.hypot(...d);
          const dir = d.map(x => x / L);
          const H = S.stats().size[1];
          const dth = px * 2 * Math.tan(fov * Math.PI / 360) / H;
          const t0 = 100;
          window.__pose = i => {
            let e = eye.slice(), f = dir.slice();
            if (mode === 'pan') { const a = (i - n / 2) * dth, c = Math.cos(a), s = Math.sin(a); f = [c * dir[0] + s * dir[2], dir[1], -s * dir[0] + c * dir[2]]; }
            if (mode === 'dolly') { const h = Math.hypot(dir[0], dir[2]); e = [eye[0] + dir[0] / h * m * i, eye[1], eye[2] + dir[2] / h * m * i]; }
            S.setCamera(e, [e[0] + f[0] * 10, e[1] + f[1] * 10, e[2] + f[2] * 10], fov);
            S.setTime(mode === 'zaman' ? t0 + i * dt : t0);
            if (heat >= 0) S.setHeat(heat);
          };
        }""", [g, a.hareket, a.px, a.m, a.dt, a.n, a.isi])
        # warm up (timers, bands) on the first pose
        pg.evaluate('(async () => { for (let k = 0; k < 12; k++) { window.__pose(0); window.__km.S.render(0, 1 / 30); await new Promise(r => requestAnimationFrame(r)); } })()')
        proj = []
        for i in range(a.n):
            wait_lock()                    # the world is frozen: a pause changes nothing in the frames
            pj = pg.evaluate(f"""(async () => {{ window.__pose({i}); const S = window.__km.S; S.render(0, 1 / 30);
              await new Promise(r => requestAnimationFrame(r));
              return window.__lamps.map(p => S.project(p)); }})()""")
            pg.screenshot(path=str(out / f'{prefix}_{i:03d}.png'))
            proj.append(pj)
        st = pg.evaluate('window.__km.S.stats()')
        b.close()
    return proj, st


def analyse(a, out, proj, lamps):
    n = a.n
    lives = [out / f'live_{i:03d}.png' for i in range(n)]
    refs = [out / f'ref_{i:03d}.png' for i in range(n)]
    W, H = a.w, a.h
    Ls, Rs = [], []
    Lrgb, Rrgb = [], []
    for i in range(n):
        l, la = luma8(lives[i]); r, ra = luma8(refs[i])
        Ls.append(l); Rs.append(r); Lrgb.append(la); Rrgb.append(ra)
    Ls, Rs = np.stack(Ls), np.stack(Rs)

    def blocks(x, b=8):
        h, w = (x.shape[-2] // b) * b, (x.shape[-1] // b) * b
        return x[..., :h, :w].reshape(x.shape[0], h // b, b, w // b, b).mean(axis=(2, 4))
    e = np.diff(Ls, axis=0) - np.diff(Rs, axis=0)
    ae = np.abs(e)
    eb = np.abs(np.diff(blocks(Ls), axis=0) - np.diff(blocks(Rs), axis=0))
    d2L = np.abs(Ls[2:] - 2 * Ls[1:-1] + Ls[:-2]).mean()
    d2R = np.abs(Rs[2:] - 2 * Rs[1:-1] + Rs[:-2]).mean()
    res = {
        'kipirti_ort': float(ae.mean()), 'kipirti_p99': float(np.percentile(ae, 99)), 'kipirti_p999': float(np.percentile(ae, 99.9)),
        'blok_ort': float(eb.mean()), 'blok_p999': float(np.percentile(eb, 99.9)),
        'ikinci_fark_canli': float(d2L), 'ikinci_fark_ref': float(d2R), 'titreme_orani': float(d2L / max(d2R, 1e-9)),
        'ref_degisim_ort': float(np.abs(np.diff(Rs, axis=0)).mean()),
        'canli_ref_fark_ort': float(np.abs(Ls - Rs).mean()),
    }
    d2x = np.maximum(np.abs(Ls[2:] - 2 * Ls[1:-1] + Ls[:-2]) - np.abs(Rs[2:] - 2 * Rs[1:-1] + Rs[:-2]), 0).mean(0)
    Image.fromarray(np.clip(d2x / 0.02 * 255, 0, 255).astype(np.uint8)).save(out / 'titreme_isi.png')
    res['titreme_fazla_ort'] = float(d2x.mean())
    res['titreme_fazla_p999'] = float(np.percentile(d2x, 99.9))
    hm = ae.mean(0)
    Image.fromarray(np.clip(hm / max(1e-6, np.percentile(hm, 99.9)) * 255, 0, 255).astype(np.uint8)).save(out / 'kipirti_isi.png')
    # lamps
    R = 4
    rows = []
    for k in range(len(lamps)):
        ok = all(p[k]['z'] > 0.3 and R + 1 <= p[k]['x'] < W - R - 1 and R + 1 <= p[k]['y'] < H - R - 1 for p in proj)
        if not ok:
            continue
        pk = {'live': [], 'ref': []}, {'live': [], 'ref': []}
        for i in range(n):
            x, y = int(round(proj[i][k]['x'])), int(round(proj[i][k]['y']))
            for key, imgs, lum in (('live', Lrgb, Ls), ('ref', Rrgb, Rs)):
                win = lum[i, y - R:y + R + 1, x - R:x + R + 1]
                lw = lin(imgs[i][y - R:y + R + 1, x - R:x + R + 1]) @ np.array([0.2126, 0.7152, 0.0722])
                pk[0][key].append(float(win.max()))
                pk[1][key].append(float(lw.sum()))
        row = {'lamba': k, 'merkez': [round(v, 2) for v in lamps[k]], 'z': round(proj[n // 2][k]['z'], 1),
               'xy': [round(proj[n // 2][k]['x']), round(proj[n // 2][k]['y'])]}
        for key in ('live', 'ref'):
            p_ = np.array(pk[0][key]); en = np.array(pk[1][key])
            row[key] = {'tepe_ort': float(p_.mean()), 'tepe_d2': float(np.abs(p_[2:] - 2 * p_[1:-1] + p_[:-2]).mean()),
                        'tepe_aralik': float(p_.max() - p_.min()),
                        'enerji_d1_bagil': float(np.abs(np.diff(en)).mean() / max(en.mean(), 1e-9)),
                        'enerji_d2_bagil': float(np.abs(en[2:] - 2 * en[1:-1] + en[:-2]).mean() / max(en.mean(), 1e-9))}
            row[key + '_tepe'] = [round(v, 3) for v in p_.tolist()]
        rows.append(row)
    # only lamps that are lit and visible in the reference
    rows = [r for r in rows if r['ref']['tepe_ort'] > 0.25]
    if rows:
        res['lamba_sayisi'] = len(rows)
        for key in ('live', 'ref'):
            res[f'lamba_tepe_d2_{key}'] = float(np.mean([r[key]['tepe_d2'] for r in rows]))
            res[f'lamba_tepe_d2_{key}_max'] = float(np.max([r[key]['tepe_d2'] for r in rows]))
            res[f'lamba_enerji_d2_{key}'] = float(np.mean([r[key]['enerji_d2_bagil'] for r in rows]))
            res[f'lamba_enerji_d2_{key}_max'] = float(np.max([r[key]['enerji_d2_bagil'] for r in rows]))
    # crops of the worst lamps (by live blink): frames side by side, live over reference, zoomed x8
    rows.sort(key=lambda r: -r['live']['tepe_d2'])
    C, Z = 12, 8
    for r in rows[:a.kirp]:
        k = r['lamba']
        strip = Image.new('RGB', (min(n, 16) * (2 * C + 1) * Z, 2 * (2 * C + 1) * Z + Z))
        for j, i in enumerate(range(0, min(n, 16))):
            x, y = int(round(proj[i][k]['x'])), int(round(proj[i][k]['y']))
            for row_, imgs in ((0, Lrgb), (1, Rrgb)):
                y0, x0 = max(0, y - C), max(0, x - C)
                crop = (imgs[i][y0:y0 + 2 * C + 1, x0:x0 + 2 * C + 1] * 255).astype(np.uint8)
                im = Image.fromarray(crop).resize((crop.shape[1] * Z, crop.shape[0] * Z), Image.NEAREST)
                strip.paste(im, (j * (2 * C + 1) * Z, row_ * ((2 * C + 1) * Z + Z)))
        strip.save(out / f'kirp_lamba{k}.png')
    res['lambalar'] = rows
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gorunum', default='fanlar')
    ap.add_argument('--hareket', default='pan', choices=['pan', 'dolly', 'zaman'])
    ap.add_argument('--px', type=float, default=0.5)
    ap.add_argument('--m', type=float, default=0.02)
    ap.add_argument('--dt', type=float, default=1 / 30)
    ap.add_argument('--n', type=int, default=40)
    ap.add_argument('--isi', type=float, default=-1, help="hold the arch's heat shimmer (0..1; -1: as the app sets it)")
    ap.add_argument('--olcek', default='2')
    ap.add_argument('--ref', default='4')
    ap.add_argument('--paket', default='sahne/paket')
    ap.add_argument('--w', type=int, default=2560)
    ap.add_argument('--h', type=int, default=1440)
    ap.add_argument('--ek', default='')
    ap.add_argument('--kirp', type=int, default=4)
    ap.add_argument('--out', default=None)
    ap.add_argument('--etiket', default='')
    ap.add_argument('--kok', default=None, help='serve ui/ from this folder (an earlier version of the renderer)')
    ap.add_argument('--yalniz-analiz', action='store_true')
    ap.add_argument('--ref-dizin', default=None, help='reuse the reference frames of an earlier run (same view and move)')
    a = ap.parse_args()
    name = f"{a.gorunum.replace(':', '').replace(';', '_').replace('=', '').replace(',', '_')}_{a.hareket}" + (f'_{a.etiket}' if a.etiket else '')
    out = Path(a.out or os.path.join(ROOT, '.tmp', 'kipirti', name))
    out.mkdir(parents=True, exist_ok=True)
    paket = Path(a.paket if os.path.isabs(a.paket) else os.path.join(ROOT, a.paket)).resolve()
    lamps = lamp_centres(paket)
    if not a.yalniz_analiz:
        sys.path.insert(0, os.path.join(ROOT, 'sahne', 'araclar'))
        import salon_test
        if a.kok:
            salon_test.ROOT = Path(a.kok).resolve()
        httpd, port = salon_test.serve(paket)
        proj, st = run(a, a.olcek, 'live', out, lamps, port)
        (out / 'proj.json').write_text(json.dumps(proj))
        (out / 'stats_live.json').write_text(json.dumps(st, indent=1))
        if a.ref_dizin:
            import shutil
            for i in range(a.n):
                shutil.copy(Path(a.ref_dizin, f'ref_{i:03d}.png'), out / f'ref_{i:03d}.png')
        else:
            run(a, a.ref, 'ref', out, lamps, port)
        httpd.shutdown()
    proj = json.loads((out / 'proj.json').read_text())
    res = analyse(a, out, proj, lamps)
    st = json.loads((out / 'stats_live.json').read_text())
    res['gpu'] = {'gpuMs': st.get('gpuMs'), 'passes': st.get('passes')}
    (out / 'olcu.json').write_text(json.dumps(res, indent=1))
    short = {k: (round(v, 5) if isinstance(v, float) else v) for k, v in res.items() if k != 'lambalar'}
    print(json.dumps(short, indent=1))
    for r in res['lambalar'][:8]:
        print(f"  lamba {r['lamba']:3d} {r['merkez']} z={r['z']} xy={r['xy']}  tepe {r['live']['tepe_ort']:.3f}/{r['ref']['tepe_ort']:.3f}"
              f"  tepe_d2 {r['live']['tepe_d2']:.4f}/{r['ref']['tepe_d2']:.4f}  enerji_d2 {r['live']['enerji_d2_bagil']:.4f}/{r['ref']['enerji_d2_bagil']:.4f}")


if __name__ == '__main__':
    main()
