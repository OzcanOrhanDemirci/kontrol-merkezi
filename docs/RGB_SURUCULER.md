# RGB drivers: protocol, persistence, measurements

Internal note (English). Drivers live in `src/Rgb/`, all implement `IRgbCihaz`. Source references are to OpenRGB 1.1
(`C:/dev/jarvis/yerel/rgb-olcum/openrgb-1.1-src/openrgb/`, paths below relative to `Controllers/`).

| Device | Class | Transport | LEDs | Status |
|---|---|---|---|---|
| Cooler Master Halo 360 (ARGB Gen 2 A1, 2516:0173, fw 0x1600) | `CoolerMasterA1` | HID interface 1, usage page 0xFF01, 65-byte reports | 84 | tested on hardware 2026-11-16 |
| SteelSeries Apex 3 (1038:161A) | `SteelSeriesApex3` | HID interface 3, usage page 0xFFC0, 33-byte reports | 10 zones | tested on hardware 2026-11-16 |
| MSI RTX 4080 Gaming X Trio (10DE:2704 / 1462:5111) | `MsiGpuV2` | NvAPI I2C port 1, address 0x68 | 1 | **locked, never run**; see `GPU_ISIK_PLANI.md` |

## Rule applied to every device

Live colour goes only through the device's volatile path. No driver sends a save/commit/flash command, a stored-mode
command, or anything that changes the power-on lighting. Each driver has a runtime guard that throws if code ever tries
to send a command outside its short allow-list, so a later edit cannot slip a persisting command in by accident.

## Cooler Master ARGB Gen 2 A1 (AIO)

### Protocol used
- Command page request: `[0]=0 [1]=0x80 [2]=cmd [3]=op (1 read, 2 write) [4..]=payload`; reply `0x80 cmd 0x03 echo...`
  (`CMARGBGen2A1Controller.cpp` `SendCommandPage`, line 1339).
- Realtime colour (cmd 0x09), three reports per target, target = port mask + Gen2 sub-device mask, 60 LEDs = 180 bytes
  (`SendRealtimeFrameLocked`, line 730): `00 09 port sub 3C + 59 bytes`, `01 09 + 62 bytes`, `82 09 + 59 bytes`.
- Realtime entry as captured from MasterPlus (`SendRealtimePreamble`, line 482): cmd 0x01 write {1}, 2 global black
  frames (port 0xFF, sub 0xFF), cmd 0x01 write {1}, 5 global black frames, first target frame ~104 ms after the 2nd
  enable. Exit (`ExitRealtimeMode`, line 532): 10 ms quiet, cmd 0x01 write {0}, retried once.
- Topology on this PC (read with cmd 0x0B / 0x07, read-only): port 1 is Gen2 with sub-devices
  `0x01:24, 0x02:24, 0x04:12, 0x08:24` = 84 LEDs. Ports 2 and 3 are empty.

### Persistence finding
| Command | Effect | Evidence | Used here |
|---|---|---|---|
| 0xB0 SAVE | writes current settings to flash | `SaveToFlash`, line 1333; called only from `DeviceSaveMode` (`RGBController_CMARGBGen2A1Controller.cpp` 2060-2066), which skips it in Direct mode | **never** |
| 0xB1 RESET | factory reset of LED/fan config | `ResetConfiguration`, line 1209 | **never** |
| 0x0B write | port generation Gen1/Gen2, called a "persistent generation handoff" | line 343 | **never** (read only) |
| 0x06 write, 0x0D, 0x10, 0x11, 0xB5, 0xC0 | Gen1 geometry, sub-port remap, overlay table/mode, UID, multilayer | lines 421, 1072, 1144, 1191, 1261, 1305 | **never** |
| 0x03 write, 0x08 write | hardware effect / custom colours: volatile until 0xB0, but they replace the effect the controller shows on its own | `SetEffect` line 866, `SendCustomColors` line 941 | **never** |
| 0x01 write | realtime session on/off (host takes over the LEDs) | `EnterRealtimeMode` 455, `ExitRealtimeMode` 532 | yes |
| 0x09 | realtime colour frame (RAM) | `SendRealtimeFrameLocked` 730 | yes, the live stream |

Allowed reads: 0xB4 firmware, 0x0B generation, 0x07 topology, 0x03 current effect. Guard: `CoolerMasterA1.Komut()`
throws on any write other than 0x01; `Paket()` only sends 0x09.

The hardware effect on all four sub-devices reads `0x09 (Off)` before, during and after every test tonight (cmd 0x03
read). The stored power-on state was not touched.

### Off, exit, crash
- `Sondur()`: one black realtime frame, then cmd 0x01 {0}. The controller returns to its own current effect, which is
  "Off". Verified: exit is acknowledged, effect reads Off afterwards. It is idempotent and works from a fresh process that
  never entered realtime (`rgb-dene aio sondur` after `--acik-birak` acknowledged), so a crashed run can be cleaned up.
- App exits or crashes with lights on: the controller stays in realtime showing the last frame. Whether it has a
  watchdog that drops realtime after the host goes quiet is **not known** (MasterPlus and OpenRGB both refresh every
  40 ms, `REALTIME_PERIOD_MS`, which hints at one but proves nothing; cmd 0x03 still reads Off during realtime, so the
  state cannot be read back). Power loss ends realtime and the controller comes up in its stored effect (Off).
  Caution: on a warm reboot the board may keep USB powered, so the last frame may survive a restart; the service
  should call `Sondur()` on shutdown, logoff, sleep and normal exit.

