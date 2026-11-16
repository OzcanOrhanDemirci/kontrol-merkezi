"""Walk the real lights through every colour and state (morning calibration with Özcan watching the case).

    python araclar/onizle.py tur            temperature sweep 44 -> 88 °C, then the two overrides, then the Jarvis states
    python araclar/onizle.py sicaklik 64    hold one temperature (Ctrl+C ends; preview is cleared on exit)
    python araclar/onizle.py temizle        clear the preview, back to live values

Uses the service's development command "onizle"; turns RGB on for the walk and back to its previous state at the end.
After editing %LOCALAPPDATA%\\KontrolMerkezi\\ayarlar.json: python araclar/onizle.py yukle
"""
import json
import sys
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
    cmd = sys.argv[1] if len(sys.argv) > 1 else "tur"
    f = open(PIPE, "r+b", buffering=0)
    if cmd == "temizle":
        send(f, {"komut": "onizle"})
        return
    if cmd == "yukle":
        send(f, {"komut": "ayar-yukle"})
        return
    was_on = rgb_state(f)
    send(f, {"komut": "rgb", "acik": True})
    try:
        if cmd == "sicaklik":
            send(f, {"komut": "onizle", "c": float(sys.argv[2])})
            while True:
                time.sleep(1)
        # temperature sweep: 1 °C every 0.6 s (the engine smooths over ~5 s, as in real use)
        c = 44.0
        send(f, {"komut": "onizle", "c": c})
        time.sleep(6)
        while c < 88:
            c += 1
            print(f"{c:.0f} °C", flush=True)
            send(f, {"komut": "onizle", "c": c})
            time.sleep(0.6)
        time.sleep(4)
        for label, extra, secs in [
            ("ılık (50 °C)", {"c": 50}, 6),
            ("yerel model yanıt yazıyor, aday 1 (akış)", {"c": 50, "yapayzeka": True, "yzEfekt": 1}, 10),
            ("yerel model yanıt yazıyor, aday 2 (kıpırtı)", {"c": 50, "yapayzeka": True, "yzEfekt": 2}, 10),
            ("işlemci yoğun yükte, aday 1 (kalp)", {"c": 50, "islemci": True, "islemciEfekt": 1}, 10),
            ("işlemci yoğun yükte, aday 2 (yük dalgası)", {"c": 50, "islemci": True, "islemciEfekt": 2}, 10),
            ("geri: yalnız sıcaklık", {"c": 50}, 5),
            ("sıcaklık uyarısı (90 °C üstü)", {"c": 85, "uyari": True}, 8),
            ("Jarvis düşünüyor", {"c": 50, "jarvis": "dusunuyor"}, 10),
            ("Jarvis hazır (bir kez parlar)", {"c": 50, "jarvis": "hazir"}, 5),
            ("Jarvis yanıtını bekliyor", {"c": 50, "jarvis": "bekliyor"}, 12),
            ("Jarvis yeniden açılıyor", {"c": 50, "jarvis": "yeniden"}, 8),
            ("Jarvis kapalı", {"c": 50, "jarvis": "kapali"}, 10),
            ("Jarvis geri geldi", {"c": 50, "jarvis": "hazir"}, 5),
        ]:
            print(label, flush=True)
            send(f, {"komut": "onizle", **extra})
            time.sleep(secs)
    except KeyboardInterrupt:
        pass
    finally:
        send(f, {"komut": "onizle"})
        send(f, {"komut": "rgb", "acik": was_on})
        time.sleep(0.3)


main()
