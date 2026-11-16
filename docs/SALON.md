# Kontrol Merkezi: the underground hall ("salon")

Internal design note (English). Everything the user reads in the app is Turkish. This file is the single reference for
everyone building the new window: the scene, its coordinates, the baker, the data pack between them, the live renderer
and its equations. If code and this file disagree, fix one of them in the same change.

## What it is and why

The window is one diegetic 3D scene: a colossal underground hall in the manner of Tokyo's flood-discharge "underground
cathedral" (G-Cans): massive concrete columns in rows receding into haze, a very high ceiling, dark. There is no UI
layer: every control and every text is an object in the world (stencilled plates, hanging steel signs, boards, a
digital display in the arch). Two places, the camera travels between them:

- **Fanlar** (start): we stand on a steel landing at the back of the entrance gallery. Giant industrial fans are built
  into the gallery's side walls, left CPU + case, right GPU. Their identity is told by stencil paint and plates on the
  machinery. A dim light falls from a shaft in the ceiling in front of us onto the floor between the fans. Beyond the
  gallery's far portal the hall opens: columns fading one by one into haze, and at its end a giant arch glowing in the
  temperature colour, a silhouette through the haze.
- **RGB** (arrival): clicking the RGB sign flies the camera ~250 m through the hall: from the dim entrance into the
  darker middle (dark from distance, never pitch black), the light growing as we approach. Arriving, the arch is centred
  and fills the screen, bright; the temperature reads on a digital display in its keystone.

The scene is still. Only the camera moves (slow steady drift at rest, the journey between the places), the fan rotors
turn by their real state, the haze moves with the fans' strength, and light colours follow the temperature.

Light is baked offline (path tracing with OptiX, the Denizaltı method) in white, linear HDR, per light group, and tinted
live: light transport is linear in emission. Live parts (rotors, moving haze, wet-floor reflection, sign texts) use the
same shading model, colour space and tonemap and read the same baked data, so nothing looks pasted on.

## Coordinates and units

Right-handed, metres, **x right (facing the arch), y up, z towards the camera**: the hall runs along **-z**. Floor at
y = 0 (the gallery's and hall's floor). z = 0 is the entrance gallery's back wall.

Layout (first version; the builder owns the exact numbers and writes them into the pack):

| Part | Extent |
|---|---|
| Entrance gallery | x ∈ [-12, 12], y ∈ [0, 20], z ∈ [-44, 0]. Back wall z = 0 with the tunnel mouth we came out of. |
| Landing | steel platform, deck at y = 3.0, z ∈ [-6, 0], x ∈ [-5, 5], railing, stair down towards -z. |
| Fans | one per side wall, axis along ±x, centre (±12, 8.5, -24), Ø 10 m, in a recess 2.5 m deep. Left = CPU + case, right = GPU. |
| Ceiling shaft | opening in the gallery ceiling, x ∈ [-5, 5], z ∈ [-36, -26], a concrete well 12 m tall above it, a steel grate in the opening. Light enters at the well's top, falls slightly slanted towards -z. |
| Gallery portal | the gallery's far end z = -44 opens into the hall through a portal 24 m wide, 20 m tall (the gallery is a frame within the frame). |
| Hall | x ∈ [-30, 30], y ∈ [0, 26], z ∈ [-275, -44]. |
| Columns | 2 m (x) × 7 m (z) × floor to ceiling, rows at x = ±8 and ±22, every 20 m from z = -60 to -240 (40 columns). The aisle x ∈ [-7, 7] is free: the camera flies through it. |
| Arch | monument at z ≈ -258, opening ~14 m wide, ~18 m tall, overall ~26 × 24 m; the light chamber behind its opening; keystone display at the top of the opening. End wall z = -275. |

Views (the builder writes them; the renderer interpolates):
- `fanlar`: eye (0, 4.65, -3.0), looking at (0, 7.5, -60), vertical FOV 50°.
- `rgb`: eye (0, ~6, ~-232), looking at the arch's centre so it fills the frame; FOV 50°.
- `yol`: the journey's centre line, a polyline of points between them (in the aisle, height 4-8 m).

## Light groups

Light is baked per group, in white. Live colour of group g is `C_g · k_g` (linear RGB times an intensity).

| id | name | sources | live colour |
|---|---|---|---|
| 0 | `kuyu` | the ceiling shaft's emitter | the temperature colour (`isik.onizleme`, the colour the case shows or would show), always; intensity animates in the opening |
| 1 | `kemer` | the arch: the light chamber behind its opening, emissive strips in the arch | the temperature colour when RGB is on (`isik.cikis`); when off, a faint ember of the temperature colour (the arch is the RGB) |
| 2 | `lamba` | small fixed service lamps (caged wall lamps, the board lamps) | fixed warm white, constant |

