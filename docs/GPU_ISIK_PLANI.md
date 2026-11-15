# GPU lighting: proof plan before any write

Card: MSI RTX 4080 Gaming X Trio, PCI 10DE:2704, subsystem 1462:5111. Goal: drive its lighting from Kontrol Merkezi
with volatile writes only, never changing what the card stores (power-on lighting stays as it is now).

State tonight: `src/Rgb/MsiGpuV2.cs` exists but has never run. It needs `DerlemeIzni = true` (compile time) AND the
environment variable `KONTROL_GPU_ISIK=acik` (run time); both are off. Nothing constructs it. No I2C or NvAPI traffic
of any kind has been sent to the card, not even a read or a probe.

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

## Never

- Write register 0x3F.
- Probe or scan addresses, or read registers "to see" before step 1 has shown MSI doing the same read.
- Run the GPU driver while MSI Center, Afterburner's RGB or OpenRGB is running.
