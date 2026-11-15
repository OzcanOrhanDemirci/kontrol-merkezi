// Kontrol Merkezi: synthesized sounds (no files). Press/release/relay/spool/ignition/lights-off come
// from Fan Anahtarı, whose levels were measured with OfflineAudioContext; the voice gains are kept.
'use strict';
window.KM_SES = {
  ctx: null,
  init(offline) {
    if (this.ctx && !offline) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC && !offline) return;
    const ctx = this.ctx = offline || new AC({ latencyHint: 'interactive' });
    this.offline = !!offline;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3.5; comp.attack.value = 0.002; comp.release.value = 0.25;
    this.out = ctx.createGain(); this.out.gain.value = 0.5;
    this.out.connect(comp); comp.connect(ctx.destination);
    this.bus = ctx.createGain(); this.bus.connect(this.out);
    const verb = ctx.createConvolver(); verb.buffer = this.impulse(2.2, 3.2);
    const wet = ctx.createGain(); wet.gain.value = 0.2;
    this.bus.connect(verb); verb.connect(wet); wet.connect(this.out);
    this.noise = this.noiseBuf(2.5);
  },
  voice(g) { const n = this.ctx.createGain(); n.gain.value = g; n.connect(this.bus); this.dest = n; },
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); },
  ok() { return this.ctx && (this.ctx.state === 'running' || this.offline); },
  impulse(sec, decay) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let s = ch ? 9973 : 4441;
      for (let i = 0; i < n; i++) {
        s = (s * 16807) % 2147483647;
        const t = i / n;
        d[i] = (s / 2147483647 * 2 - 1) * Math.pow(1 - t, decay) * Math.min(1, i / (ctx.sampleRate * 0.006));
      }
    }
    return b;
  },
  noiseBuf(sec) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    let s = 12345, b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      s = (s * 16807) % 2147483647;
      const w = s / 2147483647 * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
    return b;
  },
  tone(type, f0, f1, t, dur, peak, att = 0.002) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + att);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.dest || this.bus); o.start(t); o.stop(t + dur + 0.05);
  },
  burst(t, dur, ftype, freq, q, peak) {
    const ctx = this.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.noise; f.type = ftype; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.dest || this.bus);
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  },
  press() {
    if (!this.ok()) return; this.voice(4.5); const t = this.ctx.currentTime;
    this.tone('sine', 170, 56, t, 0.12, 0.5);
    this.burst(t, 0.014, 'bandpass', 2500, 1.3, 0.42);
    this.burst(t, 0.02, 'highpass', 6500, 0.7, 0.1);
    this.tone('sine', 1180, 1180, t, 0.05, 0.045);
    this.tone('sine', 1745, 1745, t, 0.035, 0.03);
  },
  release() {
    if (!this.ok()) return; this.voice(8.0); const t = this.ctx.currentTime;
    this.burst(t, 0.01, 'bandpass', 3800, 1.6, 0.26);
    this.tone('sine', 2350, 2350, t, 0.03, 0.035);
    this.tone('sine', 300, 180, t, 0.05, 0.12);
  },
  locked() {
    if (!this.ok()) return; this.voice(4.5); const t = this.ctx.currentTime;
    this.tone('sine', 120, 70, t, 0.08, 0.32);
    this.burst(t, 0.025, 'lowpass', 900, 0.7, 0.2);
  },
  relay(k = 1) {
    if (!this.ok()) return; this.voice(6.7); const t = this.ctx.currentTime;
    for (const [dt, a] of [[0, 1], [0.017, 0.45], [0.029, 0.18]]) {
      this.burst(t + dt, 0.012, 'bandpass', 1500, 2.2, 0.55 * a * k);
      this.burst(t + dt, 0.007, 'bandpass', 3300, 1.8, 0.25 * a * k);
    }
    this.tone('sine', 96, 58, t, 0.07, 0.42 * k);
  },
  spool(up, rb = 815, rm = 2003) {
    if (!this.ok()) return; this.voice(2.2);
    const ctx = this.ctx, t = ctx.currentTime, T = up ? 4.6 : 3.6, N = 64;
    const f = new Float32Array(N), fl = new Float32Array(N), fn = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const tt = i / (N - 1) * T;
      const rpm = up ? rb + (rm - rb) * (1 - Math.exp(-tt / 1.5)) : rm - (rm - rb) * 0.32 * (1 - Math.exp(-tt / 2.5));
      f[i] = rpm / 60 * 7; fl[i] = f[i] * 3.2; fn[i] = f[i] * 8.5;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    if (up) { g.gain.linearRampToValueAtTime(0.3, t + 0.35); g.gain.setTargetAtTime(0, t + 1.7, 0.85); }
    else { g.gain.linearRampToValueAtTime(0.2, t + 0.08); g.gain.setTargetAtTime(0, t + 0.3, 0.9); }
    g.connect(this.dest);
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueCurveAtTime(f, t, T);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.8; lp.frequency.setValueCurveAtTime(fl, t, T);
    const og = ctx.createGain(); og.gain.value = 0.32;
    o.connect(lp); lp.connect(og); og.connect(g);
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.setValueCurveAtTime(f.map(x => x * 2.01), t, T);
    const o2g = ctx.createGain(); o2g.gain.value = 0.09; o2.connect(o2g); o2g.connect(g);
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.55; bp.frequency.setValueCurveAtTime(fn, t, T);
    const ng = ctx.createGain(); ng.gain.value = 1.1; n.connect(bp); bp.connect(ng); ng.connect(g);
    for (const s of [o, o2, n]) { s.start(t); s.stop(t + T + 0.05); }
    if (up) this.tone('sine', 64, 36, t, 0.55, 0.55, 0.01);
  },
  ignition() {
    if (!this.ok()) return; this.voice(4.3); const t = this.ctx.currentTime;
    this.burst(t, 0.06, 'lowpass', 420, 0.8, 0.5);
    this.tone('sine', 72, 44, t, 0.3, 0.42);
    this.burst(t, 0.012, 'bandpass', 2100, 1.4, 0.18);
    this.tone('sine', 100, 100, t + 0.01, 1.8, 0.028, 0.05);
    this.tone('sine', 200, 200, t + 0.01, 1.4, 0.012, 0.05);
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(190, t + 0.3);
    o.frequency.exponentialRampToValueAtTime(560, t + 0.85); o.frequency.exponentialRampToValueAtTime(330, t + 1.45);
    g.gain.setValueAtTime(0, t + 0.3); g.gain.linearRampToValueAtTime(0.018, t + 0.5); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.55);
    o.connect(g); g.connect(this.dest); o.start(t + 0.3); o.stop(t + 1.6);
  },
  lightsOff() {
    if (!this.ok()) return; this.voice(3.6); const t = this.ctx.currentTime;
    this.burst(t, 0.045, 'lowpass', 520, 0.8, 0.32);
    this.tone('sine', 66, 40, t, 0.22, 0.3);
    this.burst(t, 0.01, 'bandpass', 2400, 1.4, 0.12);
  },
  // RGB on: the light guide charging up; a soft rising shimmer over a low thump
  lightsOn() {
    if (!this.ok()) return; this.voice(3.6); const t = this.ctx.currentTime;
    this.burst(t, 0.05, 'lowpass', 480, 0.8, 0.34);
    this.tone('sine', 58, 92, t, 0.35, 0.3, 0.01);
    const ctx = this.ctx;
    for (const [f, a, d] of [[523, 0.016, 0.0], [784, 0.012, 0.06], [1047, 0.009, 0.12]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(f, t + d);
      g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(a, t + d + 0.12); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 1.3);
      o.connect(g); g.connect(this.dest); o.start(t + d); o.stop(t + d + 1.4);
    }
  },
  // tab change: the camera dolly as a filtered air move
  glide() {
    if (!this.ok()) return; this.voice(2.6); const t = this.ctx.currentTime;
    const ctx = this.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.noise; f.type = 'bandpass'; f.Q.value = 0.9;
    f.frequency.setValueAtTime(260, t); f.frequency.exponentialRampToValueAtTime(900, t + 0.6); f.frequency.exponentialRampToValueAtTime(320, t + 1.5);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.22, t + 0.55); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    s.connect(f); f.connect(g); g.connect(this.dest); s.start(t, Math.random()); s.stop(t + 1.7);
  },
  error() {
    if (!this.ok()) return; this.voice(2.5); const t = this.ctx.currentTime;
    this.tone('triangle', 220, 218, t, 0.16, 0.16);
    this.tone('triangle', 164, 160, t + 0.17, 0.26, 0.16);
  },
};
