# GPU lighting: proof plan before any write

Card: MSI RTX 4080 Gaming X Trio, PCI 10DE:2704, subsystem 1462:5111. Goal: drive its lighting from Kontrol Merkezi
with volatile writes only, never changing what the card stores (power-on lighting stays as it is now).

**Current state (2026-11-16, 13:00):** done and built, not yet installed. `src/Rgb/MsiGpuV2.cs` sends only writes MSI
made; the card is part of RGB like the AIO and keyboard (temperature colour, all on/off, idle-off, sleep), with no
effect of its own. The sections below are the history of how it got there: the morning proof, the power-off tests, the
three viewings with Özcan. The last section is the result and what is open.

## What OpenRGB 1.1's source says

- Detection (`Controllers/MSIGPUController/MSIGPUv2Controller/MSIGPUv2ControllerDetect.cpp` lines 18-31, 55;
  `DetectionManager.cpp` lines 1135-1140): for 10DE:2704 / 1462:5111 the controller is created on the PCI id match
  alone, at I2C address 0x68 on NvAPI port 1. It never checks that a chip answers there.
- It never reads anything back (`RGBController_MSIGPUv2.cpp` line 427: "doesn't support reading colors from device").
  So OpenRGB showing the card proves nothing about the register map on this card.
- Registers it writes (`MSIGPUv2Controller.h` lines 26-40, `RGBController_MSIGPUv2.cpp` `DeviceUpdateAll`):
  0x22 mode (0x1C idle/programming, 0x13 static, 0x01 off, others effects), 0x27-0x29 three-byte colour blocks
  (B,G,R order, so 0x27-0x2B are touched), 0x2E "unknown" (written 0 before each mode change), 0x30-0x32 R/G/B,
  0x36 brightness (20 x 1..5), 0x38 speed, 0x46 direction/control. Address range used: 0x22, 0x27-0x2E, 0x30-0x38, 0x46.
- 0x3F is "save" (`MSIGPUv2Controller.cpp` line 86, `Save()` writes 0x00 to it), sent only from `DeviceSaveMode`.
  Every mode carries `MODE_FLAG_MANUAL_SAVE`, i.e. OpenRGB assumes the other writes are volatile. That assumption is not
  proven anywhere in the source.
- Its "Direct" is not a streaming mode: each update is 0x2E=0, 0x22=0x1C, 0x30/31/32, 0x36, 0x22=0x13, each followed by
  a 20 ms sleep (~140 ms per colour), so ~5-7 updates/s at most.

## Open risks

1. Subsystem 5111 is used by MSI for both the 4080 Gaming X Trio and the 4080 SUPER Gaming X Trio
   (`pci_ids.h` lines 862, 867); the PCI device id (2704 vs 2702) tells them apart, but nothing in the source shows the
   map was confirmed on a non-SUPER Gaming X Trio. A different chip or firmware at 0x68 could interpret these writes
   differently.
2. Whether 0x22/0x30-0x32 writes are volatile on this card is an assumption. Some MCUs persist the last mode on their
   own. This is the main thing the proof must settle.
3. Port 1 / address 0x68 may also carry something else on this card; an unrecorded write could reach the wrong device.
4. MSI Center, Afterburner or the NVIDIA driver may also use the bus; concurrent traffic can corrupt a transaction.
5. Unknown 0x2E: written by OpenRGB without explanation.

## Morning proof plan (Özcan and Jarvis together)

1. **Record MSI's own writes.** Install MSI Center with Mystic Light temporarily. Run an API monitor (e.g. API Monitor
   v2 with an NvAPI definition, or a small `nvapi64.dll` proxy that logs `nvapi_QueryInterface` id 0x283AC65A
   `NvAPI_I2CWriteEx` and 0x4D7B0709 `NvAPI_I2CReadEx` with address, register and data) on MSI Center's processes.
   In Mystic Light, change only the GPU: static red, static green, off, brightness one step. Do NOT press any "apply to
   all"/"save" that MSI offers beyond what is needed, and note which click produces which writes.
2. **Compare** the log with the OpenRGB map above: addresses, registers, order, delays, and above all whether MSI
   ever writes 0x3F (or anything else) when it "applies" versus when it only previews. Mark every register that only
   appears together with a save action as forbidden.
3. **Replay only what MSI wrote**, never 0x3F, never a register not seen in the log. Update `MsiGpuV2.IzinliKayitlar`
   and `Sabit()` to exactly that sequence before turning the switches on.
4. **One volatile change, then a power cycle.** With MSI Center closed: set one colour (e.g. static blue) through
   `MsiGpuV2`, confirm it shows, then a full power off (not a warm reboot, wait ~10 s), power on. The card must come up
   in its previous lighting. If it comes up blue, the writes persisted: stop, restore the original state with MSI
   Center, and keep the GPU driver locked.
5. Only after step 4 passes: uninstall MSI Center, set `DerlemeIzni = true`, and let the service enable the runtime
   flag. Keep the update rate low (the driver thins to 4 Hz) since each colour costs ~7 bus writes.

