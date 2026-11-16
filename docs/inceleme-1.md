# Hall integration review 1

Reviewed `salon-inceleme` at `8cc784c`, 2026-11-16. Read-only review of the app, sign painter and scene builder against `docs/SALON.md`, `docs/PROTOKOL.md`, the renderer contract in `.tmp/codex/3-render.md`, and `main:ui/uygulama.js`. No implementation changes. Findings are ordered by severity within each section. P1 means fix before accepting the integration; P2 means a visible defect or integration risk; P3 means cleanup or a smaller regression. Art items are recommendations, not instructions to change the approved design without the lead's decision.

## Bugs

### B1 — P1: normal service states throw out of the frame loop

**Locations:** `ui/uygulama.js:209`, `ui/uygulama.js:212`, `ui/uygulama.js:239`, `ui/uygulama.js:203`; `ui/salon/levha.js:488`, `ui/salon/levha.js:529`, `ui/salon/levha.js:824`.

The producer passes protocol states straight to a painter that uses a different vocabulary:

| Input | App sends | Painter accepts instead | Result |
|---|---|---|---|
| fan maximum | `max` | `en_yuksek` | throws |
| GPU automatic | `oto` | `kart` | throws |
| fan unknown | `bilinmiyor` | `bilgi_yok` or a distinct unknown state | throws |
| starting/disconnected/no fan snapshot | `yok` | `bilgi_yok` | throws |
| device absent or disconnected | `yok` | `bagli_degil` | throws |

`bios`, `geciyor`, `baska`, and device `bagli` / `hata` / `kilitli` are accepted. A normal BIOS/automatic snapshot therefore fails on `pano_gpu`; startup before the snapshot fails on `pano_kasa`. `frame()` calls `step()` before scheduling the next rAF (`ui/uygulama.js:520`, `:528`), with no exception boundary: this stops animation, rather than merely omitting one label. The load-time catch does not cover it. `putLevha()` also stores the cache key before drawing succeeds, so a later kick can skip the failed texture.

**Fix:** define one explicit adapter/schema shared by app and painter, including unknown versus disconnected semantics. Update the cache only after successful draw/upload. Exercise the complete state table through the real painter before enabling the normal frame loop; do not turn all unknown states silently into a misleading connected state.

### B2 — P1: accepted states still lose their telemetry and warnings

**Locations:** `ui/uygulama.js:206`, `:225`, `:238`, `:259`, `:264`, `:266`, `:268`; `ui/salon/levha.js:547`, `:598`, `:728`, `:780`, `:811`, `:836`.

Independent of B1, most payload fields do not match:

| App payload | Painter reads | Concrete failure |
|---|---|---|
| fan `satirlar`, `ipucu` | `sicaklik`, `fanlar:[{ad,rpm}]`, `yuzde`; generates its own hint | `bios`, CPU 47.5, CPU_FAN 817 → temperature and every RPM show dashes; GPU power is also lost |
| warning `{metin,tur}` | `{uyari}` enum | admin false + unavailable, Afterburner fan control, other-program control, or disconnection → a blank warning plate |
| display `ort` | `ortalama` | a valid averaged temperature → `--,-` |
| stop `c` | `derece` | valid thresholds → dashes |
| RGB `beklemede` | `bosta` | switch on but idle → no wake-on-input explanation |
| device error `metin` | `hata` | a specific service error → generic `CİHAZ HATASI` |

`kullanilabilir:false` and `neden` themselves match and will disable the command; the surrounding state may still crash under B1. CPU/GPU values on the keystone do match, including null. Device `ad` is never forwarded, losing the service-provided names.

**Fix:** pass the documented raw fields, translating fan names with `RPM_AD`, and explicitly map warnings. Add a starting-service warning variant: the current painter only knows disconnected, not `SERVİS BAŞLATILIYOR`. Preserve a connected-but-unknown fan state rather than treating it as a dead service and suppressing otherwise valid telemetry. For stop degrees, also replace `Math.round(d.derece)` at `levha.js:780` with Turkish formatting that retains fractions: the current real service's 80.5 °C stop must read `80,5°`, not `81°`.

