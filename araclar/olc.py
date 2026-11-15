"""Kontrol Merkezi window: screenshots and frame-time measurement in headless Edge on the real GPU.

  python araclar/olc.py kare  [ad] [--js "<setup js>"] [--bekle 4] [--w 2560 --h 1440]
      one screenshot after setup + wait (seconds), to araclar/cikti/<ad>.png
  python araclar/olc.py durumlar
      the standard set of screenshots of every state
  python araclar/olc.py olc [--sure 30]
      scripted sequence (tab switch, RGB off/on, fan spin-up, Jarvis effect) with
      GPU time per frame (EXT_disjoint_timer_query_webgl2) and rAF interval distribution,
      plus first-frame time; writes araclar/cikti/olcum.json and prints a summary.
The page runs its own simulated service outside WebView2; window.__km / __km.sim drive it.
"""
import json
import pathlib
import statistics
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "araclar" / "cikti"
OUT.mkdir(parents=True, exist_ok=True)
URL = (ROOT / "ui" / "index.html").as_uri()
EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]


def arg(name, default):
    if name in sys.argv:
        return type(default)(sys.argv[sys.argv.index(name) + 1])
    return default


def open_page(p, w, h, hash_=""):
    b = p.chromium.launch(executable_path=EDGE, headless=True, args=ARGS)
    pg = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
    logs = []
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    pg.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    t0 = time.perf_counter()
    pg.goto(URL + (("#" + hash_) if hash_ else ""))
    pg.wait_for_function("() => window.__km && window.__km.R.frame > 0", timeout=120000)
    first = time.perf_counter() - t0
    return b, pg, logs, first


def shot(pg, name):
    path = OUT / f"{name}.png"
    pg.screenshot(path=str(path))
    return path


def wait_frames(pg, n):
    pg.evaluate("n => new Promise(r => { const f0 = __km.R.frame; const c = () => __km.R.frame >= f0 + n ? r() : requestAnimationFrame(c); c(); })", n)


STATES = [
    # name, setup js, seconds to settle
    ("fan-bios-soguk", "__km.sim.temp(38)", 5),
    ("fan-max-kasa", "__km.sim.temp(52); __km.sim.send({komut:'fan-kasa'})", 6),
    ("fan-max-ikisi", "__km.sim.temp(66); __km.sim.send({komut:'fan-kasa'}); __km.sim.send({komut:'fan-gpu'})", 7),
    ("fan-afterburner", "__km.sim.temp(46); __km.sim.S.afterburner.fanKontrolu = true; __km.sim.set('x',1)", 5),
    ("fan-yonetici-yok", "__km.sim.temp(46); __km.sim.set('yonetici', false)", 5),
    ("fan-baglanti-yok", "__km.sim.link('yok')", 5),
    ("fan-rgb-kapali", "__km.sim.temp(46); __km.sim.send({komut:'rgb', acik:false})", 5),
    ("rgb-soguk-beyaz", "__km.sim.temp(38); __km.setTab('rgb', true)", 6),
    ("rgb-koyu-mavi", "__km.sim.temp(54); __km.setTab('rgb', true)", 6),
    ("rgb-sari", "__km.sim.temp(64); __km.setTab('rgb', true)", 6),
    ("rgb-kirmizi", "__km.sim.temp(84); __km.setTab('rgb', true)", 6),
    ("rgb-pembe-yerel-model", "__km.sim.temp(46); __km.sim.kip('yapayzeka'); __km.setTab('rgb', true)", 6),
    ("rgb-kapali", "__km.sim.temp(46); __km.sim.send({komut:'rgb', acik:false}); __km.setTab('rgb', true)", 6),
    ("rgb-jarvis-bekliyor", "__km.sim.temp(54); __km.sim.jarvis('bekliyor'); __km.setTab('rgb', true)", 6),
    ("rgb-jarvis-dusunuyor", "__km.sim.temp(46); __km.sim.jarvis('dusunuyor'); __km.setTab('rgb', true)", 6),
]


def cmd_kare():
    name = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else "kare"
    w, h = arg("--w", 2560), arg("--h", 1440)
    with sync_playwright() as p:
        b, pg, logs, first = open_page(p, w, h, arg("--hash", ""))
        js = arg("--js", "")
        if js:
            pg.evaluate(f"() => {{ {js} }}")
        time.sleep(arg("--bekle", 4.0))
        path = shot(pg, name)
        info = pg.evaluate("() => ({ frame: __km.R.frame, gpu: __km.R.gpuMs, compile: __km.R.compileMs, first: __km.R.firstFrameMs, n: __km.R.n })")
        print(path, json.dumps(info), f"load {first:.2f}s")
        for l in logs[:20]:
            print(l)
        b.close()


