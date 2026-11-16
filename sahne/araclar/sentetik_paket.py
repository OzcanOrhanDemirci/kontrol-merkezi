"""A synthetic pack in the docs/SALON.md format, for developing the live renderer (ui/salon/) without the oven.

    python sahne/araclar/sentetik_paket.py [--out .tmp/sentetik] [--offline]

The scene is a reduced copy of the hall at real measures: the entrance gallery (24 x 20 x 44 m) with a fan in its left
wall (9 blades, a recess), a ceiling shaft with a slanted, collimated emitter, a landing view, the gallery's portal and a
hall of 60 x 26 m with four rows of columns receding 116 m to an emissive end panel (the "arch"). The light is analytic
(this is a fixture, not a baker): area lights sampled with column shadows, a smooth indirect term, L0 and the L1
direction per texel, mean radiance M and flux F per volume cell. Materials use two Poly Haven 2K sets (CC0), fetched
into sahne/varlik/doku/ (git-ignored) and copied into the pack.

Every file is written uncompressed except the geometry, which is written gzip-compressed (.gz) to exercise the loader's
DecompressionStream path.
"""
import argparse
import gzip
import json
import math
import shutil
import struct
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
Y0, Y1 = 0.282095, 0.488603
POLY = [('concrete_floor_worn_001', 'zemin'), ('concrete_wall_008', 'beton')]


