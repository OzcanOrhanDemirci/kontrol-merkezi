// Kontrol Merkezi · the hall's live renderer (WebGL2). docs/SALON.md is the reference: the pack it reads ("The pack")
// and the frame it draws ("The live renderer"); ui/salon/README.md lists the API, the passes and their measured cost.
// Plain script, no build step, no libraries: window.KM_SALON.create(canvas, options) -> the renderer.
// Deterministic: no random numbers at run time; every pixel takes the same samples every frame.
'use strict';
(() => {
const SCRIPT_BASE = new URL('.', document.currentScript ? document.currentScript.src : location.href);
const SHADER_FILES = ['common.glsl', 'scene.vert', 'scene.frag', 'depth.frag', 'rotor.vert', 'rotor.frag', 'quad.vert',
  'haze.frag', 'post.frag', 'combine.frag'];

// ==================================================================== small maths (column-major 4x4)
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const NEAR = 0.1, FAR = 1200;

function cameraOf(eye, target, fovDeg, aspect) {
  const F = norm(sub(target, eye));
  let R = cross(F, [0, 1, 0]);
  R = len(R) < 1e-6 ? [1, 0, 0] : norm(R);
  const U = cross(R, F);
  const ty = Math.tan(fovDeg * Math.PI / 360), tx = ty * aspect;
  const A = -(FAR + NEAR) / (FAR - NEAR), B = -2 * FAR * NEAR / (FAR - NEAR);
  // VP = P * V with V's rows R, U, -F
  const vp = new Float32Array(16);
  const rows = [scl(R, 1 / tx), scl(U, 1 / ty)];
  for (let i = 0; i < 3; i++) {
    vp[i * 4 + 0] = rows[0][i];
    vp[i * 4 + 1] = rows[1][i];
    vp[i * 4 + 2] = -A * F[i];
    vp[i * 4 + 3] = F[i];
  }
  vp[12] = -dot(rows[0], eye);
  vp[13] = -dot(rows[1], eye);
  vp[14] = A * dot(F, eye) + B;
  vp[15] = -dot(F, eye);
  return { eye: eye.slice(), F, R, U, tx, ty, vp };
}
// the rotor/lever frame: x = its axis, y = the world's up made perpendicular, z = x cross y; spun by angle about x
function frameOf(axis, centre, angle) {
  const x = norm(axis);
  let y = sub([0, 1, 0], scl(x, x[1]));
  y = len(y) < 0.1 ? norm(sub([0, 0, 1], scl(x, x[2]))) : norm(y);
  const z = cross(x, y);
  const c = Math.cos(angle), s = Math.sin(angle);
  const yy = add(scl(y, c), scl(z, s)), zz = sub(scl(z, c), scl(y, s));
  return { x, y: yy, z: zz, m: new Float32Array([...x, 0, ...yy, 0, ...zz, 0, ...centre, 1]) };
}
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// ==================================================================== deterministic tables made once at load
// a 32-bit hash (seeded, the same every run): the only "randomness" here, and only to build fixed textures
function hash32(i) {
  i = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); i ^= i >>> 13;
  i = Math.imul(i, 0xc2b2ae35); i ^= i >>> 16;
  return (i >>> 0) / 4294967296;
}
// smooth tiled value noise, 64^3, two octaves (lattice periods 16 and 8 texels), quintic interpolation, 0..1
function noiseVolume() {
  const N = 64, out = new Uint8Array(N * N * N);
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const octave = (cells, seed) => {
    const lat = new Float32Array(cells * cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = hash32(i * 7919 + seed);
    const s = cells / N, v = new Float32Array(N * N * N);
    let k = 0;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = x * s, fy = y * s, fz = z * s;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
      const u = fade(fx - x0), w = fade(fy - y0), q = fade(fz - z0);
      const L = (a, b, c) => lat[((c % cells) * cells + (b % cells)) * cells + (a % cells)];
      const l00 = L(x0, y0, z0) + (L(x0 + 1, y0, z0) - L(x0, y0, z0)) * u;
      const l10 = L(x0, y0 + 1, z0) + (L(x0 + 1, y0 + 1, z0) - L(x0, y0 + 1, z0)) * u;
      const l01 = L(x0, y0, z0 + 1) + (L(x0 + 1, y0, z0 + 1) - L(x0, y0, z0 + 1)) * u;
      const l11 = L(x0, y0 + 1, z0 + 1) + (L(x0 + 1, y0 + 1, z0 + 1) - L(x0, y0 + 1, z0 + 1)) * u;
      const a = l00 + (l10 - l00) * w, b = l01 + (l11 - l01) * w;
      v[k++] = a + (b - a) * q;
    }
    return v;
  };
  const a = octave(4, 11), b = octave(8, 101);
  let lo = 1e9, hi = -1e9;
  const v = new Float32Array(a.length);
  for (let i = 0; i < v.length; i++) { v[i] = a[i] * 0.7 + b[i] * 0.3; lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
  for (let i = 0; i < v.length; i++) out[i] = Math.round((v[i] - lo) / (hi - lo) * 255);
  return out;
}
// a 64 x 64 blue-noise rank tile (void and cluster, Ulichney 1993; toroidal Gaussian, sigma 1.5): the dither
function blueNoise() {
  const N = 64, NN = N * N, sig = 1.5, R = 7;
  const ker = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) ker.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * sig * sig))]);
  const E = new Float64Array(NN), on = new Uint8Array(NN);
  const splat = (i, s) => { const x = i % N, y = (i / N) | 0; for (const [dx, dy, w] of ker) E[((y + dy + N) % N) * N + (x + dx + N) % N] += s * w; };
  const tightest = () => { let b = -1, bv = -1e30; for (let i = 0; i < NN; i++) if (on[i] && E[i] > bv) { bv = E[i]; b = i; } return b; };
  const largestVoid = () => { let b = -1, bv = 1e30; for (let i = 0; i < NN; i++) if (!on[i] && E[i] < bv) { bv = E[i]; b = i; } return b; };
  // initial pattern: 10 % of the cells from the hash, then relaxed until the tightest cluster is the largest void
  const ones = Math.round(NN * 0.1);
  for (let k = 0, i = 0; k < ones; i++) { const c = Math.floor(hash32(i * 31 + 5) * NN); if (!on[c]) { on[c] = 1; splat(c, 1); k++; } }
  for (let it = 0; it < 4 * NN; it++) {
    const t = tightest(); on[t] = 0; splat(t, -1);
    const v = largestVoid();
    if (v === t) { on[t] = 1; splat(t, 1); break; }
    on[v] = 1; splat(v, 1);
  }
  const rank = new Int32Array(NN);
  const proto = on.slice(), protoE = E.slice();
  for (let r = ones - 1; r >= 0; r--) { const t = tightest(); on[t] = 0; splat(t, -1); rank[t] = r; }
  on.set(proto); E.set(protoE);
  for (let r = ones; r < NN; r++) { const v = largestVoid(); on[v] = 1; splat(v, 1); rank[v] = r; }
  const out = new Uint8Array(NN);
  for (let i = 0; i < NN; i++) out[i] = Math.min(255, Math.floor((rank[i] + 0.5) * 256 / NN));
  return out;
}

