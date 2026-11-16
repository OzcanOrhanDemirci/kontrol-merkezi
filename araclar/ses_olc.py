"""Level of every synthesized sound, rendered with OfflineAudioContext: peak and loudest 50 ms RMS (dBFS)."""
from playwright.sync_api import sync_playwright
from olc import URL, EDGE, ARGS

JS = """async () => {
  const out = {};
  for (const name of ['press', 'release', 'locked', 'relay', 'spool', 'ignition', 'lightsOff', 'lightsOn', 'glide', 'error']) {
    const ctx = new OfflineAudioContext(2, 48000 * 5, 48000);
    KM_SES.init(ctx);
    if (name === 'spool') KM_SES.spool(true); else KM_SES[name]();
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0, best = 0;
    const W = 2400;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i + W < d.length; i += 480) { let s = 0; for (let j = i; j < i + W; j++) s += d[j] * d[j]; best = Math.max(best, Math.sqrt(s / W)); }
    const db = x => (20 * Math.log10(Math.max(x, 1e-9))).toFixed(1);
    out[name] = 'peak ' + db(peak) + ' dBFS, rms50 ' + db(best) + ' dBFS';
  }
  return out;
}"""

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EDGE, headless=True, args=ARGS)
    pg = b.new_page()
    pg.goto(URL + "#still")
    pg.wait_for_function("() => window.KM_SES")
    for k, v in pg.evaluate(JS).items():
        print(f"{k:10s} {v}")
    b.close()
