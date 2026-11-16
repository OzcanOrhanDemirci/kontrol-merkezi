"""Checks a hall pack (docs/SALON.md "The pack") the way a person would: pictures and numbers.

    python sahne/araclar/paket_bak.py PACK [--cikti DIR] [--fark OTHER_PACK] [--genislik 1600]

Writes into DIR (default: PACK + "_bak"):
  lm_<page>_g<group>.png    each light map page per group (pi*Y0*L0, auto exposure, AgX), 1:1
  lm_<page>_bos.png         false colour: grey = texel with light, red = empty texel inside a triangle, black = none
  vol_<name>_g<group>_*.png slices through each volume's middle (mean radiance M; dark blue = inside geometry)
  gorunum_<view>.png        a quick render of the static mesh from each view, shaded from the light map (nearest texel,
                            the SALON.md irradiance with the vertex normal, the material's mean albedo), every group in a
                            colour of its own; _g<group>.png for each group alone in white; _karanlik.png marks in red
                            the surface pixels without any light (if any). The rotors drawn too,
                            lit from the volumes.
Prints the stats: texels, empty texels inside charts, NaN, negative, min/max/mean per group, file sizes.
--fark OTHER_PACK: the noise between two bakes of the same scene (e.g. 256 and 1024 samples, nested): per group the
  standard deviation and the 99th percentile of the difference in 8-bit tonemapped units (sRGB after AgX, a texel's
  outgoing radiance at an exposure from PACK), and the sample count at which the noise would be < 0.5/255.
"""

import argparse
import json
import math
import os
import sys
import zlib

import cv2
import numpy as np

Y0, Y1 = 0.282095, 0.488603
LUM = np.array([0.2126, 0.7152, 0.0722], np.float32)
# the groups' colours in the quick render (live they are the temperature colour, the arch's, warm white)
GROUP_RGB = [np.array(c, np.float32) for c in ((1.0, 0.55, 0.22), (0.30, 0.62, 1.0), (1.0, 0.86, 0.66))]


# ---------------------------------------------------------------------------------------------------- reading
def read_bin(pack, name):
    with open(os.path.join(pack, name), "rb") as f:
        data = f.read()
    return zlib.decompress(data) if name.endswith(".z") else data


VERTEX = np.dtype([("p", "<f4", 3), ("n", "<i2", 4), ("t", "<i2", 4), ("uv", "<f4", 2), ("uv2", "<u2", 2)])


def read_mesh(pack, name):
    b = read_bin(pack, name)
    magic, nv, ni, stride = np.frombuffer(b, "<u4", 4)
    assert magic == 0x31474D4B and stride == 40, f"{name}: not a KMG1 mesh"
    v = np.frombuffer(b, VERTEX, nv, 16)
    idx = np.frombuffer(b, "<u4", ni, 16 + 40 * int(nv))
    return v, idx


def read_lm(pack, name):
    b = read_bin(pack, name)
    magic, w, h, groups = np.frombuffer(b, "<u4", 4)
    assert magic == 0x314C4D4B, f"{name}: not a KML1 page"
    off, A, B = 16, [], []
    for _ in range(groups):
        A.append(np.frombuffer(b, "<f2", w * h * 4, off).reshape(h, w, 4).astype(np.float32))
        off += w * h * 8
        B.append(np.frombuffer(b, "u1", w * h * 4, off).reshape(h, w, 4))
        off += w * h * 4
    return A, B


def read_vol(pack, name):
    b = read_bin(pack, name)
    magic, nx, ny, nz, groups = np.frombuffer(b, "<u4", 5)
    assert magic == 0x31564D4B, f"{name}: not a KMV1 volume"
    n, off, M, F = int(nx) * ny * nz, 20, [], []
    for _ in range(groups):
        M.append(np.frombuffer(b, "<f2", n * 4, off).reshape(nz, ny, nx, 4).astype(np.float32))
        off += n * 8
        F.append(np.frombuffer(b, "<f2", n * 4, off).reshape(nz, ny, nx, 4).astype(np.float32))
        off += n * 8
    return M, F


