/* Kontrol Merkezi · the hall's texts: every sign, board, plate and display, drawn into textures that sit on
 * objects in the 3D world (docs/SALON.md, "Interaction"). Canvas2D, no DOM overlay, no randomness at run time:
 * wear, grime and spray come from integer hashes seeded by the texture's name, so the same data gives the same
 * pixels, byte for byte.
 *
 *   await KM_LEVHA.ready;                      // fonts loaded
 *   KM_LEVHA.sizes[name]                       // { w, h, pxPerM, kind }  (metres = w / pxPerM, h / pxPerM)
 *   KM_LEVHA.draw(name, data, canvas?)         // draws into (and returns) a canvas of sizes[name]
 *
 * kind (how the renderer lights it):
 *   'boya'  paint on steel: rgb = paint colour, alpha = paint coverage; lit by the scene. Upload with
 *           UNPACK_PREMULTIPLY_ALPHA_WEBGL and blend premultiplied (rgb of uncovered texels is not kept).
 *   'levha' an opaque plate face (albedo, sRGB); lit by the scene.
 *   'ekran', 'pano' self-lit: rgb = emitted light, sRGB-encoded, <= 1, black where nothing glows.
 *
 * Data (every field optional; missing telemetry shows as dashes, never as an invented value):
 *   boya_kasa, boya_gpu, tabela_rgb, tabela_fanlar, cikis_1, cikis_2: {}  (fixed identity / navigation)
 *   masa_ekran_kasa, masa_ekran_gpu (the fan desks' panels): {
 *     durum: 'en_yuksek' | 'bios' | 'kart' | 'geciyor' | 'baska' | 'bilgi_yok'   (default 'bilgi_yok')
 *     sicaklik: number|null      CPU (_kasa) or GPU (_gpu) temperature, °C
 *     fanlar: [{ ad: string, rpm: number|null }]   real fans in order; _kasa up to 4, _gpu up to 2;
 *                                                   on _gpu rpm 0 reads DURUYOR
 *     yuzde: number|null         _gpu: the card's fan power, %
 *     kullanilabilir: boolean    false: the lever cannot act now; `neden` replaces the hint (default true)
 *     neden: string              why there is no lever / no information (default 'SERVİSE BAĞLI DEĞİL')
 *     uyari: '' | 'yetki' | 'afterburner' | 'baska' | 'baglanti'   a warning: it takes the hint's line (default '')
 *     hover: boolean             the pointer is on the desk: the hint lights up }
 *   kilit_tasi_ekran: { ortalama, cpu, gpu: number|null (°C), renk: [r,g,b] LINEAR 0..1 (the temperature
 *     colour; its hue is shown at full brightness), kapali: boolean (RGB off: dimmed, still legible) }
 *   durak_plaka_0..4: { derece: number|null, ad: string, renk: [r,g,b] LINEAR, secili: boolean }
 *   plaka_rgb: { acik: true|false|null (null = unknown, nothing marked), bosta: boolean (lights idle),
 *     beklemeDakika: number (configured idle minutes, default 15), hover: boolean }
 *   cihaz_aio, cihaz_klavye, cihaz_gpu: { durum: 'bagli' | 'bagli_degil' | 'kilitli' | 'hata',
 *     hata: string (the error text, for 'hata'), ad: string (overrides the device name) }
 * Unknown states throw: a plate never shows a state the service did not report.
 *
 * Cost: plates and paint build their wear once per texture name (cached), boards and displays use canvas ops
 * only; a redraw on a data change is a few milliseconds (measured in levha-onizleme.html). Draw only on change.
 *
 * Fonts (SIL OFL 1.1, texts in ../fonts): Big Shoulders Stencil ExtraBold (stencils, hanging signs; static
 * instance wght 800 opsz 72, subset to Latin + Turkish), Barlow Condensed SemiBold (boards, plates), IBM Plex
 * Mono Medium (small technical lines). The dot-matrix and seven-segment faces are drawn here, glyph by glyph.
 */
