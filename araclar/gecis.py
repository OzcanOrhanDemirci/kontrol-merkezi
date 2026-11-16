"""Show one real temperature transition on all lights (Özcan watches whether the GPU glides, jumps or steps).

    python araclar/gecis.py [from_c] [to_c] [hold_s] [--kart-ara MS]     default 45 -> 64, 40 s at the target

--kart-sabit sets the pause after the card's steady-mode write instead (-1 = the same as --kart-ara).
--kart-ara sets the pause after each write to the GPU's light controller (ayarlar.json gpuYazmaArasiMs) and reloads
the settings live first; it stays set afterwards (the stages of Özcan's step-by-step speed-up, 11-16).

Turns RGB on, holds from_c for 10 s (white), then sets to_c: the engine's own ~30 s drift carries the colour across,
exactly as a real warm-up would. Then the preview is cleared and RGB goes back to how it was.
"""
import json
import os
import sys
import threading
import time

PIPE = "\\\\.\\pipe\\KontrolMerkezi"


def send(f, obj):
    f.write((json.dumps(obj) + "\n").encode())


def rgb_state(f):
    buf = b""
    while True:
        buf += f.read(4096)
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            m = json.loads(line)
            if m.get("tip") == "durum":
                return m["rgb"]["acik"]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ara = None
    efekt = None
    sabit = None
    if "--kart-sabit" in sys.argv:
        i = sys.argv.index("--kart-sabit")
        sabit = int(sys.argv[i + 1])
        del sys.argv[i:i + 2]
    if "--kart-ara" in sys.argv:
        i = sys.argv.index("--kart-ara")
        ara = int(sys.argv[i + 1])
        del sys.argv[i:i + 2]
    a = float(sys.argv[1]) if len(sys.argv) > 1 else 45
    b = float(sys.argv[2]) if len(sys.argv) > 2 else 64
    hold = float(sys.argv[3]) if len(sys.argv) > 3 else 40
    f = open(PIPE, "r+b", buffering=0)
    was_on = rgb_state(f)
    if ara is not None or efekt is not None or sabit is not None:
        p = os.path.join(os.environ["LOCALAPPDATA"], "KontrolMerkezi", "ayarlar.json")
        d = json.load(open(p, encoding="utf-8"))
        if ara is not None:
            d["gpuYazmaArasiMs"] = ara
        if sabit is not None:
            d["gpuSabitSonrasiMs"] = sabit
        json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        send(f, {"komut": "ayar-yukle"})
        print(f"kart yazma arası: {d.get('gpuYazmaArasiMs', 30)} ms, sabit sonrası {d.get('gpuSabitSonrasiMs', -1)} ms", flush=True)
    # keep reading: the service drops a client whose messages pile up unread (it broadcasts the lights 30 times a second)
    threading.Thread(target=lambda: [f.read(65536) for _ in iter(int, 1)], daemon=True).start()
    try:
        send(f, {"komut": "onizle", "c": a})
        send(f, {"komut": "rgb", "acik": True})
        print(f"{time.strftime('%H:%M:%S')} {a:.0f} °C tutuluyor (10 sn)", flush=True)
        time.sleep(10)
        send(f, {"komut": "onizle", "c": b})
        print(f"{time.strftime('%H:%M:%S')} {b:.0f} °C: ~30 sn'lik geçiş başladı", flush=True)
        time.sleep(hold)
    except KeyboardInterrupt:
        pass
    finally:
        send(f, {"komut": "onizle"})
        send(f, {"komut": "rgb", "acik": was_on})
        time.sleep(0.3)
        print(f"{time.strftime('%H:%M:%S')} önizleme bitti, RGB eski hâlinde ({'açık' if was_on else 'kapalı'})", flush=True)


main()
