"""Per-device colour calibration (hue-dependent), live on the real lights.

    python araclar/renk.py goster                       table: each stop, the shared colour and each device's own
    python araclar/renk.py tut 46                       lights on, hold the 46 °C stop (also: yapayzeka)
    python araclar/renk.py kaydir aio 46 -10 0 +20      nudge the AIO's colour for that stop by dR dG dB, apply live
    python araclar/renk.py ayarla aio 46 85 132 255     set it outright, apply live
    python araclar/renk.py sifirla aio 46               back to the shared colour (null)
    python araclar/renk.py kazanctan aio 46 54          bake the device's current channel gains into those stops'
                                                        colours, then set its gains to 1 (one-time move off gains)
    python araclar/renk.py birak                        stop holding (back to the live temperature)

Colours are sRGB 0-255 as in ayarlar.json (the keyboard is the reference; a device's own colour is what to send it
so it shows what the keyboard shows). Writes %LOCALAPPDATA%\\KontrolMerkezi\\ayarlar.json, keeps the previous file as
ayarlar.onceki.json, and reloads the running service (no fade).
"""
import json
import os
import shutil
import sys

PIPE = "\\\\.\\pipe\\KontrolMerkezi"
YOL = os.path.join(os.environ["LOCALAPPDATA"], "KontrolMerkezi", "ayarlar.json")
OZEL = {"yapayzeka": "yapayZeka"}


def send(*objs):
    with open(PIPE, "r+b", buffering=0) as f:
        for o in objs:
            f.write((json.dumps(o) + "\n").encode())


def load():
    with open(YOL, encoding="utf-8-sig") as f:
        return json.load(f)


def save(d):
    shutil.copyfile(YOL, YOL.replace("ayarlar.json", "ayarlar.onceki.json"))
    with open(YOL, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    send({"komut": "ayar-yukle"})


def stop_index(d, key):
    """'46' -> stop index; 'yapayzeka' -> None (override)."""
    if key in OZEL:
        return None
    c = float(key)
    for i, s in enumerate(d["duraklar"]):
        if abs(s["c"] - c) < 0.01:
            return i
    sys.exit(f"durak yok: {key} (var olanlar: {[s['c'] for s in d['duraklar']]})")


def shared(d, key):
    i = stop_index(d, key)
    return d["duraklar"][i]["renk"] if i is not None else d["yapayZekaRengi"]


def own_get(d, dev, key):
    cr = d.setdefault("cihazRenkleri", {}).setdefault(dev, {})
    i = stop_index(d, key)
    if i is None:
        return cr.get(OZEL[key])
    lst = cr.get("duraklar") or [None] * len(d["duraklar"])
    return lst[i] if i < len(lst) else None


def own_set(d, dev, key, rgb):
    cr = d.setdefault("cihazRenkleri", {}).setdefault(dev, {})
    i = stop_index(d, key)
    if i is None:
        cr[OZEL[key]] = rgb
        return
    lst = cr.get("duraklar") or [None] * len(d["duraklar"])
    while len(lst) < len(d["duraklar"]):
        lst.append(None)
    lst[i] = rgb
    cr["duraklar"] = lst


def clamp(v):
    return max(0, min(255, int(round(v))))


def to_lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def to_srgb(c):
    c = max(0.0, min(1.0, c))
    return clamp((c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055) * 255)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    a = sys.argv[1:]
    if not a or a[0] == "goster":
        d = load()
        devs = sorted(d.get("cihazRenkleri", {}))
        print("durak       ortak (klavye)    " + "  ".join(f"{x:<16}" for x in devs))
        for key in [str(int(s["c"]) if s["c"] == int(s["c"]) else s["c"]) for s in d["duraklar"]] + list(OZEL):
            row = f"{key:<11} {str(shared(d, key)):<17} "
            row += "  ".join(f"{str(own_get(d, x, key) or '-'):<16}" for x in devs)
            print(row)
        print("kazanc:", d.get("kazanc"))
        return
    cmd = a[0]
    if cmd == "tut":
        key = a[1]
        if key in OZEL:
            send({"komut": "rgb", "acik": True}, {"komut": "onizle", "c": 50, "kip": key})
        else:
            send({"komut": "rgb", "acik": True}, {"komut": "onizle", "c": float(key), "kip": "sicaklik"})
        print("tutuluyor:", key)
    elif cmd == "birak":
        send({"komut": "onizle"})
        print("canlı sıcaklığa dönüldü")
    elif cmd in ("kaydir", "ayarla", "sifirla"):
        d = load()
        dev, key = a[1], a[2]
        if cmd == "sifirla":
            new = None
        else:
            vals = [float(x) for x in a[3:6]]
            if cmd == "kaydir":
                base = own_get(d, dev, key) or shared(d, key)
                new = [clamp(b + v) for b, v in zip(base, vals)]
            else:
                new = [clamp(v) for v in vals]
        own_set(d, dev, key, new)
        save(d)
        print(f"{dev} {key}: {new if new else 'ortak renk'}")
    elif cmd == "kazanctan":
        d = load()
        dev = a[1]
        g = d.get("kazanc", {}).get(dev, [1, 1, 1])
        for key in a[2:]:
            base = own_get(d, dev, key) or shared(d, key)
            lin = [to_lin(c) * k for c, k in zip(base, g)]
            m = max(lin) or 1
            new = [to_srgb(x / m) for x in lin]
            own_set(d, dev, key, new)
            print(f"{dev} {key}: {base} x {g} -> {new}")
        d["kazanc"][dev] = [1, 1, 1]
        save(d)
        print(f"{dev} kazancı 1'e alındı")
    else:
        sys.exit(__doc__)


main()