**RGB off** (Özcan, 11-16: "silüet karanlığı yani zifiri değil estetik karanlık [...] kapalı olmasının getirdiği bir
tekinsizlik"): the whole hall sinks slowly into a darkness you can still see in: shaft and arch fall to a faint ember of
the temperature colour, the service lamps (a little dimmer) keep columns, fans and arch readable as silhouettes, the
exit signs and the switch's pilot lamp stay findable, the exposure half adapts.

The temperature colour comes from the service's palette maths (`ui/renk.js`, which mirrors `src/Isik/Renk.cs`); the
scene uses the linear values.

## Materials

A material is a row in `sahne.json`: a Poly Haven texture set (2K: albedo sRGB, normal (GL convention), ARM = AO,
roughness, metal) or a constant, a uv scale (metres per texture repeat for procedural geometry; models use their own
uv), and flags:

- `emissive: g`: the surface glows with light group g's colour (`emitScale` × C_g k_g). The baker treats it as part of an
  emitter and terminates paths on it.
- `noOcclude`: not in the baker's ray structure (stencil decals, sign faces that are only paint) but still gets its
  texels baked at its position.
- `dynamic`: not in the static mesh (rotors); lit from the volumes.
- `wet`: the floor; reflections from the planar reflection pass, wetness mask from the texture and a puddle mask.
- `levha`: a face that carries a live-drawn texture (signs, boards, displays): its uv0 runs 0..1 over the face, and the
  anchor names the atlas rect.

The albedo the baker bounces with is the material's mean linear albedo (computed from the texture the way the renderer
decodes it: sRGB → linear, mean over the texture).

## The pack (baker → window)