### Measurements (2026-11-16, this PC)
- `Ac()`: 710-776 ms (most of it is the 150 ms reply timeouts on the empty ports 2 and 3).
- Realtime entry (first frame): 145-154 ms, includes the 104 ms MasterPlus phase.
- One HID report takes ~2.0 ms to write (USB interrupt OUT pacing), so a full 84-LED frame (12 reports) costs 23.7-24.4 ms
  with no extra gap. With the default 2.5 ms report spacing (close to MasterPlus's ~3 ms): p50 29.0 ms, max 30.0 ms.
- Sustained: 15 s at 30 Hz, every frame different: 446 frames, 29.7 frames/s, no write over 33.3 ms, no errors.
- No command or frame failed in any run.

## SteelSeries Apex 3

OpenRGB drives 161A with `SteelSeriesApexTZoneController` (`SteelSeriesControllerDetect.cpp` lines 156-170 and 543:
`DetectSteelSeriesApex3Full`, interface 3), not with the TKL controller.

### Protocol used
33-byte output reports: brightness `[1]=0x0A [3]=0..0x64`, then colours `[1]=0x0B [3+3i..5+3i]=R,G,B` for zones 0-9
(`SteelSeriesApexTZoneController.cpp` `SetColor`, lines 56-80). Same order as OpenRGB, brightness fixed at 0x64.

### Persistence finding
| Command | Effect | Evidence | Used here |
|---|---|---|---|
| 0x06 `00 08`, then 0x09 | stores current lighting in the keyboard | `Save()`, lines 45-55; exposed only through `DeviceSaveMode` (`RGBController_SteelSeriesApex3.cpp` 73) and Direct carries `MODE_FLAG_MANUAL_SAVE` (line 42), i.e. not stored unless saved | **never** |
| 0x0A | brightness, volatile | sent on every OpenRGB update; save is a separate command | yes |
| 0x0B | zone colours, volatile | same | yes |

Guard: `SteelSeriesApex3.Rapor()` throws on any command byte other than 0x0A / 0x0B.

### Off, exit, crash
- `Sondur()`: all zones black (volatile). The keyboard then stays black until it loses power; after that it shows the
  lighting it has stored itself, which the driver never changes. What it stored before tonight is not known to me.
- App exit or crash with lights on: last colours stay until power loss, unless the firmware has a timeout (not known;
  the protocol has nothing to read back). Same warm-reboot caution as the AIO.

### Measurements
- `Ac()`: 108-110 ms. One frame (2 reports): p50 11.2 ms, max 12.5 ms (~5.6 ms per report).
- Sustained: 6 s at 30 Hz: 180 frames, 30.0 frames/s, none late, no errors.

## What the colour engine needs to know
- Rates: AIO up to 30 Hz (a frame blocks ~29 ms; hard ceiling ~40 Hz); 25 Hz matches MasterPlus. Keyboard 30 Hz is easy.
  Run each device on its own thread; an AIO write must not delay the keyboard.
- Unchanged frames are skipped by the drivers but re-sent every 1 s (`TekrarMs`) as a keep-alive, so keep calling
  `Yaz` while lights are on (any rate >= 1 Hz). Whether either device actually needs a keep-alive is not known.
- AIO LED order: sub-device 0x01 (24), 0x02 (24), 0x04 (12), 0x08 (24), in that order in the 84-array. That the 12-LED
  one is the pump is a strong guess; which fan is which and the direction of each ring are for the morning check
  (`rgb-dene aio dalga`: segment 1 red, 2 green, 3 blue, 4 amber, white head runs from LED 0 upward, 10 LEDs/s).
- Colour byte order sent: R, G, B on both devices (as OpenRGB). Any GRB quirk on the fans would show in the morning
  check with `rgb-dene aio renk FF0000`.
- Keyboard: 10 zones, assumed left to right; brightness byte fixed at max, so dimming is done in the colour values.
- After sleep/wake call `Ac()` again; the first AIO frame afterwards pays the 150 ms realtime entry.
- Call `Sondur()` on every orderly exit path (see crash notes above).

## Morning visual check (Özcan)
1. `KontrolMerkezi.exe rgb-dene aio renk FF0000 5` then `00FF00`, `0000FF`: colour order.
2. `KontrolMerkezi.exe rgb-dene aio dalga 30`: which ring is which, where LED 0 is, direction; 12-LED segment (blue) = pump?
3. `KontrolMerkezi.exe rgb-dene klavye dalga 15`: zone order (white head runs zone 0 to 9).
4. `KontrolMerkezi.exe rgb-dene aio renk FFFFFF 3 --acik-birak`, wait a minute: do the lights stay (no watchdog) or drop
   back to off? Then `rgb-dene aio sondur`. Same for `klavye`.
5. Full power off (not a warm reboot), power on: AIO and keyboard must come up as before (AIO off).

## Licence note (OpenRGB is GPL-2.0-or-later)
The drivers were written from the protocol facts (command bytes, report layouts, timings), with different structure and
names. These parts follow OpenRGB closely enough to count as close translations, for a later decision on publishing:
- `CoolerMasterA1`: the realtime entry sequence and timing (`SendRealtimePreamble`), the three-report frame layout
  (`SendRealtimeFrameLocked`), and the reply matching in `Komut` (`SendCommandPage`), from `CMARGBGen2A1Controller.cpp`.
- `SteelSeriesApex3.Gonder`: the two-report sequence of `SteelSeriesApexTZoneController::SetColor`.
- `MsiGpuV2.Sabit`: the static-mode register sequence of `RGBController_MSIGPUv2::DeviceUpdateAll`.
- `MsiGpuV2.NvApi`: the `NV_I2C_INFO_V3` layout and NvAPI function ids from `dependencies/NVFC/nvapi.h/.cpp`
  (no licence header in those files) and the call shape of `i2c_smbus/Windows/i2c_smbus_nvapi.cpp`.
