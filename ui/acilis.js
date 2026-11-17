// Kontrol Merkezi · the loading screen (index.html, #acilis): the hall in the dark, its lights coming on.
// Not a screen about loading: the hall is already there, lit only by the embers of its service lamps, and its
// lighting circuits strike one after another from the landing to the far end as the scene's data arrives. With the
// last circuit on, the picture is the live scene's first frame to the pixel (same eye, same exposure, lamps on, shaft
// and arch not yet struck, displays dark: ui/uygulama.js holds the world so until the hand-over), and it dissolves
// into the scene, whose own opening (the shaft's strike) follows.
//
// The pictures are made from the scene by araclar/acilis_kareler.py (ui/acilis/: taban.jpg the ember, dNN.jpg the
// frame as it stands once circuit NN and all before it are on, cropped to where that circuit shows; katman.js their
// places). The window paints the ember before the page exists (src/Pencere/Acilis.cs) and serves the same pixels as
// acilis.bmp; the page is transparent until that picture is decoded and laid over it, so the take-over is invisible.
//
// Cost while the pack loads: the page's thread is held for up to ~0.9 s at a time then, so nothing here runs per
// frame. A circuit's strike is an opacity animation handed to the compositor ahead of its time, with its delay.
//
// When a circuit strikes: the load's words come in bursts between those silences, so the circuits are not hung on them
// alone (that gave a dark wait, then a volley). As the load begins every circuit but the far end gets a time, spread
// evenly over how long the load took last time (remembered; three seconds the first time); a word that shows the
// load ahead of that brings the circuits it covers forward; the far end waits for the load's last stage. If the
// scene is up before all have struck, the rest strike at once, quickly and in order, and the dissolve waits for the
// last to catch; if the load runs long, the hall stands lit with its far end dark until it is.
//   KM_ACILIS.progress(f)   0..1, the load (salon.js onProgress)
//   KM_ACILIS.end()         the scene's first frame is on the screen: finish striking, dissolve
//   KM_ACILIS.skip()        gone at once (stills, an error to read)
// Debug (the page's hash; in the window: the environment variable KM_SAYFA): devir=N stretches the dissolve to N
// seconds; with ilk=1 (the scene held on its first frame) devir=kirp blinks the last picture over it for ten seconds.
'use strict';
(() => {
const el = document.getElementById('acilis'), stage = el.querySelector('.kare'), board = el.querySelector('.pano');
const canvas = document.getElementById('gl');
const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
const params = new URLSearchParams(location.hash.slice(1));
const K = window.KM_ACILIS_KATMAN || { w: 2560, h: 1440, d: [] };
const N = K.d.length;
const GAP = 0.2, RUSH = 0.07;            // seconds between two strikes: at the load's pace, and once the scene is up
const STRIKE = { t: 460, o: [0, 0.8, 0.12, 0.66, 0.4, 1], at: [0, 0.09, 0.17, 0.31, 0.42, 1] };   // a tube catching
const FADE = 0.55;
const KEY = 'km-acilis-sure';             // how long the last load took (ms), for the circuits' pace
let expect = 3000;
try { expect = Math.min(9000, Math.max(1500, +localStorage.getItem(KEY) || 3000)); } catch (e) { /* no storage */ }
let up = false, over = false, ready = false, wanted = 0, t0 = 0, laid = false;
const marks = { devre: [] };              // for the opening's log line: when the pictures were ready, when each circuit strikes

// the frame's size on any window: the scene's vertical field of view is fixed, so the picture fits the height and
// is centred (on the 2560x1440 monitor: 1:1, every picture on its own pixels)
function fit() { const s = innerHeight / K.h; stage.style.transform = 'translateX(' + (-K.w * s / 2) + 'px) scale(' + s + ')'; }
fit();
addEventListener('resize', fit);

// the circuits' pictures and the board's pilot lamps, all there from the start at opacity 0 (decoded and on the GPU
// before their time comes)
const row = board.querySelector('.sira');
const layers = K.d.map(([file, x, y, w, h], i) => {
  const im = new Image();
  im.alt = ''; im.decoding = 'async';
  im.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px';
  im.src = 'acilis/' + file;
  stage.insertBefore(im, board);
  const l = document.createElement('div');
  l.className = 'l';
  l.innerHTML = '<i></i><b>' + String(i + 1).padStart(2, '0') + '</b>';
  row.appendChild(l);
  return { im, lamp: l.firstChild, at: null, anims: null };
});
Promise.all(layers.map(c => c.im.decode())).then(() => {
  ready = true; marks.resimler = performance.now();
  if (t0 && !over) { lay(); advance(wanted, GAP); }
}, () => { /* a picture missing: no strikes, the ember dissolves into the scene */ });

function raise() {
  if (up || over) return;
  up = true;
  el.classList.add('on');
  canvas.style.visibility = 'visible';           // under the opaque picture from now on
}
const base = new Image();
base.alt = ''; base.decoding = 'sync';
base.src = host ? 'acilis.bmp' : 'acilis/taban.jpg';
base.decode().then(() => {
  if (host) el.insertBefore(base, el.firstChild);                 // the window's own pixels, at the window's size
  else { base.className = 'taban'; base.style.cssText = 'left:0;top:0;width:' + K.w + 'px;height:' + K.h + 'px'; stage.insertBefore(base, stage.firstChild); }
  requestAnimationFrame(raise);
}, raise);
// the board in the sign's stencil, once its faces are there (no fallback face first)
Promise.all([document.fonts.load('20px KMAcilis'), document.fonts.load('500 12px KMAcilisMono')])
  .then(() => el.classList.add('yazili'), () => el.classList.add('yazili'));

function strikeAt(c, t) {
  const delay = Math.max(0, t - performance.now());
  if (c.anims) c.anims.forEach(a => a.cancel());   // only ever one not yet begun (still at opacity 0): moved earlier
  const kf = STRIKE.o.map((o, i) => ({ opacity: o, offset: STRIKE.at[i] }));
  c.anims = [c.im, c.lamp].map(e => e.animate(kf, { duration: STRIKE.t, delay, fill: 'both', easing: 'linear' }));
  c.at = t; marks.devre[layers.indexOf(c)] = t;
}
// the load has begun: every circuit but the far end at its expected time
function lay() {
  if (laid) return;
  laid = true;
  const now = performance.now();
  let prev = -1e9;
  for (let i = 0; i < N - 1; i++) {
    strikeAt(layers[i], Math.max(now, t0 + expect * i / N, prev + GAP * 1000));
    prev = layers[i].at;
  }
}
// circuits [0, n) that have not begun strike as soon as they may: one after another, `gap` apart, none later than
// it already was
function advance(n, gap) {
  const now = performance.now();
  let prev = -1e9;
  for (let i = 0; i < n; i++) {
    const c = layers[i];
    if (c.at != null && c.at <= now) { prev = c.at; continue; }
    const t = Math.max(now, prev + gap * 1000);
    if (c.at == null || t < c.at) strikeAt(c, t);
    prev = c.at;
  }
}

function finish() { if (el.isConnected) { el.remove(); removeEventListener('resize', fit); if (host) host.postMessage('acilis-bitti'); } }

window.KM_ACILIS = Object.freeze({
  marks,
  progress(f) {
    if (over) return;
    if (!t0) t0 = performance.now();
    // the bytes off the wire are 0..0.85 of the load (salon.js) and stand for all circuits but the far end; that one
    // waits for the load's last stage (the tables and shaders, ~0.3 s before the scene's first frame), so the
    // hand-over finds it just struck
    wanted = Math.max(wanted, f >= 0.9 ? N : Math.min(N - 1, Math.floor(Math.min(1, f / 0.85) * (N - 1))));
    if (ready) { lay(); advance(wanted, GAP); }
  },
  end() {
    if (over) return;
    raise();                                      // before over: a picture still decoding must not keep the canvas hidden
    over = true;
    marks.bitti = performance.now();
    let wait = 0.1;
    if (ready && N) {
      // what has not begun yet strikes now, quickly, in its order; what has begun plays on
      const now = performance.now();
      advance(N, RUSH);
      if (t0) try { localStorage.setItem(KEY, Math.round((expect + Math.min(9000, Math.max(1500, now - t0))) / 2)); } catch (e) { /* no storage */ }
      // the dissolve begins when the last circuit has caught (two thirds through its strike), not before a tenth
      wait = Math.max(0.1, (layers[N - 1].at + STRIKE.t * 0.66 - now) / 1000);
    }
    const kirp = params.get('devir') === 'kirp';
    const fade = kirp ? FADE : +params.get('devir') || FADE;
    board.style.transition = 'opacity .25s ease-in ' + Math.max(0, wait - 0.15).toFixed(2) + 's';
    board.style.opacity = 0;
    if (kirp) {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1200, delay: wait * 1000, iterations: 8, easing: 'steps(2, jump-none)', fill: 'forwards' });
      setTimeout(finish, (wait + 9.7) * 1000);
      return;
    }
    const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade * 1000, delay: wait * 1000, fill: 'forwards', easing: 'cubic-bezier(.5, 0, .7, 1)' });
    a.finished.then(finish, finish);
    setTimeout(finish, (wait + fade) * 1000 + 600);
  },
  skip() {
    over = true;
    canvas.style.visibility = 'visible';
    finish();
  },
});
})();
