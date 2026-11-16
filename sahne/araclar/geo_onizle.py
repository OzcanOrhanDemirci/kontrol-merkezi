"""Headless preview of the hall's geometry (salon.exe dump): the builder's own check, not the product.

    salon.exe dump --out DIR
    python sahne/araclar/geo_onizle.py DIR [--out DIR/onizleme] [--only fanlar,rgb] [--size 2560x1440]

For every view it writes two images (PNG at full size, a ~1600 px JPG to look at):
  <view>_geo  plain shading (a headlight and a fixed sun), colour by material; back faces magenta, front faces whose
              normal points away cyan (a winding/normal mismatch); levha faces show a uv checker whose top-left cell is
              red (uv 0,0); emissive faces in their group's colour; anchors as wire boxes (tik yellow, levha green,
              nokta red), the journey as a white line
  <view>_isik direct light from the emitters (no shadows), a little ambient, fog by distance, a simple tonemap
Views: fanlar, rgb, yol_25/50/75 (points along the journey looking ahead), ust (plan, ceiling cut away),
yan (section along the aisle from +x), and a few close-ups (yakin_*).
It also checks the journey's clearance to the geometry (every 0.25 m) and prints the closest approach.
"""
import argparse
import json
import math
import os
import struct
import sys

import numpy as np
from PIL import Image

import moderngl

GROUP_COLOUR = {0: (0.85, 0.92, 1.0), 1: (1.0, 0.55, 0.22), 2: (1.0, 0.82, 0.58)}


def load_mesh(path):
    with open(path, 'rb') as f:
        magic, nv, ni, stride = struct.unpack('<4I', f.read(16))
        assert magic == 0x3144474B and stride == 48, path
        v = np.frombuffer(f.read(nv * 48), dtype=np.float32).reshape(nv, 12)
        i = np.frombuffer(f.read(ni * 4), dtype=np.uint32)
    return v.copy(), i.copy()


def look_at(eye, target, up):
    eye, target, up = (np.asarray(a, np.float64) for a in (eye, target, up))
    f = target - eye
    f /= np.linalg.norm(f)
    r = np.cross(f, up)
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    m = np.eye(4)
    m[0, :3], m[1, :3], m[2, :3] = r, u, -f
    m[:3, 3] = -m[:3, :3] @ eye
    return m


def perspective(fov_deg, aspect, near=0.25, far=800.0):
    t = 1.0 / math.tan(math.radians(fov_deg) / 2)
    m = np.zeros((4, 4))
    m[0, 0], m[1, 1] = t / aspect, t
    m[2, 2], m[2, 3] = (far + near) / (near - far), 2 * far * near / (near - far)
    m[3, 2] = -1
    return m


def ortho(half_h, aspect, near=0.1, far=2000.0):
    m = np.eye(4)
    m[0, 0], m[1, 1] = 1 / (half_h * aspect), 1 / half_h
    m[2, 2], m[2, 3] = -2 / (far - near), -(far + near) / (far - near)
    return m


def dyn_model(centre, axis):
    """own frame: x = axis, y = world up made perpendicular, z = x × y (docs/SALON.md)"""
    x = np.asarray(axis, np.float64)
    x /= np.linalg.norm(x)
    up = np.array([0.0, 1.0, 0.0]) if abs(x[1]) < 0.99 else np.array([1.0, 0.0, 0.0])
    y = up - x * np.dot(up, x)
    y /= np.linalg.norm(y)
    z = np.cross(x, y)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, z, centre
    return m


VS = '''
#version 330
uniform mat4 mvp; uniform mat4 model;
in vec3 p; in vec3 n; in vec2 uv; in float mat;
out vec3 wp; out vec3 wn; out vec2 vuv; flat out int vmat;
void main(){ vec4 w = model*vec4(p,1); wp = w.xyz; wn = mat3(model)*n; vuv = uv; vmat = int(mat+0.5); gl_Position = mvp*w; }
'''

