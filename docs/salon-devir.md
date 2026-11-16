# Hall window: handover (11-16, ~21:45)

For the fresh project-leader session that continues the hall job. Read this, the original brief (Jarvis has it), and
`docs/SALON.md` (the single design reference: layout, light groups, pack format, renderer). Work is on branch `salon`
in `C:/dev/kontrol-merkezi` (main folder); main is untouched and the installed app is still the old path-traced window.
The agent log for Özcan's Codex-vs-Claude comparison is `docs/salon-ajan-gunlugu.md` (keep adding rows).

## Özcan's decisions and words so far (all 11-16)

- Brief: one diegetic 3D scene, Tokyo flood-cathedral hall, Metro-menu mood, no UI layer, baked light tinted live by
  the temperature colour, Poly Haven 2K, no flicker or sparkle, no TAA, 30 fps steady at 2560x1440.
- Opening sequence approved: "Olur o girişi de yapabilirsin." (shaft light strikes, haze lights, 1-2 s) — built.
- RGB off: "silüet karanlığı yani zifiri değil estetik karanlık [...] kapalı olmasının getirdiği bir tekinsizlik" — built
  (whole hall sinks slowly, embers of the temperature colour, lamps keep silhouettes, eye half adapts).
- Performance: "2K da 30 fps yeterli" and "optimizasyona önem verildiği halde 2K 30 [...] gerçekten kaliteye gitsin.
  Takıntı yapmadan." — cadence capped ~30 fps (every 5th refresh at 165 Hz), passes timed.
- Codex: "1 astra + paralel claude olabilir anca" (Astra one at a time); now: Codex **gpt-6.1-sol at high** joins
  ("Müsait olduğu zaman codex sol high da bu sürece destek olsun"), as many runs as its window allows (5-hour ~89 %
  until 00:39, weekly ~90 % until 11-17 15:54; Sol costs about a third of Astra). Log each run's points and quality.
- First stills (teslim1): "Şuan genel atmosfer ve ışık daha bitmemesine göre fena değil. Yani kalite yönümüz iyi
  görünüyor. Yücelik hissi yok." Goal since then: **grandeur** (standing small in a vast, tall space).
- Puddles: "Su birikintileri atmosferi güçlendirmiş" — keep; they are true planar mirrors (verified), now with damp
  margins and floor-following outlines.
- Arch: brutalist rebuild approved ("Senin hedeflediğin daha iyi [...] Şuanki biraz fazla modern duruyor"); the opening
  must not be a flat neon panel: "düz ışık yerine fantastik veya bilim kurgu şeklinde ısınmayı temsil eden bir şey".
  Concept A, the heat core, chosen: "Evet A olsun. Kemer A ile doğal birleşsin. Yani derinlik içinde derinlikli bütüncül
  bir sahne ortaya çıkar." One architecture, one light story: hall -> arch -> chamber -> core; the core's light is the
  one source; it grows with temperature; never blows out to white.
- Tonight: "Bu akşam yatmadan bitmiş halini görmek istiyorum" / "Kaliteden ödün vermeden ne kadar hızlı olabiliyorsa
  [...] Hızlandırıcam diye kaliteyi ve doğruluğu düşürmeden hızlandıralım." Speed from parallel hands, not from
  cutting checks or scope. One heavy GPU job at a time (bakes, big headless renders); parallel work goes to code,
  geometry, CPU checks. The machine is free (he left the desk); never touch WSL asistan-sunucu / Docker.

## What exists (all merged on `salon`)

- **Oven** `sahne/firin/` (`build.bat` -> `salon.exe dump|geo|bake`): OptiX path tracer, 3 light groups in one pass,
  per-chart texel density, volumes, pack writer; chart-overlap check (warns), RGB9E5 handled in the window.
  Bake times: texel-scale 4 / 256 samples ~7 min (preview, `--out .tmp/paket-on`); texel-scale 3 / 1024 samples
  ~28 min (26 M texels, 3 pages). The window reads `sahne/paket/` (git-ignored).
- **Scene** `sahne/firin/src/scene/hall*.cpp`: gallery with landing, two giant fans (green CPU+case, blue GPU) with
  square wall boards, **two desks on the landing** (displays with the board texture + the levers), ceiling shaft with
  a heavy grate (god rays), the hall widened to x +-45, ceiling 32 m, **six column rows** (+-8, +-22, +-36) with uneven
  uplights, the journey leaving the aisle into the lane x = 15 and back, **brutalist sluice-gate arch** (40 m, gate
  raised 40 %, display in the lintel, stop lamps in rows on the piers, console with RGB lever and device plates) and
  the **heat-core chamber** behind it (30 m, four frames, ringed core, end wall opened), Poly Haven props in the gallery
  (pipes, ducts, bins, ladder), sign lamps. Views: fanlar eye (0, 4.65, -1.6); rgb eye (0, 3.0, -224) target
  (0, 13.4, -256). Clearance check: `python sahne/araclar/geo_onizle.py <dump>` (min 1.65 m).
