"""Talk to the running Kontrol Merkezi service over its pipe (development tool).

    python araclar/boru.py durum                 print the current state
    python araclar/boru.py izle 5                print state changes and light-frame timing for 5 s
    python araclar/boru.py komut '{"komut":"rgb","acik":true}' [saniye]
"""
import json
import statistics
import sys
import time

PIPE = "\\\\.\\pipe\\KontrolMerkezi"


def lines(f):
    buf = b""
    while True:
        chunk = f.read(4096)
        if not chunk:
            return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if line:
                yield json.loads(line)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "durum"
    f = open(PIPE, "r+b", buffering=0)
    if cmd == "durum":
        for m in lines(f):
            if m["tip"] == "durum":
                print(json.dumps(m, ensure_ascii=False, indent=1))
                return
    secs = float(sys.argv[2]) if cmd == "izle" and len(sys.argv) > 2 else float(sys.argv[3]) if len(sys.argv) > 3 else 3
    if cmd == "komut":
        f.write((sys.argv[2] + "\n").encode())
    t0 = time.time()
    times, last = [], None
    for m in lines(f):
        if m["tip"] == "isik":
            times.append(time.time())
            last = m
        else:
            print(round(time.time() - t0, 2), json.dumps(m, ensure_ascii=False)[:400])
        if time.time() - t0 > secs:
            break
    if len(times) > 2:
        d = [(b - a) * 1000 for a, b in zip(times, times[1:])]
        print(f"isik: {len(times)} kare, aralik p50 {statistics.median(d):.1f} ms, en cok {max(d):.1f} ms")
        print("son isik:", last["acik"], "onizleme", last["onizleme"], "cikis", last["cikis"], "halka[0]", last["halka"][0], "klavye[0]", last["klavye"][0])


main()
