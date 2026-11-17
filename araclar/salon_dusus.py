"""The void's fall as a player does it (Phase 2, ui/disari.js): off the roof's edge, then one of three ways down, through
walk mode's real physics and the void's real logic, headless Edge on the real GPU with the simulated service.

    python araclar/salon_dusus.py [--paket DIR] [--out DIR] [--yol birak,don,komsu] [--video] [--w 1280 --h 720]

  birak  jump off and let go: no key held; the cloud band must bring one out over the home's deck (the recovery)
  don    jump off, drift out, then turn back towards the deck and steer onto it (one's own steering only)
  komsu  jump off and keep flying out (Shift+W) to the next facility; it must become the home, one lands on its deck,
         walks to its hatch, opens it and goes down its stair into the hall (whose lamps then wear our colours)

Prints each way's log (time, position, home, wraps, rebases, recoveries, landing) and with --video writes a frame per
step (1/30 s) and an mp4 per way under --out.
"""
import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

# one step of the player: keys, look, then the app's frame (physics, the void, the camera), optionally drawn
JS_STEP = r"""async ([keys, yaw, pitch, draw, dt]) => {
  const km = window.__km, W = km.W;
  if (keys) W.debug.keys(keys);
  // yaw as [d] turns by d from where the look is now (a mouse's way: the look may have been turned by a rebase)
  if (Array.isArray(yaw)) { const s0 = W.state(); W.debug.look(s0.yaw + yaw[0], pitch == null ? s0.pitch : pitch); }
  else if (yaw != null) W.debug.look(yaw, pitch);
  km.step(dt);
  if (draw) { km.S.render(dt, dt); await new Promise(r => requestAnimationFrame(r)); }
  const s = W.state(), v = km.V.state();
  return { x: s.x, foot: s.foot, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, g: s.grounded, yaw: s.yaw, pitch: s.pitch, home: v.home, ours: v.ours,
           band: v.band, f: { falling: v.fall.falling, wraps: v.fall.wraps, rebases: v.fall.rebases, recovered: v.fall.recovered, last: v.fall.lastFall } };
}"""

JS_PUT = r"""async ([x, foot, z, yaw, pitch]) => {
  const km = window.__km, W = km.W;
  if (!W.active) W.enter({ noLock: true });
  W.debug.put(x, foot, z, 0);
  W.debug.look(yaw, pitch);
  for (let i = 0; i < 30; i++) km.step(1 / 30);
  return W.state();
}"""


def deck_centre_yaw(st):
    # heading from the walker to the deck's middle (x 0, z -171): yaw with dir = (sin yaw, -cos yaw)
    dx, dz = 0 - st['x'], -171 - st['z']
    return math.atan2(dx, -dz)


