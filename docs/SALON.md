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
| Entrance gallery | x ∈ [-12, 12], y ∈ [0, 20], z ∈ [-44, 0]. Back wall z = 0 with the tunnel mouth we came out of (5.2 × 4.4 m from the deck, 5 m deep, closed by a bulkhead with a door). |
| Landing | steel platform, deck at y = 3.0, z ∈ [-6, 0], x ∈ [-5, 5], railing, stair (16 risers of 187.5 mm, 270 mm goings, 2.4 m wide) down towards -z to z = -10.3. |
| Fans | one per side wall, axis along ±x, centre (±12, 8.5, -24), Ø 10 m, in a square recess (14.4 m, on the formwork grid) 2.5 m deep, the barrel continuing 2 m into the duct. Left = CPU + case, right = GPU. |
| Fan boards | beside each fan on the portal side (the wall between the landing and the fans is outside the fanlar frame): a 5.7 × 3.5 m cabinet (face 5.4 × 3.2 m) on brackets, its wall end at z = -32.8, turned 35° towards the landing; the warning plate under it, the lever box on the wall below its wall end, the stencilled identity on the wall above it. |
| Ceiling shaft | opening in the gallery ceiling, x ∈ [-5, 5], z ∈ [-36, -26], a concrete well up to y = 33.5 above it, a steel grate in the opening (resting at y = 20.3). Light enters at the well's top, falls slanted 10° towards -z. |
| Gallery portal | the gallery's far end z = -44 opens into the hall through a portal 24 m wide, 20 m tall with a two-step frame standing out of the hall's front wall (the gallery is a frame within the frame). |
| Hall | x ∈ [-30, 30], y ∈ [0, 26], z ∈ [-275, -44]. Drainage channels along both walls (\|x\| 27.6..28.2), pilasters (1.6 × 1 m) at the column lines carrying the beams, a catwalk on the left wall at y = 12 with a caged ladder at its start, a door with a lit frame off the catwalk at z = -150, pipe runs. |
| Columns | 2 m (x) × 7 m (z) × floor to ceiling, a flared foot (3.1 × 8.1 m at the floor) and a haunch at the top, rows at x = ±8 and ±22, every 20 m from z = -60 to -220 (36 columns), ending ~35 m before the arch to leave it a plaza. The aisle x ∈ [-7, 7] is free: the camera flies through it. Cross beams (1.2 × 2 m) over the column lines z = -60 .. -240, lighter beams (1 × 1.2 m) along the rows. |
| Arch | monument: face z = -256 on a plinth (top y = 1.2, steps), 26 m wide, 24 m tall (to y = 25.2), 10.6 m deep; opening 14 m wide, 18 m tall (half-round, springing y = 12.2, crown 19.2), the reveal 4.3 m deep; the light chamber behind it (x ±8.6, to y = 20.6, back wall z = -266); keystone display (4.0 × 1.6 m) at y = 22.65. End wall z = -275. |

Views (the builder writes them; the renderer interpolates):
- `fanlar`: eye (0, 4.65, -3.0), looking at (0, 7.5, -60), vertical FOV 50°.
- `rgb`: eye (0, 5.5, -227.5), looking at (0, 13.4, -258): the arch centred, filling the frame's height; FOV 50°.
- `yol`: the journey's centre line, a polyline of points between them every ~2 m (in the aisle, height 4.6-7.5 m),
  rising first over the landing's railing; at least 1.5 m from any geometry (checked by `sahne/araclar/geo_onizle.py`).

## Light groups

Light is baked per group, in white. Live colour of group g is `C_g · k_g` (linear RGB times an intensity).

| id | name | sources | live colour |
|---|---|---|---|
| 0 | `kuyu` | the ceiling shaft's emitter (a horizontal rectangle at the well's top whose normal slants 10° towards -z, lobe 6) | the temperature colour (`isik.onizleme`, the colour the case shows or would show), always; intensity animates in the opening |
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
- `levha`: a face that carries a live-drawn texture (signs, boards, displays): its uv0 runs 0..1 over the face (u from
  the face's left to its right, v from its top to its bottom, as a canvas is drawn, seen from the side its normal
  faces), its uv2 is in metres like every chart's, and the anchor names the atlas rect. Round lenses (`mercek`) map
  their square.

The albedo the baker bounces with is the material's mean linear albedo (computed from the texture the way the renderer
decodes it: sRGB → linear, mean over the texture).

## The pack (baker → window)