### B3 — P1: the hall floor maps 31 different surfaces onto the same light-map texels

**Locations:** `sahne/firin/src/scene/hall_nave.cpp:47`, `:50`, `:51`; `sahne/firin/src/scene/hall_kit.cpp:294`, `:802`.

Every floor patch computes UV relative to its own corner. `floorPlane()` then relabels all patches as one chart without moving those UVs into a shared world plane. The CPU dump confirms chart 1684 contains **31 triangles covering UV (0.23, 0.19)** at distinct world points, including approximately `(-27.37,0,-44.19)`, `(-27.37,0,-89.79)` and `(-27.37,0,-149.79)`.

**Failure:** one baked texel cannot hold the gallery-side floor lighting, a middle bay's shadow and arch-side spill simultaneously. A bake will overwrite/alias those positions, repeating or misplacing illumination across the main wet floor. Correct `uv2 = uv` alone does not prevent this.

**Fix:** give all these floor vertices common planar metre coordinates, e.g. `(world.x, -world.z)`, before merging the chart, or keep/pack separate charts. Check chart overlap, not only that a triangle's three vertices share a chart.

### B4 — P1: required text is too small at the only usable camera positions

**Locations:** `sahne/firin/src/scene/hall_fans.cpp:297`, `:322`; `sahne/firin/src/scene/hall_arch.cpp:208`, `:234`, `:282`, `:294`; `ui/salon/levha.js:62`, `:66`, `:497`, `:614`, `:831`; `sahne/firin/src/scene/hall.cpp:87`.

The painter was designed for different physical sizes/aspect ratios. A square 2048² fan board is stretched onto 5.4 × 3.2 m; a 4:1 keystone texture goes onto 4 × 1.6 m; device plates designed as 4 × 1 m become 1.1 × 0.4 m. This distorts lettering before perspective is applied.

CPU projection at the specified **2560 × 1440, 50°** endpoint views gives:

| Face | Projected centre width × height |
|---|---|
| fan board | 217 × 155 px |
| fan warning | 64 × 24 px |
| keystone | 199 × 71 px |
| stop plates | 35–37 × 13–14 px |
| device plates | 75 × 30 px |

A fan board's seven-dot main glyph body is only about **6.4 px high** (84/2048 of its height). A device title's nominal 128 px font becomes at most 7.4 px high, before width-fitting the long device name; warning text is smaller still after fitting. Stop colour names are around 2–3 px high. `fanlar_geo.jpg`, `rgb_geo.jpg`, and the close-ups confirm that the useful controls are small relative to the architecture. A 2× render cannot recover letters below the final display's pixel budget. There is no closer interactive inspection position.

**Fix:** design the physical faces, texture layout and viewing distance together. Move the control cabinets/console into a readable foreground position while retaining the distant fans/arch, or increase the faces and simplify/reflow their text. Preserve texture aspect ratios. Verify actual Turkish text at final window size, including a long `neden` and error string, before baking. This is a functional readability issue, not a request for more texture resolution.

### B5 — P1: clicking the GPU control leaves Enter bound to the case fans

**Locations:** `ui/uygulama.js:356`, `:388`, `:411`, `:417`, `:248`; compare `main:ui/uygulama.js` hot-control pointerdown and `renderMod()`.

The previous pointerdown set `M.focus = i`; the new pointerdown does not. Starting at focus 0, click the GPU fan and then press Enter: the keyboard toggles **case fans**, not the last clicked GPU control. Arrow-key selection also has no visible indication: text hover and renderer hover use only `M.hover`, never `M.focus`.

**Fix:** update focus on pointer activation and give keyboard selection an in-world highlight through the existing board/lamp/hover mechanism, with a clear policy for pointer versus keyboard focus. Verify case → GPU → RGB selection with both input methods.