class Pack:
    def __init__(self, path):
        self.path = path
        with open(os.path.join(path, "sahne.json"), encoding="utf-8") as f:
            self.j = json.load(f)
        g = self.j["geometri"]
        self.v, self.idx = read_mesh(path, g["dosya"])
        self.ranges = g["araliklar"]
        self.mats = self.j["malzemeler"]
        lm = self.j["isikHaritasi"]
        self.W, self.H, self.G = lm["genislik"], lm["yukseklik"], lm["gruplar"]
        self.pages = [read_lm(path, f) for f in lm["dosya"]]
        self.vols = [(v, read_vol(path, v["dosya"])) for v in self.j["hacimler"] if v.get("dosya")]
        self.tri_mat = np.zeros(len(self.idx) // 3, np.int32)
        self.tri_page = np.zeros(len(self.idx) // 3, np.int32)
        for r in self.ranges:
            t0, t1 = r["ilk"] // 3, (r["ilk"] + r["sayi"]) // 3
            self.tri_mat[t0:t1] = r["malzeme"]
            self.tri_page[t0:t1] = r.get("sayfa", 0)
        self._cover = {}

    def coverage(self, page):
        """per texel of a page: the material of the triangle covering its centre (-1: none)"""
        if page in self._cover:
            return self._cover[page]
        m = np.full((self.H, self.W), -1, np.int32)
        uv = self.v["uv2"].astype(np.float64) / 65535.0
        px = np.stack([uv[:, 0] * self.W - 0.5, uv[:, 1] * self.H - 0.5], 1)
        tris = self.idx.reshape(-1, 3)
        shift = 8
        for t in np.nonzero(self.tri_page == page)[0]:
            pts = np.round(px[tris[t]] * (1 << shift)).astype(np.int32)
            cv2.fillConvexPoly(m, pts, int(self.tri_mat[t]), cv2.LINE_8, shift)
        self._cover[page] = m
        return m


# ---------------------------------------------------------------------------------------------------- display
AGX = np.array([0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772,
                0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104], np.float32).reshape(3, 3)
AGX_INV = np.array([1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417,
                    -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116], np.float32).reshape(3, 3)


def agx(c):
    """linear scene rgb -> linear display rgb (minimal AgX, the sigmoid's polynomial fit)"""
    lo, hi = -12.47393, 4.026069
    v = c @ AGX  # rows of AGX are GLSL's columns: v = M c
    v = np.clip(np.log2(np.maximum(v, 1e-10)), lo, hi)
    x = (v - lo) / (hi - lo)
    x2, x4 = x * x, x ** 4
    v = 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
    v = v @ AGX_INV
    return np.clip(v, 0, 1) ** 2.2


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def to8(c):
    return np.round(srgb(agx(c)) * 255).astype(np.uint8)


def key_exposure(lum, key=0.18):
    lum = lum[np.isfinite(lum) & (lum > 1e-8)]
    if lum.size == 0:
        return 1.0
    return key / math.exp(np.mean(np.log(lum)))


def save(path, rgb8):
    cv2.imwrite(path, cv2.cvtColor(rgb8, cv2.COLOR_RGB2BGR))


def save_view(path, rgb8, width):
    save(path, rgb8)
    h, w = rgb8.shape[:2]
    if w > width:  # a JPG at a size a person looks at
        small = cv2.resize(rgb8, (width, round(h * width / w)), interpolation=cv2.INTER_AREA)
    else:
        small = rgb8
    cv2.imwrite(path[:-4] + ".jpg", cv2.cvtColor(small, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])


# ---------------------------------------------------------------------------------------------------- stats & maps
def page_images(p, out):
    print("light map:")
    for pi, (A, B) in enumerate(p.pages):
        cov = p.coverage(pi)
        inside = cov >= 0
        filled = np.zeros((p.H, p.W), bool)
        for g in range(p.G):
            filled |= B[g].any(axis=2)
        empty = inside & ~filled
        bos = np.zeros((p.H, p.W, 3), np.uint8)
        bos[filled] = (110, 110, 110)
        bos[empty] = (255, 30, 30)
        save(os.path.join(out, f"lm_{pi}_bos.png"), bos)
        line = f"  page {pi}: {int(inside.sum())} texels inside triangles, {int(filled.sum())} filled (with padding), " \
               f"{int(empty.sum())} empty inside a triangle"
        print(line)
        for g in range(p.G):
            a = A[g]
            nan = int((~np.isfinite(a)).sum())
            neg = int((a[..., :3] < 0).sum())
            l0 = (a[..., :3] @ LUM)[inside]
            e = a[..., :3] * (math.pi * Y0)
            k = key_exposure(e[inside] @ LUM, 0.25)
            save(os.path.join(out, f"lm_{pi}_g{g}.png"), to8(e * k))
            print(f"    group {g}: L0 lum min {l0.min():.4g} max {l0.max():.4g} mean {l0.mean():.4g}; "
                  f"black inside {int((l0 <= 0).sum())}; NaN {nan}; negative {neg}")
        ao = A[0][..., 3][inside]
        print(f"    openness: min {ao.min():.3f} mean {ao.mean():.3f}")


def volume_images(p, out):
    print("volumes:")
    for v, (M, F) in p.vols:
        nz, ny, nx = M[0].shape[:3]
        inside = int((M[0][..., 3] < 0.5).sum())
        print(f"  {v['ad']}: {nx}x{ny}x{nz} cells of {v['hucre']} m, {inside} inside geometry")
        for g in range(p.G):
            m = M[g]
            lum = m[..., :3] @ LUM
            open_ = m[..., 3] > 0.5
            nan = int((~np.isfinite(m)).sum() + (~np.isfinite(F[g])).sum())
            print(f"    group {g}: M lum max {lum[open_].max() if open_.any() else 0:.4g} "
                  f"mean {lum[open_].mean() if open_.any() else 0:.4g}; NaN {nan}")
            # the brightest (the beam) just below white, so its structure shows
            k = 0.8 / max(1e-12, float(np.percentile(lum[open_], 99.5))) if open_.any() else 1.0
            scale = max(1, round(600 / max(nx, ny, nz)))
            slices = {"x": m[:, :, nx // 2], "z": m[nz // 2], "y": m[:, max(1, ny // 8)]}  # yz, xy, xz (low)
            for axis, sl in slices.items():
                img = to8(sl[..., :3] * k)
                img[sl[..., 3] < 0.5] = (10, 20, 60)
                if axis == "x":  # rows z, columns y -> image rows y (top = high), columns z (left = -z)
                    img = img.transpose(1, 0, 2)[::-1]
                elif axis == "z":  # rows y, columns x
                    img = img[::-1]
                else:  # rows z, columns x: rows from -z at the top
                    pass
                img = cv2.resize(img, (img.shape[1] * scale, img.shape[0] * scale), interpolation=cv2.INTER_NEAREST)
                save(os.path.join(out, f"vol_{v['ad']}_g{g}_{axis}.png"), img)


# ---------------------------------------------------------------------------------------------------- quick render
def look_at(eye, target):
    f = np.asarray(target, np.float64) - eye
    f /= np.linalg.norm(f)
    r = np.cross(f, [0, 1, 0])
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    return r, u, f


def clip_near(cam, near):
    """a triangle in camera space (z forward) clipped at z = near: a polygon (list of (point, barycentric))"""
    pts = [(cam[i], np.eye(3)[i]) for i in range(3)]
    out = []
    for i in range(3):
        (a, ba), (b, bb) = pts[i], pts[(i + 1) % 3]
        ina, inb = a[2] >= near, b[2] >= near
        if ina:
            out.append((a, ba))
        if ina != inb:
            t = (near - a[2]) / (b[2] - a[2])
            out.append((a + (b - a) * t, ba + (bb - ba) * t))
    return out


def raster(views_tris, W, H, fy):
    """z-buffer: per pixel the triangle (index into views_tris' list) and its barycentrics"""
    depth = np.full((H, W), np.inf, np.float32)
    tid = np.full((H, W), -1, np.int32)
    bary = np.zeros((H, W, 3), np.float32)
    cx, cy = W / 2, H / 2
    for t, cam in enumerate(views_tris):
        if cam[:, 2].max() < 0.05:
            continue
        poly = clip_near(cam, 0.05) if cam[:, 2].min() < 0.05 else [(cam[i], np.eye(3)[i]) for i in range(3)]
        for k in range(1, len(poly) - 1):
            tri = [poly[0], poly[k], poly[k + 1]]
            P = np.array([q for q, _ in tri])
            Bc = np.array([b for _, b in tri])
            sx = cx + fy * P[:, 0] / P[:, 2]
            sy = cy - fy * P[:, 1] / P[:, 2]
            x0, x1 = max(0, int(math.floor(sx.min()))), min(W - 1, int(math.ceil(sx.max())))
            y0, y1 = max(0, int(math.floor(sy.min()))), min(H - 1, int(math.ceil(sy.max())))
            if x0 > x1 or y0 > y1:
                continue
            area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0])
            if abs(area) < 1e-12:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            w0 = ((sx[1] - xs) * (sy[2] - ys) - (sx[2] - xs) * (sy[1] - ys)) / area
            w1 = ((sx[2] - xs) * (sy[0] - ys) - (sx[0] - xs) * (sy[2] - ys)) / area
            w2 = 1 - w0 - w1
            ok = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            if not ok.any():
                continue
            # perspective-correct: screen barycentrics / z
            iz = w0 / P[0, 2] + w1 / P[1, 2] + w2 / P[2, 2]
            z = 1 / iz
            sub_d = depth[y0:y1 + 1, x0:x1 + 1]
            win = ok & (z < sub_d)
            if not win.any():
                continue
            p0, p1, p2 = w0 / P[0, 2] * z, w1 / P[1, 2] * z, w2 / P[2, 2] * z
            b = p0[..., None] * Bc[0] + p1[..., None] * Bc[1] + p2[..., None] * Bc[2]
            sub_d[win] = z[win]
            tid[y0:y1 + 1, x0:x1 + 1][win] = t
            bary[y0:y1 + 1, x0:x1 + 1][win] = b[win]
    return tid, bary


def irradiance(A, B, px, py, n):
    """SALON.md: E(n) from L0 (rgb) and the L1 direction and share, nearest texel"""
    a = A[py, px]
    b = B[py, px].astype(np.float32) / 255.0
    L0 = a[..., :3]
    lum0 = L0 @ LUM
    d = b[..., :3] * 2 - 1
    L1 = d * (b[..., 3:4] * (Y1 / Y0) * lum0[..., None])
    E = math.pi * Y0 * L0 + (2 * math.pi / 3) * Y1 * np.sum(L1 * n, -1, keepdims=True) * (L0 / np.maximum(lum0, 1e-12)[..., None])
    return np.maximum(E, 0.1 * math.pi * Y0 * L0)


def sample_volume(p, pos):
    """the finest volume holding each point: M, F per group (trilinear), or zeros"""
    M = np.zeros((p.G,) + pos.shape[:-1] + (3,), np.float32)
    F = np.zeros_like(M)
    best = np.full(pos.shape[:-1], np.inf)
    for v, (VM, VF) in p.vols:
        lo, cell = np.array(v["alt"], np.float32), v["hucre"]
        nx, ny, nz = v["boyut"]
        q = (pos - lo) / cell - 0.5
        inside = np.all((q >= -0.5) & (q <= np.array([nx, ny, nz]) - 0.5), -1) & (cell < best)
        if not inside.any():
            continue
        best[inside] = cell
        qi = q[inside]
        i0 = np.floor(qi).astype(int)
        f = qi - i0
        for g in range(p.G):
            accM, accF, accW = 0, 0, 0
            for dz in (0, 1):
                for dy in (0, 1):
                    for dx in (0, 1):
                        ix = np.clip(i0[:, 0] + dx, 0, nx - 1)
                        iy = np.clip(i0[:, 1] + dy, 0, ny - 1)
                        iz = np.clip(i0[:, 2] + dz, 0, nz - 1)
                        w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                        cm = VM[g][iz, iy, ix]
                        w = w * cm[:, 3]  # cells inside geometry do not count
                        accM = accM + cm[:, :3] * w[:, None]
                        accF = accF + VF[g][iz, iy, ix][:, :3] * w[:, None]
                        accW = accW + w
            accW = np.maximum(accW, 1e-6)[:, None]
            M[g][inside] = accM / accW
            F[g][inside] = accF / accW
    return M, F


def rotor_world(p, d):
    v, idx = read_mesh(p.path, d["dosya"])
    ax = np.array(d["eksen"], np.float64)
    ax /= np.linalg.norm(ax)
    ref = np.array([0, 1, 0]) if abs(ax[1]) < 0.9 else np.array([0, 0, 1])
    y = np.cross(ref, ax)
    y = np.cross(ax, y) / np.linalg.norm(np.cross(ax, y))
    z = np.cross(ax, y)
    R = np.stack([ax, y, z], 1)  # own frame (x = axis) to world
    pos = v["p"] @ R.T + np.array(d["merkez"])
    n = (v["n"][:, :3].astype(np.float32) / 32767) @ R.T
    return pos, n, idx.reshape(-1, 3), d["araliklar"][0]["malzeme"]


def quick_render(p, name, view, out, width):
    W, H = 1600, 900
    eye = np.array(view["goz"], np.float64)
    r, u, f = look_at(eye, view["hedef"])
    fy = (H / 2) / math.tan(math.radians(view["fov"]) / 2)
    tris = p.idx.reshape(-1, 3)
    P = p.v["p"].astype(np.float64) - eye
    cam = np.stack([P @ r, P @ u, P @ f], 1)
    n_static = len(tris)
    allcam = list(cam[tris])
    rotors = [rotor_world(p, d) for d in p.j["dinamik"]]
    for pos, n, rt, mat in rotors:
        Q = pos - eye
        rc = np.stack([Q @ r, Q @ u, Q @ f], 1)
        allcam += list(rc[rt])
    tid, bary = raster(allcam, W, H, fy)
    lit = np.zeros((p.G, H, W, 3), np.float32)
    emit = np.zeros((p.G, H, W, 3), np.float32)
    albedo = np.array([m["ortalamaAlbedo"] for m in p.mats], np.float32)
    # the static mesh, from the light map
    sel = (tid >= 0) & (tid < n_static)
    ts = tid[sel]
    bs = bary[sel]
    vi = tris[ts]
    uv = np.einsum("pk,pkc->pc", bs, p.v["uv2"][vi].astype(np.float32) / 65535.0)
    nn = np.einsum("pk,pkc->pc", bs, p.v["n"][vi][..., :3].astype(np.float32) / 32767)
    nn /= np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-9)
    pages = p.tri_page[ts]
    mats = p.tri_mat[ts]
    px = np.clip((uv[:, 0] * p.W).astype(int), 0, p.W - 1)
    py = np.clip((uv[:, 1] * p.H).astype(int), 0, p.H - 1)
    for g in range(p.G):
        E = np.zeros((len(ts), 3), np.float32)
        for pi, (A, B) in enumerate(p.pages):
            on = pages == pi
            if on.any():
                E[on] = irradiance(A[g], B[g], px[on], py[on], nn[on])
        c = albedo[mats] / math.pi * E
        lit[g][sel] = c
        for mi, m in enumerate(p.mats):
            if "emissive" in m["bayrak"] and m["grup"] == g:
                on = mats == mi
                lit[g][sel] = np.where(on[:, None], 0, lit[g][sel])
                e = emit[g][sel]
                e[on] = m["isima"]
                emit[g][sel] = e
    # the rotors, from the volumes
    base = n_static
    for pos, n, rt, mat in rotors:
        selr = (tid >= base) & (tid < base + len(rt))
        if selr.any():
            t = tid[selr] - base
            b = bary[selr]
            wp = np.einsum("pk,pkc->pc", b, pos[rt[t]])
            wn = np.einsum("pk,pkc->pc", b, n[rt[t]])
            wn /= np.maximum(np.linalg.norm(wn, axis=1, keepdims=True), 1e-9)
            to_eye = eye - wp
            wn = np.where((np.sum(wn * to_eye, 1) < 0)[:, None], -wn, wn)
            M, F = sample_volume(p, wp)
            for g in range(p.G):
                lm = np.maximum(M[g] @ LUM, 1e-12)
                E = math.pi * M[g] + 2 * math.pi * np.sum(F[g] * wn, 1, keepdims=True) * (M[g] / lm[:, None])
                lit[g][selr] = albedo[mat] / math.pi * np.maximum(E, 0)
        base += len(rt)
    total = sum((lit[g] + emit[g]) * GROUP_RGB[g] for g in range(p.G))
    k = key_exposure((sum(lit[g] * GROUP_RGB[g] for g in range(p.G)) @ LUM)[tid >= 0])
    save_view(os.path.join(out, f"gorunum_{name}.png"), to8(total * k), width)
    for g in range(p.G):
        kg = key_exposure((lit[g] @ LUM)[tid >= 0])
        save_view(os.path.join(out, f"gorunum_{name}_g{g}.png"), to8((lit[g] + emit[g]) * kg), width)
    # black where light should be: static, non-emissive surface pixels with no light of any group
    surf = (tid >= 0) & (tid < n_static)
    emissive = np.array(["emissive" in m["bayrak"] for m in p.mats])
    surf[surf] = ~emissive[p.tri_mat[tid[surf]]]
    dark = surf & (sum(lit[g] for g in range(p.G)) @ LUM <= 0)
    print(f"  view {name}: exposure {k:.4g}; {int(surf.sum())} surface pixels, {int(dark.sum())} of them without light")
    if dark.any():  # where they are: red on the render
        mark = to8(total * k)
        mark[cv2.dilate(dark.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0] = (255, 0, 0)
        save_view(os.path.join(out, f"gorunum_{name}_karanlik.png"), mark, width)


# ---------------------------------------------------------------------------------------------------- noise
def noise(p, q):
    """p: the reference (more samples), q: the same scene with fewer (nested)"""
    print(f"noise: {q.path} against {p.path}")
    ns_p, ns_q = p.j["firin"]["ornek"], q.j["firin"]["ornek"]
    albedo = np.array([m["ortalamaAlbedo"] for m in p.mats], np.float32)
    for g in range(p.G):
        xs, ys = [], []
        for pi in range(len(p.pages)):
            cov = p.coverage(pi)
            inside = cov >= 0
            al = albedo[np.maximum(cov, 0)]
            for pk, lst in ((p, xs), (q, ys)):
                e = pk.pages[pi][0][g][..., :3] * (math.pi * Y0)
                lst.append((al / math.pi * e)[inside])
        x, y = np.concatenate(xs), np.concatenate(ys)
        k = key_exposure(x @ LUM)
        dx = srgb(agx(x * k)) * 255
        dy = srgb(agx(y * k)) * 255
        d = (dy - dx).reshape(-1)
        sd = float(d.std())
        p99 = float(np.percentile(np.abs(d), 99))
        # nested: d = (3/4)(x_256 - x_768) for 256 in 1024 -> std(d) = sqrt(1 - nq/np) * sigma_q
        sigma_q = sd / math.sqrt(max(1e-9, 1 - ns_q / ns_p))
        need = ns_q * (sigma_q / 0.5) ** 2
        print(f"  group {g}: {ns_q} vs {ns_p} samples: difference std {sd:.3f}/255, 99th percentile {p99:.3f}/255; "
              f"noise at {ns_q}: {sigma_q:.3f}/255, at {ns_p}: {sigma_q * math.sqrt(ns_q / ns_p):.3f}/255; "
              f"< 0.5/255 from about {need:.0f} samples")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pack")
    ap.add_argument("--cikti")
    ap.add_argument("--fark")
    ap.add_argument("--genislik", type=int, default=1600)
    ap.add_argument("--sadece-fark", action="store_true", help="only the noise numbers")
    a = ap.parse_args()
    p = Pack(a.pack)
    if a.fark:
        noise(p, Pack(a.fark))
        if a.sadece_fark:
            return
    out = a.cikti or a.pack.rstrip("/\\") + "_bak"
    os.makedirs(out, exist_ok=True)
    print("files:")
    for fn in sorted(os.listdir(a.pack)):
        fp = os.path.join(a.pack, fn)
        if os.path.isfile(fp):
            print(f"  {fn}: {os.path.getsize(fp) / 1048576:.2f} MiB")
    f = p.j["firin"]
    print(f"bake: {f['ornek']} samples, {f['hacimOrnek']} per cell, {f['sure_sn']} s, clamp {f['sinir']}")
    page_images(p, out)
    volume_images(p, out)
    print("quick render:")
    for name in ("fanlar", "rgb"):
        quick_render(p, name, p.j["gorunumler"][name], out, a.genislik)
    print(f"images: {out}")


if __name__ == "__main__":
    sys.exit(main())
