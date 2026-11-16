"""Convert a baked pack's light map pages from KML1 to KML2, once, at build time (docs/SALON.md, "Light map pages").

The window used to turn every page's L0 planes (RGBA16F) into RGB9_E5 and the openness plane in JavaScript on every
launch: 150 M texels, ~4.4 s of the main thread before the first light (the real window, 11-16). KML2 stores what the
window uploads, so it only uploads:

    header  uint32 magic 'KML2', width, height, groups
    per group:  plane A  uint32 RGB9_E5 (GL_UNSIGNED_INT_5_9_9_9_REV) of L0's rgb
                plane B  RGBA8, unchanged (L1 direction and spread)
    once:       openness uint8 (L0's alpha in group 0: the same in every group)

The arithmetic mirrors ui/salon/salon.js' toRgb9e5 exactly (doubles, Math.round = floor(x + 0.5)), so the picture is
the same bits as before. Usage: python sahne/araclar/paket_e5.py <pack dir>   (pages already KML2 are left alone)
"""
import json
import os
import sys
import zlib

import numpy as np


def js_round(x):
    return np.floor(x + 0.5)


def to_e5(src):
    """src: uint16 halves, RGBA per texel -> (uint32 rgb9e5, uint8 openness)"""
    h = src.reshape(-1, 4).view('<f2').astype(np.float64)
    r, g, b, a = h[:, 0], h[:, 1], h[:, 2], h[:, 3]
    with np.errstate(invalid='ignore'):
        r = np.where(r > 0, np.minimum(r, 65408.0), 0.0)
        g = np.where(g > 0, np.minimum(g, 65408.0), 0.0)
        b = np.where(b > 0, np.minimum(b, 65408.0), 0.0)
        op = np.where(a > 0, np.where(a >= 1, 255.0, js_round(a * 255.0)), 0.0).astype(np.uint8)
    mx = np.maximum(np.maximum(r, g), b)
    lit = mx >= 1.53e-10
    safe = np.where(lit, mx, 1.0)
    e = np.maximum(-16.0, np.floor(np.log2(safe))) + 1.0
    sc = np.power(2.0, e - 9.0)
    over = js_round(safe / sc) == 512
    e = np.where(over, e + 1.0, e)
    sc = np.where(over, sc * 2.0, sc)
    R = js_round(r / sc).astype(np.int64) & 511
    G = js_round(g / sc).astype(np.int64) & 511
    B = js_round(b / sc).astype(np.int64) & 511
    E = (e.astype(np.int64) + 15) & 31
    out = ((E << 27) | (B << 18) | (G << 9) | R).astype(np.uint32)
    out[~lit] = 0
    return out, op


def convert(path):
    raw = zlib.decompress(open(path, 'rb').read()) if path.endswith('.z') else open(path, 'rb').read()
    magic, w, hgt, groups = np.frombuffer(raw[:16], '<u4')
    if magic == 0x324C4D4B:
        return 'already KML2'
    if magic != 0x314C4D4B or groups != 3:
        raise SystemExit(path + ': not a KML1 page of 3 groups')
    n = int(w) * int(hgt)
    if len(raw) != 16 + n * 4 * 3 * 3:
        raise SystemExit(path + ': size does not match its header')
    parts = [np.array([0x324C4D4B, w, hgt, groups], '<u4').tobytes()]
    off, openness = 16, None
    for gi in range(3):
        a, op = to_e5(np.frombuffer(raw, '<u2', n * 4, off))
        off += n * 8
        if gi == 0:
            openness = op
        parts += [a.astype('<u4').tobytes(), raw[off:off + n * 4]]
        off += n * 4
    parts.append(openness.tobytes())
    data = b''.join(parts)
    tmp = path + '.yeni'
    with open(tmp, 'wb') as f:
        f.write(zlib.compress(data, 6) if path.endswith('.z') else data)
    os.replace(tmp, path)
    return f'{len(raw) / 1e6:.0f} -> {len(data) / 1e6:.0f} MB raw'


def main():
    pack = sys.argv[1]
    meta = json.load(open(os.path.join(pack, 'sahne.json'), encoding='utf-8'))
    for f in meta['isikHaritasi']['dosya']:
        print(f, convert(os.path.join(pack, f)), flush=True)


if __name__ == '__main__':
    main()