### B6 — P2: fan levers pull through their boxes and the wall

**Locations:** `ui/uygulama.js:191`; `sahne/firin/src/scene/hall_fans.cpp:158`, `:164`, `:337`, `:338`.

The agreed local frame is x = hinge, y = up, z = out of the wall. A negative rotation about x sends the upright blade toward **negative z**, into the wall. With `durum:max`, the local handle centre `(0,.55,.36)` at angle -1.05 becomes approximately `(0,.586,-.298)`. The hinge is only .09 m outside the box face, so this is about .21 m behind that face. The blade itself penetrates farther. The same sign also makes the RGB lever lean away from the viewer.

**Fix:** use the outward pull's positive angle, or deliberately change the rest frame/mesh and document it. Check the entire sweep against the box, contacts and wall, not only the zero-angle preview.

### B7 — P2: the lever spring is unstable at frame intervals the app allows

**Locations:** `ui/uygulama.js:188`, `:189`, `:190`, `:518`.

The explicit velocity/position update is unstable with `dt=.1`, which the frame loop explicitly permits. CPU execution of the actual `stepLevers()` from rest, with case state `max`, produces `M.lever.kol_kasa = -2,215,423,863.84` after 30 such steps (three simulated seconds). At sustained low cadence it keeps growing; intermittent long frames can cause a large visible kick.

**Failure:** a slow GPU/presentation period makes the lever spin wildly and eventually risks non-finite transforms, contrary to the no-jitter requirement.

**Fix:** substep the spring at a stable interval (e.g. <= 1/120 s), or use an analytic damped-spring update. Do not clamp the whole world's elapsed time merely to hide a spring integration error.

### B8 — P2: the keystone receives sRGB bytes where it expects linear colour

**Locations:** `ui/uygulama.js:262`; `ui/salon/levha.js:90`, `:726`, `:752`; `ui/renk.js` `toSrgb()`.

`M.col.temp` is already linear 0..1, but the app converts it to byte-valued sRGB. The painter clamps each component to 0..1. Temperature colour `[120,200,255]` therefore arrives as byte values and becomes `[1,1,1]`: a white display while the room is blue. Partially saturated colours also lose their hue.

**Fix:** pass `M.col.temp` directly. Keep byte sRGB only at the protocol boundary; renderer group and lamp calls already use the correct linear convention.

### B9 — P2: loss of service is reported as RGB off, with stale devices/temperatures

**Locations:** `ui/uygulama.js:136`, `:182`, `:261`, `:264`, `:267`, `:320`; `ui/salon/levha.js:798`.

After a valid on/connected snapshot, `baglanti:yok` leaves `D.durum` intact. The RGB plate marks **KAPALI**, because `rgbOn()` folds connection status into the switch state; its extra `bagli` field is ignored. Device labels still say **BAĞLI**, CPU/GPU readings remain stale, and fan levers can remain in their old max position. Only device lamp intensity is gated by the connection. The useful disconnected warning is back at the gallery (and currently blank under B2). The old RGB panel explicitly showed `Bilgi yok` and the connection reason.

**Fix:** model telemetry validity separately from RGB off. Pass `acik:null` for unknown, show a connection/startup explanation at the current location, and invalidate or visibly mark stale device and sensor data. Do not claim that disconnected hardware was turned off.

### B10 — P2: fixed six-stop geometry does not match the actual service palette

**Locations:** `ui/uygulama.js:266`, `:273`, `:275`; `sahne/firin/src/scene/hall_arch.cpp:25`, `:216`; supporting source `src/Isik/Ayarlar.cs:41`.

The real defaults are **five visible stops** (52, 58, 64, 74, 80.5), and service settings can include hidden blend stops. The app compacts visible stops onto indices 0..N-1, but the arch always has six fixed lamp/plate pairs. With today's five stops, red lands at `durak_4`, short of the lower-right end; `durak_5` has no plate update at all. If a prior snapshot had more visible stops, removed entries retain old textures/lamp values because they are never cleared. With more than six, `putLevha` silently drops extra labels while `setLamp` is called with nonexistent anchors.