(function (global) {
  'use strict';

  const FONT_DIR = new URL('../fonts/', document.currentScript.src);
  const FACES = [
    ['KMStencil', 'BigShouldersStencil-ExtraBold.woff2'],
    ['KMKond', 'BarlowCondensed-SemiBold.woff2'],
    ['KMMono', 'IBMPlexMono-Medium.woff2'],
  ];
  let loaded = false;
  const ready = Promise.all(FACES.map(([family, file]) =>
    new FontFace(family, `url("${new URL(file, FONT_DIR)}")`).load().then(face => document.fonts.add(face))))
    .then(() => { loaded = true; });

  // ---------------------------------------------------------------- sizes
  const sizes = {};
  const size = (names, w, h, pxPerM, kind) => names.forEach(n => { sizes[n] = Object.freeze({ w, h, pxPerM, kind }); });
  size(['boya_kasa', 'boya_gpu'], 2048, 512, 512, 'boya');            // 4 × 1 m on the fan's shroud
  size(['masa_ekran_kasa', 'masa_ekran_gpu'], 2150, 1500, 2500, 'pano');  // 0.86 × 0.6 m desk panel, read from ~4.5 m
  size(['tabela_rgb', 'tabela_fanlar'], 2048, 512, 512, 'levha');     // 4 × 1 m hanging sign, read from ~40 m
  size(['cikis_1', 'cikis_2'], 1024, 512, 1024, 'ekran');             // 1 × 0.5 m lit exit sign
  size(['kilit_tasi_ekran'], 4096, 1024, 512, 'ekran');               // 8 × 2 m display in the keystone
  size([0, 1, 2, 3, 4, 5].map(i => 'durak_plaka_' + i), 1024, 512, 512, 'levha');  // 2 × 1 m engraved steel plates
  size(['plaka_rgb'], 2048, 1024, 512, 'levha');                      // 4 × 2 m steel plate of the great switch
  size(['cihaz_aio', 'cihaz_klavye', 'cihaz_gpu'], 2048, 512, 512, 'levha');       // 4 × 1 m nameplates
  Object.freeze(sizes);

  // ---------------------------------------------------------------- basics
  const CTX = { willReadFrequently: true };   // CPU raster: identical bytes across context re-creation
  function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  const ctxOf = cv => cv.getContext('2d', CTX);
  const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const up = s => String(s).toLocaleUpperCase('tr');
  const fmt1 = n => finite(n) ? n.toFixed(1).replace('.', ',') : null;
  const fmtInt = n => finite(n) ? Math.round(n).toLocaleString('tr-TR') : null;

  const toLin = v => v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4);
  const toSrgb = v => v <= .0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - .055;
  const LUT = new Uint8ClampedArray(4097);
  for (let i = 0; i <= 4096; i++) LUT[i] = Math.round(255 * toSrgb(i / 4096));
  const enc = v => LUT[(clamp(v) * 4096 + .5) | 0];
  function hexLin(hex) { const n = parseInt(hex.slice(1), 16); return [toLin((n >> 16 & 255) / 255), toLin((n >> 8 & 255) / 255), toLin((n & 255) / 255)]; }
  function cssLin(rgb, gain = 1) { return `rgb(${rgb.map(v => enc(v * gain)).join(',')})`; }
  function linOf(rgb, fallback) {
    return Array.isArray(rgb) && rgb.length === 3 && rgb.every(finite) ? rgb.map(v => clamp(v)) : fallback;
  }

  // Integer hash and value noise: the only source of irregularity.
  function h32(x, y, s) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = h32(xi, yi, s), b = h32(xi + 1, yi, s), c = h32(xi, yi + 1, s), d = h32(xi + 1, yi + 1, s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function fbm(x, y, s, oct) {
    let v = 0, amp = .5, f = 1, n = 0;
    for (let o = 0; o < oct; o++) { v += amp * vnoise(x * f, y * f, s + o * 131); n += amp; amp *= .5; f *= 2.03; }
    return v / n;
  }
  // A noise field at reduced resolution (step px per sample), read back bilinearly.
  function field(w, h, step, scale, oct, seed, sx = 1) {
    const fw = Math.ceil(w / step) + 2, fh = Math.ceil(h / step) + 2, d = new Float32Array(fw * fh);
    for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) d[j * fw + i] = fbm(i * step / (scale * sx), j * step / scale, seed, oct);
    return { fw, step, d };
  }
  function at(F, x, y) {
    const u = x / F.step, v = y / F.step, i = u | 0, j = v | 0, fx = u - i, fy = v - j, k = j * F.fw + i, d = F.d;
    const a = d[k], b = d[k + 1], c = d[k + F.fw], e = d[k + F.fw + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
  }
  function seedOf(name) { let s = 7; for (const ch of name) s = Math.imul(s ^ ch.charCodeAt(0), 16777619); return s >>> 0; }

  const cache = new Map();
  const once = (key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };

  // Fit a font size so the text spans at most maxW px.
  function fit(c, s, family, px, maxW, spacing = 0) {
    c.font = `${px}px ${family}`; c.letterSpacing = spacing + 'px';
    const w = c.measureText(s).width;
    if (w > maxW) { px = Math.floor(px * maxW / w); c.font = `${px}px ${family}`; }
    return px;
  }
  function put(c, s, x, y, family, px, fill, align = 'left', maxW = 1e9, spacing = 0) {
    const p = fit(c, s, family, px, maxW, spacing);
    c.textAlign = align; c.textBaseline = 'alphabetic'; c.fillStyle = fill; c.fillText(s, x, y);
    return p;
  }
  // Greedy word wrap into at most `max` lines, shrinking the size until it fits.
  function wrap(c, s, family, px, maxW, max) {
    const words = s.split(/\s+/).filter(Boolean);
    for (; px > 8; px = Math.floor(px * .94)) {
      c.font = `${px}px ${family}`; c.letterSpacing = '0px';
      const out = []; let line = '';
      for (const w of words) {
        const next = line ? line + ' ' + w : w;
        if (line && c.measureText(next).width > maxW) { out.push(line); line = w; } else line = next;
      }
      if (line) out.push(line);
      if (out.length <= max && out.every(l => c.measureText(l).width <= maxW)) return { px, lines: out };
    }
    return { px, lines: [s] };
  }

  // ---------------------------------------------------------------- surfaces (opaque plates, albedo)
  /* One pass per texel, linear light, cached per texture name. sp: { paint, under ('rust'|'steel'|'iron'),
     grime, chip (amount 0..1), edge (px of edge wear), holes [[x,y,r]], streaks, brushed, seed } */
  function surface(w, h, sp) {
    const cv = mk(w, h), c = ctxOf(cv), img = c.createImageData(w, h), px = img.data, seed = sp.seed;
    const G = field(w, h, 8, h * .9, 4, seed), C = field(w, h, 2, sp.chipScale || 34, 5, seed + 7);
    const R = field(w, h, 4, 70, 3, seed + 13), B = sp.brushed ? field(w, h, 1, 3, 2, seed + 29, 260) : null;
    const paint = hexLin(sp.paint), holes = sp.holes || [];
    const rustA = [.045, .018, .008], rustB = [.32, .12, .035], steel = [.20, .20, .21], iron = [.018, .018, .02];
    const edge = sp.edge || 30, chipAmt = sp.chip ?? .5, grimeAmt = sp.grime ?? .35;
    for (let y = 0; y < h; y++) {
      const vy = y / h;
      for (let x = 0; x < w; x++) {
        const g = at(G, x, y), n = at(C, x, y), r = at(R, x, y);
        const de = Math.min(x, y, w - 1 - x, h - 1 - y);
        let near = clamp(1 - de / edge), hole = 0, streak = 0;
        for (let k = 0; k < holes.length; k++) {
          const [hx, hy, hr] = holes[k], dx = x - hx, dy = y - hy, d = Math.sqrt(dx * dx + dy * dy);
          hole = Math.max(hole, clamp(1 - (d - hr) / (hr * 2.2)));
          if (sp.streaks && dy > 0) {   // rust run-off below a fixing, narrowing and fading downwards
            const wdt = hr * (.9 + 1.6 * vnoise(y / 40, k, seed)) * (1 + dy / (h * .9));
            streak = Math.max(streak, clamp(1 - Math.abs(dx) / wdt) * clamp(1 - dy / (h * .75)) * (.45 + .55 * r));
          }
        }
        // chipped paint: mid-frequency noise, pushed up at the edges and around the fixings
        const chip = chipAmt <= 0 ? 0 : smooth(.70, .725, n * (.78 + .22 * chipAmt) + .32 * near * near * (.2 + 1.5 * g) + .30 * hole + .10 * (g - .5));
        const dirt = 1 - grimeAmt * (.55 * (g - .3) + .35 * vy * vy + .25 * streak);
        let br = 1;
        if (B) br = .93 + .12 * at(B, x, y) + .05 * (h32(0, y, seed) - .5);   // fine brushed grain along x
        const grain = 1 + .05 * (h32(x, y, seed) - .5);
        let pr = paint[0] * dirt * br * grain, pg = paint[1] * dirt * br * grain, pb = paint[2] * dirt * br * grain;
        if (streak > 0) { const s = streak * .55; pr += (rustB[0] * .6 - pr) * s; pg += (rustB[1] * .6 - pg) * s; pb += (rustB[2] * .6 - pb) * s; }
        if (chip > 0) {
          let ur, ug, ub;
          if (sp.under === 'steel') { const m = .8 + .4 * r; ur = steel[0] * m; ug = steel[1] * m; ub = steel[2] * m; }
          else if (sp.under === 'iron') { const m = smooth(.45, .85, r); ur = iron[0] + (rustB[0] * .7 - iron[0]) * m; ug = iron[1] + (rustB[1] * .7 - iron[1]) * m; ub = iron[2] + (rustB[2] * .7 - iron[2]) * m; }
          else { const m = smooth(.25, .8, r); ur = rustA[0] + (rustB[0] - rustA[0]) * m; ug = rustA[1] + (rustB[1] - rustA[1]) * m; ub = rustA[2] + (rustB[2] - rustA[2]) * m; }
          pr += (ur - pr) * chip; pg += (ug - pg) * chip; pb += (ub - pb) * chip;
        }
        const i = (y * w + x) * 4;
        px[i] = enc(pr); px[i + 1] = enc(pg); px[i + 2] = enc(pb); px[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    return cv;
  }
  // Alpha mask of where painted or filled lettering has flaked off (destination-out onto the lettering).
  function flakes(w, h, seed, amount, scale = 18) {
    const cv = mk(w, h), c = ctxOf(cv), img = c.createImageData(w, h), px = img.data;
    const F = field(w, h, 2, scale, 4, seed + 101), L = field(w, h, 8, h * .5, 3, seed + 103);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = at(F, x, y) + .22 * (at(L, x, y) - .5);
      const a = smooth(.80 - .07 * amount, .82 - .07 * amount, v) + (h32(x, y, seed + 5) < .003 * amount ? .6 : 0);
      px[(y * w + x) * 4 + 3] = Math.round(255 * clamp(a));
    }
    c.putImageData(img, 0, 0);
    return cv;
  }
  function layer(w, h, paintFn, wearMask) {
    const cv = mk(w, h), c = ctxOf(cv); paintFn(c);
    if (wearMask) { c.globalCompositeOperation = 'destination-out'; c.drawImage(wearMask, 0, 0); }
    return cv;
  }
  function screw(c, x, y, r, angle) {
    const g = c.createRadialGradient(x - r * .3, y - r * .35, r * .1, x, y, r);
    g.addColorStop(0, '#9a9890'); g.addColorStop(.7, '#5d5b55'); g.addColorStop(1, '#2a2926');
    c.fillStyle = '#0c0b0a'; c.beginPath(); c.arc(x, y, r * 1.18, 0, 7); c.fill();
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    c.save(); c.translate(x, y); c.rotate(angle); c.fillStyle = '#1a1917';
    c.fillRect(-r * .78, -r * .13, r * 1.56, r * .26); c.restore();
  }

  // ---------------------------------------------------------------- dot-matrix face (5 × 7, Turkish accents)
  /* Each glyph: [accent rows (2), body rows (7), below rows (2)], '#' = dot. Accents sit one row above the
     body (a gap row between), so İ Ö Ü Ğ never merge with the letter; Ç Ş carry a two-row cedilla. */
  const DM = {};
  (function () {
    const B = s => s.split(' ');
    const body = {
      A: '.###. #...# #...# ##### #...# #...# #...#', B: '####. #...# #...# ####. #...# #...# ####.',
      C: '.###. #...# #.... #.... #.... #...# .###.', D: '####. #...# #...# #...# #...# #...# ####.',
      E: '##### #.... #.... ####. #.... #.... #####', F: '##### #.... #.... ####. #.... #.... #....',
      G: '.###. #...# #.... #.### #...# #...# .####', H: '#...# #...# #...# ##### #...# #...# #...#',
      I: '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.', J: '..### ...#. ...#. ...#. ...#. #..#. .##..',
      K: '#...# #..#. #.#.. ##... #.#.. #..#. #...#', L: '#.... #.... #.... #.... #.... #.... #####',
      M: '#...# ##.## #.#.# #.#.# #...# #...# #...#', N: '#...# #...# ##..# #.#.# #..## #...# #...#',
      O: '.###. #...# #...# #...# #...# #...# .###.', P: '####. #...# #...# ####. #.... #.... #....',
      Q: '.###. #...# #...# #...# #.#.# #..#. .##.#', R: '####. #...# #...# ####. #.#.. #..#. #...#',
      S: '.#### #.... #.... .###. ....# ....# ####.', T: '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
      U: '#...# #...# #...# #...# #...# #...# .###.', V: '#...# #...# #...# #...# #...# .#.#. ..#..',
      W: '#...# #...# #...# #.#.# #.#.# #.#.# .#.#.', X: '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
      Y: '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..', Z: '##### ....# ...#. ..#.. .#... #.... #####',
      0: '.###. #...# #..## #.#.# ##..# #...# .###.', 1: '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.',
      2: '.###. #...# ....# ...#. ..#.. .#... #####', 3: '##### ...#. ..#.. ...#. ....# #...# .###.',
      4: '...#. ..##. .#.#. #..#. ##### ...#. ...#.', 5: '##### #.... ####. ....# ....# #...# .###.',
      6: '..##. .#... #.... ####. #...# #...# .###.', 7: '##### ....# ...#. ..#.. .#... .#... .#...',
      8: '.###. #...# #...# .###. #...# #...# .###.', 9: '.###. #...# #...# .#### ....# ...#. .##..',
      ' ': '..... ..... ..... ..... ..... ..... .....', '.': '..... ..... ..... ..... ..... ..... ..#..',
      ',': '..... ..... ..... ..... ..... ..#.. ..#..', ':': '..... ..#.. ..... ..... ..... ..#.. .....',
      '-': '..... ..... ..... .###. ..... ..... .....', '·': '..... ..... ..... ..#.. ..... ..... .....',
      '°': '.##.. #..#. .##.. ..... ..... ..... .....', '%': '##... ##..# ...#. ..#.. .#... #..## ...##',
      '/': '....# ....# ...#. ..#.. .#... #.... #....', "'": '..#.. ..#.. ..... ..... ..... ..... .....',
      '?': '.###. #...# ....# ...#. ..#.. ..... ..#..',
    };
    const none = ['.....', '.....'];
    for (const [k, v] of Object.entries(body)) DM[k] = [...none, ...B(v), ...none];
    const acc = (base, a, b) => [...a, ...DM[base].slice(2, 9), ...b];
    DM['İ'] = acc('I', ['.....', '..#..'], none);
    DM['Ö'] = acc('O', ['.....', '.#.#.'], none);
    DM['Ü'] = acc('U', ['.....', '.#.#.'], none);
    DM['Ğ'] = acc('G', ['#...#', '.###.'], none);
    DM['Ç'] = acc('C', none, ['..#..', '.#...']);
    DM['Ş'] = acc('S', none, ['..#..', '.#...']);
    DM[','] = [...none, ...B(body[',']), '.#...', '.....'];
    for (const [k, base] of [['Â', 'A'], ['Î', 'I'], ['Û', 'U']]) DM[k] = acc(base, ['.....', '.###.'], none);
  })();
  const DM_ROWS = 11, DM_ADV = 6;          // cell rows (2 accent + 7 body + 2 below), columns per character
  function dmText(s) { return up(s).replace(/[—–]/g, '-').replace(/[’‘]/g, "'"); }
  function dmWidth(s) { return [...dmText(s)].length * DM_ADV - 1; }
  // A soft round dot: bright core, faint halo; the board's glass diffuses a lit LED a little.
  function dotSprite(p, css, halo) {
    return once(`dot|${p}|${css}|${halo}`, () => {
      const r = Math.ceil(p * (halo ? 1.1 : .5)), cv = mk(2 * r, 2 * r), c = ctxOf(cv);
      const g = c.createRadialGradient(r, r, 0, r, r, r);
      const core = .37 * p / r;
      g.addColorStop(0, css); g.addColorStop(core * .7, css);
      if (halo) { g.addColorStop(core, css.replace('rgb(', 'rgba(').replace(')', ',.55)')); g.addColorStop(core * 1.35, css.replace('rgb(', 'rgba(').replace(')', ',.10)')); }
      else g.addColorStop(core, css.replace('rgb(', 'rgba(').replace(')', ',.4)'));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(0, 0, 2 * r, 2 * r);
      return cv;
    });
  }
  // Draws lit dots of `s` with its first cell column at grid column col0, cell row top at y (px).
  function dmDraw(c, s, x0, y0, p, sprite) {
    const r = sprite.width / 2; let col = 0;
    c.save(); c.globalCompositeOperation = 'lighter';
    for (const ch of dmText(s)) {
      const g = DM[ch] || DM['?'];
      for (let j = 0; j < DM_ROWS; j++) {
        const row = g[j];
        for (let i = 0; i < 5; i++) if (row.charCodeAt(i) === 35) c.drawImage(sprite, x0 + (col + i + .5) * p - r, y0 + (j + .5) * p - r);
      }
      col += DM_ADV;
    }
    c.restore();
  }
  // Unlit LEDs of a matrix window: cols × rows dots, faint (a real display shows its dark dots).
  function dmGhost(c, x0, y0, cols, rows, p, sprite) {
    const r = sprite.width / 2;
    c.save(); c.globalCompositeOperation = 'lighter';
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) c.drawImage(sprite, x0 + (i + .5) * p - r, y0 + (j + .5) * p - r);
    c.restore();
  }

  // ---------------------------------------------------------------- seven-segment face
  const SEG = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
  // Hexagonal segment between two centre-line points (a, b) of thickness t.
  function segPath(c, ax, ay, bx, by, t) {
    const h = t / 2;
    c.beginPath();
    if (ay === by) {
      c.moveTo(ax, ay); c.lineTo(ax + h, ay - h); c.lineTo(bx - h, by - h); c.lineTo(bx, by); c.lineTo(bx - h, by + h); c.lineTo(ax + h, ay + h);
    } else {
      c.moveTo(ax, ay); c.lineTo(ax + h, ay + h); c.lineTo(bx + h, by - h); c.lineTo(bx, by); c.lineTo(bx - h, by - h); c.lineTo(ax - h, ay + h);
    }
    c.closePath();
  }
  function segGeom(W, H, t, g) {
    const L = t / 2, R = W - t / 2, T = t / 2, M = H / 2, D = H - t / 2;
    return {
      a: [L + g, T, R - g, T], g: [L + g, M, R - g, M], d: [L + g, D, R - g, D],
      f: [L, T + g, L, M - g], b: [R, T + g, R, M - g], e: [L, M + g, L, D - g], c: [R, M + g, R, D - g],
    };
  }
  /* Draws one digit cell at (x, y), height H; `on` lit segments (string), ghost = intensity of unlit ones.
     `inset` > 0 draws only a thinner core (for the hot centre of lit segments). */
  function segDigit(c, x, y, H, on, litCss, ghostCss, inset = 0) {
    const W = H * .54, t = H * .118, g = t * .16;
    const G = segGeom(W, H, t, g);
    for (const id of 'abcdefg') {
      const lit = on.includes(id);
      if (!lit && (!ghostCss || inset)) continue;
      const [ax, ay, bx, by] = G[id];
      segPath(c, x + ax, y + ay, x + bx, y + by, lit ? t * (inset ? inset : 1) : t);
      c.fillStyle = lit ? litCss : ghostCss; c.fill();
    }
    return W;
  }
  // A value like "47,3" laid out as digit cells + comma + degree; returns the total width at height H.
  function segLayout(text, H) {
    const W = H * .54, gap = H * .17, comma = H * .2, deg = H * .3;
    const cells = []; let x = 0;
    for (const ch of text) {
      if (ch === ',') { cells.push({ ch, x: x - gap * .35 }); x += comma - gap * .35; }
      else { cells.push({ ch, x }); x += W + gap; }
    }
    cells.push({ ch: '°', x: x - gap * .25 }); x += deg - gap * .25;
    return { cells, width: x };
  }
  function segValue(c, text, x0, y0, H, litCss, ghostCss, inset = 0) {
    const L = segLayout(text, H), t = H * .118;
    for (const cell of L.cells) {
      const x = x0 + cell.x;
      if (cell.ch === ',') {
        const s = t * 1.05; c.beginPath();
        c.moveTo(x + s * .15, y0 + H - s); c.lineTo(x + s * 1.1, y0 + H - s); c.lineTo(x + s * .95, y0 + H + s * .55); c.lineTo(x + s * .25, y0 + H + s * .55); c.closePath();
        if (!inset) { c.fillStyle = litCss; c.fill(); }
      } else if (cell.ch === '°') {
        const h = H * .5;   // the four upper segments of a half-height cell: the display's own degree sign
        const W = h * .56, tt = t * .6, g = tt * .2, G = segGeom(W, h, tt, g);
        for (const id of 'abgf') { const [ax, ay, bx, by] = G[id]; segPath(c, x + ax, y0 + ay, x + bx, y0 + by, tt * (inset || 1)); c.fillStyle = litCss; c.fill(); }
      } else {
        const on = cell.ch === '-' ? 'g' : cell.ch === ' ' ? '' : SEG[+cell.ch] || '';
        segDigit(c, x, y0, H, on, litCss, inset ? null : ghostCss, inset);
      }
    }
    return L.width;
  }
  // Fixed digit field like a real display: two integer places (a third only when needed), one decimal.
  function segString(v) {
    if (!finite(v)) return '--,-';
    const s = Math.abs(v).toFixed(1).split('.'); let int = s[0];
    if (v < 0) int = '-' + int;
    while (int.length < 2) int = ' ' + int;
    return int + ',' + s[1];
  }

  // Soft glow of a grey (luminance) canvas: halved step by step (a box filter, nothing skipped), then a
  // three-pass box blur (≈ Gaussian) at the reduced size. Returns the small canvas; draw it scaled up.
  function halo(src, scale, radius) {
    let cur = src;
    for (let f = 1; f < scale; f *= 2) {
      const n = mk(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2)), c = ctxOf(n);
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'low';
      c.drawImage(cur, 0, 0, n.width, n.height); cur = n;
    }
    const w = cur.width, h = cur.height, c = ctxOf(cur), img = c.getImageData(0, 0, w, h), a = img.data;
    let A = new Float32Array(w * h), B = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) A[i] = a[i * 4];
    const r = radius, norm = 1 / (2 * r + 1);
    for (let it = 0; it < 3; it++) {
      for (let y = 0; y < h; y++) {
        const o = y * w; let sum = 0;
        for (let q = -r; q <= r; q++) sum += A[o + (q < 0 ? 0 : q >= w ? w - 1 : q)];
        for (let x = 0; x < w; x++) {
          B[o + x] = sum * norm;
          const add = x + r + 1, sub = x - r;
          sum += A[o + (add >= w ? w - 1 : add)] - A[o + (sub < 0 ? 0 : sub)];
        }
      }
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let q = -r; q <= r; q++) sum += B[(q < 0 ? 0 : q >= h ? h - 1 : q) * w + x];
        for (let y = 0; y < h; y++) {
          A[y * w + x] = sum * norm;
          const add = y + r + 1, sub = y - r;
          sum += B[(add >= h ? h - 1 : add) * w + x] - B[(sub < 0 ? 0 : sub) * w + x];
        }
      }
    }
    for (let i = 0; i < w * h; i++) { const v = A[i]; a[i * 4] = v; a[i * 4 + 1] = v; a[i * 4 + 2] = v; a[i * 4 + 3] = 255; }
    c.putImageData(img, 0, 0);
    return cur;
  }
  function addHalo(c, src, scale, radius, alpha) {
    const hcv = halo(src, scale, radius);
    c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha = alpha;
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'low';
    c.drawImage(hcv, 0, 0, src.width, src.height); c.restore();
  }

  // ================================================================ the textures

  // ---- boya_*: stencilled identity, spray paint on the fan's shroud
  function stencilPaint(name) {
    return once('boya|' + name, () => {
      const { w, h } = sizes[name], gpu = name === 'boya_gpu', seed = seedOf(name);
      const M = mk(w, h), m = ctxOf(M);
      m.fillStyle = '#fff';
      put(m, gpu ? 'EKRAN KARTI' : 'İŞLEMCİ · KASA', w / 2, 292, 'KMStencil', 300, '#fff', 'center', w - 150, 6);
      put(m, gpu ? 'RTX 4080' : 'FAN 1-4', w / 2, 462, 'KMStencil', 104, '#fff', 'center', w - 300, 10);
      // drips: a few runs from the bottom of the big letters, where the paint was heaviest
      const row = m.getImageData(0, 280, w, 1).data;
      const feet = []; for (let x = 0; x < w; x++) if (row[x * 4 + 3] > 200) feet.push(x);
      for (let k = 0; k < 4 && feet.length; k++) {
        const x = feet[Math.floor(h32(k, 1, seed) * feet.length)], len = 26 + 60 * h32(k, 2, seed), wd = 4 + 4 * h32(k, 3, seed);
        m.beginPath(); m.moveTo(x - wd / 2, 284); m.lineTo(x - wd * .35, 284 + len); m.arc(x, 284 + len, wd * .62, Math.PI, 0, true);
        m.lineTo(x + wd / 2, 284); m.closePath(); m.fill();
      }
      // scratches through the paint
      m.globalCompositeOperation = 'destination-out'; m.lineCap = 'round';
      for (let k = 0; k < 14; k++) {
        const x = h32(k, 4, seed) * w, y = h32(k, 5, seed) * h, a = (h32(k, 6, seed) - .5) * .9, l = 40 + 200 * h32(k, 7, seed);
        m.lineWidth = 1 + 2 * h32(k, 8, seed); m.globalAlpha = .6 + .4 * h32(k, 9, seed);
        m.beginPath(); m.moveTo(x, y); m.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); m.stroke();
      }
      const core = m.getImageData(0, 0, w, h).data;
      // overspray: the stencil's edge lifts a little, so the spray leaks out into a soft speckled fringe
      const spread = new Float32Array(w * h);
      { const s = 4, sw = Math.ceil(w / s), sh = Math.ceil(h / s), lo = new Float32Array(sw * sh), t = new Float32Array(sw * sh), r = 3;
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) lo[y * sw + x] = core[((y * s) * w + x * s) * 4 + 3] / 255;
        for (let it = 0; it < 3; it++) {
          for (let y = 0; y < sh; y++) { let acc = 0; for (let x = -r; x <= r; x++) acc += lo[y * sw + clamp(x, 0, sw - 1)];
            for (let x = 0; x < sw; x++) { t[y * sw + x] = acc / (2 * r + 1); acc += lo[y * sw + Math.min(x + r + 1, sw - 1)] - lo[y * sw + Math.max(x - r, 0)]; } }
          for (let x = 0; x < sw; x++) { let acc = 0; for (let y = -r; y <= r; y++) acc += t[clamp(y, 0, sh - 1) * sw + x];
            for (let y = 0; y < sh; y++) { lo[y * sw + x] = acc / (2 * r + 1); acc += t[Math.min(y + r + 1, sh - 1) * sw + x] - t[Math.max(y - r, 0) * sw + x]; } }
        }
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const u = Math.min(x / s, sw - 1.001), v = Math.min(y / s, sh - 1.001), i = u | 0, j = v | 0, fx = u - i, fy = v - j, k = j * sw + i;
          spread[y * w + x] = lo[k] * (1 - fx) * (1 - fy) + lo[k + 1] * fx * (1 - fy) + lo[k + sw] * (1 - fx) * fy + lo[k + sw + 1] * fx * fy;
        }
      }
      const thin = field(w, h, 4, 90, 4, seed + 1), chips = field(w, h, 2, 11, 4, seed + 2), wear = field(w, h, 8, 200, 3, seed + 3);
      const paint = gpu ? [224, 178, 60] : [222, 215, 192];
      const out = mk(w, h), o = ctxOf(out), img = o.createImageData(w, h), px = img.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = y * w + x, a0 = core[k * 4 + 3] / 255;
        const worn = at(wear, x, y);
        const flake = smooth(.76, .79, at(chips, x, y) + .55 * (worn - .5));
        const body = a0 * clamp(.70 + .45 * at(thin, x, y)) * (1 - flake);
        const sp = spread[k] * (1 - a0);
        const spray = sp > .02 ? (h32(x, y, seed) < sp * 1.1 ? .55 : .10) * clamp(sp * 2.2) : 0;
        const i = k * 4;
        px[i] = paint[0]; px[i + 1] = paint[1]; px[i + 2] = paint[2];
        px[i + 3] = Math.round(255 * clamp(Math.max(body, spray)));
      }
      o.putImageData(img, 0, 0);
      return out;
    });
  }

  // ---- masa_ekran_*: the fan desks' panels: engraved black steel, the light only where it says something. The state's
  // window first (lit in the state's colour), the temperature and each real fan's speed second (amber figures by
  // engraved legends), one line third: a warning (an amber window), else why the lever cannot act, else the hint.
  const STATES = {
    en_yuksek: { text: 'EN YÜKSEK HIZDA', tile: '#ffa05a', ink: '#2b1305' },
    bios: { text: 'BIOS DENETİMİNDE', tile: '#aacdff', ink: '#0b1424' },
    kart: { text: 'KARTIN DENETİMİNDE', tile: '#aacdff', ink: '#0b1424' },
    geciyor: { text: 'GEÇİYOR', tile: '#ffe2c4', ink: '#2b1d10' },
    baska: { text: 'BAŞKA PROGRAMDA', tile: '#ffbe78', ink: '#2b1606' },
    bilgi_yok: { text: 'BİLGİ YOK', tile: null, ink: null },
  };
  const WARN = {
    yetki: 'SERVİS YÖNETİCİ İZNİ OLMADAN ÇALIŞIYOR',
    afterburner: ["AFTERBURNER'IN FAN KONTROLÜ AÇIK", 'BU KOLLA ÇAKIŞIR'],   // a list: these lines as given
    baska: 'FANLARI BAŞKA BİR PROGRAM YÖNETİYOR',
    baglanti: 'SERVİSE BAĞLI DEĞİL',
  };
  const AMBER = 'rgb(255,170,80)', LEGEND = 'rgb(150,146,134)', LEGEND_DIM = 'rgb(96,93,85)', RULE = 'rgb(34,33,30)';
  const MASA = { m: 80, title: 116, tileY: 158, tileH: 330, readY: 524, colX: 900, tempY: 905, rowY: 718, rowH: 120,
    rule: 1112, band: 1144, bandH: 290 };
  function masaStatic(name) {
    return once('masa|' + name, () => {
      const { w, h } = sizes[name], gpu = name === 'masa_ekran_gpu', P = MASA, cv = mk(w, h), c = ctxOf(cv);
      c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
      // engraved, faintly backlit legends and the panel's rules
      put(c, gpu ? 'EKRAN KARTI FANLARI' : 'İŞLEMCİ VE KASA FANLARI', P.m, P.title, 'KMKond', 100, LEGEND_DIM, 'left', w - 2 * P.m, 3);
      c.fillStyle = RULE;
      c.fillRect(P.m, P.readY, w - 2 * P.m, 4); c.fillRect(P.m, P.rule, w - 2 * P.m, 4);
      c.fillRect(P.colX - 50, P.readY + 36, 4, P.rule - P.readY - 72);
      put(c, gpu ? 'KART ISISI' : 'İŞLEMCİ ISISI', P.m, P.readY + 86, 'KMKond', 80, LEGEND, 'left', P.colX - P.m - 90, 2);
      put(c, 'FANLAR · DEVİR / DAKİKA', P.colX, P.readY + 86, 'KMKond', 80, LEGEND, 'left', w - P.colX - P.m, 2);
      // the state window's frame (its milky face is drawn per state)
      c.strokeStyle = 'rgb(26,25,23)'; c.lineWidth = 8; c.strokeRect(P.m - 8, P.tileY - 8, w - 2 * P.m + 16, P.tileH + 16);
      return cv;
    });
  }
  function masa(c, d, name) {
    const { w } = sizes[name], gpu = name === 'masa_ekran_gpu', P = MASA;
    const state = d.durum ?? 'bilgi_yok';
    if (!Object.hasOwn(STATES, state)) throw new Error('Unknown fan state: ' + state);
    const key = d.uyari || '';
    if (key && !Object.hasOwn(WARN, key)) throw new Error('Unknown warning: ' + key);
    const S = STATES[state], live = state !== 'bilgi_yok';
    c.drawImage(masaStatic(name), 0, 0);
    // 1. the state: milky glass lit from behind (brighter in the middle), the legend in dark ink
    const tx = P.m, ty = P.tileY, tw = w - 2 * P.m, th = P.tileH;
    if (S.tile) {
      c.fillStyle = S.tile; c.fillRect(tx, ty, tw, th);
      const g = c.createRadialGradient(w / 2, ty + th / 2, th * .2, w / 2, ty + th / 2, tw * .62);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.28)');
      c.fillStyle = g; c.fillRect(tx, ty, tw, th);
    } else { c.fillStyle = 'rgb(9,9,9)'; c.fillRect(tx, ty, tw, th); }
    put(c, S.text, w / 2, ty + th / 2 + 92, 'KMKond', 262, S.ink || 'rgb(58,57,53)', 'center', tw - 120, 4);
    // 2. the readings: the temperature large on the left, each real fan's speed on the right
    const dash = '—';
    const temp = live && fmt1(d.sicaklik) ? fmt1(d.sicaklik) + '°' : dash;
    put(c, temp, P.m, P.tempY, 'KMKond', 300, live && fmt1(d.sicaklik) ? AMBER : LEGEND_DIM, 'left', P.colX - P.m - 110, 2);
    const fans = Array.isArray(d.fanlar) ? d.fanlar.slice(0, gpu ? 2 : 4) : [];
    const names = gpu ? ['FAN 1', 'FAN 2'] : ['İŞLEMCİ', 'POMPA', 'KASA 1', 'KASA 3'];
    const rows = (fans.length ? fans : names.map(ad => ({ ad, rpm: null }))).map((f, i) => {
      const rpm = live ? f?.rpm : null;
      return [up(f?.ad || names[i] || 'FAN ' + (i + 1)), gpu && rpm === 0 ? 'DURUYOR' : fmtInt(rpm) || dash, fmtInt(rpm) != null || (gpu && rpm === 0)];
    });
    if (gpu) rows.push(['FAN GÜCÜ', live && fmtInt(d.yuzde) ? '%' + fmtInt(d.yuzde) : dash, !!(live && fmtInt(d.yuzde))]);
    rows.slice(0, 4).forEach(([label, value, on], i) => {
      const y = P.rowY + i * P.rowH;
      put(c, value, w - P.m, y, 'KMKond', 118, on ? AMBER : LEGEND_DIM, 'right', 520, 2);
      const vx = w - P.m - c.measureText(value).width;
      put(c, label, P.colX, y, 'KMKond', 108, LEGEND, 'left', w - P.m - P.colX - 560, 2);
      // an engraved leader from the name to its figure (the panel is seen at a slant: it keeps a row together)
      c.fillStyle = 'rgb(62,60,54)';
      for (let x = P.colX + c.measureText(label).width + 40; x < vx - 30; x += 30) { c.beginPath(); c.arc(x, y - 30, 5, 0, 7); c.fill(); }
    });
    // 3. one line: a warning, else why the lever cannot act, else the hint by the lever
    const by = P.band, bh = P.bandH, bx = P.m, bw = w - 2 * P.m;
    if (key) {
      // an amber window with the warning triangle, the words in dark ink
      c.fillStyle = '#e0a321'; c.fillRect(bx, by, bw, bh);
      const g = c.createRadialGradient(w / 2, by + bh / 2, bh * .2, w / 2, by + bh / 2, bw * .62);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.25)');
      c.fillStyle = g; c.fillRect(bx, by, bw, bh);
      const cx = bx + 150, cy = by + bh / 2 + 8, R = 96;
      c.beginPath(); c.moveTo(cx, cy - R); c.lineTo(cx + R * 1.1, cy + R * .78); c.lineTo(cx - R * 1.1, cy + R * .78); c.closePath();
      c.fillStyle = '#161512'; c.fill();
      c.beginPath(); c.moveTo(cx, cy - R + 26); c.lineTo(cx + R * 1.1 - 30, cy + R * .78 - 13); c.lineTo(cx - R * 1.1 + 30, cy + R * .78 - 13); c.closePath();
      c.fillStyle = '#e0a321'; c.fill();
      c.fillStyle = '#161512'; c.beginPath(); c.moveTo(cx - 10, cy - 42); c.lineTo(cx + 10, cy - 42); c.lineTo(cx + 6, cy + 28); c.lineTo(cx - 6, cy + 28); c.closePath(); c.fill();
      c.beginPath(); c.arc(cx, cy + 52, 11, 0, 7); c.fill();
      const tx0 = bx + 300, mw = bx + bw - 40 - tx0, given = [].concat(WARN[key]);
      const L = given.length > 1 ? { px: Math.min(...given.map(l => fit(c, l, 'KMKond', 124, mw, 1))), lines: given } : wrap(c, given[0], 'KMKond', 124, mw, 2);
      const lh = L.px * 1.04, y0 = by + bh / 2 - (L.lines.length - 1) * lh / 2 + L.px * .35;
      L.lines.forEach((s, i) => put(c, s, tx0, y0 + i * lh, 'KMKond', L.px, '#161512', 'left', bx + bw - 40 - tx0, 1));
    } else {
      let hint = '', css = 'rgb(178,170,150)';
      if (!live || d.kullanilabilir === false) { hint = up(d.neden || 'SERVİSE BAĞLI DEĞİL'); css = 'rgb(200,140,70)'; }
      else if (state === 'en_yuksek') hint = gpu ? 'KOLU ÇEK · KARTA BIRAK' : "KOLU ÇEK · BIOS'A BIRAK";
      else if (state !== 'geciyor') hint = 'KOLU ÇEK · EN YÜKSEK HIZA AL';
      const on = live && d.kullanilabilir !== false;
      if (hint) {
        if (on && d.hover) css = 'rgb(255,236,200)';
        put(c, hint, w / 2, by + bh / 2 + 44, 'KMKond', 132, css, 'center', bw - 40, 3);
        if (on && d.hover) { c.fillStyle = 'rgb(160,138,104)'; c.fillRect(w / 2 - 300, by + bh / 2 + 80, 600, 8); }
      }
    }
  }

  function holes4(w, h, inset, r) { return [[inset, inset, r], [w - inset, inset, r], [inset, h - inset, r], [w - inset, h - inset, r]]; }

  // ---- tabela_*: hanging steel signs, painted on a dark plate
  function arrowUp(p, x, y, s) {
    p.beginPath(); p.moveTo(x, y - s); p.lineTo(x + s * .78, y - s * .18); p.lineTo(x + s * .27, y - s * .18); p.lineTo(x + s * .27, y + s);
    p.lineTo(x - s * .27, y + s); p.lineTo(x - s * .27, y - s * .18); p.lineTo(x - s * .78, y - s * .18); p.closePath(); p.fill();
  }
  function arrowBack(p, x, y, s) {   // a U-turn: go back the way you came
    const t = s * .5, r = s * .62;
    p.lineWidth = t; p.lineCap = 'butt'; p.strokeStyle = p.fillStyle;
    p.beginPath(); p.moveTo(x + r, y + s); p.lineTo(x + r, y - s * .15); p.arc(x, y - s * .15, r, 0, Math.PI, true); p.lineTo(x - r, y + s * .25); p.stroke();
    p.beginPath(); p.moveTo(x - r - s * .62, y + s * .18); p.lineTo(x - r + s * .62, y + s * .18); p.lineTo(x - r, y + s * 1.0); p.closePath(); p.fill();
  }
  function tabela(c, d, name) {
    const { w, h } = sizes[name], seed = seedOf(name), rgb = name === 'tabela_rgb';
    const holes = [[150, 52, 16], [w - 150, 52, 16]];
    c.drawImage(once('tabela|' + name, () => surface(w, h, { paint: '#28302c', under: 'rust', grime: .25, chip: .62, edge: 44, holes, streaks: true, seed })), 0, 0);
    const wear = once('tabela-f|' + name, () => flakes(w, h, seed, 1.0, 22));
    c.drawImage(layer(w, h, p => {
      p.fillStyle = '#d9a536'; p.fillRect(34, h - 58, w - 68, 16); p.fillRect(34, 96, w - 68, 10);
      p.fillStyle = '#d9a536';
      if (rgb) arrowUp(p, 220, 300, 128); else arrowBack(p, 220, 290, 118);
      put(p, rgb ? 'IŞIK ANITI · RGB' : 'FANLAR', 410, 392, 'KMStencil', 300, '#e5e0cf', 'left', w - 470, 8);
    }, wear), 0, 0);
    holes.forEach(([x, y]) => { c.fillStyle = '#060606'; c.beginPath(); c.arc(x, y, 16, 0, 7); c.fill(); c.strokeStyle = '#6a665c'; c.lineWidth = 5; c.beginPath(); c.arc(x, y, 21, 0, 7); c.stroke(); });
  }

  // ---- cikis_*: the lit exit sign (white pictogram and letters on green, light from inside)
  function runner(p, s) {   // figure running left into a door; drawn in a 100-unit box
    p.save(); p.scale(s / 100, s / 100); p.lineCap = 'round'; p.lineJoin = 'round';
    p.lineWidth = 6; p.strokeRect(4, 4, 44, 92);                       // the doorway
    p.fillStyle = p.strokeStyle; p.beginPath(); p.arc(72, 16, 8.5, 0, 7); p.fill();   // head
    p.lineWidth = 12;
    p.beginPath(); p.moveTo(68, 30); p.lineTo(60, 56); p.stroke();                    // torso
    p.lineWidth = 9;
    p.beginPath(); p.moveTo(67, 33); p.lineTo(52, 40); p.lineTo(43, 34); p.stroke();  // front arm
    p.beginPath(); p.moveTo(68, 34); p.lineTo(80, 44); p.lineTo(90, 40); p.stroke();  // back arm
    p.beginPath(); p.moveTo(60, 56); p.lineTo(46, 66); p.lineTo(40, 82); p.stroke();  // front leg
    p.beginPath(); p.moveTo(60, 56); p.lineTo(72, 72); p.lineTo(88, 74); p.stroke();  // back leg
    p.restore();
  }
  function cikis(c, d, name) {
    const { w, h } = sizes[name], mirror = name === 'cikis_2';
    c.fillStyle = 'rgb(0,150,70)'; c.fillRect(0, 0, w, h);
    // two tubes behind the diffuser: a little brighter in bands, darker at the rim
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,.30)'); g.addColorStop(.3, 'rgba(0,0,0,.02)'); g.addColorStop(.5, 'rgba(0,0,0,.10)');
    g.addColorStop(.7, 'rgba(0,0,0,.02)'); g.addColorStop(1, 'rgba(0,0,0,.34)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const ink = 'rgb(236,250,240)';
    c.strokeStyle = ink; c.lineWidth = 10; c.strokeRect(26, 26, w - 52, h - 52);
    c.save();
    if (mirror) { c.translate(w, 0); c.scale(-1, 1); }
    c.translate(70, 92); c.strokeStyle = ink; runner(c, 330);
    c.restore();
    put(c, 'ÇIKIŞ', mirror ? 64 + (w - 470) / 2 : 450 + (w - 520) / 2, 318, 'KMKond', 250, ink, 'center', w - 520, 6);
  }

  // ---- kilit_tasi_ekran: the keystone display (seven segments + dot-matrix lines in the temperature colour)
  /* The display is composed of tiles (the three labels, the average, the two sources), each cached by what it
     shows, so a changed value rebuilds only its own tile. Each tile holds luminance (white = lit; unlit segments
     and dots barely there) plus the glass's halo; the draw tints it with the temperature colour and adds the
     softened hot cores of the big digits, untinted. */
  const KS = { slant: Math.tan(5.5 * Math.PI / 180), H: 690, top: 236, room: 1960, fh: 330, ftop: 470, froom: 860 };
  const KS_GHOST = `rgb(${enc(.0045)},${enc(.0045)},${enc(.0045)})`;
  function ksH(text, H, room) {
    const wv = segLayout(text, H).width + H * KS.slant;
    return wv > room ? Math.floor(H * room / wv) : H;
  }
  function ksSeg(l, text, cx, top, H, lit, ghost, inset = 0) {
    const W = segLayout(text, H).width;
    l.save(); l.transform(1, 0, -KS.slant, 1, KS.slant * (top + H), 0);
    segValue(l, text, cx - W / 2, top, H, lit, ghost, inset); l.restore();
  }
  function ksDm(l, s, cx, top, p, lit, ghost) {
    const x = Math.round(cx - dmWidth(s) * p / 2);
    if (ghost) dmGhost(l, x - 3 * p, top, dmWidth(s) + 6, DM_ROWS, p, dotSprite(p, ghost, false));
    dmDraw(l, s, x, top, p, dotSprite(p, lit, true));
  }
  // A tile: rect (x, y, w, h) in texture pixels; paint(ctx, lit, ghost) draws in texture coordinates.
  // The display's caches are large canvases: keep only the most recent few (values change, labels stay).
  const ksRecent = new Map();
  function ksOnce(key, make) {
    if (ksRecent.has(key)) { const v = ksRecent.get(key); ksRecent.delete(key); ksRecent.set(key, v); return v; }
    const v = make(); ksRecent.set(key, v);
    if (ksRecent.size > 16) ksRecent.delete(ksRecent.keys().next().value);
    return v;
  }
  function ksTile(key, x, y, w, h, kapali, paint) {
    return ksOnce('tile|' + key + '|' + kapali, () => {
      const dim = kapali ? .2 : 1, lit = `rgb(${enc(dim)},${enc(dim)},${enc(dim)})`;
      const cv = mk(w, h), c = ctxOf(cv);
      c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
      const ghost = kapali ? `rgb(${enc(.0012)},${enc(.0012)},${enc(.0012)})` : KS_GHOST;
      c.save(); c.translate(-x, -y); paint(c, lit, ghost); c.restore();
      const sm = mk(Math.ceil(w / 8), Math.ceil(h / 8)), s8 = ctxOf(sm);
      s8.fillStyle = '#000'; s8.fillRect(0, 0, sm.width, sm.height);
      s8.scale(1 / 8, 1 / 8); s8.translate(-x, -y); paint(s8, lit, null);
      const glow = halo(sm, 1, 5);
      c.globalCompositeOperation = 'lighter'; c.globalAlpha = .5;
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'low'; c.drawImage(glow, 0, 0, sm.width * 8, sm.height * 8);
      return { cv, x, y };
    });
  }
  function keystone(c, d, name) {
    const { w, h } = sizes[name], kapali = !!d.kapali;
    let col = linOf(d.renk, [.65, .75, 1]);
    const peak = Math.max(...col, 1e-4); col = col.map(v => v / peak);
    const avg = segString(d.ortalama), cpu = segString(d.cpu), gpu = segString(d.gpu);
    const H = ksH(avg, KS.H, KS.room), top = KS.top + (KS.H - H) / 2;
    const flank = (v, cx, label, side) => {
      const fh = ksH(v, KS.fh, KS.froom);
      const x0 = Math.max(0, cx - 620), x1 = Math.min(w, cx + 620);
      return [ksTile(`${side}|${v}`, x0, 290, x1 - x0, 734, kapali, (l, lit, g) => ksSeg(l, v, cx + 10, KS.ftop + (KS.fh - fh) / 2, fh, lit, g)),
        ksTile(`${side}-ad`, cx - 520, 120, 1040, 470, kapali, (l, lit, g) => ksDm(l, label, cx, 300, 10, lit, g))];
    };
    const tiles = [
      ksTile('ad', 1250, 0, 1600, 380, kapali, (l, lit, g) => ksDm(l, 'ORTALAMA SICAKLIK', w / 2, 52, 12, lit, g)),
      ksTile('ort|' + avg, 816, 56, 2464, 968, kapali, (l, lit, g) => ksSeg(l, avg, w / 2 + 20, top, H, lit, g)),
      ...flank(cpu, 500, 'İŞLEMCİ', 'cpu'), ...flank(gpu, w - 500, 'EKRAN KARTI', 'gpu'),
    ];
    const lum = ksOnce(`lum|${avg}|${cpu}|${gpu}|${kapali}`, () => {
      for (const k of [...ksRecent.keys()]) if (k.startsWith('lum|')) ksRecent.delete(k);   // one at a time
      const cv = mk(w, h), l = ctxOf(cv);
      l.fillStyle = '#000'; l.fillRect(0, 0, w, h);
      l.globalCompositeOperation = 'lighter';   // tiles overlap where their halos meet: light adds
      for (const t of tiles) l.drawImage(t.cv, t.x, t.y);
      l.globalCompositeOperation = 'source-over';
      l.fillStyle = KS_GHOST; l.fillRect(1010, 140, 4, h - 280); l.fillRect(w - 1014, 140, 4, h - 280);
      return cv;
    });
    c.drawImage(lum, 0, 0);
    c.globalCompositeOperation = 'multiply'; c.fillStyle = cssLin(col); c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
    if (!kapali) {   // a bright LED's centre whitens a little
      const core = ksOnce('core|' + avg, () => {
        const cv = mk(2464 / 4, 968 / 4), k = ctxOf(cv);
        k.fillStyle = '#000'; k.fillRect(0, 0, cv.width, cv.height); k.scale(1 / 4, 1 / 4); k.translate(-816, -56);
        ksSeg(k, avg, w / 2 + 20, top, H, '#fff', null, .45);
        return halo(cv, 1, 3);
      });
      c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha = .22;
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'low'; c.drawImage(core, 816, 56, 2464, 968); c.restore();
    }
  }

  // ---- durak_plaka_*: engraved, paint-filled brushed-steel plates for the colour stops
  function engrave(p, s, x, y, family, px, fill, align, maxW, spacing = 0) {
    put(p, s, x, y + Math.max(2, px * .022), family, px, 'rgba(240,242,238,.75)', align, maxW, spacing);   // cut lip
    put(p, s, x, y, family, px, fill, align, maxW, spacing);
  }
  function durak(c, d, name) {
    const { w, h } = sizes[name], seed = seedOf(name);
    const holes = [[40, 40, 10], [w - 40, 40, 10], [40, h - 40, 10], [w - 40, h - 40, 10]];
    c.drawImage(once('durak|' + name, () => surface(w, h, { paint: '#a3a5a2', under: 'steel', grime: .45, chip: 0, edge: 20, holes, brushed: true, seed })), 0, 0);
    const wear = once('durak-f|' + name, () => flakes(w, h, seed, .35, 10));
    const colour = linOf(d.renk, null);
    c.drawImage(layer(w, h, p => {
      if (d.secili) { p.strokeStyle = '#ece6d4'; p.lineWidth = 12; p.strokeRect(62, 62, w - 124, h - 124); }
      else { p.strokeStyle = '#141414'; p.lineWidth = 5; p.strokeRect(66, 66, w - 132, h - 132); }
      const deg = finite(d.derece) ? Math.round(d.derece) + '°' : '—';
      const ink = '#141414';
      if (colour) {   // an enamel dot in the stop's colour
        p.fillStyle = ink; p.beginPath(); p.arc(236, 196, 74, 0, 7); p.fill();
        p.fillStyle = cssLin(colour); p.beginPath(); p.arc(236, 196, 60, 0, 7); p.fill();
      }
      engrave(p, deg, colour ? 640 : w / 2, 300, 'KMKond', 280, ink, 'center', colour ? 520 : w - 200, 2);
      engrave(p, up(d.ad || ''), w / 2, 410, 'KMKond', 88, ink, 'center', w - 190, 3);
    }, wear), 0, 0);
    holes.forEach(([x, y], i) => screw(c, x, y, 10, h32(i, 3, seed) * 3));
  }

  // ---- plaka_rgb: the engraved steel plate of the great switch
  function plakaRgb(c, d, name) {
    const { w, h } = sizes[name], seed = seedOf(name);
    const holes = holes4(w, h, 56, 16);
    c.drawImage(once('plaka|' + name, () => surface(w, h, { paint: '#a3a5a2', under: 'steel', grime: .45, chip: 0, edge: 24, holes, brushed: true, seed })), 0, 0);
    const wear = once('plaka-f|' + name, () => flakes(w, h, seed, .35, 12));
    const on = d.acik === true ? 0 : d.acik === false ? 1 : -1;
    const ink = '#141414', mark = d.hover ? '#fffaf0' : '#e2ddd0';
    c.drawImage(layer(w, h, p => {
      p.strokeStyle = ink; p.lineWidth = 7; p.strokeRect(100, 100, w - 200, h - 200);
      engrave(p, 'IŞIKLAR', w / 2, 270, 'KMKond', 170, ink, 'center', w - 400, 10);
      // the two positions either side of the switch, ticks pointing in to its spindle
      [['AÇIK', w * .25], ['KAPALI', w * .75]].forEach(([label, x], i) => {
        const sel = on === i;
        if (sel) { p.fillStyle = mark; p.fillRect(x - 290, 400, 580, 250); p.fillStyle = ink; p.fillRect(x - 290, 400, 580, 8); }
        engrave(p, label, x, 590, 'KMKond', 210, ink, 'center', 520, 6);
        p.fillStyle = ink; const tx = i ? x - 330 : x + 330;
        p.beginPath(); p.moveTo(tx + (i ? 40 : -40), 525); p.lineTo(tx - (i ? 30 : -30), 490); p.lineTo(tx - (i ? 30 : -30), 560); p.closePath(); p.fill();
      });
      if (d.acik === true && d.bosta) {
        const minutes = finite(d.beklemeDakika) ? d.beklemeDakika.toLocaleString('tr-TR') : '15';
        engrave(p, `${minutes} DAKİKADIR KLAVYE VE FARE KULLANILMADI`, w / 2, 730, 'KMKond', 84, ink, 'center', w - 360, 2);
        engrave(p, 'IŞIKLAR YUMUŞAKÇA SÖNDÜ', w / 2, 820, 'KMKond', 84, ink, 'center', w - 360, 2);
        engrave(p, 'KLAVYEYE YA DA FAREYE DOKUNUNCA YANAR', w / 2, 910, 'KMKond', 78, ink, 'center', w - 360, 2);
      } else if (d.acik === false) {
        engrave(p, 'IŞIKLAR KAPALIYKEN DE', w / 2, 782, 'KMKond', 100, ink, 'center', w - 360, 3);
        engrave(p, 'RENK HESAPLANIYOR', w / 2, 886, 'KMKond', 100, ink, 'center', w - 360, 3);
      }
    }, wear), 0, 0);
    holes.forEach(([x, y], i) => screw(c, x, y, 16, h32(i, 4, seed) * 3));
  }

  // ---- cihaz_*: black anodised nameplates with a state flag in a window
  const DEVICES = { cihaz_aio: 'KASA · COOLER MASTER HALO 360', cihaz_klavye: 'KLAVYE · STEELSERIES APEX 3', cihaz_gpu: 'EKRAN KARTI · MSI RTX 4080' };
  const FLAGS = {
    bagli: ['BAĞLI', '#3d7a4b', '#f1efe6'], bagli_degil: ['BAĞLI DEĞİL', '#cf9b2c', '#14120e'],
    kilitli: ['KİLİTLİ', '#7c7e80', '#121212'], hata: [null, '#9d2b22', '#f4ece4'],
  };
  function cihaz(c, d, name) {
    const { w, h } = sizes[name], seed = seedOf(name), state = d.durum ?? 'bagli_degil';
    if (!Object.hasOwn(FLAGS, state)) throw new Error('Unknown device state: ' + state);
    const holes = [[44, h / 2, 13], [w - 44, h / 2, 13]];
    c.drawImage(once('cihaz|' + name, () => surface(w, h, { paint: '#1b1c1d', under: 'steel', grime: .2, chip: .06, edge: 10, holes, brushed: true, seed })), 0, 0);
    const wear = once('cihaz-f|' + name, () => flakes(w, h, seed, .25, 10));
    const metal = '#c3c6c4';
    c.drawImage(layer(w, h, p => {
      p.strokeStyle = metal; p.lineWidth = 8; p.strokeRect(92, 26, w - 184, h - 52);
      put(p, DEVICES[name], 140, 186, 'KMKond', 128, metal, 'left', w - 280, 3);
      p.fillStyle = metal; p.fillRect(140, 236, w - 280, 5);
      put(p, 'DURUM', 140, state === 'kilitli' ? 342 : 380, 'KMMono', 64, metal, 'left', 300, 6);
      if (state === 'kilitli') put(p, 'BU DERLEMEDE KARTA YOL YOK', w / 2, 458, 'KMKond', 96, metal, 'center', w - 280, 2);
    }, wear), 0, 0);
    // the state flag behind a small window
    const [word, flag, ink] = FLAGS[state], text = word || up(d.hata || 'CİHAZ HATASI');
    const fx = 420, fy = state === 'kilitli' ? 264 : 284, fw = w - fx - 140, fh = state === 'kilitli' ? 104 : 152;
    c.fillStyle = '#050505'; c.fillRect(fx - 10, fy - 10, fw + 20, fh + 20);
    c.fillStyle = flag; c.fillRect(fx, fy, fw, fh);
    const sh = c.createLinearGradient(0, fy, 0, fy + fh); sh.addColorStop(0, 'rgba(0,0,0,.45)'); sh.addColorStop(.25, 'rgba(0,0,0,0)');
    c.fillStyle = sh; c.fillRect(fx, fy, fw, fh);
    const Lw = wrap(c, text, 'KMKond', Math.min(112, fh * .8), fw - 60, 2);
    Lw.px = Math.min(Lw.px, Math.floor(fh / (Lw.lines.length * 1.12)));
    const lh = Lw.px * 1.02;
    const y0 = fy + fh / 2 - (Lw.lines.length - 1) * lh / 2 + Lw.px * .34;
    Lw.lines.forEach((s, i) => put(c, s, fx + 30, y0 + i * lh, 'KMKond', Lw.px, ink, 'left', fw - 60, 2));
    holes.forEach(([x, y], i) => { c.fillStyle = '#0a0a0a'; c.beginPath(); c.arc(x, y, 18, 0, 7); c.fill();
      const g = c.createRadialGradient(x - 4, y - 5, 2, x, y, 14); g.addColorStop(0, '#e2e4e2'); g.addColorStop(1, '#6d706f');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, 14, 0, 7); c.fill(); });
  }

  // ================================================================ draw
  function draw(name, data, canvas) {
    if (!loaded) throw new Error('Await KM_LEVHA.ready before drawing');
    const s = sizes[name]; if (!s) throw new Error('Unknown world texture: ' + name);
    const d = data || {};
    const out = canvas || mk(s.w, s.h);
    out.width = s.w; out.height = s.h;            // resets the whole context state: same data, same bytes
    const c = out.getContext('2d', { ...CTX, alpha: s.kind === 'boya' });
    if (name.startsWith('boya_')) c.drawImage(stencilPaint(name), 0, 0);
    else if (name.startsWith('masa_ekran_')) masa(c, d, name);
    else if (name.startsWith('tabela_')) tabela(c, d, name);
    else if (name.startsWith('cikis_')) cikis(c, d, name);
    else if (name === 'kilit_tasi_ekran') keystone(c, d, name);
    else if (name.startsWith('durak_plaka_')) durak(c, d, name);
    else if (name === 'plaka_rgb') plakaRgb(c, d, name);
    else cihaz(c, d, name);
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    return out;
  }

  global.KM_LEVHA = Object.freeze({ ready, sizes, draw });
})(window);
