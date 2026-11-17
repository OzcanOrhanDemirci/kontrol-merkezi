// Kontrol Merkezi: simulated service, used only outside WebView2 (browser, headless measurement).
// It speaks docs/PROTOKOL.md exactly: `durum` on change (max 4 Hz), `isik` at 30 Hz, `olay` results,
// plus the host messages `baglanti` and `gorunur`. Keyboard shortcuts (simulation only) step through
// every state; window.__sim exposes the same switches to the measurement tool.
'use strict';
window.KM_BENZETIM = function (deliver) {
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const DURAKLAR = [
    { c: 52, renk: [255, 255, 255], ad: 'beyaz' },              // the service's defaults (src/Isik/Ayarlar.cs)
    { c: 58, renk: [20, 50, 255], ad: 'ılık koyu mavi' },
    { c: 64, renk: [255, 210, 0], ad: 'sıcak sarı' },
    { c: 74, renk: [255, 110, 0], ad: 'çok sıcak turuncu' },
    { c: 80.5, renk: [255, 0, 0], ad: 'kırmızı' },
  ];
  const S = {
    yonetici: true,
    bagli: 'bagli',
    cpu: 47.5, gpu: 36.0, yumusak: 41.8,
    sweep: false, sweepT: 0, hold: null,
    rgb: true,
    bekle: false,                                               // the 15-minute idle fade (switch stays on)
    kasa: { hedef: 'bios', durum: 'bios', t: 0, n: 0 },
    gpuF: { hedef: 'oto', durum: 'oto', t: 0, n: 0, baska: false },
    afterburner: { calisiyor: true, fanKontrolu: false },
    cikis: [0, 0, 0], t: 0, onizleme: [0, 0, 0], master: 1,
    lastDurum: '', lastSent: 0,
  };

  // same engine as the service: OKLCh palette at full brightness, overrides as their own colours, sent as sRGB
  const K = window.KM_RENK;
  function baseColor() {
    let c = K.palet(DURAKLAR, S.yumusak);
    return K.toSrgb(c);
  }

  function durum() {
    const unavailable = !S.yonetici ? 'Servis yönetici izniyle çalışmıyor' : null;
    const kasaRpm = S.kasa.n;
    const g = S.gpuF.n;
    return {
      tip: 'durum',
      servis: { yonetici: S.yonetici, surum: '1.0.0' },
      isi: {
        cpu: S.yonetici ? +S.cpu.toFixed(1) : null, gpu: +S.gpu.toFixed(1),
        ort: S.yonetici ? +((S.cpu + S.gpu) / 2).toFixed(1) : +S.gpu.toFixed(1),
        yumusak: +S.yumusak.toFixed(1), cpuYuk: 6, gpuYuk: 2,
      },
      fan: {
        kasa: {
          hedef: S.kasa.hedef, durum: S.yonetici ? S.kasa.durum : 'bilinmiyor', kullanilabilir: S.yonetici, neden: unavailable,
          rpm: [
            { ad: 'CPU_FAN', rpm: Math.round(lerp(817, 2003, kasaRpm)) },
            { ad: 'PUMP_FAN', rpm: Math.round(lerp(2439, 2780, kasaRpm)) },
            { ad: 'SYS_FAN1', rpm: Math.round(lerp(999, 1810, kasaRpm)) },
            { ad: 'SYS_FAN3', rpm: Math.round(lerp(940, 1795, kasaRpm)) },
          ],
        },
        gpu: {
          hedef: S.gpuF.hedef, durum: S.gpuF.baska ? 'baska' : S.gpuF.durum, kullanilabilir: S.yonetici, neden: unavailable,
          rpm: [Math.round(g * 3010 + (S.gpu > 50 ? 1100 : 0)), Math.round(g * 2990 + (S.gpu > 50 ? 1090 : 0))],
          yuzde: Math.round(g * 100 + (S.gpu > 50 && g < 0.4 ? 38 : 0)),
          afterburner: { calisiyor: S.afterburner.calisiyor, fanKontrolu: S.afterburner.fanKontrolu },
        },
      },
      rgb: {
        acik: S.rgb, beklemede: S.rgb && S.bekle, beklemeDakika: 15,
        cihazlar: [
          { kimlik: 'aio', ad: 'Cooler Master Halo 360', bagli: true, hata: null },
          { kimlik: 'klavye', ad: 'SteelSeries Apex 3', bagli: true, hata: null },
          { kimlik: 'gpu', ad: 'MSI RTX 4080 Gaming X Trio', bagli: true, hata: null },
        ],
        duraklar: DURAKLAR,
      },
    };
  }

  function send(m) { deliver(JSON.parse(JSON.stringify(m))); }
  function pushDurum(force) {
    if (S.bagli !== 'bagli') return;
    const d = durum();
    const key = JSON.stringify(d);
    const now = performance.now();
    if (!force && (key === S.lastDurum || now - S.lastSent < 250)) return;
    S.lastDurum = key; S.lastSent = now;
    send(d);
  }

  // LED effects: what the service plays on the real LEDs, so the scene mirrors them
  function frameLights(dt) {
    S.t += dt;
    const base = baseColor();
    S.onizleme = base.map(Math.round);
    const halka = [], klavye = [];
    S.master += ((S.rgb && !S.bekle ? 1 : 0) - S.master) * (1 - Math.exp(-dt / (S.rgb && S.bekle ? 1.5 : 0.3)));
    let on = S.master;
    for (let i = 0; i < 84; i++) {
      const c = base;
      halka.push(c.map(v => Math.round(clamp(v * on, 0, 255))));
    }
    for (let i = 0; i < 10; i++) {
      const c = base;
      klavye.push(c.map(v => Math.round(clamp(v * on, 0, 255))));
    }
    const avg = [0, 1, 2].map(j => Math.round(halka.reduce((s, c) => s + c[j], 0) / 84));
    return { tip: 'isik', acik: S.rgb, onizleme: S.onizleme, cikis: avg, halka, klavye };
  }

  function stepFans(f, dt, isGpu) {
    if (f.durum === 'geciyor') {
      f.t -= dt;
      if (f.t <= 0) {
        f.durum = f.hedef;
        send({ tip: 'olay', tur: isGpu ? 'fan-gpu' : 'fan-kasa', sonuc: 'tamam',
          metin: f.hedef === 'max' ? (isGpu ? 'Ekran kartı fanları en yüksek hızda' : 'Fanlar en yüksek hızda') : (isGpu ? 'Ekran kartı fanları karta bırakıldı' : 'Fanlar BIOS denetimine bırakıldı') });
      }
    }
    const target = f.durum === 'max' ? 1 : 0;
    f.n += (target - f.n) * (1 - Math.exp(-dt / (target > f.n ? 1.5 : 2.6)));
  }

  let last = performance.now();
  function tick() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (S.sweep) {
      S.sweepT += dt;
      const k = 0.5 - 0.5 * Math.cos(S.sweepT * 2 * Math.PI / 24);
      S.cpu = lerp(34, 92, k); S.gpu = lerp(30, 84, k);
    } else if (S.hold == null) {
      S.cpu = 47.5 + Math.sin(S.t * 0.7) * 0.6; S.gpu = 36 + Math.sin(S.t * 0.31) * 0.3;
    }
    if (S.hold != null) { S.cpu = S.hold + 3; S.gpu = S.hold - 3; S.yumusak = S.hold; }
    else S.yumusak += ((S.cpu + S.gpu) / 2 - S.yumusak) * (1 - Math.exp(-dt / 1.2));
    stepFans(S.kasa, dt, false);
    stepFans(S.gpuF, dt, true);
    if (S.bagli === 'bagli') send(frameLights(dt));
    pushDurum(false);
  }

  function command(m) {
    if (S.bagli !== 'bagli') return;
    if (m.komut === 'fan-kasa' || m.komut === 'fan-gpu') {
      const f = m.komut === 'fan-kasa' ? S.kasa : S.gpuF;
      if (!S.yonetici) { send({ tip: 'olay', tur: m.komut, sonuc: 'hata', metin: 'Servis yönetici izniyle çalışmıyor' }); return; }
      if (f.durum === 'geciyor') return;
      if (m.komut === 'fan-gpu' && S.gpuF.baska) S.gpuF.baska = false;
      f.hedef = f.durum === 'max' ? (m.komut === 'fan-kasa' ? 'bios' : 'oto') : 'max';
      f.durum = 'geciyor'; f.t = 0.9 + Math.random() * 0.5;
      pushDurum(true);
    } else if (m.komut === 'rgb') {
      S.rgb = !!m.acik;
      pushDurum(true);
      send({ tip: 'olay', tur: 'rgb', sonuc: 'tamam', metin: S.rgb ? 'Işıklar açıldı' : 'Işıklar kapandı' });
    }
  }

  const sim = {
    S,
    connect() {
      send({ tip: 'baglanti', durum: 'bagli' });
      send({ tip: 'gorunur', visible: true, focused: true });
      pushDurum(true);
      if (!this.timer) this.timer = setInterval(tick, 1000 / 30);
    },
    send: command,
    set(k, v) { S[k] = v; pushDurum(true); },
    temp(c) { S.hold = c; S.sweep = false; S.yumusak = c; pushDurum(true); },
    release() { S.hold = null; },
    link(d) { S.bagli = d; send({ tip: 'baglanti', durum: d }); if (d === 'bagli') pushDurum(true); },
    vis(v, f = true) { send({ tip: 'gorunur', visible: v, focused: f }); },
    key(e) {
      const k = e.key.toLowerCase();
      const map = {
        r: () => command({ komut: 'rgb', acik: !S.rgb }),
        t: () => { S.sweep = !S.sweep; S.hold = null; },
        k: () => command({ komut: 'fan-kasa' }),
        g: () => command({ komut: 'fan-gpu' }),
        b: () => { S.gpuF.baska = !S.gpuF.baska; pushDurum(true); },
        a: () => { S.afterburner.fanKontrolu = !S.afterburner.fanKontrolu; pushDurum(true); },
        e: () => sim.set('yonetici', !S.yonetici),
        d: () => sim.link(S.bagli === 'bagli' ? 'yok' : S.bagli === 'yok' ? 'baslatiliyor' : 'bagli'),
      };
      if (/^[1-6]$/.test(k)) { sim.temp(DURAKLAR[+k - 1].c); return true; }
      if (k === '0') { sim.release(); return true; }
      if (map[k]) { map[k](); return true; }
      return false;
    },
    help: [
      ['R', 'ışıklar aç / kapat'], ['T', 'sıcaklık taraması'], ['1–6', 'durak sıcaklığına sabitle'], ['0', 'sabitlemeyi bırak'],
      ['K', 'kasa fanları'], ['G', 'ekran kartı fanları'], ['B', 'GPU fanları başka programda'], ['A', 'Afterburner fan kontrolü'],
      ['E', 'yönetici izni'], ['D', 'servis bağlantısı'], ['F1', 'bu liste'],
    ],
  };
  return sim;
};