Folder `sahne/paket/` in development (git-ignored, large), installed next to the exe as `sahne\`. The window host serves
it on the page's own origin under `/sahne/` (WebResourceRequested; a second virtual host would be cross-origin for
fetch and WebGL textures). Files are little-endian. Large binaries may be gzip-compressed (`.gz`); the window reads
them through `DecompressionStream('gzip')`.

### `sahne.json`

```json
{
  "surum": 1,
  "olusturuldu": "2026-11-16T20:00:00Z",
  "firin": { "ornek": 2048, "seken": 8, "sure_sn": 412, "ortam_sigma": 0.012 },
  "malzemeler": [ { "ad": "beton_kolon", "albedo": "doku/concrete_wall_008_diff_2k.jpg", "normal": "...", "arm": "...",
                    "uvOlcek": 2.0, "renk": [1,1,1], "puruz": null, "metal": null, "bayrak": [], "grup": null,
                    "ortalamaAlbedo": [0.31, 0.30, 0.29] } ],
  "geometri": { "dosya": "geo.bin", "kose": 1234567, "ucgen": 2345678,
                "araliklar": [ { "malzeme": 0, "ilk": 0, "sayi": 36000 } ] },
  "dinamik": [ { "ad": "fan_kasa_rotor", "dosya": "rotor_kasa.bin", "kose": 1000, "ucgen": 2000,
                 "merkez": [-11.2, 8.5, -24], "eksen": [1, 0, 0], "yaricap": 4.9, "kanat": 7 } ],
  "isikHaritasi": { "dosya": ["lm_0.bin", "lm_1.bin"], "genislik": 8192, "yukseklik": 8192, "sayfa": 2,
                    "gruplar": 3, "texel": 23456789 },
  "hacimler": [ { "ad": "salon", "dosya": "vol_salon.bin", "boyut": [120, 52, 470], "alt": [-30, 0, -276],
                  "hucre": 0.5 } ],
  "isiklar": [ { "grup": 0, "tur": "dikdortgen", "merkez": [0, 32, -31], "u": [5, 0, 0], "v": [0, 0, 5],
                 "normal": [0, -1, 0], "parlaklik": 1.0, "kosUs": 6.0 } ],
  "gorunumler": { "fanlar": { "goz": [0, 4.65, -3], "hedef": [0, 7.5, -60], "fov": 50 }, "rgb": { }, "yol": [[0,5,-6], ...] },
  "capalar": [ { "ad": "fan_kasa", "tur": "tik", "kutu": { "merkez": [...], "x": [...], "y": [...], "z": [...] } },
               { "ad": "tabela_rgb", "tur": "levha", "atlas": "tabela_rgb", "boyut": [3.2, 1.1], "kutu": { } } ]
}
```

(Field names are Turkish because they end up next to the UI's code; the meaning is in this table.)

| field | meaning |
|---|---|
| `malzemeler` | materials in id order (the vertex's material id indexes this list) |
| `geometri` | the static mesh: vertices, indices, and per-material draw ranges (triangles sorted by material) |
| `dinamik` | moving meshes in their own frame (rotor: centred at origin, axis +x), placed live at `merkez`/`eksen` |
| `isikHaritasi` | the light map atlas (pages × width × height texels) and its files, one per page |
| `hacimler` | baked light in the air: axis-aligned grids (`alt` = lower corner, `hucre` = cell size) |
| `isiklar` | the emitters (for reference and for live analytic highlights) |
| `gorunumler` | the two views and the journey's centre line |
| `capalar` | anchors: things the window needs to find (click boxes, sign faces, displays, fan pivots); `kutu` is an oriented box (centre, three half-axes) |

### `geo.bin` and rotor files

Header: `uint32 magic 'KMG1', uint32 vertexCount, uint32 indexCount, uint32 stride (= 40)`, then vertices, then
`uint32` indices.

Vertex (40 bytes):

| offset | type | content |
|---|---|---|
| 0 | float32 × 3 | position (m, world; rotor files: own frame) |
| 12 | int16 × 4 snorm | normal xyz, w unused |
| 20 | int16 × 4 snorm | tangent xyz, w = bitangent sign (±32767) |
| 28 | float32 × 2 | uv0 (material uv; procedural surfaces: metres / `uvOlcek` is applied in the shader, so store metres) |
| 36 | uint16 × 2 unorm | uv2 (light map, 0..1 in the page); rotors: 0 |

Material id and light map page are per draw range (`araliklar`: `malzeme`, plus `sayfa`): triangles are sorted by
(page, material). A procedural surface stores uv0 in metres; a model's uv0 is its own (`uvOlcek` = 1).

### Light map pages `lm_<page>.bin`

Header `uint32 magic 'KML1', uint32 width, uint32 height, uint32 groups`, then for each group two planes, each
width × height texels, row 0 = top of the page (uv2.v = 0):

- plane A, RGBA16F: **L0** = ∫ L(ω) Y0 dω per channel (rgb), alpha = the openness within 0.5 m (cosine-weighted
  visibility, 0..1; same in every group, used for grime and specular occlusion).
- plane B, RGBA8 unorm: **L1 direction** of luminance: xyz = 0.5 + 0.5 · L1/|L1| , w = |L1| / (Y1/Y0 · lum(L0)) clamped
  to 0..1 (1 = all light from one direction).

L(ω) is the incoming radiance at the texel from direction ω (ω points towards where the light comes from), white
emitters of radiance `parlaklik`, Y0 = 0.282095, Y1 = 0.488603. Indirect light included (all bounces). The live
irradiance for normal n (shading normal, after the normal map):

```
lum0 = dot(L0, (0.2126, 0.7152, 0.0722))
L1   = dir * w * (Y1/Y0) * lum0                // luminance L1 vector
E(n) = π·Y0·L0_rgb  +  (2π/3)·Y1·dot(L1, n) · (L0_rgb / lum0)     clamped ≥ 0.1·π·Y0·L0_rgb
```

and diffuse out = albedo/π · Σ_g C_g k_g E_g(n). Edge texels are dilated into the padding (bilinear reads never mix in
empty texels).

### Volumes `vol_<name>.bin`

Header `uint32 magic 'KMV1', uint32 nx, ny, nz, uint32 groups`, then per group two RGBA16F grids (x fastest, then y,
then z):

- grid M: rgb = mean radiance M = (1/4π) ∫ L(ω) dω, a = 1 if the cell centre is in open air, 0 if inside geometry.
- grid F: xyz = F = (1/4π) ∫ lum(L(ω)) ω dω (luminance flux direction vector), w unused.

So L(ω) ≈ M + 3·F·ω (luminance; colour from M). Uses:
- haze in-scatter towards the camera along a view ray of direction r (from the eye into the scene), Henyey-Greenstein to
  first order: `Ls = M + 3·g·dot(F, r)·(M/lum(M))`, clamped ≥ 0; g = `ortam_g` (0.35).
- irradiance for live surfaces (rotors): `E(n) = π·M + 2π·dot(F, n)·(M/lum(M))`.

Several volumes may exist (the whole hall coarse; finer ones around the shaft, the fans and the arch). The renderer
samples the finest volume that contains the point (blending across the inner volume's last cell).

### The medium

The baker attenuates every path segment with exp(-σ·d), σ = `ortam_sigma` (homogeneous). The live haze uses the same σ
times a live density field ρ(x, t) ≥ 0 (1 on average; more near the fans and in their jets, swirled by the rotors'
speed). Single scattering only live; the baked M, F already contain the light the air receives.

## The live renderer (`ui/`, WebGL2)

Frame (2560 × 1440 the reference):

1. **Scene pass** into an RGBA16F target at the supersampling scale s (2 × 2 default: 5120 × 2880; s is a setting,
   chosen by measurement) with depth. Forward shading: material textures (texture arrays of 2048² layers, mips,
   anisotropic 16x), light map (bilinear; bicubic B-spline where a texel spans > 2 screen pixels), GGX specular from the
   light map's L1 direction as a dominant light (roughness widened by the lobe's spread 1 − w), and for metals and the
   wet floor the reflection term. Rotors: their geometry rotated by the live angle; angular motion blur over the frame's
   exposure analytically in the blade-coverage function so a spinning fan never strobes.
2. **Reflection pass** (floor, y = 0 mirror): the scene drawn mirrored at half scale, its own haze from the coarse
   volume, blurred into a mip chain; the floor reads it by roughness (screen-space distortion from the normal map).
3. **Haze pass**: per pixel at half resolution, ray-marched from the eye to the pixel's depth through the volumes with
   fixed (not random) steps: fine inside the shaft and arch volumes, coarser elsewhere; density ρ(x, t) from a tiled 3D
   noise texture advected by the fans. Output: in-scattered light (rgb) and transmittance (a). Joint-bilateral upsample
   by depth.
4. **Composite**: `scene · T + inscatter`, then bloom (small, energy-preserving), exposure (by the camera's position along
   the journey, eased), tonemap (AgX), resolve the supersampling with a Lanczos-2 downsample, sRGB, blue-noise dither
   ±0.5/255 (static).

No TAA, no FXAA/SMAA, no random numbers at run time: every pixel the same samples every frame.

Frame pacing: the existing pacer in `ui/uygulama.js` (measured refresh, frame k refreshes after the running one, the
scene pass split into flushed bands). The cadence is capped at ~30 fps (Özcan, 11-16: "2K da 30 fps yeterli"; no free
movement, only the camera's own paths): at 165 Hz every 5th refresh (33 fps), so a frame may use ~21 ms of GPU (the
pacer keeps median × 1.3 + 2 ms under the period). Budget above that goes to quality (supersampling, haze steps), not
frame rate. Even cadence, no hitch. Not a licence for waste (his words: "optimizasyona önem verildiği halde 2K 30 [...]
gerçekten kaliteye gitsin. Takıntı yapmadan."): every pass is timed, needless work removed, then the freed time is spent
on quality; no endless performance chase.

## Interaction

Picking: a ray from the camera through the mouse, tested against the anchors' boxes (`tur: "tik"`). Hover makes the
object's own lamp or paint catch the light (a small emissive or albedo lift), the cursor turns into the hand. Clicks
send the same commands as today (`fan-kasa`, `fan-gpu`, `rgb`), and the journey runs between the two views.

The texts the app shows today all exist in the world:
- each fan: its board on the wall beside it (state: EN YÜKSEK / BIOS / KART OTOMATİĞİ / GEÇİYOR / BAŞKA PROGRAMDA;
  rpm of each real fan, the CPU or GPU temperature, the press hint), a stencilled identity on the fan's housing
  (İŞLEMCİ · KASA, EKRAN KARTI);
- the warnings: no admin (a plate with an amber lamp by the boards), Afterburner's fan control (a plate on the GPU board);
  service not connected (the boards' lamps out, a plate "SERVİSE BAĞLI DEĞİL");
- RGB at the arch: the keystone display (average temperature), the stops of the colour scale as lamps around the arch's
  inner rim with their degrees, the on/off control (a great switch at the arch's base with its plate), the three devices'
  indicator lamps with their names;
- navigation: a hanging steel sign at the gallery's portal "RGB" pointing into the hall; at the arch a sign back
  "FANLAR"; an illuminated exit sign that closes the window; the window drag zone is the top strip (invisible).

## Who builds what

| Part | Where | Owner |
|---|---|---|
| Baker and scene builder (C++/CUDA/OptiX) | `sahne/firin/` (builds `salon.exe`, needs `C:/dev/pc_graphics/third_party`) | split: core baker; scene geometry |
| Asset fetch (Poly Haven 2K textures and models) | `sahne/varlik.py` → `sahne/varlik/` (git-ignored) | assets |
| Live renderer | `ui/salon/*.js` | renderer |
| Sign, board and display textures (Canvas2D) | `ui/salon/levha.js` | signs |
| App logic (state, protocol, camera, picking) | `ui/uygulama.js` | lead |

The pack is not committed (size); it is rebuilt with `sahne/firin/build.bat` + `salon.exe bake`, and a copy of each
released pack is attached to a GitHub release of this repository.