def run_way(pg, way, out, video, dt=1 / 30):
    frames = out / way if video else None
    if frames:
        frames.mkdir(parents=True, exist_ok=True)
        for f in frames.glob('*.jpg'):
            f.unlink()
    pg.evaluate(JS_PUT, [40.0, 35.0, -170.0, math.pi / 2, -0.15])
    log, n = [], 0
    phase, t, landed_t = 'run', 0.0, None
    state = None
    hatch_done = False
    wp = 0
    WAY = [(-3.0, -338.0), (-2.0, -348.8), (0.0, -348.8)]
    while t < 150:
        keys, yaw, pitch = None, None, None
        if phase == 'run':                       # run to the edge and jump over it
            keys = {'w': 1, 'shift': 1}
            if state and state['x'] > 46.5:
                pg.evaluate('window.__km.W.debug.jump()')
                phase = 'air'
                t_air = t
        elif phase == 'air':
            ta = t - t_air
            if way == 'birak':
                keys = {} if ta > 0.4 else None
                yaw, pitch = math.pi / 2, -0.35 - 0.6 * min(1, ta / 6)
            elif way == 'don':
                f = state['f']
                if ta < 2.5:
                    keys, yaw, pitch = {'w': 1}, math.pi / 2, -0.4
                elif ta < 4.5:                   # looks round for the way back
                    keys, yaw, pitch = {}, math.pi / 2 + math.pi * (ta - 2.5) / 2, -0.6
                else:                            # steers back over the deck's line, falls, and onto the deck below
                    over = -48 + 12 < state['x'] < 48 - 12 and -350 + 12 < state['z'] < 8 - 12
                    keys = {} if over else {'w': 1}
                    yaw, pitch = deck_centre_yaw(state), -0.9
            elif way == 'komsu':
                f = state['f']
                if f['rebases'] == 0:
                    keys, yaw, pitch = {'w': 1, 'shift': 1}, math.pi / 2, -0.25
                else:                            # the next facility is home now: onto its deck, turning as a hand would
                    over = -48 + 14 < state['x'] < 48 - 14 and -350 + 14 < state['z'] < 8 - 14
                    keys = {} if over else {'w': 1, 'shift': 1}
                    want = deck_centre_yaw(state)
                    dy = (want - state['yaw'] + math.pi) % (2 * math.pi) - math.pi
                    yaw = [max(-0.03, min(0.03, dy))]
                    pitch = max(-0.7, state.get('pitch', -0.25) - 0.01)
            if state and state['g'] and not state['f']['falling'] and ta > 1:
                landed_t = t
                phase = 'landed'
        elif phase == 'landed':
            keys = {}
            if way != 'komsu' or t - landed_t > 1.0:
                if way != 'komsu':
                    if t - landed_t > 1.5:
                        break
                else:
                    phase = 'hatch'
        elif phase == 'hatch':                   # as the tour does: round the hatch to its far end, open, down the stair
            if wp < len(WAY):
                tx, tz = WAY[wp]
                dx, dz = tx - state['x'], tz - state['z']
                if math.hypot(dx, dz) < 0.4:
                    wp += 1
                    keys = {}
                else:
                    yaw, pitch, keys = math.atan2(dx, -dz), -0.2, {'w': 1, 'shift': 1 if wp == 0 else 0}
            elif not hatch_done:
                yaw, pitch, keys = math.pi, -0.6, {}
                pg.evaluate('window.__km.V.setOpen(true)')
                hatch_done = t
            elif t - hatch_done > 1.8:
                dz = -340.0 - state['z']
                yaw, pitch, keys = math.pi, -0.3, {'w': 1} if dz > 0.3 else {}
                if state['foot'] < 28 or t - hatch_done > 16:
                    break
        state = pg.evaluate(JS_STEP, [keys, yaw, pitch, bool(video), dt])
        if frames:
            pg.screenshot(path=str(frames / f'{n:05d}.jpg'), type='jpeg', quality=88)
        if n % 60 == 0 or (log and (state['home'] != log[-1]['home'] or state['f']['wraps'] != log[-1]['f']['wraps'])):
            log.append({'t': round(t, 2), **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in state.items()}})
        n += 1
        t += dt
    final = pg.evaluate("({ v: window.__km.V.state(), s: window.__km.W.state() })")
    return log, final, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--paket', default=str(ROOT / 'sahne' / 'paket'))
    ap.add_argument('--out', default=str(ROOT / '.tmp' / 'dusus'))
    ap.add_argument('--yol', default='birak,don,komsu')
    ap.add_argument('--video', action='store_true')
    ap.add_argument('--w', type=int, default=1280)
    ap.add_argument('--h', type=int, default=720)
    ap.add_argument('--olcek', default='2')
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT / 'sahne' / 'araclar'))
    import salon_test
    httpd, port = salon_test.serve(Path(a.paket).resolve())
    res = {}
    with sync_playwright() as p:
        for way in a.yol.split(','):
            b = p.chromium.launch(channel='msedge', headless=True, args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
            pg = b.new_page(viewport={'width': a.w, 'height': a.h}, device_scale_factor=1)
            pg.on('pageerror', lambda e: print('  [sayfa hatasi] ' + str(e)[:400], flush=True))
            pg.on('console', lambda m: m.type == 'error' and print('  [sayfa] ' + m.text[:300], flush=True))
            pg.goto(f'http://127.0.0.1:{port}/ui/index.html#paket=/sahne/&olcek={a.olcek}&still=0')
            pg.wait_for_function("window.__km && ((window.__km.S && window.__km.S.ready) || document.body.classList.contains('nogl'))", timeout=600000)
            pg.evaluate('(async () => { await window.__km.still(0, { settle: 6 }); await window.__km.W.load(); })()')
            log, final, n = run_way(pg, way, out, a.video)
            b.close()
            print(f'== {way}: {n} adim, {n / 30:.1f} sn', flush=True)
            for e in log:
                print('  ', json.dumps(e, ensure_ascii=False), flush=True)
            print('   son:', json.dumps(final, ensure_ascii=False)[:600], flush=True)
            res[way] = {'log': log, 'final': final}
            if a.video:
                mp4 = out / f'{way}.mp4'
                subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '30', '-i', str(out / way / '%05d.jpg'),
                                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', str(mp4)], check=True)
                print('   video:', mp4, flush=True)
    (out / 'dusus.json').write_text(json.dumps(res, indent=1, ensure_ascii=False), encoding='utf-8')
    httpd.shutdown()


if __name__ == '__main__':
    main()