# ------------------------------------------------------------------------------------------------ assets
def download(url, path):
    if path.exists() and path.stat().st_size > 0:
        return
    print('indiriliyor', url, flush=True)
    req = urllib.request.Request(url, headers={'User-Agent': 'salon-sentetik/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    path.write_bytes(data)


def textures(out):
    cache = ROOT / 'sahne/varlik/doku'
    cache.mkdir(parents=True, exist_ok=True)
    (out / 'doku').mkdir(parents=True, exist_ok=True)
    sets = {}
    for asset, key in POLY:
        meta = cache / (asset + '.json')
        download('https://api.polyhaven.com/files/' + asset, meta)
        files = json.loads(meta.read_text(encoding='utf-8'))
        got = {}
        for kind, field, fmt in [('Diffuse', 'albedo', 'jpg'), ('nor_gl', 'normal', 'png'), ('arm', 'arm', 'png')]:
            url = files[kind]['2k'][fmt]['url']
            name = url.rsplit('/', 1)[-1]
            download(url, cache / name)
            shutil.copyfile(cache / name, out / 'doku' / name)
            got[field] = 'doku/' + name
        sets[key] = got
    (out / 'doku/KAYNAK.txt').write_text(
        'Poly Haven, CC0: ' + ', '.join('https://polyhaven.com/a/' + a for a, _ in POLY) + '\n', encoding='utf-8')
    return sets


# ------------------------------------------------------------------------------------------------ geometry
class Mesh:
    """Quads with their own light map charts. uv0: metres (procedural) or 0..1 over the face (levha)."""

    def __init__(self, charts=True):
        self.v, self.idx, self.tri_mat, self.faces = [], [], [], []
        self.charts = charts

    def quad(self, p, u, v, mat, texel=0.5, unit_uv=False, chart=None):
        p, u, v = (np.asarray(x, float) for x in (p, u, v))
        n = np.cross(u, v)
        n /= np.linalg.norm(n)
        lu, lv = np.linalg.norm(u), np.linalg.norm(v)
        t = u / lu
        face = dict(p=p, u=u, v=v, n=n, texel=texel, verts=len(self.v))
        if self.charts:
            face['w'] = max(4, int(math.ceil(lu / texel)) + 2)   # one texel of padding each side
            face['h'] = max(4, int(math.ceil(lv / texel)) + 2)
        self.faces.append(face)
        for a, b in [(0, 0), (1, 0), (1, 1), (0, 1)]:
            q = p + a * u + b * v
            uv = (a, b) if unit_uv else (a * lu, b * lv)
            self.v.append([q, n, t, uv, (a, b)])
        i = len(self.v) - 4
        for k in (i, i + 1, i + 2, i, i + 2, i + 3):
            self.idx.append(k)
        self.tri_mat += [mat, mat]

    def box(self, lo, hi, mat, texel=0.5, skip=(), inward=False):
        x, y, z = lo
        X, Y, Z = hi
        f = {
            '+z': ((x, y, Z), (X - x, 0, 0), (0, Y - y, 0)), '-z': ((X, y, z), (x - X, 0, 0), (0, Y - y, 0)),
            '-x': ((x, y, z), (0, 0, Z - z), (0, Y - y, 0)), '+x': ((X, y, Z), (0, 0, z - Z), (0, Y - y, 0)),
            '+y': ((x, Y, Z), (X - x, 0, 0), (0, 0, z - Z)), '-y': ((x, y, z), (X - x, 0, 0), (0, 0, Z - z)),
        }
        for k, (p, u, v) in f.items():
            if k not in skip:
                self.quad(p, v, u, mat, texel) if inward else self.quad(p, u, v, mat, texel)

    def pack_charts(self, size):
        """Shelf packing of the charts into pages of size x size; sets every vertex's uv2."""
        order = sorted(range(len(self.faces)), key=lambda i: -self.faces[i]['h'])
        page, x, y, row = 0, 0, 0, 0
        for i in order:
            f = self.faces[i]
            if x + f['w'] > size:
                x, y, row = 0, y + row, 0
            if y + f['h'] > size:
                page, x, y, row = page + 1, 0, 0, 0
            f['page'], f['x'], f['y'] = page, x, y
            x += f['w']
            row = max(row, f['h'])
            for k in range(4):
                a, b = self.v[f['verts'] + k][4]
                self.v[f['verts'] + k][4] = ((x - f['w'] + 1 + a * (f['w'] - 2)) / size, (y + 1 + b * (f['h'] - 2)) / size)
        return page + 1

    def write(self, path):
        tri = np.arange(len(self.idx) // 3)
        pages = np.array([self.faces[f].get('page', 0) for f in tri // 2]) if self.charts else np.zeros(len(tri), int)
        mats = np.array(self.tri_mat)
        order = np.lexsort((tri, mats, pages))
        idx = np.array(self.idx, dtype='<u4').reshape(-1, 3)[order].reshape(-1)
        ranges = []
        for k, t in enumerate(order):
            key = (int(pages[t]), int(mats[t]))
            if ranges and (ranges[-1]['sayfa'], ranges[-1]['malzeme']) == key:
                ranges[-1]['sayi'] += 3
            else:
                ranges.append({'malzeme': key[1], 'sayfa': key[0], 'ilk': k * 3, 'sayi': 3})
        sn = lambda a: np.round(np.clip(a, -1, 1) * 32767).astype(int)
        buf = bytearray(struct.pack('<4s3I', b'KMG1', len(self.v), len(idx), 40))
        for q, n, t, uv, uv2 in self.v:
            nn, tt = sn(n), sn(t)
            buf += struct.pack('<3f4h4h2f2H', *q, *nn, 0, *tt, 32767, *uv,
                               *(int(round(min(max(c, 0), 1) * 65535)) for c in uv2))
        buf += idx.tobytes()
        if path.suffix == '.gz':
            path.write_bytes(gzip.compress(bytes(buf), 6))
        else:
            path.write_bytes(bytes(buf))
        return {'dosya': path.name, 'kose': len(self.v), 'ucgen': len(idx) // 3, 'araliklar': ranges}


# ------------------------------------------------------------------------------------------------ the scene
M_ZEMIN, M_DUVAR, M_KOLON, M_CELIK, M_KANAT, M_TABELA, M_EKRAN, M_MERCEK, M_KEMER, M_KUYU, M_LAMBA = range(11)
COLUMNS = [(x, z) for z in range(-60, -141, -20) for x in (-22, -8, 8, 22)]
HALL_END = -160.0
FAN_C = np.array([-12.7, 8.5, -24.0])     # the rotor's centre, in the recess of the left wall


def build_scene(m):
    # entrance gallery: floor, ceiling with the shaft opening, side walls with the fan recess, back wall
    m.quad((-12, 0, 0), (24, 0, 0), (0, 0, -44), M_ZEMIN, 0.2)
    for lo, hi in [((-12, -26), (12, 0)), ((-12, -44), (12, -36)), ((-12, -36), (-5, -26)), ((5, -36), (12, -26))]:
        m.quad((lo[0], 20, hi[1]), (0, 0, lo[1] - hi[1]), (hi[0] - lo[0], 0, 0), M_DUVAR, 0.4)
    x0, x1, z0, z1 = -5, 5, -36, -26                                 # the shaft's walls up to the emitter (inward)
    m.quad((x1, 20, z1), (x0 - x1, 0, 0), (0, 10, 0), M_DUVAR, 0.4)
    m.quad((x0, 20, z0), (x1 - x0, 0, 0), (0, 10, 0), M_DUVAR, 0.4)
    m.quad((x0, 20, z1), (0, 0, z0 - z1), (0, 10, 0), M_DUVAR, 0.4)
    m.quad((x1, 20, z0), (0, 0, z1 - z0), (0, 10, 0), M_DUVAR, 0.4)
    m.quad((-5, 30, -26), (0, 0, -10), (10, 0, 0), M_KUYU, 0.5)      # facing down: the shaft's emitter
    m.quad((-12, 0, 0), (0, 20, 0), (24, 0, 0), M_DUVAR, 0.3)        # back wall (facing -z)
    for side in (-1, 1):
        x = 12.0 * side
        fz = lambda z0, z1, y0, y1: m.quad((x, y0, z0), (0, 0, z1 - z0), (0, y1 - y0, 0), M_DUVAR, 0.3) if side < 0 else \
            m.quad((x, y0, z1), (0, 0, z0 - z1), (0, y1 - y0, 0), M_DUVAR, 0.3)
        if side < 0:
            fz(0, -18.5, 0, 20); fz(-29.5, -44, 0, 20); fz(-18.5, -29.5, 0, 3); fz(-18.5, -29.5, 14, 20)
            m.box((-14.5, 3, -29.5), (-12, 14, -18.5), M_DUVAR, 0.25, skip=('+x',), inward=True)   # the recess
        else:
            fz(0, -44, 0, 20)
    # landing: deck and railing
    m.box((-5, 2.9, -6), (5, 3.0, 0), M_CELIK, 0.2)
    m.box((-5, 4.02, -6.05), (5, 4.1, -5.97), M_CELIK, 0.1)          # railing: handrail, mid rail, posts
    m.box((-5, 3.52, -6.03), (5, 3.56, -5.99), M_CELIK, 0.1)
    for x in (-5, -2.5, 0, 2.5, 5):
        m.box((x - 0.03, 3.0, -6.04), (x + 0.03, 4.02, -5.98), M_CELIK, 0.1)
    # portal wall at z = -44 with a 24 x 20 opening: the gallery frames the hall
    m.quad((-12, 0, -44), (-18, 0, 0), (0, 26, 0), M_DUVAR, 0.5)     # (seen from the hall: facing -z)
    m.quad((30, 0, -44), (-18, 0, 0), (0, 26, 0), M_DUVAR, 0.5)
    m.quad((12, 20, -44), (-24, 0, 0), (0, 6, 0), M_DUVAR, 0.5)
    # hall: floor, ceiling, walls, end wall with the arch panel
    m.quad((-30, 0, -44), (60, 0, 0), (0, 0, HALL_END + 44), M_ZEMIN, 0.4)
    m.quad((-30, 26, HALL_END), (60, 0, 0), (0, 0, -44 - HALL_END), M_DUVAR, 0.8)
    m.quad((-30, 0, -44), (0, 0, HALL_END + 44), (0, 26, 0), M_DUVAR, 0.6)
    m.quad((30, 0, HALL_END), (0, 0, -44 - HALL_END), (0, 26, 0), M_DUVAR, 0.6)
    m.quad((-30, 0, HALL_END), (23, 0, 0), (0, 26, 0), M_DUVAR, 0.5)
    m.quad((7, 0, HALL_END), (23, 0, 0), (0, 26, 0), M_DUVAR, 0.5)
    m.quad((-7, 20, HALL_END), (14, 0, 0), (0, 6, 0), M_DUVAR, 0.5)
    m.quad((-7, 0, HALL_END + 0.02), (14, 0, 0), (0, 20, 0), M_KEMER, 0.5)
    for x, z in COLUMNS:
        m.box((x - 1, 0, z - 3.5), (x + 1, 26, z + 3.5), M_KOLON, 0.35, skip=('+y', '-y'))
    # a hanging sign at the portal (paint), a board by the fan (a display), a stop lamp lens, caged lamps
    m.box((-1.7, 12.45, -43.0), (1.7, 13.65, -42.9), M_CELIK, 0.2)
    m.quad((-1.6, 12.5, -42.89), (3.2, 0, 0), (0, 1.1, 0), M_TABELA, 0.1, unit_uv=True)
    m.box((-12, 4.4, -35.2), (-11.9, 7.0, -30.8), M_CELIK, 0.2)
    m.quad((-11.89, 4.5, -31.0), (0, 0, -4.0), (0, 2.4, 0), M_EKRAN, 0.1, unit_uv=True)
    m.box((-12, 2.2, -33.3), (-11.85, 2.6, -32.9), M_CELIK, 0.1)
    m.quad((-11.84, 2.25, -32.95), (0, 0, -0.3), (0, 0.3, 0), M_MERCEK, 0.05, unit_uv=True)
    for c in LAMPS:
        m.box(np.array(c) - 0.15, np.array(c) + 0.15, M_LAMBA, 0.1)


LAMPS = [(-11.7, 6.2, -9.0), (11.7, 6.2, -14.0), (-29.7, 5.0, -80.0), (29.7, 5.0, -120.0), (-11.7, 6.2, -38.0)]


def rotor_mesh():
    """Nine pitched blades and a hub, own frame: axis +x (towards the gallery), centred."""
    r = Mesh(charts=False)
    blades, r0, r1, pitch = 9, 0.9, 4.85, math.radians(32)
    for b in range(blades):
        a = b * 2 * math.pi / blades
        rows = []
        for k in range(9):
            rr = r0 + (r1 - r0) * k / 8
            chord = 1.25 - 0.35 * k / 8                       # metres, narrower towards the tip
            half = chord / 2 / rr                             # half the chord as an angle
            tw = pitch * (1.0 - 0.45 * k / 8)                 # twist: flatter at the tip
            lead, trail = a - half, a + half
            # the chord tilted by the pitch: the leading edge forward (+x), the trailing edge back
            rows.append([(0.5 * chord * math.sin(tw), rr * math.cos(lead), rr * math.sin(lead)),
                         (-0.5 * chord * math.sin(tw), rr * math.cos(trail), rr * math.sin(trail))])
        for k in range(8):
            p00, p01 = np.array(rows[k][0]), np.array(rows[k][1])
            p10, p11 = np.array(rows[k + 1][0]), np.array(rows[k + 1][1])
            for (pa, pb, pc, pd) in [(p00, p10, p11, p01)]:   # one side (drawn two-sided)
                i = len(r.v)
                n = np.cross(pb - pa, pd - pa); n /= np.linalg.norm(n)
                t = (pb - pa) / np.linalg.norm(pb - pa)
                for q in (pa, pb, pc, pd):
                    r.v.append([q, n, t, (q[1], q[2]), (0, 0)])
                r.idx += [i, i + 1, i + 2, i, i + 2, i + 3]
                r.tri_mat += [M_KANAT, M_KANAT]
    seg = 32                                               # hub: a shallow cone, front face
    i0 = len(r.v)
    r.v.append([np.array([0.55, 0, 0]), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), (0, 0), (0, 0)])
    for s in range(seg + 1):
        a = s * 2 * math.pi / seg
        q = np.array([0.0, 1.05 * math.cos(a), 1.05 * math.sin(a)])
        n = np.array([0.55, math.cos(a) * 0.6, math.sin(a) * 0.6]); n /= np.linalg.norm(n)
        r.v.append([q, n, np.array([0, -math.sin(a), math.cos(a)]), (q[1], q[2]), (0, 0)])
    for s in range(seg):
        r.idx += [i0, i0 + 1 + s, i0 + 2 + s]
        r.tri_mat.append(M_CELIK)
    return r


def lever_mesh():
    """A switch handle, own frame: hinge axis +x, the handle along +y."""
    k = Mesh(charts=False)
    k.box((-0.06, 0.0, -0.07), (0.06, 0.62, 0.07), M_CELIK)
    k.box((-0.09, 0.56, -0.2), (0.09, 0.66, 0.2), M_KANAT)
    return k


# ------------------------------------------------------------------------------------------------ light
def column_boxes():
    return np.array([[x - 1, 0, z - 3.5, x + 1, 26, z + 3.5] for x, z in COLUMNS], float)


def visible(p, q, boxes):
    """1 where the segment p -> q (arrays N x 3) misses every box; slab test, vectorised."""
    d = q - p
    inv = 1.0 / np.where(np.abs(d) < 1e-9, 1e-9, d)
    lo, hi = boxes[:, :3], boxes[:, 3:]
    t0 = (lo[None] - p[:, None]) * inv[:, None]
    t1 = (hi[None] - p[:, None]) * inv[:, None]
    tn = np.minimum(t0, t1).max(-1)
    tf = np.maximum(t0, t1).min(-1)
    hit = (tn < tf) & (tf > 1e-3) & (tn < 1 - 1e-3)
    return ~hit.any(-1)


def emitters():
    """Per group, area lights as sample points: position, normal, radiance x area per sample, cosine lobe."""
    out = []
    # 0 kuyu: the shaft's top, facing down, slanted towards -z, collimated
    g = (np.arange(4) + 0.5) / 4 * 2 - 1
    gx, gz = np.meshgrid(g * 4.6, g * 4.6)
    p = np.stack([gx.ravel(), np.full(gx.size, 29.9), gz.ravel() - 31], -1)
    nrm = np.array([0, -1, -0.22]); nrm /= np.linalg.norm(nrm)
    out.append(dict(p=p, n=np.tile(nrm, (len(p), 1)), la=np.full(len(p), 12.0 * 100 / len(p)), lobe=6.0))
    # 1 kemer: the end panel, facing +z
    gx, gy = np.meshgrid((np.arange(4) + 0.5) / 4 * 14 - 7, (np.arange(5) + 0.5) / 5 * 20)
    p = np.stack([gx.ravel(), gy.ravel(), np.full(gx.size, HALL_END + 0.1)], -1)
    out.append(dict(p=p, n=np.tile([0, 0, 1.0], (len(p), 1)), la=np.full(len(p), 2.4 * 280 / len(p)), lobe=1.0))
    # 2 lamba: small caged lamps (spheres of 0.15 m, radiance 9)
    p = np.array(LAMPS, float)
    out.append(dict(p=p, n=None, la=np.full(len(p), 9.0 * math.pi * 0.15 ** 2), lobe=0.0))
    return out


def direct(points, normals, light, boxes, chunk=4096):
    """Per point: the incoming light as a sum of directions: L0-like scalar sum and the L1 vector (both luminance,
    the emitters are white). normals None: the whole sphere (volumes)."""
    n_pts = len(points)
    s0 = np.zeros(n_pts)
    s1 = np.zeros((n_pts, 3))
    for a in range(0, n_pts, chunk):
        P = points[a:a + chunk]
        for k in range(len(light['p'])):
            q = light['p'][k]
            d = q[None] - P
            dist2 = np.maximum((d * d).sum(-1), 0.05)
            dirn = d / np.sqrt(dist2)[:, None]
            if light['n'] is not None:
                cl = np.maximum(-(dirn @ light['n'][k]), 0) ** light['lobe']
            else:
                cl = np.ones(len(P))
            e = light['la'][k] * cl / dist2                  # radiance x solid angle: irradiance at normal incidence
            if normals is not None:
                e = e * ((dirn * normals[a:a + chunk]).sum(-1) > 0)
            if e.max() <= 0:
                continue
            vis = visible(P, np.broadcast_to(q, P.shape), boxes) if len(boxes) else 1.0
            e = e * vis
            s0[a:a + chunk] += e
            s1[a:a + chunk] += e[:, None] * dirn
    return s0, s1


def indirect(points, g):
    """A smooth stand-in for the bounced light of group g (radiance, uniform over the open hemisphere)."""
    x, y, z = points[:, 0], points[:, 1], points[:, 2]
    if g == 0:
        d = np.sqrt(x ** 2 + (z + 31) ** 2 + (0.5 * (y - 4)) ** 2)
        return 0.012 * np.exp(-d / 14) + 0.0015 * np.exp(-np.maximum(-z - 44, 0) / 50)
    if g == 1:
        return 0.012 * np.exp(-(z - HALL_END) / 45) + 0.0004
    d = np.min(np.linalg.norm(points[:, None] - np.array(LAMPS)[None], axis=-1), -1)
    return 0.006 * np.exp(-d / 5)


def light_map(mesh, pages, size, boxes, lights):
    texels = []
    for fi, f in enumerate(mesh.faces):
        w, h = f['w'], f['h']
        a = np.clip((np.arange(w) + 0.5 - 1) / (w - 2), 0, 1)
        b = np.clip((np.arange(h) + 0.5 - 1) / (h - 2), 0, 1)
        A, B = np.meshgrid(a, b)
        P = f['p'] + A[..., None] * f['u'] + B[..., None] * f['v'] + f['n'] * 0.01
        texels.append((f, P.reshape(-1, 3)))
    allP = np.concatenate([t[1] for t in texels])
    allN = np.concatenate([np.tile(t[0]['n'], (len(t[1]), 1)) for t in texels])
    # openness: lower near the columns' feet and the floor/wall corners (grime and specular occlusion)
    dc = np.full(len(allP), 9.0)
    for x0, y0, z0, x1, y1, z1 in boxes:
        q = np.maximum(np.maximum(np.array([x0, y0, z0]) - allP, allP - np.array([x1, y1, z1])), 0)
        dc = np.minimum(dc, np.linalg.norm(q, axis=-1) + np.where(allN[:, 1] > 0.5, 0, 9))
    open_ = 1 - 0.45 * np.exp(-dc / 0.6) - 0.25 * np.exp(-allP[:, 1] / 0.4) * (np.abs(allN[:, 1]) < 0.5)
    planes = []
    for g, light in enumerate(lights):
        s0, s1 = direct(allP, allN, light, boxes if g != 2 else np.zeros((0, 6)))
        amb = indirect(allP, g)
        L0 = s0 * Y0 + amb * Y0 * 2 * math.pi * open_
        L1 = s1 * Y1 + (amb * Y1 * math.pi * open_)[:, None] * allN
        lum0 = np.maximum(L0, 1e-12)
        m = np.linalg.norm(L1, axis=-1)
        dirn = L1 / np.maximum(m, 1e-12)[:, None]
        w = np.clip(m / (Y1 / Y0 * lum0), 0, 1)
        warm = np.array([1.0, 0.985, 0.96]) if g != 1 else np.array([0.99, 1.0, 1.0])   # a slight bounce tint
        A = np.zeros((pages, size, size, 4), np.float16)
        Bp = np.zeros((pages, size, size, 4), np.uint8)
        k = 0
        for f, P in texels:
            cnt = len(P)
            sl = slice(k, k + cnt)
            a = np.zeros((cnt, 4))
            a[:, :3] = L0[sl, None] * warm
            a[:, 3] = open_[sl]
            bb = np.zeros((cnt, 4))
            bb[:, :3] = dirn[sl] * 0.5 + 0.5
            bb[:, 3] = w[sl]
            A[f['page'], f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']] = a.reshape(f['h'], f['w'], 4)
            Bp[f['page'], f['y']:f['y'] + f['h'], f['x']:f['x'] + f['w']] = \
                np.clip(np.round(bb * 255), 0, 255).astype(np.uint8).reshape(f['h'], f['w'], 4)
            k += cnt
        planes.append((A, Bp))
    return planes


def volume(name, lo, dims, cell, boxes, lights):
    nx, ny, nz = dims
    z, y, x = np.meshgrid(np.arange(nz), np.arange(ny), np.arange(nx), indexing='ij')
    P = (np.stack([x, y, z], -1).reshape(-1, 3) + 0.5) * cell + np.array(lo, float)
    inside = np.zeros(len(P), bool)
    for b in boxes:
        inside |= np.all((P >= b[:3]) & (P <= b[3:]), -1)
    gallery = (P[:, 2] > -44) & ((np.abs(P[:, 0]) > 12) | (P[:, 1] > 20))
    shaft = (np.abs(P[:, 0]) < 5) & (P[:, 2] > -36) & (P[:, 2] < -26) & (P[:, 1] < 30)
    recess = (P[:, 0] > -14.5) & (P[:, 0] < -12) & (P[:, 1] > 3) & (P[:, 1] < 14) & (P[:, 2] > -29.5) & (P[:, 2] < -18.5)
    solid = inside | (gallery & ~shaft & ~recess) | (P[:, 1] > 26) | (P[:, 2] > 0)
    out = []
    for g, light in enumerate(lights):
        s0, s1 = direct(P, None, light, boxes if g != 2 else np.zeros((0, 6)))
        amb = indirect(P, g)
        M = s0 / (4 * math.pi) + amb
        F = s1 / (4 * math.pi)
        Mg = np.zeros((len(P), 4), np.float16)
        Fg = np.zeros((len(P), 4), np.float16)
        tint = np.array([1.0, 0.985, 0.96]) if g != 1 else np.array([0.99, 1.0, 1.0])
        Mg[:, :3] = np.where(solid[:, None], 0, M[:, None] * tint)
        Mg[:, 3] = np.where(solid, 0, 1)
        Fg[:, :3] = np.where(solid[:, None], 0, F)
        out.append((Mg, Fg))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', type=Path, default=ROOT / '.tmp/sentetik')
    ap.add_argument('--offline', action='store_true', help='constant materials (no download)')
    ap.add_argument('--lm', type=int, default=2048)
    a = ap.parse_args()
    out = a.out
    out.mkdir(parents=True, exist_ok=True)
    tex = {} if a.offline else textures(out)
    mesh = Mesh()
    build_scene(mesh)
    pages = mesh.pack_charts(a.lm)
    print('yuzler', len(mesh.faces), 'sayfa', pages, flush=True)
    geo = mesh.write(out / 'geo.bin.gz')
    rotor = rotor_mesh().write(out / 'rotor_fan_kasa_rotor.bin')
    lever = lever_mesh().write(out / 'rotor_kol_kasa.bin')
    boxes = column_boxes()
    lights = emitters()
    planes = light_map(mesh, pages, a.lm, boxes, lights)
    for p in range(pages):
        with open(out / f'lm_{p}.bin', 'wb') as f:
            f.write(struct.pack('<4s3I', b'KML1', a.lm, a.lm, 3))
            for g in range(3):
                f.write(planes[g][0][p].tobytes())
                f.write(planes[g][1][p].tobytes())
    vols = [('salon', [-30, 0, HALL_END - 1], [60, 31, 161], 1.0),
            ('kuyu', [-6, 0, -38], [48, 124, 64], 0.25),
            ('kemer', [-12, 0, HALL_END], [48, 52, 40], 0.5),
            ('fan_kasa', [-14.5, 1, -32], [56, 60, 64], 0.25)]
    hacim = []
    for name, lo, dims, cell in vols:
        data = volume(name, lo, dims, cell, boxes, lights)
        with open(out / f'vol_{name}.bin', 'wb') as f:
            f.write(struct.pack('<4s4I', b'KMV1', *dims, 3))
            for Mg, Fg in data:
                f.write(Mg.tobytes())
                f.write(Fg.tobytes())
        hacim.append(dict(ad=name, dosya=f'vol_{name}.bin', boyut=dims, alt=lo, hucre=cell))
        print('hacim', name, dims, flush=True)
    z = tex.get('zemin', {})
    b = tex.get('beton', {})
    mat = lambda ad, t, **k: dict(ad=ad, albedo=t.get('albedo', ''), normal=t.get('normal', ''), arm=t.get('arm', ''),
                                  uvOlcek=k.pop('uvOlcek', 1), renk=k.pop('renk', [1, 1, 1]), puruz=k.pop('puruz', None),
                                  metal=k.pop('metal', None), grup=k.pop('grup', None), emitScale=k.pop('emitScale', 0),
                                  ortalamaAlbedo=k.pop('ortalama', [0.3, 0.3, 0.3]), bayrak=k.pop('bayrak', []))
    materials = [
        mat('beton_zemin', z, uvOlcek=2.5, bayrak=['wet']),
        mat('beton_duvar', b, uvOlcek=3.0, renk=[0.9, 0.9, 0.9]),
        mat('beton_kolon', b, uvOlcek=2.5),
        mat('celik_pasli', {}, renk=[0.16, 0.12, 0.09], puruz=0.55, metal=0.6, bayrak=['metal']),
        mat('celik_kanat', {}, renk=[0.32, 0.33, 0.33], puruz=0.42, metal=0.8, bayrak=['metal', 'dynamic']),
        mat('tabela_yuz', {}, renk=[0.5, 0.48, 0.42], puruz=0.6, metal=0.0, bayrak=['levha']),
        mat('ekran_yuz', {}, renk=[0.02, 0.025, 0.03], puruz=0.15, metal=0.0, bayrak=['levha']),
        mat('mercek', {}, renk=[0.06, 0.06, 0.06], puruz=0.1, metal=0.0, bayrak=['levha']),
        mat('kemer_isik', {}, renk=[1, 1, 1], grup=1, emitScale=2.4, bayrak=['emissive']),
        mat('kuyu_isik', {}, renk=[1, 1, 1], grup=0, emitScale=3.0, bayrak=['emissive']),
        mat('cam_lamba', {}, renk=[1, 1, 1], grup=2, emitScale=9.0, bayrak=['emissive']),
    ]
    box = lambda c, x, y, zz: dict(merkez=list(c), x=list(x), y=list(y), z=list(zz))
    anchors = [
        dict(ad='fan_kasa', tur='tik', atlas='', boyut=[0, 0], malzeme=-1,
             kutu=box(FAN_C + [0.5, 0, 0], [1.6, 0, 0], [0, 5.3, 0], [0, 0, 5.3])),
        dict(ad='tabela_rgb', tur='levha', atlas='tabela_rgb', boyut=[3.2, 1.1], malzeme=M_TABELA,
             kutu=box([0, 13.05, -42.89], [1.6, 0, 0], [0, 0.55, 0], [0, 0, 0.025])),
        dict(ad='git_rgb', tur='tik', atlas='', boyut=[0, 0], malzeme=-1,
             kutu=box([0, 13.05, -42.95], [1.8, 0, 0], [0, 0.7, 0], [0, 0, 0.2])),
        dict(ad='pano_kasa', tur='levha', atlas='pano_kasa', boyut=[4.0, 2.4], malzeme=M_EKRAN,
             kutu=box([-11.89, 5.7, -33.0], [0, 0, -2.0], [0, 1.2, 0], [0.025, 0, 0])),
        dict(ad='durak_0', tur='nokta', atlas='', boyut=[0, 0], malzeme=-1,
             kutu=box([-11.84, 2.4, -33.1], [0.05, 0, 0], [0, 0.2, 0], [0, 0, 0.2])),
        dict(ad='kol_kasa', tur='nokta', atlas='', boyut=[0, 0], malzeme=-1,
             kutu=box([-11.85, 3.3, -16.5], [0.16, 0, 0], [0, 0.16, 0], [0, 0, 0.16])),
    ]
    yol = [[0, 4.65, -3.0], [0, 5.2, -20], [0, 6.0, -45], [0, 6.5, -70], [0, 6.5, -100], [0, 6.2, -125]]
    data = dict(
        surum=1, olusturuldu='sentetik', firin=dict(ornek=0, seken=0, sure_sn=0, ortam_sigma=0.012, ortam_g=0.35),
        malzemeler=materials, geometri=geo,
        dinamik=[dict(rotor, ad='fan_kasa_rotor', merkez=list(FAN_C), eksen=[1, 0, 0], yaricap=4.85, kanat=9),
                 dict(lever, ad='kol_kasa', merkez=[-11.85, 3.3, -16.5], eksen=[1, 0, 0], yaricap=0.7, kanat=0)],
        isikHaritasi=dict(dosya=[f'lm_{p}.bin' for p in range(pages)], genislik=a.lm, yukseklik=a.lm, sayfa=pages,
                          gruplar=3),
        hacimler=hacim,
        isiklar=[dict(grup=0, tur='dikdortgen', merkez=[0, 30, -31], u=[5, 0, 0], v=[0, 0, 5], normal=[0, -1, 0],
                      parlaklik=3.0, kosUs=6.0)],
        gorunumler=dict(fanlar=dict(goz=[0, 4.65, -3.0], hedef=[0, 7.5, -60], fov=50),
                        rgb=dict(goz=[0, 6.2, -125], hedef=[0, 10, HALL_END], fov=50), yol=yol),
        capalar=anchors)
    (out / 'sahne.json').write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    print(out)


if __name__ == '__main__':
    main()
