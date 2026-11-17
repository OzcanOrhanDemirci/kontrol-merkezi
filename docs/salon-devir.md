# Hall window: state after the night of 11-17 (~03:45)

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

Phase 2: walk mode (Y; WASD, mouse, Escape leaves walk) checked in the real window (pointer lock holds in WebView2);
chamber, passages, 182-riser stair, hatch, roof with the lamp pit, the void with facilities on columns, the 35.6 s
fall and the wrap: headless only (2560x1440, scale 2.5: outside 4.6-4.7 ms).

## Not done / not checked

- The roof, the void and the fall were never seen in the real window (no way to place the walker there from outside).
- Presentation: the 165 fps recording shows ~7 % of intervals as 4+2 refresh pairs, the same at rest as in motion;
  capture jitter or real late presents can only be told apart with PresentMon, which needs administrator rights.
- The installed layout (Program Files) and a real taskbar click; multi-monitor and DPI.
- Look questions for Özcan: the stair lamps read as bright white globes (he described faint lamps); the roof is sparse.
- Phase 2 decisions he has not seen: the fall brakes to ~6 m/s and is carried onto the roof below; the hatch shuts
  behind you (the wrap needs it); our whole stack shows our lamp colour; homogeneous fog; masts vanish beyond ~700 m.

## Tools

`araclar/salon-denetim.ps1 -Bolum acilis|yolculuk|yuruyus|fanlar|sicaklik|hepsi -Hz 165` (real window; no longer
maximizes, which dropped the borderless fullscreen to the work area), `araclar/salon_kipirti.py` (steadiness
sequences), `araclar/salon_disari.py` (the void), headless timing as in `ui/salon/README.md`.
