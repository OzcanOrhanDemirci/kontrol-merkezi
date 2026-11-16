// Kontrol Merkezi: the service's colour maths, mirrored so the scale shows exactly what the case will show.
// Port of src/Isik/Renk.cs (Lin.Full, Lab.From/ToLin, Lab.MixHue) and RenkMotoru.Palet.
'use strict';
window.KM_RENK = (() => {
  const toLin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const fromSrgb = c => [toLin(c[0] / 255), toLin(c[1] / 255), toLin(c[2] / 255)];
  const full = c => { const m = Math.max(c[0], c[1], c[2]); return m <= 1e-6 ? [1, 1, 1] : c.map(v => clamp01(v / m)); };
  const labFrom = c => {
    let l = 0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2];
    let m = 0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2];
    let s = 0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2];
    l = Math.cbrt(Math.max(l, 0)); m = Math.cbrt(Math.max(m, 0)); s = Math.cbrt(Math.max(s, 0));
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  };
  const labToLin = ([L, A, B]) => {
    let l = L + 0.3963377774 * A + 0.2158037573 * B;
    let m = L - 0.1055613458 * A - 0.0638541728 * B;
    let s = L - 0.0894841775 * A - 1.2914855480 * B;
    l = l * l * l; m = m * m * m; s = s * s * s;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  };
  const mixHue = (a, b, t) => {
    const ca = Math.hypot(a[1], a[2]), cb = Math.hypot(b[1], b[2]);
    let ha = Math.atan2(a[2], a[1]), hb = Math.atan2(b[2], b[1]);
    if (ca < 0.04) ha = hb;
    if (cb < 0.04) hb = ha;
    let dh = hb - ha;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const h = ha + dh * t, c = ca + (cb - ca) * t, l = a[0] + (b[0] - a[0]) * t;
    return [l, c * Math.cos(h), c * Math.sin(h)];
  };
  // stops: [{c, renk:[r,g,b]}]; full-brightness linear colour at temperature c (RenkMotoru.Palet)
  function palet(stops, c) {
    const lab = stops.map(s => labFrom(full(fromSrgb(s.renk))));
    if (c <= stops[0].c) return full(labToLin(lab[0]));
    for (let i = 1; i < stops.length; i++) {
      if (c <= stops[i].c) {
        let t = (c - stops[i - 1].c) / (stops[i].c - stops[i - 1].c);
        t = t * t * (3 - 2 * t) * 0.35 + t * 0.65;
        return full(labToLin(mixHue(lab[i - 1], lab[i], t)));
      }
    }
    return full(labToLin(lab[lab.length - 1]));
  }
  const toSrgb = c => c.map(v => { v = clamp01(v); return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255); });
  return { palet, fromSrgb, full, toSrgb };
})();
