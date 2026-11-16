# The hall's assets

`python sahne/varlik.py` fetches them from Poly Haven (CC0 1.0, https://polyhaven.com/license) into
`sahne/varlik/` (git-ignored): 2K maps in `doku/` (albedo sRGB jpg, normal GL png, ARM png = AO, roughness, metal;
all 2048 × 2048), glTF models in `model/<id>/`, and `varlik.json` (per material: source, maps, `olcek_m` = the real
width one texture repeat covers, `ortalama` = mean linear albedo as the renderer decodes it). Re-runnable: originals are
checked against the API's size and MD5, derived maps against a SHA-256 receipt; nothing is executed. Needs requests,
numpy, Pillow, opencv-python.

Each set was chosen by looking at it, for its role in the hall:

| material | Poly Haven set | why |
|---|---|---|
| `beton_zemin` | concrete_floor_worn_001 (3 m) | dark worn grey floor, scratches and stains, no paint coating; reads wet with the mask |
| `beton_duvar` | concrete_layers_02 (2 m) | grey cast concrete with horizontal formwork lifts and water stains |
| `beton_kolon` | concrete (4 m) | raw board-formed concrete, vertical form joints and pores: tall cast columns |
| `beton_tavan` | concrete_wall_006 (2 m) | darker, smoother concrete with tie holes: a slab seen from 20 m below |
| `beton_anit` | concrete_wall_009 (1.8 m) | fine pale architectural concrete, panel joints; neutral so the temperature light reads true |
| `celik_boyali_kasa` | green_metal_rust (1 m) | olive industrial paint, sparse rust: the CPU + case fan |
| `celik_boyali_gpu` | blue_metal_plate (2.5 m) | deep blue painted panels: the GPU fan, a different hue from the green through haze |
| `celik_kanat` | rusty_metal_sheet (2 m) | neutral weathered bare steel: blades that belong to either shroud |
| `celik_pasli` | rust_coarse_01 (2.2 m) | continuous coarse rust without ribs, right on narrow rails, chains, grates |
| `celik_sac` | metal_plate (0.5 m) | worn diamond tread plate: landing deck and stair treads |
| `metal_koyu` | metal_plate_02 (2 m), albedo × 0.35 linear | aged iron plates darkened for brackets and frames |
| `kablo` | rubber_tiles (2 m) | near-black fine rubber, the only black rubber set; cable UVs stay inside one tile, off its seams |

Rejected after viewing: wood_textured_concrete (reads as timber), concrete_wall_008 (beige, tints the arch light),
concrete_panels (stepped cladding), smooth_concrete_floor (brown-red, reads painted), worn_concrete_floor (ochre
coating), concrete_floor_worn_02 (dry, crumbly), concrete_wall_005 (too broken for columns), rusty_painted_metal and
rusty_metal (corrugated), rusty_metal_05 (big blue flakes).

Wetness: `doku/zemin_islak_2k.png`, greyscale, same uv as `beton_zemin` (1 = standing water). It is the floor's own
16-bit displacement, low-passed (σ = 6 cm) and ramped: below its 25th height percentile wet, above the 60th dry (about
40 % of the floor wet). It tiles with the floor every 3 m; scale or rotate it against the floor uv if the repeat shows.

Models (set dressing, glTF 2K with textures): caged_hanging_light, industrial_caged_sconce, industrial_wall_lamp,
modular_industrial_pipes_01, modular_airduct_circular_01, modular_electric_cables, metal_trash_can, Barrel_01,
ladder_sectioned_01. Left out: fire_alarm, WetFloorSign_01, utility_box_01/02, power_box_01, because their textures
carry English lettering (FIRE ALARM, CAUTION, DANGER) that a Turkish-only world cannot show.
