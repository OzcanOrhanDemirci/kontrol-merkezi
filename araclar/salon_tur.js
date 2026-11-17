// Phase 2's whole loop walked by script inside the page, through walk mode's own physics and collision: from the arch
// into the chamber, a passage, up the stair, the hatch, the roof, the jump, the fall, the landing, the hatch, down the
// stair, the other passage, back out under the gate into the hall. Injected by araclar/salon_tur.py (headless, or the
// real window over CDP); it only sets walk mode's keys and look each frame, as a player's keyboard and mouse would.
// window.__tur = { done, log: [...], path: [...], step } while it runs.
(() => {
  const km = window.__km, W = km.W, V = km.V;
  const D2R = Math.PI / 180;
  // steps: go [x, z] (run: shift held; pitch: the look's pitch while walking, deg), look [yaw, pitch] over t s,
  // hatch (open it), wait t s, fall (wait for the landing)
  const ROUTE = [
    { look: [0, 2], t: 2.0, say: 'kemer meydanı' },
    { go: [6.3, -236], run: 1 },
    { go: [6.3, -262], run: 1, say: 'kapının altından' },
    { go: [4.6, -268], run: 0 },
    { go: [4.6, -279.5], run: 0, r: 0.4 },
    { go: [10.6, -279.5], run: 0, r: 0.35, say: 'yan kapı' },
    { go: [13.1, -279.5], run: 0, r: 0.3 },
    { go: [13.1, -294.4], run: 1, say: 'dar geçit' },
    { go: [0.0, -294.4], run: 0, r: 0.3 },
    { look: [180 + 180, 8], t: 1.2, say: 'merdivenin dibi' },
    { go: [0.0, -337.5], run: 0, pitch: 14, r: 0.4, say: 'merdiven (yukarı)' },
    { look: [0, 30], t: 0.8 },
    { hatch: 1, say: 'kapak açılıyor' },
    { wait: 1.8 },
    { go: [0.0, -348.0], run: 0, pitch: 6, r: 0.5, say: 'çatıya çıkış' },
    { look: [70, 0], t: 2.5, say: 'çatı' },
    { go: [20, -336], run: 1 },
    { go: [44, -322], run: 1, say: 'kenara' },
    { look: [90, -35], t: 1.2 },
    { go: [56, -318], run: 1, pitch: -25, r: 2, say: 'atlayış' },
    { fall: 1, say: 'düşüş' },
    { wait: 1.5, say: 'iniş' },
    { go: [-3.0, -338.0], run: 1, r: 0.8, say: 'kapağa' },
    { go: [-2.0, -348.8], run: 0, r: 0.4 },
    { go: [0.0, -348.8], run: 0, r: 0.3 },
    { look: [180, -35], t: 1.2 },
    { hatch: 1, say: 'kapak açılıyor' },
    { wait: 1.8 },
    { go: [0.0, -340.0], run: 0, pitch: -18, r: 0.4, say: 'merdiven (aşağı)' },
    { go: [0.0, -294.6], run: 0, pitch: -10, r: 0.4 },
    { go: [-13.1, -294.4], run: 0, r: 0.3, say: 'öbür geçit' },
    { go: [-13.1, -279.5], run: 1, r: 0.3 },
    { go: [-10.6, -279.5], run: 0, r: 0.35 },
    { go: [-4.6, -279.5], run: 0, r: 0.4 },
    { go: [-4.6, -268], run: 0, say: 'oda' },
    { go: [-6.3, -262], run: 1 },
    { go: [-6.3, -236], run: 1, say: 'kapının altından salona' },
    { go: [-2.0, -205], run: 1, say: 'salon' },
    { look: [0 + 180, 4], t: 3.0 },
    { look: [360, 4], t: 3.0, say: 'son' },
  ];

  const from = window.__turFrom || null;          // tests: start at step from.i, put at from.put [x, foot, z]
  const T = window.__tur = { done: false, i: from ? from.i : 0, log: [], path: [], stuck: [], t0: performance.now() };
  if (!W.active) W.enter({ noLock: true });
  if (from && from.put) W.debug.put(from.put[0], from.put[1], from.put[2]);
  let st0 = null, sT = 0, stuckT = 0, lastP = null, lastLog = 0, fallSeen = false;
  const say = m => { const s = W.state(); T.log.push({ t: +((performance.now() - T.t0) / 1000).toFixed(2), m, x: +s.x.toFixed(2), foot: +s.foot.toFixed(2), z: +s.z.toFixed(2) }); };
  const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  let yaw = W.state().yaw, pitch = W.state().pitch;
  function turnTo(ty, tp, dt, rate) {                // a player's mouse: a smooth turn, never a snap
    const dy = wrapA(ty - yaw), k = 1 - Math.exp(-dt / 0.35);
    yaw += Math.sign(dy) * Math.min(Math.abs(dy), Math.max(Math.abs(dy) * k, 0), (rate || 2.2) * dt);
    pitch += (tp - pitch) * k;
    W.debug.look(yaw, pitch);
  }
  let prev = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
    const s = W.state();
    if (now - lastLog > 100) { lastLog = now; T.path.push([+((now - T.t0) / 1000).toFixed(2), +s.x.toFixed(2), +s.foot.toFixed(2), +s.z.toFixed(2), s.grounded ? 1 : 0, T.i]); }
    const step = ROUTE[T.i];
    if (!step) { W.debug.keys({}); T.done = true; say('bitti'); return; }
    if (st0 !== step) { st0 = step; sT = 0; stuckT = 0; lastP = [s.x, s.z]; if (step.say) say(step.say); }
    sT += dt;
    let next = false;
    if (step.look) {
      W.debug.keys({});
      turnTo(step.look[0] * D2R, step.look[1] * D2R, dt, 1.2);
      next = sT >= step.t;
    } else if (step.wait) {
      W.debug.keys({});
      next = sT >= step.wait;
    } else if (step.hatch) {
      W.debug.keys({});
      V.setOpen(true);
      next = true;
    } else if (step.fall) {
      W.debug.keys({});
      if (!s.grounded) fallSeen = true;
      if (fallSeen && s.grounded) { fallSeen = false; say('indi: ' + JSON.stringify(V.state ? V.state().lastFall || null : null)); next = true; }
      if (sT > 90) { say('düşüş 90 sn bitmedi'); next = true; }
    } else if (step.go) {
      const [tx, tz] = step.go, dx = tx - s.x, dz = tz - s.z, d = Math.hypot(dx, dz);
      if (d < (step.r || 0.8)) next = true;
      else {
        const want = Math.atan2(dx, -dz);
        turnTo(want, (step.pitch || 0) * D2R, dt, 2.2);
        const ahead = Math.abs(wrapA(want - yaw)) < 0.6;
        W.debug.keys(ahead ? { w: 1, shift: step.run ? 1 : 0 } : {});
        // stuck: no progress for 5 s
        if (Math.hypot(s.x - lastP[0], s.z - lastP[1]) > 0.5) { lastP = [s.x, s.z]; stuckT = 0; } else stuckT += dt;
        if (stuckT > 5) { T.stuck.push({ i: T.i, x: s.x, foot: s.foot, z: s.z }); say('takıldı'); next = true; }
        if (!s.grounded && !step.pitch && s.foot < -5) { say('dünyanın dışına düştü?'); }
      }
    }
    if (next) T.i++;
    requestAnimationFrame(frame);
  }
  say('başla');
  requestAnimationFrame(frame);
})();