## Step 1-2 result (2026-11-16, 11:02-11:06)

Recorded with `araclar/nvspy/izle.exe` attached as a debugger to MSI Center 2.0.75 / Mystic Light's `LEDKeeper2.exe`
(the folder proxy was bypassed: MSI loads nvapi by full path). Raw log: `docs/gpu-kayit/msi-mystic-light-2026-11-16.txt`.

- 63 calls, all `NvAPI_I2CWriteEx`, all to 7-bit address **0x68** on I2C **port 1** (portSet=1), all status 0. No reads,
  no other address, port or I2C function.
- Colour apply, in this order, ~30 ms apart: `2D=00`, `22=1C`, `36=<brightness>`, `38=02`, `30=R`, `31=G`, `32=B`,
  `22=13`, then ~1 s later `3F=00`. Red FF/00/00, green 00/FF/00. Brightness one step: 0x50 -> 0x3C.
- Off: `2D=00`, `2D=01` (Side) or `2D=03` (Front+Side), then `3F=00`. 0x2D is a zones-off mask (bit 1 Side, bit 2 Front
  by inference).
- MSI writes **0x2D, not 0x2E** (OpenRGB's guess) and never 0x27-0x2C or 0x46.
- **MSI saves (0x3F) after every apply**, plain colour changes included. The card's stored state after the session:
  Front+Side off (11:06:05). Volatility of the non-save registers is not shown by this data: step 4 decides it.

## Step 4 (2026-11-16)

Static blue sent at 11:10:57 with MSI's sequence, no 0x3F (`araclar/nvspy/gpu-tek-renk.c`). It went out earlier than
planned by a mistake (an old build run with an argument it ignored), before MSI's services were stopped; the content was
the approved step. Power-off check: `docs/GPU_ADIM4_KONTROL.md`.

## After the power-off test (2026-11-16)

- 11:54 boot: the card lit green at power-on (MSI's last saved colour; MSI's "off" had only switched the zones off via
  0x2D), then MSI Center, started at logon despite its disabled services, re-applied its profile at 11:55:28/31 (the
  flashing) and the card went dark. Our blue did not return: the step-4 write without 0x3F was volatile.
- 12:03 (captured, `docs/gpu-kayit/msi-mystic-light-2026-11-16-off.txt`): Özcan applied Steady white, full brightness
  (0x36 = 0x64), then Mystic Light's "Off". MSI's Off effect is the zone switch only (0x2D = 03) plus a save; it never
  writes the mode register. Stored state: Steady white, full brightness, zones off. Power-on check pending.

## Never

- Write register 0x3F.
- Probe or scan addresses, or read registers "to see" before step 1 has shown MSI doing the same read.
- Run the GPU driver while MSI Center, Afterburner's RGB or OpenRGB is running, or run `rgb-dene gpu` while the installed
  service drives the card.

## Open question: is the zone switch 0x2D stored? (2026-11-16, 12:15)

- 11:06:06 MSI's last save before step 4 stored Steady green, 0x36=3C, zones off (`2D=03`, then `3F`).
- 11:10:57 the step-4 blue (no 3F) began with `2D=00` (zones on). Log: `docs/gpu-kayit/gpu-tek-renk-2026-11-16.txt`.
- 11:54, after a shutdown and ~10 s power off: green at power-on, i.e. saved colour and mode, but zones **on**
  although the save said off.
- 12:06 boot after "Kapat" (wall power unknown): white flashed at startup and went off (MSI's logon re-apply).
  12:11 boot after a warm restart: dark at power-on (the light chip keeps power across a restart).

Two readings, not yet told apart:
- (A) 0x2D is stored by the controller on every write, without 3F. Then every on/off through 0x2D writes the card's
  memory, and a power loss while lit brings the card up lit. Design then: never write 0x2D for on/off; use black.
- (B) 0x2D is never stored, not even by 3F; power-on always has zones on and shows the stored mode (now Steady
  white, full brightness, from 12:03). Then white at every power-on until the service switches the zones off with a
  volatile write; dark-at-power-on would need one deliberate save of a dark state (his decision, not the plan).

The decisive test: a full power off (PSU off ~10 s) with MSI gone; dark at the BIOS logo = (A), white = (B).

## MSI Center removed (2026-11-16, 12:22)

`araclar/msi-kaldir/msi-kaldir.cmd` (one UAC) took MSI Center apart by hand without running any MSI program (its
uninstaller launches MSI executables): Store app, SDK folder, 4 services, NTIOLib drivers, the logon task
"MSI Task Host - LEDKeeper2_Host" (what started MSI at logon with its services disabled, and the flicker after the
desktop), firewall rules, registry, ProgramData; 10 plug-ins with their own quiet uninstallers (5 ENE HALs, WD P40,
WD_BLACK D50, WD_BLACK AN1500, Verbatim, AMD Ryzen Master SDK with its driver); MSI's MsIo64 boot driver (January);
the logger log folder; the built logger and colour-tool binaries. Kept: Afterburner, RTSS, and the BIOS-installed
MSI Driver Utility Installer and msiswacpi driver.

## Power-off test with MSI gone (2026-11-16, 12:26): the zone switch is never stored

Shutdown, PSU off ~10 s: the card lit **steady white at the logo** (MSI's saved Steady white, full brightness, 12:03)
and stayed white, no flicker after the desktop. MSI's saved "off" (2D=03 + 3F) did not hold: the zone switch 0x2D is
never stored, only mode, colour and brightness are, and only by 3F. Reading (B) above holds. Özcan chose (12:4x) never
to save, 3F stays absolute: "açılışta beyaz olması benim için sorun değil". The card is white from power-on until the
service takes over (about a minute after the power button; also after waking from S3 sleep, which cuts the card's power).

## Runs and viewings on the card (2026-11-16), all volatile, every write logged

Log: `%LOCALAPPDATA%\KontrolMerkezi\gpu-deneme.txt`. Every write returned status 0. The NvAPI call is the 64-bit layout
of MSI's call (ver 3, D0, port 1 set, i2cSpeed FFFF, 400 kHz) from an unelevated process.

- 12:36 `2D=03` alone: the card went from its white to dark.
- Viewing 1 (12:44): MSI's full sequence white then blue: "5 saniye beyaz 5 saniye mavi güzeldi". R/G/B alone after a
  full red: ignored, it stayed red. Fades sent as full sequences: seen as off/on (the programming step 22=1C darkens the
  LEDs until 22=13).
- Viewing 2 (12:47): R, G, B followed by 22=13 changes the colour cleanly ("renklerin hepsi çalıştı"). White fades:
  ~7/s steppy; ~27/s (no pause between writes) plain off/on.
- Viewing 3 (12:52): fades at ~11, ~20 (two curves) and ~35 updates/s: "kısılıp açılma anlaşılmıyor [...] renk
  değiştirse [...] renklerin geçişi net görünür". Brightness changes do not read on this card; colour changes do.

## Result (2026-11-16, 13:00)

- Driver: the first colour after an open or an off is MSI's full sequence (2D=00, 22=1C, 36=64, 38=02, R, G, B, 22=13);
  every later change is R, G, B, 22=13; off is 2D=03; 30 ms after each write (MSI's pace, ~8 changes/s). Allow-list of
  (register, value) pairs from the capture; 0x3F refused by the bus class as well. Unchanged colours are not re-sent
  (the controller holds them, no keep-alive).
- Özcan's decision: no effect on the card, "efekt değil, sıcaklıkla aynı senkronizede". The card shows the temperature
  colour in step with the AIO and keyboard; the local-model effect is "akış" on the keyboard and fans
  (`efektler.yapayzeka = 1`, set in his `ayarlar.json` on 11-16; the previous file is `ayarlar.json.yedek-2026-11-16`).
- Start and wake: the service darkens the card (2D=03) unless RGB is on, in which case the first frame paints the
  temperature colour. No fade (fades do not read on the card).
- Build: the normal build contains the NvAPI write; `-p:GpuIsik=kapali` builds one without any path to the card, whose
  `rgb-dene gpu sira|sondur|servis` only simulate. Before a card run, check which build it is: the I2C function id
  bytes `5A C6 3A 28` appear once in the card build's exe and never in the other.
- Open: after the install Özcan watches a temperature transition on the card next to the others: smooth, abrupt or
  stepped? If stepped, a card effect built around the steps (a breath, an on/off) may come back as a later step.
- Not checked yet: the installed service on the card (start darkening, RGB on/off, idle-off, sleep/wake); per-device
  colour match of the card against the keyboard (`cihazRenkleri.gpu` if needed).

## Speed stages and the final card setting (2026-11-16, 15:52-16:50)

- Installed 15:52; the card follows RGB on/off with the others ("ekran kartı uyumlu yanıyor").
- Pace, like an overclock, with Özcan watching each stage: 25 ms after every write is taken (~10 colour changes/s);
  20, 10 and 5 ms are silently ignored (every write returns status 0, the card keeps its colour), also with 5 ms
  between the colour writes and 25 ms after the steady write. So ~10 changes/s is this card's limit.
- Re-sending an unchanged colour is invisible ("dümdüz durdu"), so the visible stepping comes from how the chip maps
  values; the computed steps at 10/s stay under the visible threshold. A/B on the card alone: sRGB-encoded values
  step less than linear ones ("basamaklanma var ama azaldı [...] kabul edilebilir"). Final: 25 ms, eye-encoded
  (`gpuYazmaArasiMs`, `gpuGozeGore`).
- Effects: after seeing them on the real lights (a white/colour "akış" wave and a red over-temperature wave, both
  previews; the first was disturbed by the window restarting the service), Özcan removed all of them, the 90 °C
  warning too: "Sıcaklık + 15 dakika yeterli." The service no longer reads Jarvis's state or the local model.
- For a test run on the devices with the service stopped: close the window first (it restarts the service task),
  then `{"komut":"kapat"}` on the pipe, and `schtasks /run /tn KontrolMerkezi` afterwards (works unelevated).
