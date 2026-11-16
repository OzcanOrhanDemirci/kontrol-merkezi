# ui/salon: the hall's live renderer (WebGL2)

Plain scripts, no build step, no libraries. `salon.js` defines `window.KM_SALON`; the shaders are separate files next
to it, fetched at start (`common.glsl` is pasted into every fragment shader at `// COMMON`). The reference for the pack
it reads and the frame it draws is `docs/SALON.md`.

## API

```js
const s = await KM_SALON.create(canvas, {
  base: '/sahne/',              // the pack's folder (same origin as the page)
  scale: 2,                     // supersampling: the scene pass at scale x the canvas' device pixels (1, 1.5, 2, 3)
  quality: { ... },             // optional, see s.quality below
  onProgress(f, text) {},       // 0..1 and a Turkish line; on failure the error text (then nothing more)
  preserveDrawingBuffer: false, debug: false,
});
s.views                         // sahne.json's gorunumler: { fanlar: {goz, hedef, fov}, rgb: {...}, yol: [[x,y,z]...] }
s.anchors                       // sahne.json's capalar by name; s.dyn: its dinamik list; s.pack: the whole sahne.json
s.setCamera(eye, target, fovDeg)
s.setGroup(i, [r, g, b], k)     // light group i (0 kuyu, 1 kemer, 2 lamba): linear colour and intensity
s.setRotor(name, angle, omega)  // rotor angle (rad) and speed (rad/s): the frame's motion blur comes from omega x shutter
s.setLever(name, angle)         // any dinamik entry turned about its axis (eksen) at its merkez
s.setLevha(atlas, source, { emissive })   // canvas / ImageBitmap for the faces of the anchors with that atlas name;
                                // emissive 0: paint (albedo blend by alpha), > 0: a display (linear radiance scale)
s.setLamp(anchorName, [r, g, b], k)       // the self-lit lens inside that anchor's box
s.setHaze({ density, fans: [{ name: 'fan_kasa', strength }] })   // strength 0..1; fan = dinamik name + '_rotor'
s.setExposure(ev)               // stops
s.setHover(tikName | null)      // lifts the levha/lamp faces whose anchors sit inside that tik box (eased, 80 ms)
s.render(dt, shutterSeconds)    // one frame; dt advances the haze's clock
s.pick(xCss, yCss)              // name of the nearest "tik" box under the point, or null
s.project(p)                    // world -> CSS pixels {x, y, z}
s.resize()                      // after the canvas' CSS size changes (render() also checks)
s.stats()                       // { gpuMs (last measured frame), passes (median of 30 frames), volumesMs, cpuMs,
                                //   memoryMB, textures, triangles, compileMs, size, scene, quality }
s.setQuality({...}); s.setTime(seconds); s.dispose()
```