Folder `sahne/paket/` in development (git-ignored, large), installed next to the exe as `sahne\`. The window host serves
it on the page's own origin under `/sahne/` (WebResourceRequested; a second virtual host would be cross-origin for
fetch and WebGL textures). Files are little-endian. Every binary is written as a zlib stream (miniz, level 6) with
the suffix `.z` (`geo.bin.z`, `lm_0.bin.z`, ...); the window reads it through `DecompressionStream('deflate')` (zlib
format, not raw deflate, not gzip). `salon.exe ... --compress 0` writes them plain (`.bin`), for debugging; the names in
`sahne.json` are always the files as written. The materials' textures are copied beside the pack under their
`sahne/varlik` paths (the pack is all the window reads). `salon.exe geo` writes everything but the light files (no
`lm_*`, the volumes' `dosya` null). The same inputs give the same bytes in every binary (`sahne.json` carries the time).

### `sahne.json`

```json
{
  "surum": 1,
  "olusturuldu": "2026-11-16T20:00:00Z",
  "firin": { "ornek": 2048, "hacimOrnek": 2048, "seken": 8, "sure_sn": 412, "ortam_sigma": 0.012, "ortam_g": 0.35,
             "texelOlcek": 1, "filtre": true, "sinir": [1.56, 0.24, 0.28] },
  "malzemeler": [ { "ad": "beton_kolon", "albedo": "doku/concrete_wall_008_diff_2k.jpg", "normal": "...", "arm": "...",
                    "isimaDoku": null, "uvOlcek": 2.0, "renk": [1,1,1], "puruz": null, "metal": null, "bayrak": [],
                    "grup": null, "isima": 0, "ortalamaAlbedo": [0.31, 0.30, 0.29] } ],
  "geometri": { "dosya": "geo.bin.z", "kose": 1234567, "ucgen": 2345678,
                "araliklar": [ { "malzeme": 0, "sayfa": 0, "ilk": 0, "sayi": 36000 } ] },
  "dinamik": [ { "ad": "fan_kasa_rotor", "dosya": "rotor_fan_kasa_rotor.bin.z", "kose": 1000, "ucgen": 2000,
                 "merkez": [-11.2, 8.5, -24], "eksen": [1, 0, 0], "yaricap": 4.9, "kanat": 7, "gecirgenlik": 0.6,
                 "araliklar": [ { "malzeme": 5, "ilk": 0, "sayi": 6000 } ] } ],
  "isikHaritasi": { "dosya": ["lm_0.bin.z", "lm_1.bin.z"], "genislik": 8192, "yukseklik": 8192, "sayfa": 2,
                    "gruplar": 3, "dolgu": 2, "texel": 23456789 },
  "hacimler": [ { "ad": "salon", "dosya": "vol_salon.bin.z", "boyut": [120, 52, 470], "alt": [-30, 0, -276],
                  "hucre": 0.5 } ],
  "isiklar": [ { "grup": 0, "tur": "dikdortgen", "merkez": [0, 32, -31], "u": [5, 0, 0], "v": [0, 0, 5],
                 "normal": [0, -1, 0], "parlaklik": 1.0, "kosUs": 6.0 },
               { "grup": 2, "tur": "kure", "merkez": [-5, 7, -19], "yaricap": 0.21, "parlaklik": 200 } ],
  "gorunumler": { "fanlar": { "goz": [0, 4.65, -3], "hedef": [0, 7.5, -60], "fov": 50 }, "rgb": { }, "yol": [[0,5,-6], ...] },
  "capalar": [ { "ad": "fan_kasa", "tur": "tik", "kutu": { "merkez": [...], "x": [...], "y": [...], "z": [...] } },
               { "ad": "tabela_rgb", "tur": "levha", "atlas": "tabela_rgb", "boyut": [3.2, 1.1], "kutu": { } } ]
}
```

(Field names are Turkish because they end up next to the UI's code; the meaning is in this table.)

| field | meaning |
|---|---|
| `firin` | how it was baked: samples per texel and per cell, bounces, seconds, the medium, the texel scale, the filter, the firefly clamp per group (`sinir`, one path's luminance) |
| `malzemeler` | materials in id order (a draw range's `malzeme` indexes this list). `bayrak`: `emissive`, `noOcclude`, `wet`, `levha`, `metal`, `twoSided` (glTF doubleSided: draw without culling). `isima` = emitScale, `isimaDoku` = a model's emissive texture (sRGB) or null; `puruz`/`metal` null: from the ARM texture |
| `geometri` | the static mesh: vertex and triangle counts, and draw ranges by (page, material); `ilk` and `sayi` count indices |
| `dinamik` | moving meshes in their own frame, placed live at `merkez`/`eksen`: the rotors (centred at the origin, axis +x) and the levers `kol_kasa`, `kol_gpu`, `kol_rgb` (origin at the hinge, x the hinge axis). The own frame maps to the world as x → `eksen`, y → world up made perpendicular to it, z → x × y; a lever's mesh is built at rest (handle up), the window turns it about x; `gecirgenlik` = the share of light the spinning rotor let through in the bake; its draw ranges by material |
| `isikHaritasi` | the light map atlas (pages × width × height texels, `dolgu` texels of padding round each chart) and its files, one per page; `texel` = baked texels (null from `geo`) |
| `hacimler` | baked light in the air: axis-aligned grids (`alt` = lower corner, `hucre` = cell size) |
| `isiklar` | the emitters (for reference and for live analytic highlights). `dikdortgen` (half axes `u`, `v`, perpendicular) and `disk` (`u` = a radius vector): radiance `parlaklik` along `normal`, falling as cos^(kosUs-1) (intensity cos^kosUs: 1 = Lambertian; a shaft's crisp beams need thousands, see "The oven"); `kure`: radiance `parlaklik`, `yaricap` |
| `gorunumler` | the two views and the journey's centre line |
| `capalar` | anchors: things the window needs to find (click boxes, sign faces, displays, lamps, lever hinges); `kutu` is an oriented box (centre, three half-axes); a moving part's `nokta` anchor (`kol_*`) also carries its hinge, `mentese` and `eksen` (the scene's `Anchor::pivot`, `axis`) |

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

Material id and light map page are per draw range (`araliklar`: `malzeme`, `sayfa`, first index `ilk`, index count
`sayi`): triangles are sorted by (page, material), vertices in the order the sorted triangles first use them (a range's
vertices are contiguous). A procedural surface stores uv0 in metres; a model's uv0 is its glTF uv (origin at the
image's top left, `uvOlcek` = 1).

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

### The oven (`sahne/firin`, `salon.exe bake`)

Method from pc_graphics' Denizaltı oven, extended. What the window can count on, and what the scene builder needs to know:

- **Charts.** The builder leaves each vertex's chart-local coordinates in metres in `uv2` (the kit's `grid` copies its
  surface coordinates there; `importModel` unwraps a glTF with xatlas into charts in metres). The atlas gives every chart
  `texelFor(d) × texelScale` metres per texel, d = its distance to the journey and the two eyes, shelf-packs them on
  pages, and overwrites `uv2`. A chart larger than a page at its density is made coarser to fit (printed).
- **Emitters.** Rectangles and discs are sampled two ways in one-sample MIS: by area and by their lobe. A shaft's
  emitter as large as the well's top with a lobe of thousands casts the grate's bars crisp (the test room: 4 × 4 m,
  lobe 10000, half intensity at 0.7°, bars sharp on the floor 12 m below); a lobe of ~6 cannot, whatever the emitter's
  size: its beams are soft by geometry.
- **Two passes.** Pass 1, 32 samples of direct light per texel: from it the firefly clamp per group (2 × the 99.9th
  percentile of the surfaces' direct outgoing radiance) and the secondary lights: the directly lit texels as emitters,
  picked by power (equal share per group), sampled at every path vertex in MIS with the path. A pool of light from the
  shaft lighting a gallery by its bounce is 1 % of the hemisphere; without them the test room's walls were speckled at
  1024 samples (12.8/255), with them 0.78/255.
- **Texels inside parts.** Where two parts meet flush (a wall piece under the next, a wall on the floor) the rounded strip
  along the joint is narrower than a texel and shaded from the texel of the hidden face. A texel whose centre is inside
  a part is moved, before its samples, to a point within its footprint in open air (printed: "moved out of a part");
  deeper inside it stays black (hidden). Without it every joint was a black line.
- **Back faces end paths**, two-sided materials too (a glTF `doubleSided` prop is usually closed; walked as two-sided,
  paths wandered inside its pieces and the bake stopped being deterministic).
- **Samples** spread over the texel's footprint (the cell's volume); a 5 × 5 edge-keeping filter inside each chart
  (`--filter 0` turns it off); the padding filled from the chart's own texels; NaN/Inf counted and zeroed.
- **Launches** about 40 ms each (the card is Özcan's desk; the driver's watchdog is 2 s), GPU memory under 6 GiB.
- **Determinism:** every random number is a hash of the texel's (cell's) index and the sample's: the same inputs give
  the same bytes, and the first N samples of a bake with more are the bake with N (nested).
- **Measured on the test room** (`salon.exe bake --test 1`, 1.67 M texels on 4 pages of 1024², two volumes of
  0.40 M cells in all; RTX 4080): 256 samples 4.0 s, 1024 samples 12.4 s. Noise, as the standard deviation in 8-bit sRGB after
  AgX of a texel's outgoing radiance, each group alone at its own exposure (key 0.18): filtered, at 1024 samples group 0
  (the shaft, all of the room but the pool lit by its bounce) 0.78/255, groups 1 and 2 0.16 and 0.14/255; under
  0.5/255 from about 2000-2500 samples for group 0 and 100 for the others (from 256 against 1024, and 1024 against
  4096: 0.70/255 at 1024, 0.35/255 at 4096; 4096 samples took 46 s). Unfiltered: 1.9, 0.47, 0.39/255 at 1024.
  The hall's shaft lights a gallery the same way: bake it at 2048-4096.

### The medium

The baker attenuates every path segment with exp(-σ·d), σ = `ortam_sigma` (homogeneous). The live haze uses the same σ
times a live density field ρ(x, t) ≥ 0 (1 on average; more near the fans and in their jets, swirled by the rotors'
speed). Single scattering only live; the baked M, F already contain the light the air receives.

## The scene builder (`sahne/firin/src/scene/hall*.cpp`)

The hall is built in code at real measures with the geometry kit (`kit/geom.h`, every edge rounded) and the hall's own
helpers (`scene/hall_kit.h`: formwork faces with seams and tie holes, lofted concrete outlines, railings, chains of real
links, caged lamps, levha faces, anchors). One file per place: `hall_gallery.cpp`, `hall_fans.cpp`, `hall_nave.cpp`,
`hall_arch.cpp`, `hall_signs.cpp`; `hall.cpp` adds the views, the journey and the volumes. The emitters' radiance is one
table at the top of `hall_kit.h`, one value per emissive material so a surface seen directly glows as bright as the
emitter that lights (`kuyu_isik` 1.0, `kemer_isik` 2.0, `cam_lamba` 8.0; the dim lamps along the hall's walls have smaller
bulbs).

Formwork seams (12 mm deep rounded grooves on 1.2 × 2.4 m panels) are geometry on the gallery's walls, ceiling and well,
and on the inner rows' aisle faces within ~60 m of the gallery, where the tie holes (3 cm cone recesses, two by four per
panel) are geometry too; everywhere else they are the textures' matter (small regular grooves far away would shimmer).

What is built: 2.46 M static triangles in 5.5 k light map charts. The gallery 0.13 M, the fans 0.38 M (bell-mouths,
grilles, motors), the hall 1.56 M (the six tie-hole faces 0.8 M of it), the arch 0.22 M, the hanging signs 0.17 M (their
chains); the rotors 37 k and 43 k triangles, the levers 3 k each. Anchors (40): `fan_kasa`, `fan_gpu`, `git_rgb`,
`git_fanlar`, `cikis_1`, `cikis_2`, `anahtar_rgb` (tik); `boya_*`, `pano_*`, `uyari_*`, `tabela_rgb`, `tabela_fanlar`,
`cikis_1`, `cikis_2`, `kilit_tasi_ekran`, `durak_plaka_0..5`, `plaka_rgb`, `cihaz_aio|klavye|gpu` (levha); `kol_kasa`,
`kol_gpu`, `kol_rgb`, `durak_0..5` (cold to hot from lower left to lower right), `lamba_aio|klavye|gpu` (nokta).
Volumes: `salon` 0.5 m (122 × 69 × 563 cells), `kuyu` 0.15 m (70 × 224 × 117; 0.1 m was 6.1 M cells, ~290 MB), `fan_kasa`, `fan_gpu` 0.2 m
(63 × 66 × 70 each), `kemer` 0.25 m (120 × 104 × 92).

`salon.exe dump --out DIR` writes the scene as plain binaries + JSON; `python sahne/araclar/geo_onizle.py DIR` renders the
views headless (plain shading with back faces in magenta and levha faces as a uv checker, and a direct-light preview)
and checks the journey's clearance. It is the builder's check, not the product.

### What the renderer assumes of the pack

- uv0 is GL-style, v up (the renderer does not flip images; the normal map's green follows +v). A levha face's uv0
  runs 0..1 in canvas order: u to the right as seen from the front, v = 0 at its top edge (the builder's convention,
  `hall_kit.h`; the live canvas is uploaded unflipped).
- A levha-flagged material may be shared by many faces: the renderer gives each triangle to the smallest `levha` or
  `nokta` anchor box holding its centre. So every sign, board, display and lamp lens needs an anchor box around its
  face (lamp lenses: a `nokta` anchor named as `setLamp` will call it), and boxes of different faces must not overlap.
- Hover: a `tik` box lifts the levha/nokta anchors whose centres it contains (and the one of its own name).
- A rotor's blur disc uses its main material as constants (`ortalamaAlbedo` x `renk`, `puruz`, `metal`).
- Files may be `.gz` (gzip) or `.z` (zlib deflate).

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

As built (`ui/salon/README.md` has the API and the measured costs): the volumes are recombined with the groups'
colours into one texture per volume whenever a colour moves (four reads per haze step instead of six; the per-group
clamp of Ls becomes one clamp of the sum); the reflection is drawn at half the scene pass' resolution and only below
the horizon, its haze through the outer volume at double steps; bloom starts from the scene composited at the haze's
resolution; the light map's B-spline read is applied to plane A only (plane B, the direction, stays bilinear); the
rotor is its crisp mesh when slow and the analytic disc when fast, crossfaded.

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
