# GPU proof, step 4: what to check after the power off (2026-11-16)

State before the power off:
- 11:10:57: one static blue was sent to the RTX 4080's lighting with MSI's recorded sequence (2D=00, 22=1C, 36=50,
  38=02, 30=00, 31=00, 32=FF, 22=13), **no 0x3F**. It was sent earlier than planned, by a mistake (an old build of
  `gpu-tek-renk.exe` run with an argument it ignored); the content was exactly the approved step. Log:
  `C:\ProgramData\KontrolMerkezi-nvspy\gpu-tek-renk.txt`. The tool now writes only with `--karta-yaz`.
- The card's saved state (MSI's last save, 11:06:05): Front+Side **off**.
- MSI Center's services are stopped and disabled by `araclar\nvspy\msi-durdur.cmd` (previous startup types in
  `araclar\nvspy\msi-hizmetler-onceki.txt`), so nothing of MSI writes to the card before, during or after the boot.

After the boot, in this order:
1. **The graphics card's lights: dark or blue?**
   - Dark: our writes were volatile (the card came up in its saved "off"). Step 4 passed.
   - Blue: our writes persisted without 0x3F. Stop: `araclar\nvspy\msi-durdur.cmd geri` (UAC), in Mystic Light set the
     card to Off and apply (that saves), and the GPU driver stays locked.
   - Anything else (rainbow, MSI default): note exactly what; MSI Center must not have run (check step 4 below).
2. AIO and keyboard: dark (their stored state is off; our service never writes while the lights are off).
3. Kontrol Merkezi service up: `tasklist | findstr KontrolMerkezi`, and its log
   `%LOCALAPPDATA%\KontrolMerkezi\gunluk.txt` shows "servis başladı | yönetici=True".
4. MSI services still disabled and not running: `Get-Service LightKeeperService, Mystic_Light_Service,
   MSI_Center_Service, MSI_Case_Service`.
5. RGB stays off until he turns it on in the window; then case and keyboard follow the temperature as before.

Re-enable MSI Center if needed (e.g. to set the card off): `araclar\nvspy\msi-durdur.cmd geri`. Uninstall it after the
proof is closed (Settings > Apps > MSI Center), as planned.