`s.quality` (defaults): `scale` 2, `hazeScale` 0.5 (haze pass resolution, share of the canvas), `hazeStep` 1 (1 = half a
cell; 0.5 = twice the steps), `reflScale` 0.5 (of the scene pass), `prepass` true, `bands` 6 (most flushed bands per
heavy pass; the actual count is one per ~3 ms of that pass' last GPU time), `cubic` true, `rotor` 'auto'.

## What it does with the pack

- Faces of `levha`-flagged materials are split at load per anchor: each triangle goes to the smallest `levha` or
  `nokta` box holding its centre; one draw per anchor, so a sign, a board or a lamp lens gets its own texture/colour.
- Material textures: 2048² layers of texture arrays (albedo sRGB, normal and ARM as data), mips, 16x anisotropy. uv0 is
  read GL-style (v up; the images are not flipped). Levha uv: 0..1 over the face, v = 1 at the top (the canvas' top row).
- Volumes: kept raw, and combined with the groups' colours into one 3D texture per volume (Mc, K_r, K_g, K_b side by
  side) whenever a colour moves by more than 1e-4 relative; the haze and the live surfaces read four texels per point.
- Rotors (`kanat` > 0): the mesh is projected along its axis once into a polar table (2048 angles x 256 radii) of
  coverage and normal, integrated over the angle. Slow: the mesh itself, crisp. Fast: a disc whose pixels average the
  blades over the swept arc (two reads), crossfading over 0.12-0.3 of the blade spacing swept per frame.
- Small emitters (11-17): the connected pieces of the group-emissive materials that are thin in at least two
  directions (lamp lenses, the arch's 13 m light strips; curved strips in ~1 m chunks) and the faces of every `nokta`
  anchor (setLamp's lenses), at most 255, each with its id in a per-vertex attribute of the hall's mesh. Every frame
  the CPU projects each one's points (its convex outline: area, centroid, second moments) to an equal-area rectangle of
  the same spread, and `emit.vert/.frag` add it to the scene and reflection passes convolved with a Gaussian of 0.65
  (reflection 0.85) canvas px, hidden per sample behind nearer depth. The lens' own emission fades out over a minor
  extent of 6 -> 2.5 px (reflection 8 -> 3.5): a lens of a few pixels keeps its energy and shape at every sub-pixel
  phase instead of being hit or missed by the samples.

## The frame

| pass | what | resolution |
|---|---|---|
| volumes | groups' colours into the volumes (only when a colour changes) | the volumes |
| reflection | the scene mirrored in y = 0 (depth prepass, discard below the floor), only the rows below the horizon | 0.5 x scene pass |
| reflectionHaze | haze of the mirrored rays from the floor on (outer volume, double steps), composite, 13-tap mip chain | half of that |
| scene | depth prepass, then forward shading (light map + B-spline close up, GGX with geometric specular AA, wet floor, levha, lamps, rotor discs), the small emitters' footprints | scale x canvas |
| haze | the march: fixed steps in metres, half a cell of the finest volume at each point, ending on boundaries | 0.5 x canvas |
| bloom | Karis-weighted box of the scene composited with the haze, 13-tap down, tent up | 0.5 x canvas |
| composite | scene x T + in-scatter (joint-bilateral by depth), bloom 4 %, exposure, AgX (Denizaltı's) | scale x canvas |
| resolve | separable Lanczos-2 in linear light, sRGB, a fixed 64² blue-noise dither of ±0.5/255 | canvas |

No TAA, no FXAA, no random numbers at run time.

## Measured (synthetic pack, 2560 x 1440, RTX 4080, headless Edge / ANGLE D3D11, ms of GPU per pass)

Fan view, rotor at 3 rev/s, fan strength 1 (the heaviest view of the synthetic pack); the lowest of three 45-frame medians.

| scale | reflection | reflHaze | scene | haze | bloom | composite | resolve | total | memory |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 0.05 | 0.20 | 0.39 | 1.98 | 0.06 | 0.06 | 0.11 | 2.8 | 484 MB |
| 1.5 | 0.09 | 0.27 | 0.86 | 1.99 | 0.10 | 0.12 | 0.18 | 3.6 | 595 MB |
| 2 | 0.14 | 0.39 | 1.51 | 2.00 | 0.16 | 0.22 | 0.28 | 4.7 | 746 MB |
| 3 | 0.30 | 0.76 | 3.53 | 2.10 | 0.26 | 0.51 | 0.56 | 8.0 | 1163 MB |

Knobs at scale 2: no prepass +0.75 ms (scene 2.26); no B-spline -0.16 ms; haze at 0.75 of the canvas 4.75 ms, at full
7.9 ms; haze steps halved 4.5 ms; volumes recombined every frame +0.14 ms. Journey middle 3.8 ms, rgb view 3.5 ms.
CPU in render() 0.2 ms. Shader compile 200-360 ms (parallel). Load of the synthetic pack ~1 s.
Timer queries count other programs' GPU work in between, so single readings on a busy desk run high.

Stability (pc_graphics `tools/kararlilik.py`, 60 frames, live scale 2 against scale 4 with full-resolution haze and half
steps; luminance 0..1): camera yaw of 0.25 px/frame: excess flicker mean 0.00075, p99 0.0039 (~1/255), 8x8 blocks
mean 0.00019; static camera with the haze churning at strength 1: mean 0.00035, p99 0.0036, relative 0.36. Static
camera, static haze: identical frames.