If all temperature readings become null, `M.temp` retains the last reading (or the initial 40), so lamps still advertise a valid temperature even when the numerical display should be unknown.

**Fix:** agree a layout for the actual visible-stop count, use the full arc from cold to hot, explicitly clear unused slots, and gate the temperature marker on valid telemetry. Preserve hidden stops for palette interpolation, not display. Update SALON.md's stale six-stop assumption together with the chosen geometry/app contract.

### B11 — P2 integration risk: duplicate exit anchor names cannot form a lossless by-name map

**Locations:** `sahne/firin/src/scene/hall_gallery.cpp:226`, `:227`; `sahne/firin/src/scene/hall_arch.cpp:316`, `:317`.

Each exit has two entries named `cikis_1` / `cikis_2`, one `levha` with atlas/material/size and one `tik` without those fields. The specified renderer API exposes anchors **by name**. A straightforward last-wins map loses the levha metadata; first-wins loses the click type/box. Calls need both `setLevha('cikis_1',...)` and `pick()` → `'cikis_1'`.

**Fix:** give click anchors distinct names and map them in `ACTIONS`, or explicitly specify a composite/multi-entry anchor representation in the renderer contract. This is a confirmed contract ambiguity; its actual renderer symptom cannot be asserted before that renderer is merged.

### B12 — P2: some analytic arch-strip light samples lie inside the concrete

**Locations:** `sahne/firin/src/scene/hall_arch.cpp:150`, `:168`, `:172`.

The curved strip at radius 6.975 m is approximated by 12 tangent rectangles. A rectangle's half-length is `6.975*sin(pi/24)`, so its ends have radius about **7.034 m**, beyond the 7.0 m opening. The light surface is only 6.975..7.005 m radially, and the concrete reveal starts at 7.0 m. A significant end portion of each analytic emitter therefore samples from inside the reveal instead of on the luminous strip. Visibility-tested direct light is spuriously blocked there; permissive intersection offsets could instead leak it.

**Fix:** sample the actual curved emitting surface, or use sufficiently fine inward chord segments with their area and normal matched to the luminous geometry. Keep the intentional shaft lobe tilt separate: that tilt is specified and is not this defect.

### B13 — P3: degenerate triangles survive the builder's sanity checks

**Locations:** `sahne/firin/src/scene/hall_kit.cpp:516`; `sahne/firin/src/scene/hall_fans.cpp:120`; `sahne/firin/src/scene/hall.cpp:107`; supporting `sahne/firin/src/kit/geom.cpp:562`.

The dump contains **157,304 static** triangles with doubled area below 1e-10 m², plus 1,218/1,286 in the two rotors and 238/238/272 in the levers. Collapsed pole/centre rows (including tie-hole bottoms) generate zero-area halves of grid cells. The current checks only test finite vertex values and chart membership; `finishMesh` does not remove them.

**Failure/risk:** these primitives do not draw useful geometry, consume processing, and are invalid input to unguarded normalized face-normal or barycentric calculations in the forthcoming baker. No NaN or visible inversion was observed in this dump, so this is not evidence that the current preview is already broken.

**Fix:** emit triangle fans at collapsed rows, or remove zero-area triangles before the bake/pack stage and retain the index/range invariants.

## Missing behaviour

### M1 — P2: no window minimize action remains

**Location:** `ui/uygulama.js:330`, `:397`, `:406`; compare `main:ui/uygulama.js`'s `#win button` handler and `main:ui/index.html`'s `data-cmd="minimize"`.

The old window had a minimize button. The replacement exposes close via exit/Escape and maximize via double-click, but never sends `minimize`. A user trying to minimize from inside the window has lost that operation.

