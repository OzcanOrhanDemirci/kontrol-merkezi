# Hall window: handover (11-17, ~01:35)

For a fresh project-leader session continuing tonight's hall job. Read with `docs/salon-gece-plani.md` (tonight's
plan and diagnosis), `docs/SALON.md` (design reference; "The way up" is Phase 2's architecture) and the project
notebook. Work is on local branch **`salon-gece`** in `C:/dev/kontrol-merkezi` (main folder), not yet pushed; main =
fa474c3 (pushed). Outer limit 06:30 (Özcan: "Daha erken de bitirebilirsin ... sonsuz revize döngüsüne de girmeyelim"),
final report to Jarvis by 06:15: what he will see, a 720p phone recording from the real window, a few stills, what was
measured, what is not done. Codex: its remaining weekly quota (~9 %) may be used; one Astra at a time, best as a
read-only review of a finished piece before an expensive step.

## His five revisions (00:25 + 01:10) and their state

1. **Shimmer / blinking floor lamps / lamps "swimming" near the arch** — helper *stab* (agent a7368f56e3c926064,
   worktree `.claude/worktrees/agent-a7368f56e3c926064`) still working: energy-conserving footprint for small emitters,
   specular AA, steadier reflection, shimmer; told to judge by frame-by-frame scans and spend GPU headroom on more
   samples if analytic fixes leave any blink (Jarvis). Also told of the bloom downsample bug (post.frag PASS_DOWN
   `textureSize(uSrc, int(uLod))` with BASE_LEVEL = l-1: footprint 2^(l-1) too wide). Not merged yet.
2. **Regular hitch** — fixed and merged: sign redraws in a worker (`ui/salon/levha-isci.js`) + strip uploads
   (`setLevhaBytes`/`pumpLevha`); cadence every 3rd refresh (55 fps at 165 Hz) with animation time in whole refreshes;
   volume recombine spread over 4 frames. Real window (00:52): at rest p50 18.2 / p99 18.3 ms, no main-thread stalls;
   remaining late frames came in bursts with GPU time 23-30 ms = another GPU user (helpers' headless renders), so the
   final measurement must be on a quiet GPU. Every late frame is logged as `pencere: gec ...` in
   `%LOCALAPPDATA%\KontrolMerkezi\gunluk.txt`.
3. **Not fullscreen, long black** — merged (helper *acilis*): borderless fullscreen from the first frame, a native
   picture then an HTML loading screen ("SALON HAZIRLANIYOR", shaft light, a slit opening) handing over into the
   opening's strike; pack on its own mapped host + inflate workers; first scene frame ~3.5-3.9 s (was 9.8). Not run:
   the installed layout (Program Files, sahne\ next to exe), real taskbar click, multi-monitor/DPI. One unexplained
   #111 grey frame once in ~10 runs.
4. **Light burst on puddles** — two causes found in the 23:45 recording: a one-frame beige wash where the old lane route
   grazed a column (route removed) and the puddle reflection switching absent->full in one frame leaving the arch,
   coinciding with a hitch. Needs confirming gone in the final recording (scan frames near the arch both ways).
5. **Close collides with fan** — fixed and merged: the ÇIKIŞ sign past the CPU fan was never pickable (fan's box in
   front); fans now pick only on their disc; small near controls within 18 px. Pick map checked headless.
   Straight path to the arch: merged (`straightPath` in uygulama.js; clearance checked, ≥ 1.65 m only at the landing).

## Phase 2

- Walk mode (merged): Y toggles, WASD/mouse/Shift/Space, Escape leaves walk (does not close), collision worker from
  geo.bin, eye adaptation from a frame-luminance readback (table calibrated to the journey; re-measure after a bake:
  `araclar/salon_yuruyus.py --yalniz olcum`). Close-up weak spots reported: faceted green device lamp, plinth step
  faces streaky (light-map resolution), floor texture repeat visible, entrance under the landing near black.
  Not tried in the real window (pointer lock in WebView2 unconfirmed).
- Architecture (merged, oven): chamber doors, passages, 182-riser stair (~32 s), hatch `kapak` (dinamik), raised block
  on 8 columns to y -604, roof deck y 35, roof lamp pit over the shaft, mast lamp; exterior = materials `dis_*`.
  Preview bake `.tmp/paket-on2` (ts 4/256, 11 min; Fanlar/arch views unchanged). **Final bake running since 01:40 as a detached process (salon.exe, pid 34256)**
  into `.tmp/paket-son2` (ts 2.5, 1024, stair lamps ×2), log `.tmp/gece/bake-son2.log` (+ `.err`), ~60-65 min, done ~02:45. After it:
  `python sahne/araclar/paket_e5.py .tmp/paket-son2`, then it replaces `sahne/paket` (keep the old one as
  `.tmp/paket-eski`), `dotnet build -c Release --no-incremental` copies it to bin\Release\sahne.
- Void, hatch, fall and loop — helper *bosluk* (agent aa49ccaff5f95de23) working on the preview pack; report due by
  04:30 at the latest. If it is not at the bar, ship walk mode inside the hall only and say the outside is not done.

## Helpers at the restart

Both running helpers were asked at 01:40 to commit and write a status file in their own worktree:
`.claude/worktrees/agent-a7368f56e3c926064/.tmp/stab-durum.md` (stability, branch worktree-agent-a7368f56e3c926064)
and `.claude/worktrees/agent-aa49ccaff5f95de23/.tmp/bosluk-durum.md` (void/loop). Continue each with a new helper
briefed from that file and its branch (merge salon-gece into it first). Branches already merged: the walk, oven and
opening worktrees (agent-a1f831a…, agent-abe74550…, agent-aa285b9…): those worktrees can be cleared.

At 01:43 both had committed (stab: 4d0359d on worktree-agent-a7368f56e3c926064; void: 87222f6 on
worktree-agent-aa49ccaff5f95de23) and written their status files; the void helper's distant-lamp pan test was still
running and is lost with the restart (rerun it).

## Tools made tonight

`araclar/salon_dizi.py` (headless frame sequences), `araclar/salon-denetim.ps1 -Hz 165` (real-window check, recording
rate), `.tmp/gece/sunum.py` (presented-frame intervals; unreliable at slow camera speed), `.tmp/gece/sicrama.py`
(single-frame jumps), `.tmp/gece/sorgu.py` (run a JS file in the headless page; env EK, PAKET).
Real-window rule: `.tmp/pencere.lock` (name + time) before any real-window run; while it exists helpers do no GPU work.
Özcan's installed window was closed (by itself or a helper, before 00:49); reopen it at the end
(`C:\Program Files\KontrolMerkezi\KontrolMerkezi.exe`). The install itself is his (Kurulum.cmd + UAC) in the morning.

## To finish

1. Merge stab when it reports; check its numbers and crops; real-window run on a quiet GPU (no helpers rendering):
   journey both ways, frame scans, pacing log.
2. Final pack in, rebuild, Phase 2 merge if at the bar, walk-mode check in the real window (pointer lock, Escape).
3. Optional: Codex Astra read-only review of the merged diff (`git diff fa474c3..salon-gece -- ui src`) before the
   final build.
4. Final recording (720p phone copy), stills, report to Jarvis; land on main + push (memory-helper can do it),
   notebook via memory-helper, clear worktrees (`node C:/dev/jarvis/scripts/worktree-clean.mjs C:/dev/kontrol-merkezi`),
   reopen his window.