// ==================================================================== the renderer
async function create(canvas, options = {}) {
  let failed = false;            // after the first error the loads still running report nothing more
  const say = (f, t) => { if (options.onProgress && !failed) try { options.onProgress(f, t); } catch (e) { /* the page's handler */ } };
  const fail = msg => { const e = new Error(msg); if (!failed) { say(1, msg); console.error('Salon: ' + msg); } failed = true; return e; };
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
    preserveDrawingBuffer: !!options.preserveDrawingBuffer, powerPreference: 'high-performance',
  });
  if (!gl) throw fail('WebGL2 kullanılamıyor');
  for (const ext of ['EXT_color_buffer_float', 'OES_texture_float_linear'])
    if (!gl.getExtension(ext)) throw fail('Bu ekran kartı sürücüsünde ' + ext + ' yok');
  const extTimer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const extPar = gl.getExtension('KHR_parallel_shader_compile');
  const extAniso = gl.getExtension('EXT_texture_filter_anisotropic');
  const base = new URL(options.base || '/sahne/', location.href);
  const Q = {                                   // quality settings (setQuality); measured defaults, README.md
    scale: options.scale || 2,                  // supersampling: the scene pass at scale x the canvas' device pixels
    hazeScale: 0.5,                             // the haze pass' resolution, share of the canvas
    hazeStep: 1,                                // haze steps: 1 = half a cell; 0.5 = twice as many
    reflScale: 0.5,                             // the reflection's resolution, share of the scene pass'
    prepass: true,                              // depth prepass before the scene pass
    bands: 6,                                   // flushed horizontal bands of the heavy passes
    cubic: true,                                // the light map's B-spline read close up
    rotor: 'auto',                              // 'auto': crisp mesh when slow, the blurred disc when fast; 'disc', 'mesh' (tests)
  };
  if (options.quality) Object.assign(Q, options.quality);

  // ---------------------------------------------------------------- loading
  let done = 0, total = 1;
  const tick = text => { done++; say(Math.min(0.9, done / total * 0.9), text); };
  async function fetchBytes(file) {
    let r;
    try { r = await fetch(new URL(file, base)); } catch (e) { throw fail(file + ': okunamadı (' + e.message + ')'); }
    if (!r.ok) throw fail(file + ': bulunamadı (HTTP ' + r.status + ')');
    let buf;
    if (/\.gz$/.test(file)) buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    else if (/\.z$/.test(file)) buf = await new Response(r.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
    else buf = await r.arrayBuffer();
    tick(file);
    return buf;
  }
  say(0, 'sahne.json');
  let pack;
  try {
    const r = await fetch(new URL('sahne.json', base));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    pack = await r.json();
  } catch (e) { throw fail('sahne.json okunamadı: ' + e.message); }
  if (pack.surum !== 1) throw fail('sahne.json: desteklenmeyen sürüm ' + pack.surum);
  const lmDef = pack.isikHaritasi;
  if (!lmDef || lmDef.gruplar !== 3) throw fail('sahne.json: ışık haritası üç grup içermeli');
  const volDefs = (pack.hacimler || []).filter(v => v.dosya).sort((a, b) => a.hucre - b.hucre);
  if (!volDefs.length) throw fail('sahne.json: pişmiş ışık hacmi yok');
  if (volDefs.length > 8) throw fail('sahne.json: en çok 8 hacim okunabilir');
  const mats = pack.malzemeler || [];
  if (mats.length > 64) throw fail('sahne.json: en çok 64 malzeme');
  const dynDefs = pack.dinamik || [];
  const anchorList = pack.capalar || [];
  const anchors = Object.fromEntries(anchorList.map(a => [a.ad, a]));
  const flagOf = (m, f) => (m.bayrak || []).includes(f);

  // texture sets: one layer per distinct (albedo, normal, arm)
  const texKey = m => (m.albedo || m.normal || m.arm) ? [m.albedo || '', m.normal || '', m.arm || ''].join('|') : null;
  const layerOf = new Map(), sets = [];
  for (const m of mats) { const k = texKey(m); if (k && !layerOf.has(k)) { layerOf.set(k, sets.length); sets.push(m); } }
  const imageFiles = [...new Set(sets.flatMap(m => [m.albedo, m.normal, m.arm]).filter(Boolean))];
  const binFiles = [pack.geometri.dosya, ...dynDefs.map(d => d.dosya), ...lmDef.dosya, ...volDefs.map(v => v.dosya)];
  total = binFiles.length + imageFiles.length + SHADER_FILES.length + 3;
  const [bins, images, sources] = await Promise.all([
    Promise.all(binFiles.map(fetchBytes)),
    Promise.all(imageFiles.map(async f => {
      const r = await fetch(new URL(f, base)).catch(e => { throw fail(f + ': okunamadı (' + e.message + ')'); });
      if (!r.ok) throw fail(f + ': doku bulunamadı (HTTP ' + r.status + ')');
      const blob = await r.blob();
      let bmp;
      try {
        bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
        if (bmp.width !== 2048 || bmp.height !== 2048) {
          const r2 = await createImageBitmap(bmp, { resizeWidth: 2048, resizeHeight: 2048, resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          bmp.close(); bmp = r2;
        }
      } catch (e) { throw fail(f + ': doku çözülemedi (' + e.message + ')'); }
      tick(f);
      return bmp;
    })),
    Promise.all(SHADER_FILES.map(async f => {
      const r = await fetch(new URL(f, SCRIPT_BASE)).catch(e => { throw fail(f + ': gölgelendirici okunamadı (' + e.message + ')'); });
      if (!r.ok) throw fail(f + ': gölgelendirici bulunamadı (HTTP ' + r.status + ')');
      const t = await r.text();
      tick(f);
      return t;
    })),
  ]);
  const bin = Object.fromEntries(binFiles.map((f, i) => [f, bins[i]]));
  const img = Object.fromEntries(imageFiles.map((f, i) => [f, images[i]]));
  const src = Object.fromEntries(SHADER_FILES.map((f, i) => [f, sources[i]]));

  // ---------------------------------------------------------------- GPU resources
  const owned = [];                             // [kind, object, bytes]
  let bytes = 0;
  const own = (kind, o, b = 0) => { owned.push([kind, o, b]); bytes += b; return o; };
  const drop = o => {
    const i = owned.findIndex(x => x[1] === o);
    if (i < 0) return;
    const [kind, obj, b] = owned.splice(i, 1)[0];
    gl['delete' + kind](obj); bytes -= b;
  };
  function tex(target, params = {}) {
    const t = own('Texture', gl.createTexture(), params.bytes || 0);
    gl.bindTexture(target, t);
    const f = params.filter || gl.LINEAR, wrap = params.wrap || gl.CLAMP_TO_EDGE;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, params.mips ? gl.LINEAR_MIPMAP_LINEAR : f);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrap);
    if (target === gl.TEXTURE_3D || target === gl.TEXTURE_2D_ARRAY) gl.texParameteri(target, gl.TEXTURE_WRAP_R, wrap);
    if (params.aniso && extAniso) gl.texParameterf(target, extAniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, gl.getParameter(extAniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return t;
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE), max3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);

  // material texture arrays (2048^2 layers, mips, anisotropic 16x): albedo sRGB, normal and ARM as data
  say(0.9, 'Dokular yükleniyor');
  const nSets = Math.max(1, sets.length), MIPS = 12;
  const matTex = [];
  const fills = ['#ffffff', 'rgb(128,128,255)', 'rgb(255,178,0)'];
  for (let ch = 0; ch < 3; ch++) {
    const t = tex(gl.TEXTURE_2D_ARRAY, { mips: true, wrap: gl.REPEAT, aniso: true, bytes: 2048 * 2048 * 4 * nSets * 4 / 3 });
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, MIPS, ch === 0 ? gl.SRGB8_ALPHA8 : gl.RGBA8, 2048, 2048, nSets);
    for (let l = 0; l < nSets; l++) {
      const m = sets[l], f = m && m[['albedo', 'normal', 'arm'][ch]];
      let source = f ? img[f] : null;
      if (!source) { const c = new OffscreenCanvas(2048, 2048), x = c.getContext('2d'); x.fillStyle = fills[ch]; x.fillRect(0, 0, 2048, 2048); source = c; }
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, l, 2048, 2048, 1, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    matTex.push(t);
  }
  for (const b of images) b.close();

  // light map: two arrays, layer = page * 3 + group (plane A RGBA16F, plane B RGBA8)
  const lmW = lmDef.genislik, lmH = lmDef.yukseklik, pages = lmDef.sayfa;
  if (lmW > maxTex || lmH > maxTex || pages * 3 > maxLayers) throw fail('Işık haritası bu kartın doku sınırını aşıyor (' + lmW + ' × ' + lmH + ' × ' + pages * 3 + ')');
  const lmA = tex(gl.TEXTURE_2D_ARRAY, { bytes: lmW * lmH * 8 * pages * 3 });
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, lmW, lmH, pages * 3);
  const lmB = tex(gl.TEXTURE_2D_ARRAY, { bytes: lmW * lmH * 4 * pages * 3 });
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, lmW, lmH, pages * 3);
  for (let p = 0; p < pages; p++) {
    const file = lmDef.dosya[p], buf = bin[file], dv = new DataView(buf), n = lmW * lmH * 4;
    if (buf.byteLength < 16 || dv.getUint32(0, true) !== 0x314c4d4b) throw fail(file + ': KML1 başlığı yok');
    if (dv.getUint32(4, true) !== lmW || dv.getUint32(8, true) !== lmH || dv.getUint32(12, true) !== 3 || buf.byteLength !== 16 + n * 3 * 3)
      throw fail(file + ': boyutu sahne.json ile uyuşmuyor');
    let off = 16;
    for (let g = 0; g < 3; g++) {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, lmA);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, p * 3 + g, lmW, lmH, 1, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(buf, off, n)); off += n * 2;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, lmB);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, p * 3 + g, lmW, lmH, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(buf, off, n)); off += n;
    }
    delete bin[file];
  }

  // volumes: one 3D texture each, M | F side by side along x, the groups stacked along z
  const vols = volDefs.map(v => {
    const buf = bin[v.dosya], dv = new DataView(buf);
    if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x31564d4b) throw fail(v.dosya + ': KMV1 başlığı yok');
    const [nx, ny, nz] = [dv.getUint32(4, true), dv.getUint32(8, true), dv.getUint32(12, true)];
    if (nx !== v.boyut[0] || ny !== v.boyut[1] || nz !== v.boyut[2] || dv.getUint32(16, true) !== 3 || buf.byteLength !== 20 + nx * ny * nz * 8 * 2 * 3)
      throw fail(v.dosya + ': boyutu sahne.json ile uyuşmuyor');
    if (2 * nx > max3D || ny > max3D || 3 * nz > max3D) throw fail(v.dosya + ': hacim bu kartın 3B doku sınırını aşıyor');
    const grid = nx * ny * nz * 4, row = nx * 4, out = new Uint16Array(grid * 2 * 3);
    for (let g = 0; g < 3; g++) {
      const M = new Uint16Array(buf, 20 + (g * 2) * grid * 2, grid), F = new Uint16Array(buf, 20 + (g * 2 + 1) * grid * 2, grid);
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
        const s = (z * ny + y) * row, d = ((g * nz + z) * ny + y) * row * 2;
        out.set(M.subarray(s, s + row), d);
        out.set(F.subarray(s, s + row), d + row);
      }
    }
    const raw = tex(gl.TEXTURE_3D, { filter: gl.NEAREST, bytes: out.byteLength });
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 2 * nx, ny, 3 * nz, 0, gl.RGBA, gl.HALF_FLOAT, out);
    if (4 * nx > max3D) throw fail(v.dosya + ': hacim bu kartın 3B doku sınırını aşıyor');
    // the combined volume (common.glsl), one framebuffer per slice
    const t = tex(gl.TEXTURE_3D, { bytes: 4 * nx * ny * nz * 8 });
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, 4 * nx, ny, nz);
    const slices = [];
    for (let z = 0; z < nz; z++) {
      const f = own('Framebuffer', gl.createFramebuffer());
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, z);
      slices.push(f);
    }
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw fail(v.dosya + ': hacim çizim hedefi kurulamadı');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    delete bin[v.dosya];
    return { ...v, n: [nx, ny, nz], raw, t, slices, hi: add(v.alt, scl([nx, ny, nz], v.hucre)) };
  });
  const NV = vols.length;
  const volLo = new Float32Array(vols.flatMap(v => [...v.alt, v.hucre]));
  const volN = new Float32Array(vols.flatMap(v => [...v.n, 0]));

  // meshes: the 40-byte vertex of SALON.md; the CPU copy is kept only as long as the load needs it
  function mesh(file) {
    const buf = bin[file], dv = new DataView(buf);
    if (buf.byteLength < 16 || dv.getUint32(0, true) !== 0x31474d4b) throw fail(file + ': KMG1 başlığı yok');
    const nv = dv.getUint32(4, true), ni = dv.getUint32(8, true);
    if (dv.getUint32(12, true) !== 40 || buf.byteLength !== 16 + nv * 40 + ni * 4) throw fail(file + ': boyutu tutarsız');
    const vao = own('VertexArray', gl.createVertexArray());
    gl.bindVertexArray(vao);
    const vb = own('Buffer', gl.createBuffer(), nv * 40);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(buf, 16, nv * 40), gl.STATIC_DRAW);
    [[3, gl.FLOAT, false, 0], [4, gl.SHORT, true, 12], [4, gl.SHORT, true, 20], [2, gl.FLOAT, false, 28], [2, gl.UNSIGNED_SHORT, true, 36]]
      .forEach(([n, type, nrm, off], i) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, type, nrm, 40, off); });
    const idx = new Uint32Array(buf.slice(16 + nv * 40));
    const ib = own('Buffer', gl.createBuffer(), ni * 4);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bindVertexArray(null);
    return { vao, ib, nv, ni, pos: new Float32Array(buf.slice(16, 16 + nv * 40)), idx, upload() { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.idx, gl.STATIC_DRAW); } };
  }
  const vtx = (m, i) => [m.pos[i * 10], m.pos[i * 10 + 1], m.pos[i * 10 + 2]];     // 40 bytes = 10 floats

  // the faces that carry live things (levha-flagged materials: signs, boards, displays, lamp lenses) are split per
  // anchor: each triangle goes to the smallest levha/nokta box that holds its centre, so one draw = one anchor
  const holders = anchorList.filter(a => a.kutu && (a.tur === 'levha' || a.tur === 'nokta'));
  const inBox = (p, k, tol) => {
    const d = sub(p, k.merkez);
    for (const ax of [k.x, k.y, k.z]) { const l = len(ax); if (l < 1e-9 || Math.abs(dot(d, ax)) / l > l + tol) return false; }
    return true;
  };
  const boxVol = k => len(k.x) * len(k.y) * len(k.z);
  function splitRanges(m, ranges) {
    const out = [];
    for (const r of ranges) {
      const mat = mats[r.malzeme];
      if (!mat) throw fail('geometri: malzeme ' + r.malzeme + ' yok');
      if (!flagOf(mat, 'levha') || !holders.length) { out.push({ ...r, anchor: null }); continue; }
      const groups = new Map();
      for (let t = 0; t < r.sayi / 3; t++) {
        const i0 = r.ilk + t * 3;
        const c = scl(add(add(vtx(m, m.idx[i0]), vtx(m, m.idx[i0 + 1])), vtx(m, m.idx[i0 + 2])), 1 / 3);
        let best = null, bv = Infinity;
        for (const a of holders) if (inBox(c, a.kutu, 0.03) && boxVol(a.kutu) < bv) { bv = boxVol(a.kutu); best = a; }
        const key = best ? best.ad : '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m.idx[i0], m.idx[i0 + 1], m.idx[i0 + 2]);
      }
      let at = r.ilk;
      for (const [key, list] of groups) {
        m.idx.set(list, at);
        out.push({ malzeme: r.malzeme, sayfa: r.sayfa || 0, ilk: at, sayi: list.length, anchor: key ? anchors[key] : null });
        at += list.length;
      }
    }
    return out;
  }
  const geo = mesh(pack.geometri.dosya);
  const staticItems = splitRanges(geo, pack.geometri.araliklar);
  geo.upload();
  let triangles = geo.ni / 3;

  // the moving parts: rotors (kanat > 0: spun, motion-blurred) and levers (turned about their axis)
  const dyn = dynDefs.map(d => {
    const m = mesh(d.dosya);
    const ranges = d.araliklar && d.araliklar.length ? d.araliklar
      : [{ malzeme: d.malzeme != null ? d.malzeme : Math.max(0, mats.findIndex(x => flagOf(x, 'dynamic'))), ilk: 0, sayi: m.ni }];
    const items = ranges.map(r => ({ ...r, sayfa: 0, anchor: null }));
    m.upload();
    triangles += m.ni / 3;
    const o = { def: d, name: d.ad, mesh: m, items, angle: 0, omega: 0, centre: d.merkez, axis: norm(d.eksen || [1, 0, 0]), rotor: (d.kanat || 0) > 0 };
    if (o.rotor) Object.assign(o, rotorTable(m, d, ranges));
    delete bin[d.dosya];
    return o;
  });
  delete bin[pack.geometri.dosya];

  // The rotor's polar table: the mesh projected along its axis into a 1024^2 grid (front-most face from +x), then read
  // in polar coordinates (NR radii x NT angles) as coverage and coverage-weighted normal in the blade's own polar frame
  // (axial, tangential, radial), and integrated along the angle (rotor.frag averages any swept arc with two reads).
  function rotorTable(m, d, ranges) {
    const G = 1024, NT = 2048, NR = 256;
    let rmax = d.yaricap || 0;
    for (let i = 0; i < m.nv; i++) { const p = vtx(m, i); rmax = Math.max(rmax, Math.hypot(p[1], p[2])); }
    rmax *= 1.01;
    const depth = new Float32Array(G * G).fill(-1e30), nrm = new Float32Array(G * G * 3);
    const toG = v => (v / rmax * 0.5 + 0.5) * G - 0.5;
    const dv = new DataView(m.pos.buffer);
    const normalAt = i => [dv.getInt16(i * 40 + 12, true) / 32767, dv.getInt16(i * 40 + 14, true) / 32767, dv.getInt16(i * 40 + 16, true) / 32767];
    for (let t = 0; t < m.ni; t += 3) {
      const ids = [m.idx[t], m.idx[t + 1], m.idx[t + 2]], P = ids.map(i => vtx(m, i));
      const xs = P.map(p => toG(p[1])), ys = P.map(p => toG(p[2]));
      const den = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2]);
      if (Math.abs(den) < 1e-9) continue;
      let n = norm(add(add(normalAt(ids[0]), normalAt(ids[1])), normalAt(ids[2])));
      if (n[0] < 0) n = scl(n, -1);
      const x0 = Math.max(0, Math.ceil(Math.min(...xs))), x1 = Math.min(G - 1, Math.floor(Math.max(...xs)));
      const y0 = Math.max(0, Math.ceil(Math.min(...ys))), y1 = Math.min(G - 1, Math.floor(Math.max(...ys)));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const a = ((ys[1] - ys[2]) * (x - xs[2]) + (xs[2] - xs[1]) * (y - ys[2])) / den;
        const b = ((ys[2] - ys[0]) * (x - xs[2]) + (xs[0] - xs[2]) * (y - ys[2])) / den;
        const c = 1 - a - b;
        if (a < -1e-6 || b < -1e-6 || c < -1e-6) continue;
        const z = a * P[0][0] + b * P[1][0] + c * P[2][0], k = y * G + x;
        if (z > depth[k]) { depth[k] = z; nrm[k * 3] = n[0]; nrm[k * 3 + 1] = n[1]; nrm[k * 3 + 2] = n[2]; }
      }
    }
    let plane = 0, covered = 0;
    for (let k = 0; k < G * G; k++) if (depth[k] > -1e29) { plane += depth[k]; covered++; }
    plane = covered ? plane / covered : 0;
    const tab = new Float32Array((NT + 1) * NR * 4);
    const sample = (gx, gy) => {                 // bilinear coverage and normal
      const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy, r = [0, 0, 0, 0];
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const x = ix + i, y = iy + j;
        if (x < 0 || y < 0 || x >= G || y >= G) continue;
        const k = y * G + x, w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
        if (depth[k] < -1e29) continue;
        r[0] += w; r[1] += w * nrm[k * 3]; r[2] += w * nrm[k * 3 + 1]; r[3] += w * nrm[k * 3 + 2];
      }
      return r;
    };
    for (let j = 0; j < NR; j++) {
      const rr = j / (NR - 1) * rmax;
      const acc = [0, 0, 0, 0];
      const o = j * (NT + 1) * 4;
      for (let i = 0; i < NT; i++) {
        const th = (i + 0.5) / NT * 2 * Math.PI, c = Math.cos(th), s = Math.sin(th);
        const v = sample(toG(rr * c), toG(rr * s));
        // the normal (own frame x, y, z) in the polar frame at this angle: axial, tangential, radial
        const ax = v[1], tg = -s * v[2] + c * v[3], rd = c * v[2] + s * v[3];
        acc[0] += v[0] / NT; acc[1] += ax / NT; acc[2] += tg / NT; acc[3] += rd / NT;
        tab.set(acc, o + (i + 1) * 4);
      }
    }
    const t = tex(gl.TEXTURE_2D, { bytes: tab.byteLength });
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, NT + 1, NR, 0, gl.RGBA, gl.FLOAT, tab);
    // the blurred disc's surface: the rotor's main material as constants (its mean albedo when textured)
    const main = ranges.slice().sort((a, b) => b.sayi - a.sayi)[0], mm = mats[main.malzeme] || {};
    const tint = mm.renk || [1, 1, 1], mean = texKey(mm) ? (mm.ortalamaAlbedo || [0.5, 0.5, 0.5]) : [1, 1, 1];
    return { tab: t, rmax, plane, discAlbedo: [tint[0] * mean[0], tint[1] * mean[1], tint[2] * mean[2]],
      discRM: [mm.puruz != null ? mm.puruz : 0.45, mm.metal != null ? mm.metal : 0] };
  }

  // the materials' constants for the shaders (one uniform block)
  const matUBO = new Float32Array(64 * 4 * 3);
  mats.forEach((m, i) => {
    const k = texKey(m);
    matUBO.set([m.uvOlcek || 1, k ? layerOf.get(k) : -1, m.puruz != null ? m.puruz : -1, m.metal != null ? m.metal : -1], i * 4);
    matUBO.set([...(m.renk || [1, 1, 1]), m.emitScale || 0], 256 + i * 4);
    const fl = (flagOf(m, 'wet') ? 1 : 0) | (flagOf(m, 'levha') ? 2 : 0);
    const eg = flagOf(m, 'emissive') && m.grup != null ? m.grup : -1;
    matUBO.set([eg, fl, 0, 0], 512 + i * 4);
  });
  const ubo = own('Buffer', gl.createBuffer(), matUBO.byteLength);
  gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
  gl.bufferData(gl.UNIFORM_BUFFER, matUBO, gl.STATIC_DRAW);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
  const hasWet = staticItems.some(r => flagOf(mats[r.malzeme], 'wet'));

  // fixed tables: the haze's noise, the dither's blue noise, a blank texture
  say(0.92, 'Tablolar');
  const noise = tex(gl.TEXTURE_3D, { wrap: gl.REPEAT, bytes: 64 * 64 * 64 });
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, 64, 64, 64, 0, gl.RED, gl.UNSIGNED_BYTE, noiseVolume());
  const dither = tex(gl.TEXTURE_2D, { filter: gl.NEAREST, wrap: gl.REPEAT, bytes: 4096 });
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 64, 64, 0, gl.RED, gl.UNSIGNED_BYTE, blueNoise());
  const blank = tex(gl.TEXTURE_2D, { bytes: 4 });
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

  // ---------------------------------------------------------------- shaders
  say(0.93, 'Gölgelendiriciler derleniyor');
  let volCode = '';
  for (let i = 0; i < NV; i++) volCode += `uniform sampler3D uVol${i};\n`;
  volCode += 'void volRead(int i, vec3 c, out vec4 m, out vec4 kr, out vec4 kg, out vec4 kb) {\n';
  for (let i = 0; i < NV; i++) volCode += `    ${i ? 'else ' : ''}if (i == ${i}) { m = texture(uVol${i}, c); kr = texture(uVol${i}, c + vec3(0.25, 0, 0)); ` +
    `kg = texture(uVol${i}, c + vec3(0.5, 0, 0)); kb = texture(uVol${i}, c + vec3(0.75, 0, 0)); }\n`;
  volCode += '    else { m = kr = kg = kb = vec4(0.0); }\n}\n';
  const common = src['common.glsl'].replace('// VOLUMES', volCode);
  const compileT0 = performance.now();
  const programs = {};
  function build(name, vsFile, fsFile, defines = '') {
    const head = '#version 300 es\n#define NV ' + NV + '\n' + defines;
    const pieces = [[gl.VERTEX_SHADER, vsFile, head + src[vsFile]], [gl.FRAGMENT_SHADER, fsFile, head + src[fsFile].replace('// COMMON', common)]];
    const p = own('Program', gl.createProgram());
    const shaders = pieces.map(([type, file, text]) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, text);
      gl.compileShader(s);
      gl.attachShader(p, s);
      return { s, file };
    });
    gl.linkProgram(p);
    programs[name] = { p, shaders, name };
  }
  build('scene', 'scene.vert', 'scene.frag');
  build('depth', 'scene.vert', 'depth.frag');
  build('rotor', 'rotor.vert', 'rotor.frag');
  build('haze', 'quad.vert', 'haze.frag');
  build('combine', 'quad.vert', 'combine.frag');
  for (const pass of ['BLOOMPRE', 'DOWN', 'UP', 'REFLCOMP', 'COMPOSE', 'RESOLVEH', 'RESOLVEV'])
    build(pass.toLowerCase(), 'quad.vert', 'post.frag', '#define PASS_' + pass + '\n');
  if (extPar) {
    const all = () => Object.values(programs).every(x => gl.getProgramParameter(x.p, extPar.COMPLETION_STATUS_KHR));
    while (!all()) await new Promise(r => setTimeout(r, 4));
  }
  for (const pr of Object.values(programs)) {
    for (const { s, file } of pr.shaders) {
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = (gl.getShaderInfoLog(s) || '').split('\n').slice(0, 6).join(' | ');
        throw fail('Gölgelendirici derlenemedi: ' + pr.name + ' / ' + file + ': ' + log);
      }
    }
    if (!gl.getProgramParameter(pr.p, gl.LINK_STATUS)) throw fail('Gölgelendirici bağlanamadı: ' + pr.name + ': ' + gl.getProgramInfoLog(pr.p));
    for (const { s } of pr.shaders) { gl.detachShader(pr.p, s); gl.deleteShader(s); }
    pr.u = {};
    const n = gl.getProgramParameter(pr.p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(pr.p, i);
      pr.u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(pr.p, info.name);
    }
    const bi = gl.getUniformBlockIndex(pr.p, 'Materials');
    if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(pr.p, bi, 0);
  }
  const compileMs = performance.now() - compileT0;

  // texture units: fixed per name, the volumes after them
  const UNIT = { uAlb: 0, uNrm: 1, uArm: 2, uLmA: 3, uLmB: 4, uLevha: 5, uRefl: 6, uNoise: 7, uTab: 5, uDepth: 1, uHaze: 2,
    uScene: 3, uBloom: 4, uSrc: 0, uDither: 6 };
  const VOL_UNIT = 8;
  for (const pr of Object.values(programs)) {
    gl.useProgram(pr.p);
    for (const [k, unit] of Object.entries(UNIT)) if (pr.u[k]) gl.uniform1i(pr.u[k], unit);
    for (let i = 0; i < NV; i++) if (pr.u['uVol' + i]) gl.uniform1i(pr.u['uVol' + i], VOL_UNIT + i);
    if (pr.u.uVolLo) { gl.uniform4fv(pr.u.uVolLo, volLo); gl.uniform4fv(pr.u.uVolN, volN); }
    if (pr.u.uPhaseG) gl.uniform1f(pr.u.uPhaseG, (pack.firin && pack.firin.ortam_g != null) ? pack.firin.ortam_g : 0.35);
  }
  const bindTex = (unit, target, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, t); };
  function bindVolumes() { vols.forEach((v, i) => bindTex(VOL_UNIT + i, gl.TEXTURE_3D, v.t)); }

  // ---------------------------------------------------------------- targets (made on resize)
  let W = 0, H = 0, T = null;
  const targetObjects = [];
  function target(w, h, format, opts = {}) {
    const levels = opts.levels || 1;
    const bpp = { [gl.RGBA16F]: 8, [gl.RGB10_A2]: 4, [gl.R16F]: 2 }[format] || 4;
    const t = tex(gl.TEXTURE_2D, { mips: levels > 1, filter: opts.nearest ? gl.NEAREST : gl.LINEAR, bytes: w * h * bpp * (levels > 1 ? 4 / 3 : 1) });
    gl.texStorage2D(gl.TEXTURE_2D, levels, format, w, h);
    targetObjects.push(t);
    const fbs = [];
    let depth = null;
    if (opts.depth) {
      depth = tex(gl.TEXTURE_2D, { filter: gl.NEAREST, bytes: w * h * 4 });
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT32F, w, h);
      targetObjects.push(depth);
    }
    for (let l = 0; l < levels; l++) {
      const f = own('Framebuffer', gl.createFramebuffer());
      targetObjects.push(f);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, l);
      if (depth && l === 0) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw fail('Çizim hedefi kurulamadı (' + w + ' × ' + h + ')');
      fbs.push(f);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { t, depth, fb: fbs[0], fbs, w, h, levels, size: l => [Math.max(1, w >> l), Math.max(1, h >> l)] };
  }
  function resize() {
    const dpr = options.devicePixelRatio || window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (w === W && h === H && T && T.scale === Q.scale && T.key === key()) return;
    W = w; H = h;
    canvas.width = w; canvas.height = h;
    while (targetObjects.length) drop(targetObjects.pop());
    const s = Q.scale, sw = Math.round(w * s), sh = Math.round(h * s);
    if (Math.max(sw, sh) > maxTex) throw fail('Örnekleme ölçeği bu çözünürlükte kartın sınırını aşıyor (' + sw + ' × ' + sh + ')');
    const hw = Math.max(1, Math.round(w * Q.hazeScale)), hh = Math.max(1, Math.round(h * Q.hazeScale));
    const rw = Math.max(1, Math.round(sw * Q.reflScale)), rh = Math.max(1, Math.round(sh * Q.reflScale));
    const bloomLevels = Math.max(1, Math.min(6, Math.floor(Math.log2(Math.min(hw, hh))) - 2));
    const reflLevels = Math.max(1, Math.min(7, Math.floor(Math.log2(Math.min(rw, rh))) - 2));
    T = {
      scale: s, key: key(),
      scene: target(sw, sh, gl.RGBA16F, { depth: true }),
      haze: target(hw, hh, gl.RGBA16F, { nearest: true }),
      bloom: target(hw, hh, gl.RGBA16F, { levels: bloomLevels }),
      tone: target(sw, sh, gl.RGB10_A2, { nearest: true }),
      half: target(w, sh, gl.RGBA16F, { nearest: true }),
    };
    if (hasWet) {
      T.refl = target(rw, rh, gl.RGBA16F, { depth: true, nearest: true });
      T.reflHaze = target(Math.max(1, rw >> 1), Math.max(1, rh >> 1), gl.RGBA16F, { nearest: true });
      T.reflMip = target(rw, rh, gl.RGBA16F, { levels: reflLevels });
    }
  }
  const key = () => [Q.hazeScale, Q.reflScale].join(',');

  // ---------------------------------------------------------------- live state
  let cam = null, eye = pack.gorunumler.fanlar.goz.slice(), look = pack.gorunumler.fanlar.hedef.slice(), fov = pack.gorunumler.fanlar.fov || 50;
  const groups = [[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]];
  const groupUniform = new Float32Array(9);
  let exposure = 1, time = 0, haze = { density: 1, fans: [] }, hoverName = null;
  const levha = new Map();                       // atlas name -> { t, w, h, emissive }
  const lamps = new Map();                       // anchor name -> [r, g, b] * k
  const hoverAmt = new Map();                    // anchor name -> 0..1 (eased)
  const linked = {};                             // tik anchor name -> the levha/nokta anchors it lifts
  for (const a of anchorList) if (a.tur === 'tik' && a.kutu) {
    linked[a.ad] = holders.filter(h => h.ad === a.ad || (h.atlas && h.atlas === a.ad) || inBox(h.kutu.merkez, a.kutu, 0.05)).map(h => h.ad);
  }
  const fanEye = pack.gorunumler.fanlar.goz;

  // ---------------------------------------------------------------- GPU timing
  const timing = { frames: [], hist: {}, last: {}, lastSet: new Set(), total: null, frame: null };
  // one pass, timed on the GPU when the timer extension is there; flushed after it, so the compositor finds the GPU
  // between passes (outside the query: the flush's gap is not counted in the pass)
  function timed(name, fn) {
    if (!extTimer || timing.frames.length > 8) { fn(); gl.flush(); return; }
    const q = gl.createQuery();
    gl.beginQuery(extTimer.TIME_ELAPSED_EXT, q);
    fn();
    gl.endQuery(extTimer.TIME_ELAPSED_EXT);
    timing.frame.push([name, q]);
    gl.flush();
  }
  function pollTimers() {
    if (!extTimer) return;
    if (gl.getParameter(extTimer.GPU_DISJOINT_EXT)) {
      for (const f of timing.frames) for (const [, q] of f) gl.deleteQuery(q);
      timing.frames.length = 0;
      return;
    }
    while (timing.frames.length) {
      const f = timing.frames[0];
      if (f.length && !gl.getQueryParameter(f[f.length - 1][1], gl.QUERY_RESULT_AVAILABLE)) break;
      timing.frames.shift();
      let sum = 0;
      for (const [name, q] of f) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(q);
        sum += ms;
        timing.last[name] = ms;
        const h = timing.hist[name] || (timing.hist[name] = []);
        h.push(ms); if (h.length > 30) h.shift();
      }
      if (f.length) { timing.total = sum; timing.lastSet = new Set(f.map(x => x[0])); }
    }
  }
  const median = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

  // ---------------------------------------------------------------- drawing
  const quad = own('VertexArray', gl.createVertexArray());
  // how many flushed bands a pass gets: about one per 3 ms of its last measured GPU time, at most Q.bands (one long
  // draw keeps the compositor from the GPU and frames miss their refresh; many short ones only add gaps)
  const bandsFor = name => !extTimer || timing.last[name] == null ? Q.bands : clamp(Math.ceil(timing.last[name] / 3), 1, Q.bands);
  // draw() over rows [0, h) of the bound target in n flushed horizontal bands (scissored; h may be less than the
  // target's height: the reflection is drawn only where the floor can be seen)
  function bands(h, draw, n = Q.bands, full = false) {
    if (n <= 1 && full) { draw(); return; }
    gl.enable(gl.SCISSOR_TEST);
    for (let i = 0; i < n; i++) {
      const y0 = Math.floor(i * h / n), y1 = Math.floor((i + 1) * h / n);
      if (y1 <= y0) continue;
      gl.scissor(0, y0, 1 << 15, y1 - y0);
      draw();
      gl.flush();
    }
    gl.disable(gl.SCISSOR_TEST);
  }
  function camUniforms(pr, c) {
    const u = pr.u;
    if (u.uEye) gl.uniform3fv(u.uEye, c.eye);
    if (u.uCamF) { gl.uniform3fv(u.uCamF, c.F); gl.uniform3fv(u.uCamR, c.R); gl.uniform3fv(u.uCamU, c.U); gl.uniform2f(u.uTan, c.tx, c.ty); }
    if (u.uNearFar) gl.uniform2f(u.uNearFar, NEAR, FAR);
    if (u.uGroup) gl.uniform3fv(u.uGroup, groupUniform);
  }
  function drawItem(pr, item, alpha) {
    const u = pr.u, m = mats[item.malzeme], a = item.anchor;
    gl.uniform1i(u.uMat, item.malzeme);
    if (u.uPage) gl.uniform1i(u.uPage, item.sayfa || 0);
    let on = 0, em = 0, hv = 0, lamp = null;
    if (a) {
      const lv = levha.get(a.atlas || a.ad);
      if (lv) { on = 1; em = lv.emissive; bindTex(UNIT.uLevha, gl.TEXTURE_2D, lv.t); }
      hv = hoverAmt.get(a.ad) || 0;
      lamp = lamps.get(a.ad);
    }
    if (u.uDraw) gl.uniform4f(u.uDraw, on, em, hv, item.dynamic ? 1 : 0);
    if (u.uLamp) gl.uniform3fv(u.uLamp, lamp || [0, 0, 0]);
    if (u.uAlpha) gl.uniform1f(u.uAlpha, alpha);
    drawRaw(item);
  }
  // decals and sign faces are pulled towards the eye a little (the same in the prepass, so EQUAL still matches)
  function drawRaw(item) {
    const m = mats[item.malzeme];
    const offset = flagOf(m, 'levha') || flagOf(m, 'noOcclude');
    if (offset) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -2); }
    gl.drawElements(gl.TRIANGLES, item.sayi, gl.UNSIGNED_INT, item.ilk * 4);
    if (offset) gl.disable(gl.POLYGON_OFFSET_FILL);
  }
  const rotorShare = d => !d.rotor ? 0 : Q.rotor === 'disc' ? 1 : Q.rotor === 'mesh' ? 0 :
    smoothstep(0.12, 0.3, Math.abs(d.omega * d.shutter) / (2 * Math.PI / d.def.kanat));
  // the meshes of one view: static hall, levers and crisp rotors (opaque), fading rotors, blurred discs
  function drawMeshes(c, mirror, tgt, prepass) {
    const eyeShade = mirror ? [c.eye[0], -c.eye[1], c.eye[2]] : c.eye;
    const runMeshes = (pr, colour) => {
      gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uVP, false, c.vp);
      gl.uniform1f(pr.u.uMirror, mirror ? 1 : 0);
      if (colour) {
        camUniforms(pr, c);
        gl.uniform3fv(pr.u.uEyeShade, eyeShade);
        gl.uniform2f(pr.u.uTarget, tgt.w, tgt.h);
        gl.uniform1f(pr.u.uPxScale, mirror ? 1 : 1 / Q.scale);
        gl.uniform1f(pr.u.uReflLevels, hasWet ? T.reflMip.levels - 1 : 0);
        gl.uniform1f(pr.u.uCubic, Q.cubic && !mirror ? 1 : 0);
      }
      gl.uniformMatrix4fv(pr.u.uModel, false, IDENTITY);
      gl.bindVertexArray(geo.vao);
      for (const it of staticItems) colour ? drawItem(pr, it, 1) : drawRaw(it);
      for (const d of dyn) {
        const share = rotorShare(d);
        if (share >= 1 || (!colour && share > 0)) continue;
        gl.uniformMatrix4fv(pr.u.uModel, false, frameOf(d.axis, d.centre, d.angle).m);
        gl.bindVertexArray(d.mesh.vao);
        // a rotor fading into its disc is not in the prepass: drawn blended over what is there, with its own depth
        if (colour && share > 0) {
          gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
        }
        for (const it of d.items) colour ? drawItem(pr, { ...it, dynamic: true }, 1 - share) : drawRaw(it);
        if (colour && share > 0) {
          gl.disable(gl.BLEND);
          if (prepass) { gl.depthFunc(gl.EQUAL); gl.depthMask(false); }
        }
      }
    };
    const colourPass = () => {
      if (prepass) { gl.depthFunc(gl.EQUAL); gl.depthMask(false); }
      runMeshes(programs.scene, true);
      gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
      // the blurred discs: no depth write (the haze and the upsampling see the recess behind)
      const discs = dyn.filter(d => d.rotor && rotorShare(d) > 0);
      if (discs.length) {
        const pr = programs.rotor;
        gl.useProgram(pr.p);
        camUniforms(pr, c);
        gl.uniformMatrix4fv(pr.u.uVP, false, c.vp);
        gl.uniform1f(pr.u.uMirror, mirror ? 1 : 0);
        gl.uniform3fv(pr.u.uEyeShade, eyeShade);
        gl.bindVertexArray(quad);
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        for (const d of discs) {
          const f = frameOf(d.axis, d.centre, 0);
          gl.uniformMatrix4fv(pr.u.uModel, false, f.m);
          gl.uniform3fv(pr.u.uAxisW, f.x); gl.uniform3fv(pr.u.uYW, f.y); gl.uniform3fv(pr.u.uZW, f.z);
          gl.uniform1f(pr.u.uRadius, d.rmax);
          gl.uniform1f(pr.u.uPlane, d.plane);
          gl.uniform1f(pr.u.uAngle, ((d.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
          gl.uniform1f(pr.u.uSweep, d.omega * d.shutter);
          gl.uniform1f(pr.u.uShare, rotorShare(d));
          gl.uniform3fv(pr.u.uAlbedo, d.discAlbedo);
          gl.uniform2fv(pr.u.uRoughMetal, d.discRM);
          const fanName = d.name.replace(/_rotor$/, '');
          gl.uniform1f(pr.u.uHover, hoverName && (hoverName === fanName || hoverName === d.name) ? 1 : 0);
          bindTex(UNIT.uTab, gl.TEXTURE_2D, d.tab);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fb);
    gl.viewport(0, 0, tgt.w, tgt.h);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
    bindTex(UNIT.uAlb, gl.TEXTURE_2D_ARRAY, matTex[0]); bindTex(UNIT.uNrm, gl.TEXTURE_2D_ARRAY, matTex[1]); bindTex(UNIT.uArm, gl.TEXTURE_2D_ARRAY, matTex[2]);
    bindTex(UNIT.uLmA, gl.TEXTURE_2D_ARRAY, lmA); bindTex(UNIT.uLmB, gl.TEXTURE_2D_ARRAY, lmB);
    bindTex(UNIT.uLevha, gl.TEXTURE_2D, blank);
    bindTex(UNIT.uRefl, gl.TEXTURE_2D, mirror || !hasWet ? blank : T.reflMip.t);
    bindTex(UNIT.uNoise, gl.TEXTURE_3D, noise);
    bindVolumes();
    const rows = mirror ? floorRows(c, tgt.h) : tgt.h;
    gl.clearColor(0, 0, 0, 1); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    bands(rows, () => {
      if (prepass) { gl.colorMask(false, false, false, false); runMeshes(programs.depth, false); gl.colorMask(true, true, true, true); }
      colourPass();
    }, bandsFor(mirror ? 'reflection' : 'scene'));
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }
  // the rows of a target in which the floor can be seen (below the horizon of y = 0, with a margin): the reflection
  // is drawn only there
  function floorRows(c, h) {
    // the horizon: directions with no vertical part; their highest point on screen
    const f = norm([c.F[0], 0, c.F[2]]);
    if (len([c.F[0], 0, c.F[2]]) < 1e-3) return h;
    const yv = dot(c.U, f) / (dot(c.F, f) * c.ty);           // NDC y of the horizon straight ahead
    const tilt = Math.abs(dot(c.R, [0, 1, 0])) * c.tx / c.ty;  // roll (none in practice)
    return clamp(Math.ceil(((yv + tilt) * 0.5 + 0.5) * h) + 8, 0, h);
  }
  function fullscreen(pr, tgt, level, setup, nBands = 1, rows = null) {
    const [w, h] = tgt ? tgt.size(level || 0) : [W, H];
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt ? tgt.fbs[level || 0] : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(pr.p);
    gl.bindVertexArray(quad);
    setup(pr.u, w, h);
    bands(rows != null ? rows : h, () => gl.drawArrays(gl.TRIANGLES, 0, 3), nBands, rows == null);
  }
  function marchSteps(mirror) {
    const o = vols[NV - 1];
    const diag = len(scl(o.n, o.hucre));
    return Math.ceil(diag / (0.5 * o.hucre * Q.hazeStep * (mirror ? 2 : 1))) +
      (mirror ? 0 : vols.slice(0, -1).reduce((s, v) => s + Math.ceil(len(scl(v.n, v.hucre)) / (0.5 * v.hucre * Q.hazeStep)) + 2, 0)) + 4;
  }
  function hazePass(c, depthTgt, out, mirror, rows) {
    fullscreen(programs.haze, out, 0, (u, w, h) => {
      camUniforms(programs.haze, c);
      bindTex(UNIT.uDepth, gl.TEXTURE_2D, depthTgt.depth);
      bindTex(UNIT.uNoise, gl.TEXTURE_3D, noise);
      bindVolumes();
      gl.uniform2f(u.uDepthRatio, depthTgt.w / w, depthTgt.h / h);
      gl.uniform2f(u.uSize, w, h);
      gl.uniform1f(u.uSigma, (pack.firin && pack.firin.ortam_sigma) || 0.012);
      gl.uniform1f(u.uDensity, haze.density != null ? haze.density : 1);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uStepFactor, Q.hazeStep);
      gl.uniform1i(u.uMaxSteps, marchSteps(mirror));
      gl.uniform1f(u.uMirror, mirror ? 1 : 0);
      const fans = [], dirs = [];
      for (const f of (haze.fans || []).slice(0, 2)) {
        const d = dyn.find(x => x.name === f.name + '_rotor' || x.name === f.name);
        const a = anchors[f.name];
        const centre = d ? d.centre : a && a.kutu ? a.kutu.merkez : null;
        if (!centre) continue;
        let ax = d ? d.axis : norm(a.kutu.x);
        if (dot(ax, sub(fanEye, centre)) < 0) ax = scl(ax, -1);
        fans.push(...centre, clamp(f.strength || 0, 0, 1));
        dirs.push(...ax, d ? (d.def.yaricap || d.rmax || 4) : 4);
      }
      gl.uniform1i(u.uFans, fans.length / 4);
      if (fans.length) { gl.uniform4fv(u.uFan, new Float32Array([...fans, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8))); gl.uniform4fv(u.uFanDir, new Float32Array([...dirs, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8))); }
    }, bandsFor(mirror ? 'reflectionHaze' : 'haze'), rows);
  }
  // a 13-tap mip chain (bloom, reflection): level l from level l - 1 of the same texture (the sampled level range
  // excludes the one written, so no feedback loop)
  function mipChain(tg) {
    const pr = programs.down;
    for (let l = 1; l < tg.levels; l++) {
      gl.bindTexture(gl.TEXTURE_2D, tg.t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, l - 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, l - 1);
      fullscreen(pr, tg, l, u => { bindTex(UNIT.uSrc, gl.TEXTURE_2D, tg.t); gl.uniform1f(u.uLod, l - 1); });
    }
    gl.bindTexture(gl.TEXTURE_2D, tg.t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, tg.levels - 1);
  }
  function bloomUp(tg) {
    const pr = programs.up;
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let l = tg.levels - 2; l >= 0; l--) {
      gl.bindTexture(gl.TEXTURE_2D, tg.t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, l + 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, l + 1);
      fullscreen(pr, tg, l, u => { bindTex(UNIT.uSrc, gl.TEXTURE_2D, tg.t); gl.uniform1f(u.uLod, l + 1); });
    }
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, tg.t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, tg.levels - 1);
  }

  let combinedFor = null;
  function combineVolumes() {
    const pr = programs.combine;
    gl.useProgram(pr.p);
    gl.bindVertexArray(quad);
    gl.uniform3fv(pr.u.uGroup, groupUniform);
    gl.activeTexture(gl.TEXTURE0);
    for (const v of vols) {
      gl.bindTexture(gl.TEXTURE_3D, v.raw);
      gl.uniform3i(pr.u.uN, v.n[0], v.n[1], v.n[2]);
      gl.viewport(0, 0, 4 * v.n[0], v.n[1]);
      for (let z = 0; z < v.n[2]; z++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, v.slices[z]);
        gl.uniform1i(pr.u.uZ, z);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    combinedFor = groupUniform.slice();
  }
  function render(dt = 1 / 60, shutter = 1 / 60) {
    if (disposed) return;
    const cpu0 = performance.now();
    if (gl.isContextLost()) throw fail('GPU bağlantısı kesildi');
    resize();
    time += Math.max(0, dt || 0);
    pollTimers();
    timing.frame = [];
    // eased hover (a small lift in about a tenth of a second)
    const lift = new Set(hoverName ? (linked[hoverName] || [hoverName]) : []);
    for (const a of holders) {
      const v = hoverAmt.get(a.ad) || 0, goal = lift.has(a.ad) ? 1 : 0;
      if (v !== goal) hoverAmt.set(a.ad, Math.abs(goal - v) < 0.02 ? goal : v + (goal - v) * (1 - Math.exp(-Math.max(0, dt || 0) / 0.08)));
    }
    for (let g = 0; g < 3; g++) groupUniform.set(scl(groups[g].slice(0, 3), groups[g][3]), g * 3);
    // the volumes follow the light's colours: recombined when a colour moved (by more than a ten-thousandth)
    let moved = !combinedFor;
    for (let i = 0; i < 9 && !moved; i++) moved = Math.abs(groupUniform[i] - combinedFor[i]) > 1e-4 * Math.max(1e-3, Math.abs(combinedFor[i]));
    if (moved) timed('volumes', combineVolumes);
    for (const d of dyn) d.shutter = shutter || 0;
    cam = cameraOf(eye, look, fov, W / H);

    if (hasWet) {
      timed('reflection', () => drawMeshes(cam, true, T.refl, Q.prepass));
      timed('reflectionHaze', () => {
        const rows = floorRows(cam, T.reflHaze.h);
        hazePass(cam, T.refl, T.reflHaze, true, rows);
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.reflMip.fb);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        fullscreen(programs.reflcomp, T.reflMip, 0, u => {
          camUniforms(programs.reflcomp, cam);
          bindTex(UNIT.uScene, gl.TEXTURE_2D, T.refl.t);
          bindTex(UNIT.uDepth, gl.TEXTURE_2D, T.refl.depth);
          bindTex(UNIT.uHaze, gl.TEXTURE_2D, T.reflHaze.t);
          gl.uniform2f(u.uHazeRatio, T.refl.w / T.reflHaze.w, T.refl.h / T.reflHaze.h);
        }, 1, floorRows(cam, T.refl.h));
        mipChain(T.reflMip);
      });
    }
    timed('scene', () => drawMeshes(cam, false, T.scene, Q.prepass));
    timed('haze', () => hazePass(cam, T.scene, T.haze, false, null));
    timed('bloom', () => {
      fullscreen(programs.bloompre, T.bloom, 0, () => {
        bindTex(UNIT.uScene, gl.TEXTURE_2D, T.scene.t);
        bindTex(UNIT.uHaze, gl.TEXTURE_2D, T.haze.t);
      });
      mipChain(T.bloom);
      bloomUp(T.bloom);
    });
    timed('composite', () => fullscreen(programs.compose, T.tone, 0, u => {
      camUniforms(programs.compose, cam);
      bindTex(UNIT.uScene, gl.TEXTURE_2D, T.scene.t);
      bindTex(UNIT.uDepth, gl.TEXTURE_2D, T.scene.depth);
      bindTex(UNIT.uHaze, gl.TEXTURE_2D, T.haze.t);
      bindTex(UNIT.uBloom, gl.TEXTURE_2D, T.bloom.t);
      gl.uniform2f(u.uHazeRatio, T.scene.w / T.haze.w, T.scene.h / T.haze.h);
      gl.uniform1f(u.uBloomMix, 0.04);
      gl.uniform1f(u.uBloomLevels, T.bloom.levels);
      gl.uniform1f(u.uExposure, exposure);
    }));
    timed('resolve', () => {
      const taps = s => Math.ceil(4 * s) + 1;
      fullscreen(programs.resolveh, T.half, 0, u => {
        bindTex(UNIT.uSrc, gl.TEXTURE_2D, T.tone.t);
        gl.uniform1f(u.uScale, T.tone.w / W);
        gl.uniform1i(u.uTaps, taps(T.tone.w / W));
      });
      fullscreen(programs.resolvev, null, 0, u => {
        bindTex(UNIT.uSrc, gl.TEXTURE_2D, T.half.t);
        bindTex(UNIT.uDither, gl.TEXTURE_2D, dither);
        gl.uniform1f(u.uScale, T.half.h / H);
        gl.uniform1i(u.uTaps, taps(T.half.h / H));
      });
    });
    if (timing.frame.length) timing.frames.push(timing.frame);
    timing.frame = null;
    frames++;
    cpuHist.push(performance.now() - cpu0);
    if (cpuHist.length > 30) cpuHist.shift();
    if (options.debug) { const e = gl.getError(); if (e) console.error('Salon: WebGL hatası 0x' + e.toString(16)); }
  }

  // ---------------------------------------------------------------- picking
  function rayAt(x, y) {
    const r = canvas.getBoundingClientRect();
    const c = cameraOf(eye, look, fov, r.width / r.height);
    const nx = (x / r.width) * 2 - 1, ny = 1 - (y / r.height) * 2;
    return { c, d: norm(add(c.F, add(scl(c.R, nx * c.tx), scl(c.U, ny * c.ty)))) };
  }
  function pick(x, y) {
    const { c, d } = rayAt(x, y);
    let best = Infinity, hit = null;
    for (const a of anchorList) {
      if (a.tur !== 'tik' || !a.kutu) continue;
      const k = a.kutu, q = sub(c.eye, k.merkez);
      let lo = -Infinity, hi = Infinity, ok = true;
      for (const ax of [k.x, k.y, k.z]) {
        const e = len(ax);
        if (e < 1e-9) { ok = false; break; }
        const n = scl(ax, 1 / e), o = dot(q, n), dd = dot(d, n);
        if (Math.abs(dd) < 1e-12) { if (Math.abs(o) > e) { ok = false; break; } continue; }
        let t0 = (-e - o) / dd, t1 = (e - o) / dd;
        if (t0 > t1) [t0, t1] = [t1, t0];
        lo = Math.max(lo, t0); hi = Math.min(hi, t1);
      }
      if (!ok || hi < Math.max(lo, 0)) continue;
      const t = Math.max(lo, 0);
      if (t < best) { best = t; hit = a.ad; }
    }
    return hit;
  }
  function project(p) {
    const r = canvas.getBoundingClientRect();
    const c = cameraOf(eye, look, fov, r.width / r.height);
    const q = sub(p, c.eye), z = dot(q, c.F);
    return { x: (dot(q, c.R) / (z * c.tx) * 0.5 + 0.5) * r.width, y: (0.5 - dot(q, c.U) / (z * c.ty) * 0.5) * r.height, z };
  }

  let disposed = false, frames = 0;
  const cpuHist = [];
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const f of timing.frames) for (const [, q] of f) gl.deleteQuery(q);
    while (owned.length) { const [kind, o] = owned.pop(); gl['delete' + kind](o); }
    bytes = 0;
  }

  resize();
  say(1, 'Salon hazır');
  return {
    views: pack.gorunumler,
    anchors,
    dyn: dynDefs,
    pack,
    quality: Q,
    setCamera(e, t, deg) { eye = e.slice(); look = t.slice(); if (deg) fov = deg; },
    setGroup(i, c, k) { if (i >= 0 && i < 3) groups[i] = [Math.max(0, c[0]), Math.max(0, c[1]), Math.max(0, c[2]), Math.max(0, k)]; },
    setRotor(name, angle, omega) { const d = dyn.find(x => x.name === name); if (d) { d.angle = angle; d.omega = omega || 0; } },
    setLever(name, angle) { const d = dyn.find(x => x.name === name); if (d) d.angle = angle; },
    setLevha(name, source, opts = {}) {
      if (!source || !source.width || !source.height) return;
      let lv = levha.get(name);
      if (!lv || lv.w !== source.width || lv.h !== source.height) {
        if (lv) drop(lv.t);
        lv = { t: tex(gl.TEXTURE_2D, { mips: true, aniso: true, bytes: source.width * source.height * 4 * 4 / 3 }), w: source.width, h: source.height, emissive: 0 };
        gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(lv.w, lv.h))) + 1, gl.SRGB8_ALPHA8, lv.w, lv.h);
        levha.set(name, lv);
      }
      gl.bindTexture(gl.TEXTURE_2D, lv.t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
      lv.emissive = Math.max(0, opts.emissive || 0);
    },
    setLamp(name, c, k) { lamps.set(name, [c[0] * k, c[1] * k, c[2] * k]); },
    setHaze(h) { haze = { ...haze, ...h }; },
    setExposure(ev) { exposure = Math.pow(2, ev || 0); },
    setHover(name) { hoverName = name || null; },
    setTime(t) { time = t; },
    setQuality(q) { Object.assign(Q, q); T = null; W = 0; resize(); },
    render,
    pick,
    project,
    resize,
    stats() {
      pollTimers();
      // the median of the last frames of every pass the last measured frame ran (the volumes' recombination only
      // runs when a light's colour moves: its last time is reported apart)
      const passes = {};
      for (const k of Object.keys(timing.last)) if (timing.hist[k] && timing.lastSet.has(k)) passes[k] = +median(timing.hist[k]).toFixed(3);
      return {
        gpuMs: timing.total, passes, cpuMs: cpuHist.length ? +median(cpuHist).toFixed(2) : null, volumesMs: timing.last.volumes != null ? +timing.last.volumes.toFixed(3) : null, memoryMB: +(bytes / 1048576).toFixed(1), textures: owned.filter(x => x[0] === 'Texture').length,
        triangles, compileMs: +compileMs.toFixed(0), parallelCompile: !!extPar, timer: !!extTimer, frames,
        size: [W, H], scene: T ? [T.scene.w, T.scene.h] : null, quality: { ...Q },
      };
    },
    dispose,
  };
}

window.KM_SALON = Object.freeze({ create });
})();