**Fix:** provide an agreed in-world or keyboard minimize control and a discoverable Turkish hint. This is a product placement decision for the lead, not permission to add a conventional overlay.

### M2 — P2: several explanatory texts from the old RGB page have no destination

**Locations:** `ui/uygulama.js:264`, `:268`; `ui/salon/levha.js:811`, `:817`; compare `main:ui/uygulama.js` `renderRgb()`.

Even after fixing B2, the painter has no field for `beklemeDakika` or the locked-build explanation. `kilitli:true` now says only **KİLİTLİ**, losing **bu derlemede karta yol yok**. Idle no longer explains the configured idle duration; the explanation that CPU/GPU temperatures are averaged and smoothed into colour, including continued calculation while off, is absent too.

**Fix:** place these explanations on readable plates/current-location displays, including actual device names. Distinguish a deliberately inaccessible GPU build from a temporary device problem.

### M3 — P3: simulation help and the old performance ledger were removed

**Locations:** `ui/uygulama.js:421`, `:497`, `:534`; compare `main:ui/uygulama.js` F1 handler, simulator startup help population and `updateOverlay()` ledger.

Simulator shortcuts still exist, but F1 no longer reveals their Turkish list. The visible `3 DÜĞME` / rays-per-second / samples ledger has no replacement; host perf logging is not equivalent to something the user sees. Rays/s is understandably no longer the right measurement for a baked renderer, but the brief says existing shown behaviour must not disappear silently.

**Fix:** restore development help outside the installed product as appropriate; have the lead decide whether to retire the ledger or replace it with meaningful hall-render costs in-world. Do not display invented path-tracing statistics.

## Art

These observations come from the supplied geometry JPGs, not a final textured/baked render. Orange emissive fills, UV checkers, anchor wire boxes and debug magenta edges are preview conventions, not proposed final art. Recommendations below concern silhouette, staging and readable hierarchy.

### A1 — highest visual impact: the arch reads as a civic triumphal gate / game portal

**Locations:** `sahne/firin/src/scene/hall_arch.cpp:51`, `:70`, `:83`, `:97`, `:190`.

**Evidence:** `rgb_geo.jpg`, `yakin_kemer_alt_geo.jpg`, `yakin_kemer_ust_geo.jpg`. Cornices, rusticated pylons, framed panels, a conspicuous keystone and symmetric door pair make the endpoint classical and ornamental. The single uninterrupted luminous opening encourages a portal reading. This is a silhouette issue even though the preview orange is not final shading.

**Proposed change:** retain the approved monumental arch, dimensions and display, but simplify the ornamental bands into thick cast-concrete lifts and construction joints; recess the display in a service housing. Give the light chamber visible depth and a restrained structural/service interruption if the lead wants a less portal-like image. A heavy hydraulic opening with credible steel lining will connect to the hall's engineering more directly than decorative pilaster panels. Do not replace the arch outright: it is an explicit part of SALON.md.

### A2 — the middle reads as a narrow repeated corridor more than a vast reservoir

**Locations:** `sahne/firin/src/scene/hall_nave.cpp:17`, `:102`, `:158`; `sahne/firin/src/scene/hall.cpp:32`; `ui/uygulama.js:91`.

**Evidence:** `yol_25_geo.jpg`, `yol_50_geo.jpg`, `yol_75_geo.jpg`. The two inner column rows and perfectly centred sightline hide much of the other rows, producing nested identical doorway frames. The scale exists in metres, but the picture reveals relatively little lateral volume.

**Proposed change:** keep the aisle safe, but consider a small, smooth lateral reveal in the middle journey/look direction so the outer columns briefly separate in silhouette. Keep the low viewpoint and huge plain structural masses. In the final lighting, let a few side bays emerge through distance haze and retain large quiet concrete areas; avoid lighting every bay equally or solving scale with extra props. Any camera/path change needs renewed clearance checks. This is a staging recommendation, not a defect in the current spline.

### A3 — controls need the foreground authority of a physical menu

