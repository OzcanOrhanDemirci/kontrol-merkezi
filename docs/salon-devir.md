# Hall window: state after the night of 11-17 (~04:50)

The night's hall job is done and on main. Read with `docs/salon-gece-plani.md` (the night's diagnoses), `docs/SALON.md`
(design; "The way up" and "The void" for Phase 2) and the project notebook.

## What changed tonight (his five revisions + Phase 2)

1. **Steadiness.** Small emitters (lamp lenses, thin strips) drawn as energy-kept footprints (emit.vert/.frag), long
   strips depth-tested along their centre line, small lenses by a nine-point share; geometric specular AA; puddle maps
   filtered at the pixel; heat shimmer a third; supersampling 2.5 (was 2). Lamp blink peak 2nd diff max, before ->
   after: rgb dolly 0.309 -> 0.057, journey dolly 0.727 -> 0.021, rgb pan 0.215 -> 0.030; edge flicker vs the scale-4
   reference 1.38 -> 1.26 (scale 3 would be 1.12 but sits at the cadence's edge).
2. **Hitch.** Sign redraws in a worker, strip uploads that queue instead of restarting, cadence every 3rd refresh with
   animation time in whole refreshes; the first cadence is chosen from the hall, not the opening's frames. Haze at
   half its cost (a cell per step). Real window, 2560x1440 at 165 Hz: k = 3 (55 fps) the whole run, p50 18.2 ms,
   p99 <= 18.6 ms, one 30 ms frame in two minutes, GPU 8.9-12.6 ms.
3. **Opening.** Borderless fullscreen 2560x1440 from the first frame, loading screen "SALON HAZIRLANIYOR", first light
   3.9-4.5 s after start. The classic title bar that flashed for ~0.35 s on activation is gone (WM_NCACTIVATE/NCPAINT).
4. **Puddle burst.** Gone in the real-window recording: four arch trips scanned frame by frame, no single-frame jump.
5. **Close vs fan.** Fans pick only on their disc (pointer and walk mode share `pickRay`). Straight path to the arch.

Phase 2: walk mode (Y; WASD, mouse, Escape leaves walk). Since 04:40 the whole loop is walked in the real window,
fullscreen 2560x1440 at 165 Hz, recorded (`salon-denetim.ps1 -Bolum tur`): arch, under the gate, chamber, side door,
passage, back space, the 182-riser stair (~28 s up), the hatch, the roof, the jump, the fall (~33 s, the wrap at
mid-fall), the landing, the hatch, down the stair (~34 s), the other passage, out under the gate into the hall. No
stuck point, nothing walked through, nobody out of the world; 15 210 frames, every 10 s window p99 <= 18.7 ms, max
19.1 ms (the only bad window is the opening's loading second, as before).

Fixed on that walk (11-17 ~04:30):
- **The passages were black** for ~8 s (pixel value 0 on the video, also at +8 EV: the bake leaves them unlit). The
  core's light now seeps in through each side door and fades along the corridor into the back space (scene.frag
  `uSeep`), and walk mode's eye opens up to 4 EV more in a frame far darker than the journey's (yuruyus.js
  `EYE.DARK_*`; no lit place reaches that threshold). A lamp per passage in the next bake would replace both.
- **The stair lamps' white globes** were not the lens: the disc emitter sits millimetres from the cup and hood, whose
  4 cm texels took its full radiance in the bake. Within 13 cm of each lens the received light is now held to
  `lensCap` of group 0, and the lens itself shows only its own emission at 0.001 of the baked radiance (`LENS`). They
  read as faint lamps in the temperature colour; the treads keep the bake's light. No bake needed.
- **The dark arch in the 03:35 delivery stills was not a regression:** the service had been in its 15-minute idle
  since 00:52 (no real input), the LEDs fade, and the arch's light follows the LED colour (`M.col.arch`); the shaft and
  pillars do not. Code and the 02:44 bake give the accepted look (headless at 64.6 C, real window at 68 C).

## Recording in the real window: wake the lights first

The service ignores injected input (`src/Durum/Girdi.cs`), so after 15 minutes without Özcan every recording shows
the idle hall (dark arch). For a run: copy `%LOCALAPPDATA%\KontrolMerkezi\ayarlar.json`, set `beklemeDakika` to 0,
send `{"komut":"ayar-yukle"}` (from Python or bash: PowerShell 5.1 strips the inner quotes of a native argument and the
command silently fails), wait for "beklemeden çıktı" in gunluk.txt, record, then copy the file back and reload. Also
pass `-BosSure 20` when the previous run's own keys are the last input.

## Not done / not checked

- Presentation: the 165 fps recording shows ~7 % of intervals as 4+2 refresh pairs, the same at rest as in motion;
  capture jitter or real late presents can only be told apart with PresentMon, which needs administrator rights.
- The installed layout (Program Files) and a real taskbar click; multi-monitor and DPI.
- Walk mode with a real mouse and keyboard beyond the hall (the tour sets keys and look through walk mode's debug
  hooks; the physics, collision, hatch and fall are the real ones).
- Look questions for Özcan: the roof is plain and empty; the passages' light is a live fill without shadows; in idle
  the hall half dims (arch dark, shaft full) instead of the even RGB-off look.
- Phase 2 decisions he has not seen: the fall brakes to ~6 m/s and is carried onto the roof below; the hatch shuts
  behind you (the wrap needs it); our whole stack shows our lamp colour; homogeneous fog; masts vanish beyond ~700 m.

## Tools

`araclar/salon-denetim.ps1 -Bolum acilis|yolculuk|yuruyus|tur|fanlar|sicaklik|hepsi -Hz 165` (real window; no longer
maximizes, which dropped the borderless fullscreen to the work area), `araclar/salon_kipirti.py` (steadiness
sequences), `araclar/salon_disari.py` (the void), `araclar/salon_tur.py` (the whole loop: headless, `--bas` to start
at a step, or `--cdp PORT` in the real window), headless timing as in `ui/salon/README.md`.