FS = '''
#version 330
uniform vec3 eye; uniform int mode; uniform vec4 clipPlane;
uniform vec3 albedo[24]; uniform int flags[24]; uniform int group[24]; uniform float emission[24];
uniform vec3 gcol[3];
uniform int nl; uniform float lL[48]; uniform vec4 lc[48]; uniform vec4 lu[48]; uniform vec4 lv[48]; uniform vec4 ln[48];
in vec3 wp; in vec3 wn; in vec2 vuv; flat in int vmat;
out vec4 o;
void main(){
  if (dot(vec4(wp,1), clipPlane) > 0.0) discard;
  vec3 N = normalize(wn); vec3 V = normalize(eye - wp);
  int fl = flags[vmat];
  bool emissive = (fl & 1) != 0, levha = (fl & 8) != 0;
  vec3 a = albedo[vmat];
  if (mode == 0) {
    if (!gl_FrontFacing) { o = vec4(1,0,1,1); return; }
    if (dot(N, V) < -0.3) { o = vec4(0,1,1,1); return; }
    if (emissive) { o = vec4(gcol[group[vmat]], 1); return; }
    vec3 c = pow(a, vec3(0.5)) * 1.25;
    if (levha) {
      vec2 q = floor(vuv * vec2(8.0, 4.0));
      float k = mod(q.x + q.y, 2.0);
      c = mix(vec3(0.75,0.75,0.7), vec3(0.35,0.35,0.4), k);
      if (vuv.x < 0.125 && vuv.y < 0.25) c = vec3(0.9,0.1,0.1);
      if (vuv.x > 0.875 && vuv.y > 0.75) c = vec3(0.1,0.3,0.9);
    }
    float l = 0.22 + 0.55*abs(dot(N, V)) + 0.35*max(0.0, dot(N, normalize(vec3(0.35, 1.0, 0.45))));
    o = vec4(c*l, 1); return;
  }
  // lit: direct light from every emitter, no shadows
  float d = length(eye - wp);
  vec3 col;
  if (emissive) col = gcol[group[vmat]] * emission[vmat];
  else {
    vec3 E = vec3(0);
    for (int i = 0; i < nl; ++i) {
      int g = int(lc[i].w); int type = int(lu[i].w);
      vec3 L = lc[i].xyz - wp; float dd = dot(L,L); vec3 l = L*inversesqrt(dd);
      float cr = max(0.0, dot(N, l));
      float power;
      if (type == 1) { float r = lv[i].w; power = 3.14159*r*r; }
      else { float area = 4.0*length(cross(lu[i].xyz, lv[i].xyz)); float ce = max(0.0, dot(ln[i].xyz, -l)); power = area*pow(ce, ln[i].w); }
      E += gcol[g] * lL[i] * power * cr / (dd + 0.05);
    }
    col = a/3.14159*E + a*0.012;
  }
  float T = exp(-0.012*d);
  col = col*T + vec3(0.010,0.011,0.012)*(1.0-T);
  col *= 2.2; col = col/(1.0+col);
  o = vec4(pow(col, vec3(1.0/2.2)), 1);
}
'''


LINE_VS = '''
#version 330
uniform mat4 mvp; in vec3 p; in vec3 c; out vec3 vc;
void main(){ vc = c; gl_Position = mvp*vec4(p,1); }
'''
LINE_FS = '''
#version 330
in vec3 vc; out vec4 o; void main(){ o = vec4(vc,1); }
'''


def box_lines(a):
    c, x, y, z = (np.array(a[k]) for k in ('c', 'x', 'y', 'z'))
    pts = [c + sx * x + sy * y + sz * z for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    edges = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]
    return [(pts[i], pts[j]) for i, j in edges]