**Locations:** `sahne/firin/src/scene/hall_fans.cpp:285`, `:328`; `sahne/firin/src/scene/hall_arch.cpp:238`; `ui/salon/levha.js:504`, `:831`.

**Evidence:** `fanlar_geo.jpg`, `yakin_pano_gpu_geo.jpg`, `rgb_geo.jpg`, `yakin_kol_geo.jpg`. Cabinets on brackets, conduits, caged lamps and the knife-switch are good physical cues. From the actual views, however, their controls are tiny labels attached to giant scenery; the fan boards resemble small widescreen monitors. This weakens the Metro-menu intent and causes B4.

**Proposed change:** put the user's working controls in a readable, lamp-lit foreground and let the machinery supply the depth behind them. Make one clear hierarchy: state first, temperature/RPM second, reason/action third. Keep the heavy lever and real mounting/conduit details. Reflow the board around its actual aspect ratio, and favour engraved/enamel labels plus concentrated indicator light over uniformly glowing monitor faces.

### A4 — surface history should follow water and construction, not uniform distress

**Locations:** `sahne/firin/src/scene/hall_nave.cpp:54`, `:102`, `:246`; `sahne/firin/src/scene/hall_gallery.cpp:97`; `ui/salon/levha.js:158`.

**Evidence:** `yakin_kalip_geo.jpg`, `yakin_kolon_geo.jpg`, `yakin_kanal_geo.jpg`, `yakin_kuyu_geo.jpg`, `yakin_gecit_geo.jpg`. The ties, drainage channels, catwalk and human-scale doors already make the structure credible. The broad repeated masses need coherent material history; indiscriminate noisy grunge would make the hall cheap and would fight the no-sparkle requirement.

**Proposed change:** use low-frequency waterlines at column feet, downward mineral streaks beneath joints/shaft edges, dampness towards drains, and localized rust below metal fixings. Preserve dry, relatively quiet upper concrete. Keep these variations baked/static, with real material roughness and appropriate mip filtering. Judge this after real textures and light are present; the flat geometry preview cannot establish the final material quality.

## Checks that passed, and limits