- **Window** `ui/`: `uygulama.js` (state -> world, journey with lane yaw, picking, opening, RGB off, 30 fps pacing,
  calibrated group gains GK = [30, 12, 6], exposure along the journey, heat 0..1 from temperature driving the core's
  group 0.75x..1.45x plus 7 s breathing), `salon/salon.js` + shaders (forward scene pass at 2x supersampling, planar
  reflection, haze march, AgX, Lanczos resolve, heat shimmer in the `kemer_agiz` box), `salon/levha.js` (all Turkish
  texts: boards, keystone display, plates, signs, stencils). Host `src/Pencere/Pencere.cs` serves the pack under
  `/sahne/`; `KontrolMerkezi.csproj` copies `sahne/paket` next to the exe; `kur.ps1` replaces the old pack on install.
- **Stills tool** `python araclar/salon_kare.py --u 0,0.45,1 [--paket DIR] [--sicaklik 72] [--ek "k1=12&ev=1"]`
  (headless Edge, real GPU, simulated service; writes PNG + 1600 px JPG).

## Latest frames (look at these first)

`.tmp/kareler/teslim2/`:
- `1-giris-onizleme.jpg` (preview bake): entrance, strong; desk displays now show text but the desk lamp's highlight
  washes their upper half (lower `kDeskLampL` or aim the lamp at the lever, not the display).
- `2-orta-seritte-onizleme.jpg` (preview bake): the lane, now a forest of uplit columns with diagonal views; good.
- `3-kemer-42c.jpg` (full bake, k1 = 12): brutalist arch lit by its floods, core glowing under the gate, plates read.
- `4-kemer-72c-eski-kalibrasyon.jpg` (full bake, old k1 = 3, 72 °C): orange, too dark.
- `5-kemer-42c-onizleme.jpg` (preview bake, k1 = 12).
Earlier rounds: `teslim1/` (first stills shown to him), `r2/`, `r2k/`, `r3on/`.

## Open weak points (fix tonight)

1. **Arch light story**: the floods still light the face more than the core; the core's light should visibly pour
   out under the gate (bright tongue across the plaza floor, light on the gate's underside and the jamb faces, haze
   glow in the opening), and the face mostly lit by that. Raise `kCekirdekL` / lower `kKemerFloodL` further; check
   the console does not hide the tongue. At 72 °C it must stay legible and not flat-tinted; check that the heat
   shimmer is visible but calm (it only shows live: verify with two frames 0.1 s apart).
2. **Desk display glare** (above).
3. **Stop lamp order**: in `3-kemer-42c` the left row shows white, blue, *grey* (unlit slot) — stopSlots spreads 5
   stops over 6 lamps; check it reads as a gauge (maybe make the arch 5 lamps, or light all 6 with interpolated colours).
4. **Middle exposure** vs the arch at the end of the lane; the journey's look and speed have not been watched in
   motion yet (VMAX 38 m/s, AMAX 11): watch it in the real window.
5. Review 1 leftovers: M1 (no minimize action in the world: ask Jarvis/Özcan whether an in-world control is wanted;
   Windows taskbar click and Win+Down work), M2 (explanatory texts: idle minutes, locked-build note), M3 (dev-only).
6. Not yet verified at all: the real WebView2 window, frame pacing there, VRAM in the real window (headless showed
   ~3.9 GB for the full pack; light map now RGB9E5), the opening sequence in motion, fans max/BIOS in motion (rotor
   blur), the journey both ways, a temperature change live, RGB off look.

## Plan to finish tonight (parallel pieces)

GPU is serial: one bake or render at a time, owned by the lead. Everything else in parallel worktrees
(`git worktree add -b salon-<x> .claude/worktrees/salon-<x> salon`), merged by the lead.

- **Lead (GPU + integration)**: preview bake after each merged change set (`--texel-scale 4 --samples 256`, 7 min),
  stills, calibration (GK, exposure, kCekirdekL/kKemerFloodL), then the **final bake** (`--texel-scale 2.5 --samples
  2048 --vol-samples 1024`: estimate ~60-70 min; 3 pages) and install.
- **Claude helper A (arch light story, CPU)**: weak point 1 in `hall_arch.cpp` (emitters, under-gate glow surfaces,
  console height), check with `geo_onizle.py`; no bakes.
- **Codex Sol high run(s)** (bounded, CPU): (a) weak point 3 (stop lamps as a gauge) across `hall_arch.cpp` +
  `uygulama.js` stopSlots; (b) M2 explanatory texts on plates via `levha.js` data; (c) a second read-only review of
  everything merged since review 1 (`docs/inceleme-1.md` is the format), as the window allows. Log points per run.
- **Claude helper B (real-window check tooling)**: a script that drives the installed window for the final check:
  screenshots via `araclar/pencere-goruntu.ps1`-style capture at 2560x1440 and a screen recording with ffmpeg
  `ddagrab` (installed) of: the opening, the journey both ways, fans max and BIOS (simulate with the real service's
  buttons? no: the real service drives real fans: only toggle with Özcan's knowledge — he approved full use while
  away, the fan toggles are safe and reversible), one temperature change (dev command `onizle` on the pipe, see
  `araclar/onizle.py`; card-safety rules in the notebook still hold: `onizle` only previews colours on the devices).
- **Install**: follow the notebook's procedure (`Kurulum.cmd` / `kur.ps1`, close the window first; build with
  `dotnet build -c Release`, check the GPU-light build bytes rule in the notebook before any run that can reach the
  card). Then the real-window check, frames and video to Jarvis first, memory via memory-helper, system-watcher for
  the Claude/Codex consumption comparison, merge `salon` to main and push, clear worktrees
  (`node C:/dev/jarvis/scripts/worktree-clean.mjs C:/dev/kontrol-merkezi`).