def closest_on_triangles(p, A, B, C):
    """distance from point p to each triangle (vectorised, Ericson's closest point)"""
    ab, ac, ap = B - A, C - A, p - A
    d1, d2 = (ab * ap).sum(1), (ac * ap).sum(1)
    bp = p - B
    d3, d4 = (ab * bp).sum(1), (ac * bp).sum(1)
    cp = p - C
    d5, d6 = (ab * cp).sum(1), (ac * cp).sum(1)
    va = d3 * d6 - d5 * d4
    vb = d5 * d2 - d1 * d6
    vc = d1 * d4 - d3 * d2
    denom = 1.0 / np.maximum(va + vb + vc, 1e-30)
    v = vb * denom
    w = vc * denom
    q = A + ab * v[:, None] + ac * w[:, None]
    # the regions outside the face
    m = (d1 <= 0) & (d2 <= 0); q[m] = A[m]
    m2 = (d3 >= 0) & (d4 <= d3) & ~m; q[m2] = B[m2]
    m3 = (d6 >= 0) & (d5 <= d6) & ~m & ~m2; q[m3] = C[m3]
    done = m | m2 | m3
    mab = (vc <= 0) & (d1 >= 0) & (d3 <= 0) & ~done
    t = d1 / np.where(d1 - d3 != 0, d1 - d3, 1); q[mab] = (A + ab * t[:, None])[mab]
    mac = (vb <= 0) & (d2 >= 0) & (d6 <= 0) & ~done & ~mab
    t = d2 / np.where(d2 - d6 != 0, d2 - d6, 1); q[mac] = (A + ac * t[:, None])[mac]
    mbc = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0) & ~done & ~mab & ~mac
    t = (d4 - d3) / np.where((d4 - d3) + (d5 - d6) != 0, (d4 - d3) + (d5 - d6), 1)
    q[mbc] = (B + (C - B) * t[:, None])[mbc]
    return np.linalg.norm(q - p, axis=1)