def cmd_durumlar():
    only = arg("--sadece", "")
    with sync_playwright() as p:
        for name, js, wait in STATES:
            if only and only not in name:
                continue
            b, pg, logs, first = open_page(p, 2560, 1440)
            pg.evaluate(f"() => {{ {js} }}")
            time.sleep(wait)
            print(shot(pg, name), f"gpu {pg.evaluate('__km.R.gpuMs'):.1f} ms")
            for l in logs[:10]:
                print("  ", l)
            b.close()
        # mid-transition
        b, pg, logs, first = open_page(p, 2560, 1440)
        pg.evaluate("__km.sim.temp(54)")
        time.sleep(3)
        pg.evaluate("__km.setTab('rgb', true)")
        time.sleep(0.7)
        print(shot(pg, "gecis-orta"))
        b.close()


SEQ = """async (sure) => {
  const k = window.__km, s = k.sim;
  const iv = [], marks = [];
  let last = 0;
  k.onFrame = now => { if (last) iv.push([now, now - last]); last = now; };
  const g0 = k.R.gpu.length;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const mark = m => marks.push([performance.now(), m]);
  s.temp(46);
  await wait(3000);
  mark('sekme rgb'); k.setTab('rgb', true); await wait(3000);
  mark('rgb kapat'); s.send({komut:'rgb', acik:false}); await wait(2500);
  mark('rgb ac'); s.send({komut:'rgb', acik:true}); await wait(2500);
  mark('jarvis dusunuyor'); s.jarvis('dusunuyor'); await wait(3000);
  mark('jarvis bekliyor'); s.jarvis('bekliyor'); await wait(3000);
  mark('sekme fan'); k.setTab('fan', true); await wait(2500);
  mark('fan kasa max'); s.send({komut:'fan-kasa'}); await wait(3000);
  mark('fan gpu max'); s.send({komut:'fan-gpu'}); await wait(3000);
  mark('sicaklik taramasi'); s.release(); s.S.sweep = true; await wait(Math.max(0, sure * 1000 - 28500));
  k.onFrame = null;
  return { iv, marks, gpu: k.R.gpu.slice(g0), first: k.R.firstFrameMs, compile: k.R.compileMs, w: k.R.w, h: k.R.h, spp: k.R.spp, sppDyn: k.R.sppDyn };
}"""


def pct(a, q):
    a = sorted(a)
    return a[min(len(a) - 1, int(q * len(a)))]


def cmd_olc():
    sure = arg("--sure", 34.0)
    with sync_playwright() as p:
        b, pg, logs, first = open_page(p, 2560, 1440, arg("--hash", ""))
        time.sleep(1.0)
        r = pg.evaluate(SEQ, sure)
        b.close()
    iv = [x[1] for x in r["iv"]]
    gpu = r["gpu"]
    med = statistics.median(iv)
    res = {
        "cozunurluk": f"{r['w']}x{r['h']}", "spp": r["spp"], "sppDyn": r["sppDyn"],
        "ilk_kare_ms": round(r["first"]), "derleme_ms": round(r["compile"]), "yukleme_s": round(first, 2),
        "kare_sayisi": len(iv),
        "raf_ms": {"p50": round(med, 2), "p95": round(pct(iv, .95), 2), "p99": round(pct(iv, .99), 2), "max": round(max(iv), 2),
                   "uzun_2x": sum(1 for x in iv if x > 2 * med)},
        "gpu_ms": {"p50": round(pct(gpu, .5), 2), "p95": round(pct(gpu, .95), 2), "p99": round(pct(gpu, .99), 2), "max": round(max(gpu), 2), "n": len(gpu)} if gpu else None,
        "isaretler": [m[1] for m in r["marks"]],
    }
    # the worst intervals and what was happening
    t0 = r["iv"][0][0] if r["iv"] else 0
    worst = sorted(r["iv"], key=lambda x: -x[1])[:8]
    def at(t):
        cur = "basla"
        for mt, m in r["marks"]:
            if mt <= t:
                cur = m
        return cur
    res["en_uzun"] = [[round((t - t0) / 1000, 2), round(d, 1), at(t)] for t, d in worst]
    (OUT / "olcum.json").write_text(json.dumps({**res, "iv": iv, "gpu": gpu}, indent=1), encoding="utf-8")
    print(json.dumps(res, indent=1, ensure_ascii=False))
    for l in logs[:10]:
        print(l)


if __name__ == "__main__":
    {"kare": cmd_kare, "durumlar": cmd_durumlar, "olc": cmd_olc}[sys.argv[1]]()