- Compiled `sahne/firin/build.bat` successfully and ran only `salon.exe dump --out .tmp/review-dump` (CPU). Result: 2,459,718 static triangles, 5,516 charts, 37 lights, 40 anchors, 113 path points, five dynamic meshes, 8,304,174 volume cells. Assets were absent in this worktree, so this dump used constant material fallbacks. No bake, renderer, installed app, pipe, GPU job or hardware command was run.
- Inspected all supplied `fanlar_geo.jpg`, `rgb_geo.jpg`, `yol_25/50/75_geo.jpg` and the sixteen `yakin_*_geo.jpg` images under `C:/dev/kontrol-merkezi/.claude/worktrees/salon-sahne/.tmp/dump/onizleme/`. They establish geometry/staging, not final light, text, antialiasing or motion quality.
- CPU checks over static and dynamic dump meshes found no non-finite position/normal/UV values and no triangles crossing chart IDs. Among nondegenerate triangles, none had a face normal opposing the averaged vertex normal by more than the 0.01 cosine tolerance. This does not prove watertightness or absence of internal intersections. All non-levha static vertices obey `uv2 = uv`; dynamic `uv2 = 0` is intentional. Levha quad UV orientation and metre-valued UV2 agree with the documented convention. B3 is a separate chart-overlap problem.
- Every one of the app's 20 possible text names exists in `KM_LEVHA.sizes` and as a levha anchor. All seven action names, two rotors, three levers and the nine possible lamp names exist. Exit names have the B11 collision. Click boxes have nonzero axes and cover the intended control areas. Actual occlusion-aware picking/hover could not be verified without the renderer; the API specifies anchor-box picking, not mesh occlusion.
- Renderer calls use the specified methods, argument order and names: camera, groups, rotors, levers, levha, lamps, haze, exposure, hover, render, pick, resize and stats. `S.ready` is an app-owned flag set after the create promise resolves, not a required renderer property. `/sahne/` follows SALON.md's same-origin requirement. There is no implementation of `salon.js` here to validate uploads, lens association, shadowing, motion blur or disposal. B8 is the painter's colour contract, not a misuse of `setGroup`.
- Executed the actual app journey functions in a Node VM with DOM/audio stubs, using the CPU dump's views/path. The 24-sample-per-segment arc table measured **224.922162 m** and reproduced both eyes exactly. Full trips reached the exact endpoint in 10.20–10.53 simulated seconds at fixed dt 1/60, 1/33, 1/30, 1/15 and 0.1; velocity never reversed on an uninterrupted trip. Reversals at 1/3/5/7/9 seconds at 30 Hz each changed velocity sign once and settled exactly at the starting endpoint, with no oscillation. The position clamp prevents leaving [0,total]; in more pathological timing it can clip velocity-driven movement at a boundary rather than guarantee a continuous physical stop. No such failure occurred in these cases.
- Look direction is position-dependent, so reversing does not flip the camera. On this long path the start/end blend regions do not overlap; the near-end upward `ahead` direction is suppressed by the endpoint weight. Sampled pitches were finite and continuous (2.862° at Fanlar, 14.521° at RGB). No endpoint look snap was found. Uniform Catmull-Rom is actually used in both builders; the C++ comment saying “centripetal enough” is not a different parameterization. The current resampled path is well behaved.
- CPU triangle-distance checks of both the supplied polyline and the app's resampled spline found **1.65 m** minimum clearance, at the landing eye. The coarse volume contains the full path; fine volumes cover the specified shaft/fan/arch regions. Rest drift can lower the landing eye by .07 m, still leaving 1.58 m above the deck. The maximum arbitrary drift magnitude is .175 m, so a complete swept-camera clearance check remains appropriate if geometry/path/drift is changed; no GPU preview of the moving camera was made.
- Emitter radiance constants match their material `emitScale` values (1/2/8), rectangles use metre half-axes and spheres use metre radii. Shaft normal is a unit vector tilted 10° toward -z as specified; the chamber faces into the opening. The curved-strip approximation is B12. Baked/live emission equality and the actual darkness level are unverified.
- RGB-off logic does retain temperature-coloured embers (shaft .07, arch additive .06), dims service lamps to .7 and adds .8 exposure stops. The opening's two-stage shaft rise and delayed arch rise are deterministic. Whether silhouettes, exits and controls remain readable requires the actual bake and renderer, especially because self-lit boards/exits have their own emission independent of group fades.
- Pacing retains refresh-aligned scheduling and GPU-time hysteresis. The new `floor(33.33/refresh)` target intentionally gives 30 fps at 60 Hz and 33 fps at 165 Hz; it is **not a strict maximum of 30 fps**, despite the comment. Initial `k=3` persists for the first 60 rendered frames, so startup is 20 fps at 60 Hz or 55 fps at 165 Hz before adapting. Initialize from the pre-load refresh estimate if the target must apply during the opening too. With GPU timing available, `PACE.recent` is continually appended but not drained because the GPU branch returns early; cap/clear that unused history. No real frame cadence or GPU timing was measured.
- Read all painter strings: Turkish dotted/dotless I, accents, case conversion and number formatting are generally correct; no spelling defect requiring a separate finding was found. The dot-matrix font explicitly carries Turkish glyphs. Wrong/missing *meaning* is covered above, including fractional thresholds. Painter noise is name-seeded integer hashing, caches are keyed by data, and draw resets canvas state: no clock or `Math.random()` source was found in `levha.js`. Pixel-for-pixel Canvas determinism and real font rendering were not exercised. Simulator/audio randomness outside the reviewed painter is not evidence of visual noise in the installed hall.

Memory handoff: record that this review found integration blockers and is **not** visual acceptance of the new window. The report and commit are the durable record; no memory files were changed.