def clearance(V, I, path):
    P = V[:, :3].astype(np.float64)
    T = I.reshape(-1, 3)
    A, B, C = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    lo, hi = np.minimum(np.minimum(A, B), C), np.maximum(np.maximum(A, B), C)
    pts = []
    path = np.asarray(path, np.float64)
    for a, b in zip(path[:-1], path[1:]):
        n = max(1, int(math.ceil(np.linalg.norm(b - a) / 0.25)))
        for k in range(n):
            pts.append(a + (b - a) * k / n)
    pts.append(path[-1])
    pts = np.array(pts)
    plo, phi = pts.min(0) - 3, pts.max(0) + 3
    keep = np.all(hi >= plo, 1) & np.all(lo <= phi, 1)
    A, B, C, lo, hi = A[keep], B[keep], C[keep], lo[keep], hi[keep]
    best = (1e9, None, None)
    per = []
    for p in pts:
        near = np.all(hi >= p - 2.5, 1) & np.all(lo <= p + 2.5, 1)
        if not near.any():
            per.append(2.5)
            continue
        d = closest_on_triangles(p, A[near], B[near], C[near])
        k = int(np.argmin(d))
        per.append(float(d[k]))
        if d[k] < best[0]:
            best = (float(d[k]), p, A[near][k])
    return best, np.array(per), pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir')
    ap.add_argument('--out')
    ap.add_argument('--only')
    ap.add_argument('--size', default='2560x1440')
    ap.add_argument('--no-check', action='store_true')
    a = ap.parse_args()
    out = a.out or os.path.join(a.dir, 'onizleme')
    os.makedirs(out, exist_ok=True)
    W, H = (int(x) for x in a.size.split('x'))
    D = json.load(open(os.path.join(a.dir, 'dump.json')))
    V, I = load_mesh(os.path.join(a.dir, D['static']))
    print(f"static: {len(V)} vertices, {len(I)//3} triangles")

    if not a.no_check:
        (dmin, p, q), per, pts = clearance(V, I, D['path'])
        print(f"journey clearance: min {dmin:.2f} m at {np.round(p, 2).tolist()} (geometry near {np.round(q, 2).tolist()})")
        bad = per < 1.5
        if bad.any():
            print(f"  {bad.sum()} of {len(per)} samples closer than 1.5 m, e.g. {np.round(pts[bad][:5], 2).tolist()}")

    ctx = moderngl.create_standalone_context(require=330)
    prog = ctx.program(vertex_shader=VS, fragment_shader=FS)
    lprog = ctx.program(vertex_shader=LINE_VS, fragment_shader=LINE_FS)

    def vao_for(v, i):
        vbo = ctx.buffer(v.astype('f4').tobytes())
        ibo = ctx.buffer(i.astype('u4').tobytes())
        return ctx.vertex_array(prog, [(vbo, '3f 3f 2f 2x4 1f 1x4', 'p', 'n', 'uv', 'mat')], ibo)

    meshes = [(vao_for(V, I), np.eye(4))]
    for d in D['dynamic']:
        dv, di = load_mesh(os.path.join(a.dir, d['file']))
        meshes.append((vao_for(dv, di), dyn_model(d['centre'], d['axis'])))

    mats = D['materials']
    alb = [tuple(m['colour']) for m in mats] + [(0, 0, 0)] * (24 - len(mats))
    prog['albedo'].value = alb
    prog['flags'].value = [m['flags'] for m in mats] + [0] * (24 - len(mats))
    prog['group'].value = [max(0, m['group']) for m in mats] + [0] * (24 - len(mats))
    prog['emission'].value = [m['emission'] for m in mats] + [0.0] * (24 - len(mats))
    prog['gcol'].value = [GROUP_COLOUR[0], GROUP_COLOUR[1], GROUP_COLOUR[2]]
    L = D['lights'][:48]
    pad = 48 - len(L)
    prog['nl'].value = len(L)
    prog['lc'].value = [tuple(l['c']) + (float(l['group']),) for l in L] + [(0, 0, 0, 0)] * pad
    prog['lu'].value = [tuple(l['u']) + (float(l['type']),) for l in L] + [(0, 0, 0, 0)] * pad
    prog['lv'].value = [tuple(l['v']) + (float(l['r']),) for l in L] + [(0, 0, 0, 0)] * pad
    prog['ln'].value = [tuple(l['n']) + (float(max(1.0, l['lobe'])),) for l in L] + [(0, 0, 0, 0)] * pad
    prog['lL'].value = [float(l['L']) for l in L] + [0.0] * pad

    # wire boxes for the anchors, the journey
    col = {'tik': (1, 0.9, 0.1), 'levha': (0.2, 1, 0.3), 'nokta': (1, 0.2, 0.2)}
    segs = []
    for an in D['anchors']:
        for p0, p1 in box_lines(an):
            segs += [tuple(p0) + col[an['type']], tuple(p1) + col[an['type']]]
    path = D['path']
    for p0, p1 in zip(path[:-1], path[1:]):
        segs += [tuple(p0) + (1, 1, 1), tuple(p1) + (1, 1, 1)]
    lbo = ctx.buffer(np.array(segs, 'f4').tobytes())
    lvao = ctx.vertex_array(lprog, [(lbo, '3f 3f', 'p', 'c')])

    msaa = ctx.framebuffer(color_attachments=[ctx.renderbuffer((W, H), samples=4)], depth_attachment=ctx.depth_renderbuffer((W, H), samples=4))
    res = ctx.framebuffer(color_attachments=[ctx.renderbuffer((W, H))])
    aspect = W / H

    def pt(i):
        return path[min(len(path) - 1, max(0, i))]

    views = {}
    fv, rv = D['views']['fanlar'], D['views']['rgb']
    views['fanlar'] = (look_at(fv['eye'], fv['target'], (0, 1, 0)), perspective(fv['fov'], aspect), fv['eye'], None)
    views['rgb'] = (look_at(rv['eye'], rv['target'], (0, 1, 0)), perspective(rv['fov'], aspect), rv['eye'], None)
    for frac in (25, 50, 75):
        i = int(len(path) * frac / 100)
        e = np.array(pt(i))
        t = np.array(pt(i + 8)) + np.array([0, 1.2, 0])
        views[f'yol_{frac}'] = (look_at(e, t, (0, 1, 0)), perspective(50, aspect), e.tolist(), None)
    views['ust'] = (look_at((0, 300, -137), (0, 0, -137), (-1, 0, 0)), ortho(80, aspect), (0, 300, -137), (0, 1, 0, -23.0))
    views['yan'] = (look_at((300, 13, -137), (0, 13, -137), (0, 1, 0)), ortho(80, aspect), (300, 13, -137), (1, 0, 0, -0.5))
    close = {
        'yakin_fan_kasa': ((-2.5, 5.0, -9.0), (-11.5, 8.0, -26.0), 40),
        'yakin_fan_gpu': ((2.5, 5.0, -9.0), (11.5, 8.0, -26.0), 40),
        'yakin_pano_gpu': ((4.0, 4.0, -24.0), (10.6, 3.6, -34.6), 45),
        'yakin_kuyu': ((0.0, 1.8, -44.0), (0.0, 20.0, -31.0), 60),
        'yakin_iskele': ((3.5, 6.2, -12.0), (0.0, 3.0, -4.0), 55),
        'yakin_kemer_alt': ((2.5, 2.6, -244.0), (-0.8, 2.2, -252.4), 45),
        'yakin_kemer_ust': ((0.0, 14.0, -246.0), (0.0, 20.5, -256.0), 50),
        'yakin_kolon': ((3.0, 2.0, -66.0), (7.0, 3.5, -60.0), 55),
        'yakin_gecit': ((-24.0, 12.0, -60.0), (-28.3, 11.0, -46.0), 60),
        'yakin_tabela': ((0.0, 9.0, -30.0), (0.0, 14.5, -43.0), 45),
        'yakin_gobek': ((-6.0, 8.0, -21.0), (-12.9, 8.5, -24.0), 40),
        'yakin_kalip': ((4.5, 3.0, -62.0), (7.0, 3.0, -60.5), 40),
        'yakin_kapi': ((-27.6, 13.6, -144.0), (-30.0, 13.0, -150.0), 55),
        'yakin_kanal': ((25.0, 1.6, -86.0), (28.0, 0.0, -92.0), 50),
        'yakin_kol': ((-0.4, 3.4, -248.8), (-1.6, 2.6, -252.2), 45),
        'yakin_tabela_kemer': ((-3.0, 9.0, -200.0), (-9.0, 9.0, -247.0), 12),
    }
    for k, (e, t, f) in close.items():
        views[k] = (look_at(e, t, (0, 1, 0)), perspective(f, aspect), list(e), None)

    only = set(a.only.split(',')) if a.only else None
    for name, (view, proj, eye, clip) in views.items():
        if only and name not in only:
            continue
        for mode, suffix in ((0, 'geo'), (1, 'isik')):
            if mode == 1 and (name in ('ust', 'yan') or name.startswith('yakin_')):
                continue
            msaa.use()
            ctx.enable(moderngl.DEPTH_TEST)
            ctx.disable(moderngl.CULL_FACE)
            ctx.clear(0.02, 0.02, 0.03, 1.0) if mode == 0 else ctx.clear(0.0, 0.0, 0.0, 1.0)
            prog['eye'].value = tuple(float(x) for x in eye)
            prog['mode'].value = mode
            prog['clipPlane'].value = clip if clip else (0, 0, 0, -1)
            for vao, model in meshes:
                prog['model'].write((model).T.astype('f4').tobytes())
                prog['mvp'].write((proj @ view).T.astype('f4').tobytes())   # the shader applies model
                vao.render()
            if mode == 0:
                lprog['mvp'].write((proj @ view).T.astype('f4').tobytes())
                lvao.render(moderngl.LINES)
            ctx.copy_framebuffer(res, msaa)
            img = Image.frombytes('RGB', (W, H), res.read(components=3)).transpose(Image.FLIP_TOP_BOTTOM)
            base = os.path.join(out, f'{name}_{suffix}')
            img.save(base + '.png')
            small = img.copy()
            small.thumbnail((1600, 1600), Image.LANCZOS)
            small.save(base + '.jpg', quality=90)
            print('wrote', base + '.jpg')


if __name__ == '__main__':
    sys.exit(main())
