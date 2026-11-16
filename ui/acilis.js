// Kontrol Merkezi · the loading screen (index.html, #acilis): from the window's first frame to the scene's opening.
// The window paints a picture of the hall before its lights strike (src/Pencere/Acilis.cs) and serves the same
// pixels as acilis.bmp; the page is transparent until that picture is decoded and laid over it, so the take-over is
// invisible. It shows the load as a slit of light opening and ends when the scene's first frame is on the screen:
// the hatch opens (the beam swells), the picture dissolves into the scene's own strike of the shaft's light.
// Cost while the pack loads: a few style writes in all; every movement is opacity or transform on the compositor.
//   KM_ACILIS.progress(f)   0..1, the load (salon.js onProgress)
//   KM_ACILIS.end()         the scene's first frame is on the screen: open and dissolve
//   KM_ACILIS.skip()        gone at once (stills, an error to read)
'use strict';
(() => {
const el = document.getElementById('acilis');
const slit = el.querySelector('.yarik');
const canvas = document.getElementById('gl');
const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
let up = false, over = false, shown = 0;

function raise() {
  if (up || over) return;
  up = true;
  el.classList.add('on');
  canvas.style.visibility = 'visible';           // under the opaque picture from now on
  if (!shown) setSlit(0.08, 1.6);               // the load has begun
}
if (host) {
  const img = new Image();
  img.alt = '';
  img.decoding = 'sync';
  img.src = 'acilis.bmp';
  img.decode().then(() => { el.insertBefore(img, el.firstChild); requestAnimationFrame(raise); }, raise);
} else raise();                                   // without the window (headless, browser): the field colour only
// the line in the sign's stencil, once its font is there (no fallback face first)
document.fonts.load('20px KMAcilis').then(() => el.classList.add('yazili'), () => el.classList.add('yazili'));

function setSlit(f, seconds) {
  slit.style.transition = 'transform ' + seconds + 's cubic-bezier(.25, .6, .35, 1)';
  slit.style.transform = 'scaleX(' + Math.max(0.015, Math.min(1, f)).toFixed(3) + ')';
}

window.KM_ACILIS = Object.freeze({
  progress(f) {
    if (over || !(f > shown + 0.01)) return;
    shown = f;
    // the page's thread is held for up to ~0.9 s at a time while the pack is built (no word gets through then): each
    // word starts a glide a little past it, which the compositor plays on through the silence, slowing as it nears
    setSlit(Math.min(0.97, f + 0.12), 1.6);
  },
  end() {
    if (over) return;
    raise();                                      // before over: a picture still decoding must not keep the canvas hidden
    over = true;
    setSlit(1, 0.2);
    el.classList.add('bitti');
    const done = () => { if (el.isConnected) { el.remove(); if (host) host.postMessage('acilis-bitti'); } };
    el.addEventListener('transitionend', e => { if (e.target === el && e.propertyName === 'opacity') done(); });
    setTimeout(done, 1200);
  },
  skip() {
    over = true;
    canvas.style.visibility = 'visible';
    el.remove();
    if (host) host.postMessage('acilis-bitti');
  },
});
})();
