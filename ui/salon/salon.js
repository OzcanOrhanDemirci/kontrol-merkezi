// Kontrol Merkezi · the hall's live renderer (WebGL2). docs/SALON.md is the reference: the pack it reads ("The pack")
// and the frame it draws ("The live renderer"); ui/salon/README.md lists the API, the passes and their measured cost.
// Plain script, no build step, no libraries: window.KM_SALON.create(canvas, options) -> the renderer.
// Deterministic: no random numbers at run time; every pixel takes the same samples every frame.
'use strict';
(() => {
const SCRIPT_BASE = new URL('.', document.currentScript ? document.currentScript.src : location.href);
// the pack is read straight from its files each start; nothing of its ~900 MB goes into the browser's disk cache
const NO_STORE = { cache: 'no-store' };
const SHADER_FILES = ['common.glsl', 'scene.vert', 'scene.frag', 'depth.frag', 'rotor.vert', 'rotor.frag', 'quad.vert',
  'haze.frag', 'post.frag', 'combine.frag', 'dis.vert', 'dis.frag', 'fener.vert', 'fener.frag', 'direk.vert', 'direk.frag'];

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
const NEAR = 0.1, FAR_HALL = 1200, FAR_VOID = 4000;
let FAR = FAR_HALL;               // the void (Phase 2) moves it out while the outside can be seen

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
  const files = {};                            // per file: [ms from T0 when its bytes were in, bytes on the wire]
  // The loading screen's progress: bytes off the wire of every file against their sizes; the wire is 0..0.85 of the
  // load, uploads and shaders the rest. The window's mapped host sends no Content-Length, so it tells the pack's
  // size itself (options.packBytes); otherwise the sizes are the responses' (all requests start at once).
  const wire = { got: new Map(), size: new Map(), n: 0, f: 0 };
  function onWire(file, got, size) {
    if (size) wire.size.set(file, size);
    if (got != null) wire.got.set(file, got);
    if (!options.packBytes && wire.size.size < wire.n) return;
    let g = 0, s = options.packBytes || 0;
    for (const v of wire.got.values()) g += v;
    if (!s) for (const v of wire.size.values()) s += v;
    const f = s ? 0.85 * Math.min(1, g / s) : 0;
    if (f >= wire.f + 0.005) { wire.f = f; say(f, 'paket'); }
  }
  // The big files (geometry, light map pages, volumes) go to a worker each (paket-isci.js): fetched and inflated on
  // their own cores, not on this thread; the small ones (moving parts, ~1 MB) stay here. A volume also comes back in
  // its texture's layout (M | F side by side, the groups stacked: the copy was ~0.3 s here for the hall's volume).
  const laidOut = new Set();
  function fetchInWorker(file, kmv1) {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new Worker(new URL('paket-isci.js', SCRIPT_BASE)); } catch (e) { reject(e); return; }
      w.onmessage = e => {
        const m = e.data;
        if (m.error) { w.terminate(); reject(fail(file + (m.status ? ': bulunamadı (' + m.error + ')' : ': okunamadı (' + m.error + ')'))); return; }
        onWire(file, m.got, m.size);
        if (m.buf) { w.terminate(); if (m.laidOut) laidOut.add(file); resolve(m.buf); }
      };
      w.onerror = e => { w.terminate(); reject(fail(file + ': okunamadı (' + (e.message || 'işçi') + ')')); };
      w.postMessage({ url: new URL(file, base).href, kmv1 });
    });
  }
  async function fetchBytes(file, big, kmv1) {
    let buf;
    if (big && typeof Worker === 'function') {
      buf = await fetchInWorker(file, kmv1);
    } else {
      let r;
      try { r = await fetch(new URL(file, base), NO_STORE); } catch (e) { throw fail(file + ': okunamadı (' + e.message + ')'); }
      if (!r.ok) throw fail(file + ': bulunamadı (HTTP ' + r.status + ')');
      onWire(file, 0, +(r.headers.get('Content-Length') || 0));
      if (/\.gz$/.test(file)) buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      else if (/\.z$/.test(file)) buf = await new Response(r.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
      else buf = await r.arrayBuffer();
      onWire(file, wire.size.get(file), null);
    }
    files[file] = [performance.now() - T0, wire.size.get(file) || buf.byteLength];
    return buf;
  }
  const T0 = performance.now(), mark = {};   // load phases, logged once (the opening waits on them)
  say(0, 'sahne.json');
  let pack;
  try {
    const r = await fetch(new URL('sahne.json', base), NO_STORE);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    pack = await r.json();
  } catch (e) { throw fail('sahne.json okunamadı: ' + e.message); }
  mark.json = performance.now() - T0;
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
  wire.n = binFiles.length + imageFiles.length;
  const small = new Set(dynDefs.map(d => d.dosya));
  // Every request starts now; each part below waits only for its own files and is built as they arrive (textures,
  // meshes, volumes, the light map last: about their order off the wire), so the uploads run while the big files
  // are still being inflated in their workers instead of after the last of them (11-17: ~1.2 s off the opening).
  const later = p => { p.catch(() => {}); return p; };   // a failure is reported where it is awaited
  const volFiles = new Set(volDefs.map(v => v.dosya));
  const binP = new Map(binFiles.map(f => [f, later(fetchBytes(f, !small.has(f), volFiles.has(f)))]));
  const imgP = new Map(imageFiles.map(f => [f, later((async () => {
      const r = await fetch(new URL(f, base), NO_STORE).catch(e => { throw fail(f + ': okunamadı (' + e.message + ')'); });
      if (!r.ok) throw fail(f + ': doku bulunamadı (HTTP ' + r.status + ')');
      onWire(f, 0, +(r.headers.get('Content-Length') || 0));
      const blob = await r.blob();
      onWire(f, blob.size, null);
      let bmp;
      try {
        bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
        if (bmp.width !== 2048 || bmp.height !== 2048) {
          const r2 = await createImageBitmap(bmp, { resizeWidth: 2048, resizeHeight: 2048, resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          bmp.close(); bmp = r2;
        }
      } catch (e) { throw fail(f + ': doku çözülemedi (' + e.message + ')'); }
      files[f] = [performance.now() - T0, blob.size];
      return bmp;
    })())]));
  Promise.all([...binP.values(), ...imgP.values()]).then(() => { mark.indir = performance.now() - T0; }, () => {});
  const sources = await Promise.all(SHADER_FILES.map(async f => {
      const r = await fetch(new URL(f, SCRIPT_BASE)).catch(e => { throw fail(f + ': gölgelendirici okunamadı (' + e.message + ')'); });
      if (!r.ok) throw fail(f + ': gölgelendirici bulunamadı (HTTP ' + r.status + ')');
      const t = await r.text();
      return t;
    }));
  const bin = {};
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
  const images = await Promise.all(imageFiles.map(f => imgP.get(f)));
  const img = Object.fromEntries(imageFiles.map((f, i) => [f, images[i]]));
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

  mark.doku = performance.now() - T0;

  bin[pack.geometri.dosya] = await binP.get(pack.geometri.dosya);
  for (const d of dynDefs) bin[d.dosya] = await binP.get(d.dosya);
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
    return { vao, vb, ib, nv, ni, pos: new Float32Array(buf.slice(16, 16 + nv * 40)), idx, upload() { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.idx, gl.STATIC_DRAW); } };
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
  // the exterior (Phase 2): the ranges of the dis_* materials, drawn by the void once per facility (drawVoid)
  const isDis = it => /^dis_/.test((mats[it.malzeme] || {}).ad || '');
  const disItems = staticItems.filter(isDis);
  const interiorItems = staticItems.filter(it => !isDis(it));

  // the moving parts: rotors (kanat > 0: spun, motion-blurred) and levers (turned about their axis)
  const dyn = dynDefs.map(d => {
    const m = mesh(d.dosya);
    const ranges = d.araliklar && d.araliklar.length ? d.araliklar
      : [{ malzeme: d.malzeme != null ? d.malzeme : Math.max(0, mats.findIndex(x => flagOf(x, 'dynamic'))), ilk: 0, sayi: m.ni }];
    const items = ranges.map(r => ({ ...r, sayfa: 0, anchor: null }));
    m.upload();
    triangles += m.ni / 3;
    const o = { def: d, name: d.ad, mesh: m, items, angle: 0, omega: 0, centre: d.merkez, axis: norm(d.eksen || [1, 0, 0]), rotor: (d.kanat || 0) > 0,
      void: d.ad === 'kapak' };                   // the hatch's lid: part of the exterior (drawVoid)
    if (o.rotor) Object.assign(o, rotorTable(m, d, ranges));
    delete bin[d.dosya];
    return o;
  });
  delete bin[pack.geometri.dosya];
  mark.nesne = performance.now() - T0;

  for (const v of volDefs) bin[v.dosya] = await binP.get(v.dosya);
  // volumes: one 3D texture each, M | F side by side along x, the groups stacked along z
  const vols = volDefs.map(v => {
    const buf = bin[v.dosya], dv = new DataView(buf);
    if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x31564d4b) throw fail(v.dosya + ': KMV1 başlığı yok');
    const [nx, ny, nz] = [dv.getUint32(4, true), dv.getUint32(8, true), dv.getUint32(12, true)];
    if (nx !== v.boyut[0] || ny !== v.boyut[1] || nz !== v.boyut[2] || dv.getUint32(16, true) !== 3 || buf.byteLength !== 20 + nx * ny * nz * 8 * 2 * 3)
      throw fail(v.dosya + ': boyutu sahne.json ile uyuşmuyor');
    if (2 * nx > max3D || ny > max3D || 3 * nz > max3D) throw fail(v.dosya + ': hacim bu kartın 3B doku sınırını aşıyor');
    const grid = nx * ny * nz * 4, row = nx * 4, pre = laidOut.has(v.dosya);
    const out = pre ? new Uint16Array(buf, 20, grid * 2 * 3) : new Uint16Array(grid * 2 * 3);
    for (let g = 0; g < 3 && !pre; g++) {
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
  mark.hacim = performance.now() - T0;

  // light map: layer = page * 3 + group. L0 as RGB9_E5 (4 bytes instead of RGBA16F's 8: a shared exponent keeps
  // 9 bits of every channel relative to the brightest, ~0.2 %, far under one output level), its direction plane B
  // RGBA8, and the openness (the same in every group) once per page as R8: 25 instead of 36 bytes a texel
  const lmW = lmDef.genislik, lmH = lmDef.yukseklik, pages = lmDef.sayfa;
  if (lmW > maxTex || lmH > maxTex || pages * 3 > maxLayers) throw fail('Işık haritası bu kartın doku sınırını aşıyor (' + lmW + ' × ' + lmH + ' × ' + pages * 3 + ')');
  const lmA = tex(gl.TEXTURE_2D_ARRAY, { bytes: lmW * lmH * 4 * pages * 3 });
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGB9_E5, lmW, lmH, pages * 3);
  const lmB = tex(gl.TEXTURE_2D_ARRAY, { bytes: lmW * lmH * 4 * pages * 3 });
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, lmW, lmH, pages * 3);
  const lmO = tex(gl.TEXTURE_2D_ARRAY, { bytes: lmW * lmH * pages });
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, lmW, lmH, pages);
  const halfToFloat = (() => {               // every half float's value, once
    const t = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const e = (h >> 10) & 31, m = h & 1023, sg = h & 0x8000 ? -1 : 1;
      t[h] = sg * (e === 0 ? m * Math.pow(2, -24) : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * Math.pow(2, e - 15));
    }
    return t;
  })();
  const rgb9e5 = new Uint32Array(lmW * lmH), openness = new Uint8Array(lmW * lmH);
  const toRgb9e5 = (src, withOpen) => {   // src: RGBA half floats of one layer
    for (let i = 0, q = 0; i < rgb9e5.length; i++, q += 4) {
      let r = halfToFloat[src[q]], g = halfToFloat[src[q + 1]], b = halfToFloat[src[q + 2]];
      if (withOpen) { const a = halfToFloat[src[q + 3]]; openness[i] = a > 0 ? (a >= 1 ? 255 : Math.round(a * 255)) : 0; }
      r = r > 0 ? Math.min(r, 65408) : 0; g = g > 0 ? Math.min(g, 65408) : 0; b = b > 0 ? Math.min(b, 65408) : 0;
      const mx = Math.max(r, g, b);
      if (mx < 1.53e-10) { rgb9e5[i] = 0; continue; }
      let e = Math.max(-16, Math.floor(Math.log2(mx))) + 1;                  // shared exponent, bias 15, 9-bit mantissa
      let sc = Math.pow(2, e - 9);
      if (Math.round(mx / sc) === 512) { e++; sc *= 2; }
      const R = Math.round(r / sc), G = Math.round(g / sc), B = Math.round(b / sc);
      rgb9e5[i] = (((e + 15) & 31) << 27 | (B & 511) << 18 | (G & 511) << 9 | (R & 511)) >>> 0;
    }
  };
  // KML2 (sahne/araclar/paket_e5.py, at build time) holds what is uploaded; KML1 is converted here (~4.4 s for three
  // pages on the main thread, the real window's black opening, 11-16)
  for (let p = 0; p < pages; p++) {
    const file = lmDef.dosya[p], buf = bin[file] = await binP.get(file), dv = new DataView(buf), n = lmW * lmH * 4, nt = lmW * lmH;
    const magic = buf.byteLength >= 16 ? dv.getUint32(0, true) : 0;
    if (magic !== 0x314c4d4b && magic !== 0x324c4d4b) throw fail(file + ': KML1/KML2 başlığı yok');
    const v2 = magic === 0x324c4d4b;
    if (dv.getUint32(4, true) !== lmW || dv.getUint32(8, true) !== lmH || dv.getUint32(12, true) !== 3 ||
        buf.byteLength !== (v2 ? 16 + nt * 8 * 3 + nt : 16 + n * 3 * 3))
      throw fail(file + ': boyutu sahne.json ile uyuşmuyor');
    let off = 16;
    for (let g = 0; g < 3; g++) {
      let e5;
      if (v2) { e5 = new Uint32Array(buf, off, nt); off += nt * 4; } else { toRgb9e5(new Uint16Array(buf, off, n), g === 0); off += n * 2; e5 = rgb9e5; }
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, lmA);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, p * 3 + g, lmW, lmH, 1, gl.RGB, gl.UNSIGNED_INT_5_9_9_9_REV, e5);
      if (g === 0 && !v2) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, lmO);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, p, lmW, lmH, 1, gl.RED, gl.UNSIGNED_BYTE, openness);
      }
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, lmB);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, p * 3 + g, lmW, lmH, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(buf, off, n)); off += n;
    }
    if (v2) {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, lmO);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, p, lmW, lmH, 1, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(buf, off, nt));
    }
    delete bin[file];
  }

  mark.isikHaritasi = performance.now() - T0;

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
    matUBO.set([...(m.renk || [1, 1, 1]), m.isima != null ? m.isima : (m.emitScale || 0)], 256 + i * 4);   // sahne.json: isima = emitScale
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
  // Each program declares only the volumes it reads: a fragment shader has 16 texture units, the scene pass already
  // uses 9 and the pack can hold 8 volumes (Phase 2: stair, back space, roof). The scene and rotor passes light only the
  // moving parts from the volumes, so they get the volumes that hold one of them (and the outer one); lightAt skips the
  // rest (VOL_MASK). The haze reads all of them.
  function volCodeFor(mask) {
    let c = '';
    for (let i = 0; i < NV; i++) if (mask >> i & 1) c += `uniform sampler3D uVol${i};\n`;
    c += 'void volRead(int i, vec3 c, out vec4 m, out vec4 kr, out vec4 kg, out vec4 kb) {\n';
    let first = true;
    for (let i = 0; i < NV; i++) {
      if (!(mask >> i & 1)) continue;
      c += `    ${first ? '' : 'else '}if (i == ${i}) { m = texture(uVol${i}, c); kr = texture(uVol${i}, c + vec3(0.25, 0, 0)); ` +
        `kg = texture(uVol${i}, c + vec3(0.5, 0, 0)); kb = texture(uVol${i}, c + vec3(0.75, 0, 0)); }\n`;
      first = false;
    }
    c += (first ? '    ' : '    else ') + '{ m = kr = kg = kb = vec4(0.0); }\n}\n';
    return c;
  }
  const bits = m => { let n = 0; while (m) { n += m & 1; m >>= 1; } return n; };
  const ALL_VOLS = (1 << NV) - 1;
  const inVol = (v, p) => [0, 1, 2].every(k => p[k] >= v.alt[k] && p[k] <= v.hi[k]);
  let DYN_VOLS = 1 << (NV - 1);
  for (const d of dyn) vols.forEach((v, i) => { if (inVol(v, d.centre)) DYN_VOLS |= 1 << i; });
  if (bits(DYN_VOLS) > 7) DYN_VOLS = ALL_VOLS;     // more than the scene pass can hold: the compile error will say so
  mark.tablo = performance.now() - T0;           // materials, fixed tables
  const compileT0 = performance.now();
  const programs = {};
  function build(name, vsFile, fsFile, defines = '', mask = ALL_VOLS) {
    const head = '#version 300 es\n#define NV ' + NV + '\n#define VOL_MASK ' + mask + '\n' + defines;
    const common = src['common.glsl'].replace('// VOLUMES', volCodeFor(mask));
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
  build('scene', 'scene.vert', 'scene.frag', '', DYN_VOLS);
  build('depth', 'scene.vert', 'depth.frag', '', DYN_VOLS);
  build('rotor', 'rotor.vert', 'rotor.frag', '', DYN_VOLS);
  build('haze', 'quad.vert', 'haze.frag');
  build('combine', 'quad.vert', 'combine.frag');
  build('dis', 'dis.vert', 'dis.frag', '', DYN_VOLS);   // the lid is lit from the volumes round it
  build('disDepth', 'dis.vert', 'depth.frag');
  build('fener', 'fener.vert', 'fener.frag');
  build('direk', 'direk.vert', 'direk.frag');
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
  mark.derleme = performance.now() - T0;
  console.info('Salon: yükleme (ms, baştan) ' + Object.entries(mark).map(([k, v]) => k + '=' + Math.round(v)).join(' '));

  // texture units: fixed per name, the volumes after them
  const UNIT = { uAlb: 0, uNrm: 1, uArm: 2, uLmA: 3, uLmB: 4, uLmO: 15, uLevha: 5, uRefl: 6, uNoise: 7, uTab: 5, uDepth: 1, uHaze: 2,
    uScene: 3, uBloom: 4, uSrc: 0, uDither: 6, uGlow: 7 };
  const VOL_UNIT = 16;                             // after every fixed unit (uLmO is 15): 16 + 8 <= 32 combined
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
      glow: target(w, h, gl.RGBA16F),               // the void's lamps (fener.vert), at the canvas' resolution
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
  let exposure = 1, time = 0, haze = { density: 1, fans: [] }, hoverName = null, heat = 0;
  const levha = new Map();                       // atlas name -> { t, w, h, emissive }
  const levhaJobs = new Map();                   // atlas name -> { lv, bytes, row, emissive }: strips still to upload
  const LEVHA_BYTES_PER_FRAME = 4 << 20;         // ~1 ms of upload a frame (16 MB measured 3.5 ms, 2 MB 0.2 ms)
  function pumpLevha() {
    let budget = LEVHA_BYTES_PER_FRAME;
    for (const [name, j] of levhaJobs) {
      const { lv } = j, rowBytes = lv.w * 4;
      const rows = Math.max(1, Math.min(lv.h - j.row, Math.floor(budget / rowBytes)));
      gl.bindTexture(gl.TEXTURE_2D, lv.next);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, j.row, lv.w, rows, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(j.bytes.buffer || j.bytes, j.row * rowBytes, rows * rowBytes));
      j.row += rows;
      budget -= rows * rowBytes;
      if (j.row >= lv.h) {
        gl.generateMipmap(gl.TEXTURE_2D);
        const t = lv.t; lv.t = lv.next; lv.next = t;
        lv.emissive = j.emissive;
        levhaJobs.delete(name);
      }
      if (budget <= 0) break;
    }
  }
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
      if (!(voidOn() && VOID.noInterior)) for (const it of (voidOn() ? interiorItems : staticItems)) colour ? drawItem(pr, it, 1) : drawRaw(it);
      for (const d of dyn) {
        if (d.void && voidOn()) continue;          // the hatch's lid: drawn with the exterior
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
    bindTex(UNIT.uLmA, gl.TEXTURE_2D_ARRAY, lmA); bindTex(UNIT.uLmB, gl.TEXTURE_2D_ARRAY, lmB); bindTex(UNIT.uLmO, gl.TEXTURE_2D_ARRAY, lmO);
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
    // the void's facilities once over the whole target, not per band (each band would redo all their vertices)
    if (!mirror && voidOn()) {
      gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
      if (prepass) { gl.colorMask(false, false, false, false); drawVoid(c, false); gl.colorMask(true, true, true, true); gl.depthFunc(gl.EQUAL); gl.depthMask(false); }
      drawVoid(c, true);
      gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
      gl.flush();
    }
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

  // the frame's own brightness (eye adaptation, ui/yuruyus.js): bloom level 0 (the scene composited with the haze at
  // the haze's size, before exposure) halved by linear blits (exact 2x2 means) down to at most 64 texels wide, so
  // the whole screen is measured; read into a PBO behind a fence and picked up a frame or two later, never with a
  // synchronous readPixels. Off until setMeter(true). (Not the bloom chain's own smallest level: the down pass
  // takes its texel step from the wrong level there, so that level samples a few points, not the screen.)
  const meter = { on: false, every: 4, ring: [], next: 0, n: 0, data: null, value: null, chain: [], src: '', readMs: 0 };
  function meterChain() {
    const key = T.bloom.w + 'x' + T.bloom.h;
    if (meter.src === key) return meter.chain;
    for (const c of meter.chain) { gl.deleteFramebuffer(c.fb); gl.deleteTexture(c.t); }
    meter.chain = []; meter.src = key;
    let w = T.bloom.w, h = T.bloom.h;
    while (w > 64) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      meter.chain.push({ t, fb, w, h });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return meter.chain;
  }
  // three PBOs in a ring: a buffer is written again only after it was read (one written while its fence was pending
  // lost Chromium's readback shadow and turned the read into a stall)
  function meterPoll() {
    for (let k = 0; k < meter.ring.length; k++) {
      const r = meter.ring[(meter.next + k) % meter.ring.length];   // oldest first
      if (!r.sync) continue;
      const st = gl.clientWaitSync(r.sync, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED) return;
      if (st !== gl.WAIT_FAILED && r.n === meter.n) {
        const t0 = performance.now();
        gl.bindBuffer(gl.COPY_READ_BUFFER, r.pbo);
        gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, meter.data, 0, r.n * 4);
        meter.readMs = performance.now() - t0;
        gl.bindBuffer(gl.COPY_READ_BUFFER, null);
        let lsum = 0, sum = 0, max = 0;
        for (let i = 0; i < r.n; i++) {
          const y = 0.2126 * meter.data[i * 4] + 0.7152 * meter.data[i * 4 + 1] + 0.0722 * meter.data[i * 4 + 2];
          const v = y > 0 && isFinite(y) ? y : 0;
          lsum += Math.log(v + 1e-5); sum += v; if (v > max) max = v;
        }
        meter.value = { logAvg: Math.exp(lsum / r.n), mean: sum / r.n, max, frame: r.frame, readMs: meter.readMs };
      }
      gl.deleteSync(r.sync); r.sync = null;
    }
  }
  function meterSample() {
    const chain = meterChain();
    let src = T.bloom.fbs[0], sw = T.bloom.w, sh = T.bloom.h;
    const last = chain.length ? chain[chain.length - 1] : null, n = last ? last.w * last.h : sw * sh;
    if (meter.n !== n) {
      for (const r of meter.ring) { if (r.sync) gl.deleteSync(r.sync); gl.deleteBuffer(r.pbo); }
      meter.n = n; meter.data = new Float32Array(n * 4);
      meter.ring = [0, 1, 2].map(() => {
        const pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, n * 16, gl.STREAM_READ);
        return { pbo, sync: null, n, frame: -1 };
      });
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      meter.next = 0;
    }
    const slot = meter.ring[meter.next];
    if (slot.sync) return;                       // all three in flight: skip this frame's measurement
    if (frames % meter.every) return;            // the read costs 0.2-0.7 ms of the main thread (measured headless)
    for (const c of chain) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, c.fb);
      gl.blitFramebuffer(0, 0, sw, sh, 0, 0, c.w, c.h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      src = c.fb; sw = c.w; sh = c.h;
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, src);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.readPixels(0, 0, sw, sh, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    slot.frame = frames;
    meter.next = (meter.next + 1) % meter.ring.length;
    gl.flush();
  }

  // ==================================================================== the void (Phase 2): the outside
  // The facility seen from outside, ours and every other one in the fog: the exterior's draw ranges (dis_*) instanced
  // per facility (dis.vert, dis.frag), each lamp a sprite (fener.vert), the fog in the composite (post.frag). The app
  // (ui/disari.js) says where the facilities are (setVoid: placements, deterministic, round the camera); this culls,
  // chooses the detail by distance and draws. Ours is the placement with home: true at the origin; every facility of
  // our own stack (home) wears our colours, so after the wrap (the camera moved by one period) the picture is the same.
  // Off (no cost, nothing changed) while the camera is in the hall away from the stair.
  const VOID = {
    list: [],                                   // [{ o: [x, y, z], yaw, col: [r, g, b] (full colour, 0..1), home }]
    lid: 0,                                     // our hatch's lid, radians about its axis (+: open)
    kOthers: 30,                                // the other facilities' group-0 intensity (their lamps are steady)
    fog: { sigma: 0.0028, up: [0.066, 0.086, 0.098], down: [0.018, 0.023, 0.027], amb: 1.6, pierce: 0.55, haloR: 9.0, haloK: 90 },
    force: null,                                // tests: true / false overrides the automatic switch
    lampsOff: false,                            // tests: the frame without the lamps' sprites (their own light alone)
    lampsBare: false,                           // tests: the lamps unhidden by the scene (their full light)
    mastsOff: false,                            // tests: without the far masts' lines
    on: false, inBlock: true, homeHaze: 1, n: 0, lamps: 0, drawn: [0, 0, 0], noInterior: false,
  };
  const voidOn = () => VOID.on;
  const kapakDyn = dyn.find(d => d.void) || null;
  const boxLoHi = k => { const e = [len(k.x), len(k.y), len(k.z)]; return [sub(k.merkez, e), add(k.merkez, e)]; };
  const blockBox = anchors.dis_blok && anchors.dis_blok.kutu ? boxLoHi(anchors.dis_blok.kutu) : null;
  const boundsBox = anchors.dis_sinir && anchors.dis_sinir.kutu ? boxLoHi(anchors.dis_sinir.kutu) : null;
  const hatchBox = anchors.kapak && anchors.kapak.kutu ? anchors.kapak.kutu : null;
  const fenerAnchor = anchors.dis_fener && anchors.dis_fener.kutu ? anchors.dis_fener.kutu.merkez : null;
  const fenerLight = (pack.isiklar || []).find(l => l.tur === 'kure' && fenerAnchor && len(sub(l.merkez, fenerAnchor)) < 0.2);
  const fenerMat = mats.find(m => m.ad === 'dis_fener');
  const lampR = fenerLight ? fenerLight.yaricap : 0.1;
  const lampL = fenerMat ? scl(fenerMat.renk || [1, 1, 1], fenerMat.isima || 0) : [0, 0, 0];
  // the mast under every lamp (sahne/firin hall_outside.cpp, mast()): 18 m of steel 0.15-0.22 m thick, its top 0.07 m
  // under the globe; lit only by the fog (dis.frag's ambient: the sky's light from all round x uAmb x its albedo)
  const koyuMat = mats.find(m => m.ad === 'dis_koyu');
  const MAST = { below: lampR + 0.07 + 18.0, width: 0.17, top: 0.07 };
  const mastL = () => {
    const a = koyuMat && koyuMat.ortalamaAlbedo ? koyuMat.ortalamaAlbedo : [0.03, 0.024, 0.017], f = VOID.fog;
    return [0, 1, 2].map(i => a[i] * f.amb * 0.5 * (f.up[i] + f.down[i]));
  };
  const bCentre = boundsBox ? scl(add(boundsBox[0], boundsBox[1]), 0.5) : [0, 0, 0];
  const bRadius = boundsBox ? 0.5 * len(sub(boundsBox[1], boundsBox[0])) : 1;
  // the detail by distance: near (every range), mid (no lamp globe: its sprite is it; no mast and dark steel: under
  // a pixel, the mast is drawn as a line instead), far (walls, columns, deck)
  const nameOf = it => (mats[it.malzeme] || {}).ad || '';
  const LOD = [
    disItems,
    disItems.filter(it => !/^dis_(fener|koyu)$/.test(nameOf(it))),   // the mast: a line of its width (direk.vert)
    disItems.filter(it => /^dis_(duvar|kolon|zemin|isik)$/.test(nameOf(it))),
  ];
  const LOD_D = [260, 700];                     // nearest distance (m) to a facility's bounds below which near / mid
  const INST_F = 8;                             // floats per instance: offset, yaw, colour (C k), the globe's mesh share
  const LAMP_F = 12;                            // per lamp: centre, radius, colour, the sprite's core share, mast (1: a line)
  let instData = new Float32Array(INST_F * 64), lampData = new Float32Array(LAMP_F * 64);
  const instBuf = own('Buffer', gl.createBuffer()), lampBuf = own('Buffer', gl.createBuffer());
  function instancedVao(m) {
    const vao = own('VertexArray', gl.createVertexArray());
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vb);
    [[3, gl.FLOAT, false, 0], [4, gl.SHORT, true, 12], [4, gl.SHORT, true, 20], [2, gl.FLOAT, false, 28], [2, gl.UNSIGNED_SHORT, true, 36]]
      .forEach(([n, type, nrm, off], i) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, type, nrm, 40, off); });
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, INST_F * 4, gl.STREAM_DRAW);
    for (const i of [5, 6]) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, INST_F * 4, (i - 5) * 16); gl.vertexAttribDivisor(i, 1); }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
    gl.bindVertexArray(null);
    return vao;
  }
  const geoInstVao = disItems.length ? instancedVao(geo) : null;
  const lidInstVao = kapakDyn ? instancedVao(kapakDyn.mesh) : null;
  const lampVao = own('VertexArray', gl.createVertexArray());
  gl.bindVertexArray(lampVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lampBuf);
  gl.bufferData(gl.ARRAY_BUFFER, LAMP_F * 4, gl.STREAM_DRAW);
  for (const i of [0, 1, 2]) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, LAMP_F * 4, i * 16); gl.vertexAttribDivisor(i, 1); }
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  const VG = [{ first: 0, count: 0 }, { first: 0, count: 0 }, { first: 0, count: 0 }];
  const VLID = { first: 0, count: 0, home: -1 };
  // the switch: on while the camera can see out (outside the block, or on the way up behind the chamber)
  function voidSwitch(e) {
    let inBlock = false;
    if (blockBox) inBlock = e[0] > blockBox[0][0] - 0.05 && e[0] < blockBox[1][0] + 0.05 && e[1] > blockBox[0][1] - 0.05 &&
      e[1] < blockBox[1][1] + 0.05 && e[2] > blockBox[0][2] - 0.05 && e[2] < blockBox[1][2] + 0.05;
    VOID.inBlock = inBlock;
    VOID.on = VOID.force != null ? !!VOID.force : !!(disItems.length && blockBox && (!inBlock || e[2] < -289));
    FAR = VOID.on ? FAR_VOID : FAR_HALL;
  }
  // the frame's facilities: culled (the fog's reach, the view's frustum), sorted into the three details; their lamps
  function prepareVoid(c) {
    VOID.n = 0; VOID.lamps = 0;
    if (!VOID.on) return;
    const e = c.eye;
    let dB = 0;
    for (let i = 0; i < 3; i++) dB += Math.pow(Math.max(0, blockBox[0][i] - e[i], e[i] - blockBox[1][i]), 2);
    VOID.homeHaze = 1 - smoothstep(150, 300, Math.sqrt(dB));
    // the hall can only be seen from outside through the open hatch: skip all of it unless the hatch is open, near
    // enough to show a few pixels of the stair, and in view
    VOID.noInterior = !VOID.inBlock;
    if (VOID.noInterior && hatchBox && VOID.lid > 0.02) {
      const q = sub(hatchBox.merkez, e), d = len(q), z = dot(q, c.F), r = 3.5;
      if (d < 140 && z > -r && Math.abs(dot(q, c.R)) < z * c.tx + r * 1.5 && Math.abs(dot(q, c.U)) < z * c.ty + r * 1.5) VOID.noInterior = false;
    }
    const f = VOID.fog, rGeo = 4.6 / f.sigma, rLamp = 6.2 / (f.sigma * f.pierce);
    const g0 = groups[0], kOurs = g0[3], ours = [g0[0] * kOurs, g0[1] * kOurs, g0[2] * kOurs];
    const pxAngle = 2 * c.ty / Math.max(1, H);
    const sx = Math.sqrt(1 + c.tx * c.tx), sy = Math.sqrt(1 + c.ty * c.ty);
    const lists = [[], [], []], lamps = [], lids = [];
    let homeLid = null;
    for (const fac of VOID.list) {
      const yaw = fac.yaw || 0, cy = Math.cos(yaw), sn = Math.sin(yaw);
      const rot = p => [cy * p[0] + sn * p[2], p[1], -sn * p[0] + cy * p[2]];
      const col = fac.home ? ours : scl(fac.col, VOID.kOthers);
      // the offset that turns the facility about its own centre: p' = R p + (o + c - R c), exact for ours (yaw 0)
      const off = yaw ? add(fac.o, sub(bCentre, rot(bCentre))) : fac.o;
      let share = 0, lampAt = -1;
      if (fenerAnchor) {
        const lp = add(rot(fenerAnchor), off);
        const q = sub(lp, e), d = len(q), z = dot(q, c.F);
        share = smoothstep(1.0, 2.2, lampR / Math.max(d, 1e-3) / pxAngle);
        // in view, or its mast (18 m below it) is
        if (d < rLamp && z > -1 && Math.abs(dot(q, c.R)) < z * c.tx + 2 * sx && Math.abs(dot(q, c.U)) < z * c.ty + 20 * sy && share < 1) {
          lampAt = lamps.length;
          lamps.push(lp[0], lp[1], lp[2], lampR, col[0] * lampL[0], col[1] * lampL[1], col[2] * lampL[2], 1 - share, 0, 0, 0, 0);
        }
      }
      // the body: its bounds' sphere against the frustum, the box's nearest distance against the fog's reach
      const q = sub(add(rot(bCentre), off), e);
      const z = dot(q, c.F);
      if (z < -bRadius || Math.abs(dot(q, c.R)) > z * c.tx + bRadius * sx || Math.abs(dot(q, c.U)) > z * c.ty + bRadius * sy) continue;
      let dn = 0;
      for (let i = 0; i < 3; i++) {
        const m = i !== 1 ? 25 : 0;               // 25 m: the yaw's swing
        dn += Math.pow(Math.max(0, boundsBox[0][i] + fac.o[i] - m - e[i], e[i] - boundsBox[1][i] - fac.o[i] - m), 2);
      }
      dn = Math.sqrt(dn);
      if (dn > rGeo) continue;
      const rec = [off[0], off[1], off[2], yaw, col[0], col[1], col[2], share];
      const lod = dn < LOD_D[0] || (fac.home && dn < LOD_D[1]) ? 0 : dn < LOD_D[1] ? 1 : 2;
      if (lod > 0 && lampAt >= 0) lamps[lampAt + 8] = 1;      // its mesh has no mast: the line
      lists[lod].push(rec);
      if (lod === 0) { if (!off[0] && !off[1] && !off[2] && !yaw) homeLid = rec; else lids.push(rec); }
    }
    let n = 0;
    const need = (lists[0].length + lists[1].length + lists[2].length + lids.length + 1) * INST_F;
    if (instData.length < need) instData = new Float32Array(need * 2);
    for (let l = 0; l < 3; l++) {
      VG[l].first = n; VG[l].count = lists[l].length;
      for (const r of lists[l]) { instData.set(r, n * INST_F); n++; }
    }
    VLID.first = n; VLID.count = lids.length; VLID.home = -1;
    for (const r of lids) { instData.set(r, n * INST_F); n++; }
    if (homeLid) { instData.set(homeLid, n * INST_F); VLID.home = n; n++; }
    VOID.n = n;
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instData.subarray(0, Math.max(1, n) * INST_F), gl.STREAM_DRAW);
    VOID.lamps = lamps.length / LAMP_F;
    if (lampData.length < lamps.length) lampData = new Float32Array(lamps.length * 2);
    lampData.set(lamps);
    gl.bindBuffer(gl.ARRAY_BUFFER, lampBuf);
    gl.bufferData(gl.ARRAY_BUFFER, lampData.subarray(0, Math.max(LAMP_F, lamps.length)), gl.STREAM_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    VOID.drawn = [VG[0].count, VG[1].count, VG[2].count];
  }
  function pointInstances(first) {
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, INST_F * 4, first * INST_F * 4);
    gl.vertexAttribPointer(6, 4, gl.FLOAT, false, INST_F * 4, first * INST_F * 4 + 16);
  }
  // the exterior's draws inside the scene pass (its prepass and its colour pass: the same vertex shader)
  function drawVoid(c, colour) {
    if (!VOID.n || !geoInstVao) return;
    const pr = colour ? programs.dis : programs.disDepth, u = pr.u;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(u.uVP, false, c.vp);
    if (u.uMirror) gl.uniform1f(u.uMirror, 0);
    if (colour) {
      camUniforms(pr, c);
      gl.uniform3fv(u.uEyeShade, c.eye);
      gl.uniform1f(u.uPxScale, 1 / Q.scale);
      gl.uniform1f(u.uCubic, Q.cubic ? 1 : 0);
      gl.uniform1f(u.uVolLit, 0);
      gl.uniform3fv(u.uFogUp, VOID.fog.up); gl.uniform3fv(u.uFogDown, VOID.fog.down);
      gl.uniform1f(u.uAmb, VOID.fog.amb);
    }
    gl.uniformMatrix4fv(u.uModel, false, IDENTITY);
    gl.bindVertexArray(geoInstVao);
    for (let l = 0; l < 3; l++) {
      const g = VG[l];
      if (!g.count) continue;
      pointInstances(g.first);
      for (const it of LOD[l]) {
        if (colour) {
          gl.uniform1i(u.uMat, it.malzeme);
          gl.uniform1i(u.uPage, it.sayfa || 0);
          gl.uniform1f(u.uFener, nameOf(it) === 'dis_fener' ? 1 : 0);
        }
        gl.drawElementsInstanced(gl.TRIANGLES, it.sayi, gl.UNSIGNED_INT, it.ilk * 4, g.count);
      }
    }
    if (lidInstVao && (VLID.count || VLID.home >= 0)) {
      gl.bindVertexArray(lidInstVao);
      if (colour) { gl.uniform1f(u.uVolLit, 1); gl.uniform1f(u.uFener, 0); gl.uniform1i(u.uPage, 0); }
      const draw = (first, count, angle) => {
        gl.uniformMatrix4fv(u.uModel, false, frameOf(kapakDyn.axis, kapakDyn.centre, angle).m);
        pointInstances(first);
        for (const it of kapakDyn.items) {
          if (colour) gl.uniform1i(u.uMat, it.malzeme);
          gl.drawElementsInstanced(gl.TRIANGLES, it.sayi, gl.UNSIGNED_INT, it.ilk * 4, count);
        }
      };
      if (VLID.count) draw(VLID.first, VLID.count, 0);              // the others' lids: closed
      if (VLID.home >= 0) draw(VLID.home, 1, VOID.lid);
      if (colour) gl.uniform1f(u.uVolLit, 0);
      gl.uniformMatrix4fv(u.uModel, false, IDENTITY);
    }
    gl.bindVertexArray(geo.vao);
  }
  // the lamps' sprites into their own target (canvas resolution), after the scene (they read its depth)
  function drawLamps(c) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.glow.fb);
    gl.viewport(0, 0, T.glow.w, T.glow.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!VOID.lamps || VOID.lampsOff) return;
    const pr = programs.fener, u = pr.u;
    gl.useProgram(pr.p);
    camUniforms(pr, c);
    bindTex(UNIT.uDepth, gl.TEXTURE_2D, T.scene.depth);
    gl.uniform2f(u.uSize, T.glow.w, T.glow.h);
    gl.uniform1f(u.uPxAngle, 2 * c.ty / T.glow.h);
    gl.uniform1f(u.uSigma, VOID.fog.sigma);
    gl.uniform1f(u.uPierce, VOID.fog.pierce);
    gl.uniform1f(u.uHaloR, VOID.fog.haloR);
    if (u.uHaloK) gl.uniform1f(u.uHaloK, VOID.fog.haloK);
    gl.uniform1f(u.uExposure, exposure * (1 - 0.04));   // tonemapped here (fener.vert); 0.04: the composite's bloom mix
    gl.uniform3fv(u.uFogUp, VOID.fog.up); gl.uniform3fv(u.uFogDown, VOID.fog.down);
    gl.uniform1f(u.uMaxPx, 420);
    gl.uniform1f(u.uOcc, VOID.lampsBare ? 0 : 1);
    gl.bindVertexArray(lampVao);
    gl.enable(gl.BLEND);
    // the far masts first, laid over (premultiplied); the lamps on them, added (their alpha is 0)
    const pm = programs.direk, um = pm.u;
    gl.useProgram(pm.p);
    camUniforms(pm, c);
    bindTex(UNIT.uDepth, gl.TEXTURE_2D, T.scene.depth);
    gl.uniform2f(um.uSize, T.glow.w, T.glow.h);
    gl.uniform1f(um.uPxAngle, 2 * c.ty / T.glow.h);
    gl.uniform1f(um.uSigma, VOID.fog.sigma);
    gl.uniform1f(um.uExposure, exposure * (1 - 0.04));
    gl.uniform3fv(um.uFogUp, VOID.fog.up); gl.uniform3fv(um.uFogDown, VOID.fog.down);
    gl.uniform3fv(um.uMastL, mastL());
    gl.uniform3f(um.uMastS, MAST.below, MAST.width, MAST.top);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (!VOID.mastsOff) gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, VOID.lamps);
    gl.useProgram(pr.p);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, VOID.lamps);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
  // the fog's uniforms in the composite and the bloom's first level
  function fogUniforms(pr, c) {
    const u = pr.u;
    if (!u.uVoidOn) return;
    gl.uniform1f(u.uVoidOn, VOID.on ? 1 : 0);
    if (!VOID.on) return;
    camUniforms(pr, c);
    gl.uniform1f(u.uFogSigma, VOID.fog.sigma);
    gl.uniform3fv(u.uFogUp, VOID.fog.up);
    gl.uniform3fv(u.uFogDown, VOID.fog.down);
    gl.uniform3fv(u.uBlockLo, blockBox[0]);
    gl.uniform3fv(u.uBlockHi, blockBox[1]);
    gl.uniform1f(u.uCamInside, VOID.inBlock ? 1 : 0);
    gl.uniform1f(u.uHomeHaze, VOID.homeHaze);
  }

  let combinedFor = null, combinePhase = 0;
  // all slices when a colour jumps; otherwise every 4th slice per frame, interleaved in z (the core's breathing and
  // the smoothed temperature colour move a colour every frame: recombining all of it cost 1.3 ms a frame, 11-17).
  // A slice lags at most 3 frames; neighbouring slices differ by under 0.5 % then, and the filtering blends them.
  function combineVolumes(all) {
    const pr = programs.combine;
    gl.useProgram(pr.p);
    gl.bindVertexArray(quad);
    gl.uniform3fv(pr.u.uGroup, groupUniform);
    gl.activeTexture(gl.TEXTURE0);
    for (const v of vols) {
      gl.bindTexture(gl.TEXTURE_3D, v.raw);
      gl.uniform3i(pr.u.uN, v.n[0], v.n[1], v.n[2]);
      gl.viewport(0, 0, 4 * v.n[0], v.n[1]);
      for (let z = all ? 0 : combinePhase; z < v.n[2]; z += all ? 1 : 4) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, v.slices[z]);
        gl.uniform1i(pr.u.uZ, z);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    combinePhase = (combinePhase + 1) & 3;
    if (all || combinePhase === 0) combinedFor = groupUniform.slice();
  }
  function render(dt = 1 / 60, shutter = 1 / 60) {
    if (disposed) return;
    const cpu0 = performance.now();
    if (gl.isContextLost()) throw fail('GPU bağlantısı kesildi');
    resize();
    time += Math.max(0, dt || 0);
    pollTimers();
    if (meter.on) meterPoll();
    timing.frame = [];
    if (levhaJobs.size) pumpLevha();
    // eased hover (a small lift in about a tenth of a second)
    const lift = new Set(hoverName ? (linked[hoverName] || [hoverName]) : []);
    for (const a of holders) {
      const v = hoverAmt.get(a.ad) || 0, goal = lift.has(a.ad) ? 1 : 0;
      if (v !== goal) hoverAmt.set(a.ad, Math.abs(goal - v) < 0.02 ? goal : v + (goal - v) * (1 - Math.exp(-Math.max(0, dt || 0) / 0.08)));
    }
    for (let g = 0; g < 3; g++) groupUniform.set(scl(groups[g].slice(0, 3), groups[g][3]), g * 3);
    // the volumes follow the light's colours: recombined when a colour moved (by more than a ten-thousandth)
    let moved = !combinedFor || combinePhase !== 0, jump = !combinedFor;
    for (let i = 0; i < 9 && combinedFor; i++) {
      const r = Math.abs(groupUniform[i] - combinedFor[i]) / Math.max(1e-3, Math.abs(combinedFor[i]));
      if (r > 1e-4) moved = true;
      if (r > 0.02) jump = true;
    }
    if (moved) timed('volumes', () => combineVolumes(jump));
    for (const d of dyn) d.shutter = shutter || 0;
    voidSwitch(eye);
    cam = cameraOf(eye, look, fov, W / H);
    prepareVoid(cam);

    if (hasWet && !(VOID.on && !VOID.inBlock)) {   // outside the block the wet floor cannot be seen
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
    if (VOID.on) timed('lamps', () => drawLamps(cam));
    timed('bloom', () => {
      fullscreen(programs.bloompre, T.bloom, 0, () => {
        bindTex(UNIT.uScene, gl.TEXTURE_2D, T.scene.t);
        bindTex(UNIT.uHaze, gl.TEXTURE_2D, T.haze.t);
        bindTex(UNIT.uDepth, gl.TEXTURE_2D, T.scene.depth);
        fogUniforms(programs.bloompre, cam);
      });
      if (meter.on) meterSample();
      mipChain(T.bloom);
      bloomUp(T.bloom);
    });
    timed('composite', () => fullscreen(programs.compose, T.tone, 0, u => {
      camUniforms(programs.compose, cam);
      bindTex(UNIT.uScene, gl.TEXTURE_2D, T.scene.t);
      bindTex(UNIT.uDepth, gl.TEXTURE_2D, T.scene.depth);
      bindTex(UNIT.uHaze, gl.TEXTURE_2D, T.haze.t);
      bindTex(UNIT.uBloom, gl.TEXTURE_2D, T.bloom.t);
      fogUniforms(programs.compose, cam);
      gl.uniform2f(u.uHazeRatio, T.scene.w / T.haze.w, T.scene.h / T.haze.h);
      gl.uniform1f(u.uBloomMix, 0.04);
      gl.uniform1f(u.uBloomLevels, T.bloom.levels);
      gl.uniform1f(u.uExposure, exposure);
      const hb = anchors.kemer_agiz && anchors.kemer_agiz.kutu;
      gl.uniform3fv(u.uHeatC, hb ? hb.merkez : [0, 0, 0]);
      gl.uniform3fv(u.uHeatX, hb ? hb.x : [0, 0, 0]);
      gl.uniform3fv(u.uHeatY, hb ? hb.y : [0, 0, 0]);
      gl.uniform3fv(u.uHeatZ, hb ? hb.z : [0, 0, 0]);
      gl.uniform1f(u.uHeat, heat);
      gl.uniform1f(u.uTime, time % 3600);
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
        bindTex(UNIT.uGlow, gl.TEXTURE_2D, T.glow.t);
        gl.uniform1f(u.uGlowOn, VOID.on ? 1 : 0);             // the void's lamps, in display light (fener.vert)
        gl.uniform1f(u.uScale, T.half.h / H);
        gl.uniform1i(u.uTaps, taps(T.half.h / H));
      });
    });
    if (timing.frame.length) timing.frames.push(timing.frame);
    timing.frame = null;
    frames++;
    if (frames === 1) firstRenderMs = performance.now() - cpu0;
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
      let t = Math.max(lo, 0);
      // a fan's box is a slab in front of the whole wall: only its disc counts, at the disc, so what is seen past the
      // disc (the exit sign beyond the CPU fan, 11-17: every click on it toggled the fan) is picked, not the fan
      const rot = dyn.find(r => r.rotor && r.name === a.ad + '_rotor');
      if (rot) {
        const dn = dot(d, rot.axis);
        if (Math.abs(dn) < 1e-6) continue;
        const td = dot(sub(rot.centre, c.eye), rot.axis) / dn;
        if (td <= 0 || len(sub(add(c.eye, scl(d, td)), rot.centre)) > rot.rmax * 1.02) continue;
        t = td;
      }
      if (t < best) { best = t; hit = a.ad; }
    }
    // a far small control (the exit sign seen from the entrance is ~70 x 25 px) is also taken within 18 px of its box's
    // centre on screen, when nothing else is under the pointer
    if (!hit) {
      let bd = 18;
      for (const a of anchorList) {
        if (a.tur !== 'tik' || !a.kutu) continue;
        const q = project(a.kutu.merkez);
        if (!q || q.z <= 0 || q.z > 60) continue;   // not the far end's exit sign from the entrance
        const dd = Math.hypot(q.x - x, q.y - y);
        if (dd < bd) { bd = dd; hit = a.ad; }
      }
    }
    return hit;
  }
  function project(p) {
    const r = canvas.getBoundingClientRect();
    const c = cameraOf(eye, look, fov, r.width / r.height);
    const q = sub(p, c.eye), z = dot(q, c.F);
    return { x: (dot(q, c.R) / (z * c.tx) * 0.5 + 0.5) * r.width, y: (0.5 - dot(q, c.U) / (z * c.ty) * 0.5) * r.height, z };
  }

  let disposed = false, frames = 0, firstRenderMs = null;
  const cpuHist = [];
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const f of timing.frames) for (const [, q] of f) gl.deleteQuery(q);
    while (owned.length) { const [kind, o] = owned.pop(); gl['delete' + kind](o); }
    for (const r of meter.ring) { if (r.sync) gl.deleteSync(r.sync); gl.deleteBuffer(r.pbo); }
    for (const c of meter.chain) { gl.deleteFramebuffer(c.fb); gl.deleteTexture(c.t); }
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
    load: { t0: T0, mark, files, get firstMs() { return firstRenderMs; } },   // the load's phases and files (ms from T0, a performance.now()); the first render's script time
    get frames() { return frames; },
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
    // the same as setLevha from raw RGBA bytes (a worker's drawing), uploaded in strips over the next frames into a
    // second texture that replaces the shown one when complete: no frame pays for a whole 16 MB upload (11-17)
    setLevhaBytes(name, w, h, bytes, opts = {}) {
      const lv = levha.get(name);
      if (!lv || lv.w !== w || lv.h !== h) return false;
      if (!lv.next) {
        lv.next = tex(gl.TEXTURE_2D, { mips: true, aniso: true, bytes: w * h * 4 * 4 / 3 });
        gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.SRGB8_ALPHA8, w, h);
      }
      levhaJobs.set(name, { lv, bytes, row: 0, emissive: Math.max(0, opts.emissive || 0) });
      return true;
    },
    setLamp(name, c, k) { lamps.set(name, [c[0] * k, c[1] * k, c[2] * k]); },
    setHaze(h) { haze = { ...haze, ...h }; },
    setExposure(ev) { exposure = Math.pow(2, ev || 0); },
    setHover(name) { hoverName = name || null; },
    setTime(t) { time = t; },
    setMeter(on, every) { meter.on = !!on; if (every) meter.every = Math.max(1, every | 0); if (!on) meter.value = null; },        // the frame's brightness, read back asynchronously (meter())
    meter() { if (meter.on) meterPoll(); return meter.value; },   // { logAvg, mean, max (linear, before exposure), frame } or null
    // the void (Phase 2): { list, lid, kOthers, fog: {...}, force } (ui/disari.js); voidState() for tests
    setVoid(o) {
      if (o.list) VOID.list = o.list;
      if (o.lid != null) VOID.lid = o.lid;
      if (o.kOthers != null) VOID.kOthers = o.kOthers;
      if (o.fog) Object.assign(VOID.fog, o.fog);
      if ('force' in o) VOID.force = o.force;
      if ('lampsOff' in o) VOID.lampsOff = !!o.lampsOff;
      if ('lampsBare' in o) VOID.lampsBare = !!o.lampsBare;
      if ('mastsOff' in o) VOID.mastsOff = !!o.mastsOff;
    },
    // tests: the lamps' display light (fener.vert, the glow target) summed round canvas point (x, y), from
    // the top left as S.project gives it; exact float, before the 8-bit canvas
    voidGlow(x, y, r) {
      if (!T) return 0;
      const n = 2 * r + 1, x0 = Math.round(x) - r, y0 = T.glow.h - 1 - Math.round(y) - r;
      if (x0 < 0 || y0 < 0 || x0 + n > T.glow.w || y0 + n > T.glow.h) return null;
      const px = new Float32Array(n * n * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.glow.fb);
      gl.readPixels(x0, y0, n, n, gl.RGBA, gl.FLOAT, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // weighted by a smooth window centred on the exact point (a square's whole-pixel edge would cut a halo's tail
      // by a different amount at each sub-pixel place)
      let sum = 0;
      const sw = r / 2.5;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const k = 4 * (j * n + i), dx = x0 + i + 0.5 - x, dy = (T.glow.h - (y0 + j + 0.5)) - y;
        sum += Math.exp(-0.5 * (dx * dx + dy * dy) / (sw * sw)) * (0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]);
      }
      return sum;
    },
    voidState: () => ({ on: VOID.on, inBlock: VOID.inBlock, noInterior: VOID.noInterior, homeHaze: VOID.homeHaze, drawn: VOID.drawn.slice(), lamps: VOID.lamps, fog: { ...VOID.fog } }),
    setHeat(h) { heat = Math.min(1, Math.max(0, h || 0)); },   // the arch opening's shimmer (0..1, from the temperature)
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
