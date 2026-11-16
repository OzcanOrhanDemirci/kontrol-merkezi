# Hall, night of 11-17: clean and steady in motion, then Phase 2

Lead's plan, written 01:15 before the build. Özcan's revisions (00:25, his words in the notebook and Jarvis's brief):
1. the scene shimmers in motion, the small floor lamps blink, the lamps near the arch "swim"; 2. a regular short hitch
inside smooth motion; 3. not fullscreen at start, long black at the opening (wants a loading screen that belongs to
the scene); 4. a light burst on the puddles near the arch when the camera comes and goes; 5. (01:10) the close
control collides with the fan: trying to close he toggled a fan again and again. Out of revision: the camera goes
straight to the arch, not round the columns. The bar is his pc_graphics scenes, watched moving on his monitor
(2560x1440, 165 Hz). Outer limit 06:30; done when it meets the bar, no polishing loop.

## Diagnosis (evidence)

- **Hitch (2).** His window's own log (`%LOCALAPPDATA%\KontrolMerkezi\gunluk.txt`, 00:16-00:24, installed 23:44
  build): k = 5 at 165 Hz (30.3 ms p50) but p95 36-42 ms and p99 48-60 ms, i.e. ≥ 5 % of frames held 6-9
  refreshes instead of 5, and 2-14 main-thread long tasks of 55-78 ms in every 10 s, also at rest. GPU 10-12 ms, so
  the GPU is not the limit: the main thread is (sign redraws, the 23:59 build spreads them; still to be measured) and
  the cadence logic. Animation dt is the raw rAF interval, so a late frame also jumps the camera. At 33 fps a camera
  moving 38 m/s steps 1.2 m per frame: even when perfectly paced it reads as stepping.
- **Blinking lamps (1).** His screenshot (Desktop 00:22:49, 48x40 px): the floor uplights' lenses are 2-4 px bright
  rectangles; 2x2 supersampling cannot hold a sub-pixel HDR emitter (coverage 0 or 1 per sample, the tonemap
  saturates either way). Same for the 1 px bright edges of the uplit columns (specular on normal-mapped concrete with
  no specular antialiasing) and the reflection pass, which is drawn at 1 sample per canvas pixel, so every lamp's
  mirror image blinks harder than the lamp.
- **Swimming lamps near the arch (1).** Candidates: the heat-shimmer box `kemer_agiz` (screen offsets of up to ~2 px
  over everything seen through it) and the half-resolution reflection; to be separated with a frozen-time sequence.
- **Burst (4).** Found in last night's real-window recording (`.tmp/denetim/20261116-234515/kayit.mkv`):
  (a) 66.8 s, a single frame where the whole screen washes beige: the lane route grazes a column and the haze/near
  plane sees the camera inside or against it; (b) 63.9 s, leaving the arch: the puddle reflection in front switches
  from absent to full between two frames (a hard on/off of the reflection, coinciding with a frame hitch).
  Not reproduced headless at 0.0025 u steps, so it is tied to the window's frame timing or state; fixed at the cause
  and checked by scanning a new recording frame by frame for single-frame jumps.
- **Close (5).** There is no close control in the world: Escape only. He reaches for the top-right corner, which is
  the GPU fan's pick box. Every pick box gets checked against the corners and against each other.
- **Opening (3).** The window opens at 80 % of the work area; ~10 s black (WebView2 start, ~900 MB through the
  managed WebResourceRequested stream, uploads, compile).

## Route (chosen, and why)

Stay in WebView2 + WebGL2. A native renderer would give exact flip-model pacing and faster loading, but it is a
rewrite of the renderer, the signs and the interaction, and nothing measured says the browser is the limit: the GPU
does a frame in 11 ms, the hitches are main-thread stalls and our own cadence logic. Fix those, raise the cadence to
every 3rd refresh (55 fps at 165 Hz) with animation time locked to whole refreshes, and solve the small lights at
their cause (energy-conserving minimum footprint, specular antialiasing, a supersampled reflection) instead of brute
supersampling. Verified in the real window by a 165 fps desktop recording (presented-frame intervals) and frame-by-
frame scans of a slow move and the journey both ways.

## Pieces (parallel, each in its own worktree; the lead merges)

- **Lead:** pacing and main-thread stalls, the straight path, the close control and pick boxes, integration, all
  real-window measurement and the final recording.
- **stab (Claude):** renderer stability: small emitters, specular AA, reflection pass, shimmer, the burst's renderer
  side; measured with `araclar/salon_dizi.py` sequences against a scale-4 reference.
- **acilis (Claude):** fullscreen from the first instant, a loading screen in the scene's language, faster pack
  serving, measured stage by stage.
- **yuruyus (Claude):** Phase 2 walk mode (key, WASD, mouse look, collision against geo.bin), new file, few hooks.
- **dis (Claude):** Phase 2 geometry in the oven: chamber passages, the long stair, hatch, roof with the louvred
  fake-daylight lamp as the shaft's real emitter, the raised block on columns. CPU only; the lead runs the bake.
- **Later:** the void renderer (fog, instanced facilities on columns, fall and wrap) once `dis` has the exterior;
  Codex Astra as a read-only review of the finished Phase 1 before the final build.

## GPU schedule (one heavy job at a time)

01:30-03:00 Phase 1 real-window runs (no bake). ~03:00 the Phase 2 bake (texel 2.5, 1024 samples, ~60-75 min) if
`dis` is ready, else none. After it: Phase 2 integration and the final recording. If Phase 2 is not at the bar by
~05:15 it stays off main (or behind its key) and is reported as not done.
