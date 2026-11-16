"""CPU-only B12/B13 regression check; requires numpy, never creates a graphics context.

Build/dump the original revision into BEFORE, then the fixed revision into AFTER:
    salon.exe dump --out .tmp/b12-before
    salon.exe dump --out .tmp/b12-after
    salon.exe geo --out .tmp/paket-geo
    python sahne/araclar/scene_b12_b13_check.py .tmp/b12-after --before .tmp/b12-before --pack .tmp/paket-geo

BEFORE is optional on subsequent runs. Areas use float64 arithmetic on the actual stored float32 positions.
"""
import argparse
import json
import math
from pathlib import Path
import struct
import zlib

import numpy as np


def read_mesh(path):
    raw = path.read_bytes()
    if path.suffix == '.z':
        raw = zlib.decompress(raw)
    magic, nv, ni, stride = struct.unpack_from('<4I', raw)
    assert (magic, stride) in ((0x3144474B, 48), (0x31474D4B, 40)), path
    assert len(raw) == 16 + nv * stride + ni * 4 and ni % 3 == 0, path
    records = np.frombuffer(raw, '<f4', nv * stride // 4, 16).reshape(nv, stride // 4)
    idx = np.frombuffer(raw, '<u4', ni, 16 + nv * stride).reshape(-1, 3)
    assert idx.size and idx.max() < nv, path
    assert np.isfinite(records[:, :3]).all(), path
    return records, idx


def degenerate(v, idx):
    bad = np.empty(len(idx), dtype=bool)
    for start in range(0, len(idx), 100000):
        p = v[idx[start:start + 100000], :3].astype(np.float64)
        n = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
        bad[start:start + len(p)] = np.einsum('ij,ij->i', n, n) < 1e-20
    return bad


def strips(data):
    return [e for e in data['lights'] if e['type'] == 0 and e['group'] == 1
            and abs(e['c'][2] + 258) < .01]


def flux(emitters):
    return sum(4 * np.linalg.norm(np.cross(e['u'], e['v'])) * e['L']
               * 2 * math.pi / (e['lobe'] + 1) for e in emitters)


def concrete_radius(data, vertices, idx):
    """Bound the actual concrete mesh in the curved strip's z slab, above the springing."""
    materials = [i for i, m in enumerate(data['materials']) if m['name'].startswith('beton_')]
    selected = np.isin(vertices[idx[:, 0], 10], materials)
    tri = vertices[idx[selected], :3].astype(np.float64)
    tri = tri[(tri[:, :, 2].min(axis=1) <= -257.96) & (tri[:, :, 2].max(axis=1) >= -258.04)
              & (tri[:, :, 1].max(axis=1) >= 12.2)]
    closest = math.inf
    for t in tri:
        poly = list(t)
        for axis, boundary, sign in ((2, -258.04, 1), (2, -257.96, -1), (1, 12.2, 1)):
            clipped = []
            for a, b in zip(poly, poly[1:] + poly[:1]):
                da, db = sign * (a[axis] - boundary), sign * (b[axis] - boundary)
                if da >= 0:
                    clipped.append(a)
                if (da >= 0) != (db >= 0):
                    clipped.append(a + (b - a) * da / (da - db))
            poly = clipped
        for a, b in zip(poly, poly[1:] + poly[:1]):
            p, q = a[:2] - [0, 12.2], b[:2] - [0, 12.2]
            d = q - p
            f = np.clip(-(p @ d) / (d @ d), 0, 1) if d @ d else 0
            closest = min(closest, np.linalg.norm(p + f * d))
    assert math.isfinite(closest)
    return closest


def surface_check(data, vertices, idx):
    mat = next(i for i, m in enumerate(data['materials']) if m['name'] == 'kemer_isik')
    tri = vertices[idx[vertices[idx[:, 0], 10] == mat], :3].astype(np.float64)
    lo, hi = tri.min(axis=1), tri.max(axis=1)
    emitters = strips(data)
    assert len(emitters) > 2
    worst, radius_max, normal_min = 0., 0., 1.
    for e in emitters:
        c, u, v, n = (np.array(e[k], dtype=float) for k in ('c', 'u', 'v', 'n'))
        assert abs(np.dot(u, v)) < 1e-7 and abs(np.linalg.norm(n) - 1) < 1e-6
        corners = np.array([c + su * u + sv * v for su in (-1, 1) for sv in (-1, 1)])
        # The convex rectangle is bounded by its corners' radius: every curved sample remains inside the reveal.
        if c[1] > 12.2:
            radius_max = max(radius_max, np.linalg.norm(corners[:, :2] - [0, 12.2], axis=1).max())
        candidates = tri[np.all(hi >= corners.min(axis=0) - .001, axis=1)
                         & np.all(lo <= corners.max(axis=0) + .001, axis=1)]
        assert len(candidates), 'no luminous surface near emitter'
        # Include all corners, edges and interior. Project to actual mesh triangles, testing barycentric inclusion.
        sample = np.array([c + su * u + sv * v for su in np.linspace(-1, 1, 9)
                           for sv in np.linspace(-1, 1, 9)])
        nearest = np.full(len(sample), np.inf)
        for t in candidates:
            a, b = t[1] - t[0], t[2] - t[0]
            face = np.cross(a, b)
            face /= np.linalg.norm(face)
            signed = (sample - t[0]) @ face
            q = sample - signed[:, None] * face - t[0]
            aa, ab, bb = a @ a, a @ b, b @ b
            det = aa * bb - ab * ab
            s = (bb * (q @ a) - ab * (q @ b)) / det
            r = (aa * (q @ b) - ab * (q @ a)) / det
            inside = (s >= -2e-4) & (r >= -2e-4) & (s + r <= 1 + 2e-4)
            nearest[inside] = np.minimum(nearest[inside], abs(signed[inside]))
            if inside[len(sample) // 2] and abs(signed[len(sample) // 2]) < .001:
                normal_min = min(normal_min, face @ n)
        worst = max(worst, nearest.max())
    assert worst <= .001, f'emitter surface error {worst} m'
    assert radius_max < 7., f'emitter enters reveal: radius {radius_max}'
    assert normal_min > .9999, f'emitter normal differs from luminous facet: {normal_min}'
    concrete_min = concrete_radius(data, vertices, idx)
    assert radius_max < concrete_min, 'curved emitter overlaps concrete'
    print(f'Strips: {len(emitters) - 2} curved + 2 straight; maximum surface error {worst * 1000:.6f} mm; '
          f'maximum curved radius {radius_max:.9f} m; minimum normal dot {normal_min:.9f}')
    print(f'Concrete in strip slab: minimum radius {concrete_min:.9f} m; '
          f'curved emitter radial clearance at least {(concrete_min - radius_max) * 1000:.6f} mm')
    return emitters


def pack_check(path, counts):
    data = json.loads((path / 'sahne.json').read_text(encoding='utf-8'))
    for name, mesh in [('static', data['geometri'])] + [(d['ad'], d) for d in data['dinamik']]:
        v, idx = read_mesh(path / mesh['dosya'])
        assert len(v) == mesh['kose'] and len(idx) == mesh['ucgen'] == counts[name], name
        assert not degenerate(v, idx).any(), name
        end, previous, vertex_end = 0, None, 0
        for r in mesh['araliklar']:
            assert r['ilk'] == end and r['sayi'] > 0 and r['sayi'] % 3 == 0, name
            assert 0 <= r['malzeme'] < len(data['malzemeler']), name
            key = (r.get('sayfa', 0), r['malzeme'])
            if name == 'static':
                assert 0 <= key[0] < data['isikHaritasi']['sayfa']
            assert previous is None or previous < key, name
            ids = np.unique(idx.reshape(-1)[end:end + r['sayi']])
            assert np.array_equal(ids, np.arange(vertex_end, vertex_end + len(ids))), name
            vertex_end += len(ids)
            end += r['sayi']
            previous = key
        assert end == idx.size and vertex_end == len(v), name
        print(f'Pack {name}: {len(idx)} triangles, 0 degenerate; indices and {len(mesh["araliklar"])} draw ranges valid')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('after', type=Path)
    parser.add_argument('--before', type=Path)
    parser.add_argument('--pack', type=Path, required=True)
    args = parser.parse_args()
    data = json.loads((args.after / 'dump.json').read_text(encoding='utf-8'))
    counts = {}
    for name, file in [('static', data['static'])] + [(d['name'], d['file']) for d in data['dynamic']]:
        v, idx = read_mesh(args.after / file)
        assert not degenerate(v, idx).any(), name
        assert np.all(v[idx, 10] == v[idx[:, :1], 10]), name
        assert np.all(v[idx, 11] == v[idx[:, :1], 11]), name
        counts[name] = len(idx)
        if args.before:
            old_v, old_idx = read_mesh(args.before / file)
            bad = degenerate(old_v, old_idx)
            assert np.array_equal(v, old_v), f'{name}: dumped vertex attributes changed'
            assert np.array_equal(idx, old_idx[~bad]), f'{name}: nondegenerate triangle changed'
            print(f'{name}: {len(old_idx)} -> {len(idx)} triangles; removed {bad.sum()}, 0 degenerate remain; '
                  'all surviving triangles and dumped vertex attributes unchanged')
        else:
            print(f'{name}: {len(idx)} triangles, 0 degenerate')
        if name == 'static':
            emitters = surface_check(data, v, idx)
    new_flux = flux(emitters)
    if args.before:
        before = json.loads((args.before / 'dump.json').read_text(encoding='utf-8'))
        old_flux = flux(strips(before))
        assert math.isclose(old_flux, new_flux, rel_tol=1e-6)
        print(f'Strip flux (scene units): {old_flux:.9f} -> {new_flux:.9f}; '
              f'relative change {(new_flux / old_flux - 1) * 1e6:.6f} ppm')
    else:
        print(f'Strip flux (scene units): {new_flux:.9f}')
    pack_check(args.pack, counts)


if __name__ == '__main__':
    main()
