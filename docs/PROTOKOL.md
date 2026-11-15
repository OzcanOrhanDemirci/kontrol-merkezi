# Kontrol Merkezi: process layout and message protocol

Internal design note (English). Everything the user reads in the app is Turkish.

## Processes

One executable, `KontrolMerkezi.exe` (net48, C#), with modes:

| Command | Who runs it | What it does |
|---|---|---|
| `KontrolMerkezi.exe` | desktop shortcut, unelevated | The window (WebView2 + `ui/index.html`). Holds no hardware. Talks to the service over a named pipe. If the service is not running it starts it through the scheduled task `KontrolMerkezi` (COM, no UAC prompt), like Fan Anahtarı. |
| `KontrolMerkezi.exe servis` | scheduled task at logon, elevated (Highest) | The background service: owns every device. Fan chip (NCT6687D via PawnIO/LHM), CPU temperature (LHM), GPU temperature/load (NVML), GPU fans (NvAPI cooler control), RGB (USB HID), colour engine, sleep/wake, Jarvis and local-model state. Runs for the whole logon session. Unelevated it still runs, with the admin-only parts reported as unavailable. |
| `KontrolMerkezi.exe rgb-dene <cihaz> ...` | developer | Short light tests, one device at a time. |
| `KontrolMerkezi.exe oku` | developer | Read-only dump of every sensor and device state to `okuma.txt`. |

Only one service instance (mutex `Local\KontrolMerkezi.Servis`), only one window (mutex `Local\KontrolMerkezi.Pencere`).

Data folder: `%LOCALAPPDATA%\KontrolMerkezi\` (log `gunluk.txt`, `durum.json` persisted targets, `isi-gecmisi.csv`, `ayarlar.json` colour calibration, `jarvis.json` written by the hook script). The elevated service runs as the same user, so this is the same folder for both.

## Pipe

Name `\\.\pipe\KontrolMerkezi` (created by the service, DACL: current user + SYSTEM + Administrators full). UTF-8, one JSON object per line, both directions. Several clients may connect (window, test tools).

## Service -> client

### `durum` (sent on connect, then whenever something changes, at most 4 Hz)

```json
{
  "tip": "durum",
  "servis": { "yonetici": true, "surum": "1.0.0" },
  "isi": { "cpu": 47.5, "gpu": 36.0, "ort": 41.8, "yumusak": 41.6, "cpuYuk": 6, "gpuYuk": 2 },
  "fan": {
    "kasa": { "hedef": "bios", "durum": "bios", "kullanilabilir": true, "neden": null,
              "rpm": [ { "ad": "CPU_FAN", "rpm": 817 }, { "ad": "PUMP_FAN", "rpm": 2439 }, { "ad": "SYS_FAN1", "rpm": 999 }, { "ad": "SYS_FAN3", "rpm": 940 } ] },
    "gpu":  { "hedef": "oto", "durum": "oto", "kullanilabilir": true, "neden": null,
              "rpm": [ 0, 0 ], "yuzde": 0,
              "afterburner": { "calisiyor": true, "fanKontrolu": false } }
  },
  "rgb": {
    "acik": false,
    "kip": "sicaklik",
    "jarvis": "bekliyor",
    "cihazlar": [
      { "kimlik": "aio", "ad": "Cooler Master Halo 360", "bagli": true, "hata": null },
      { "kimlik": "klavye", "ad": "SteelSeries Apex 3", "bagli": true, "hata": null },
      { "kimlik": "gpu", "ad": "MSI RTX 4080 Gaming X Trio", "bagli": false, "kilitli": true, "hata": null }
    ],
    "duraklar": [ { "c": 38, "renk": [235, 242, 255], "ad": "soğuk beyaz" } ]
  }
}
```

Values:
- `isi.*` may be `null` when a sensor is unavailable (CPU temperature needs the elevated service).
- `fan.kasa.durum`: `max` | `bios` | `geciyor` (switching) | `bilinmiyor`. `fan.gpu.durum`: `max` | `oto` | `geciyor` | `baska` (someone else, e.g. Afterburner, holds manual control) | `bilinmiyor`.
- `kullanilabilir: false` with a Turkish `neden` (reason) when the button cannot work (no admin, no driver).
- `rgb.kip`: `sicaklik` (temperature colour) | `yapayzeka` (local model generating) | `islemci` (CPU full load, GPU idle).
- `rgb.jarvis`: `yok` (no info) | `dusunuyor` (thinking) | `bekliyor` (waiting for Özcan's answer) | `hazir` (idle, nothing asked) | `kapali` (closed) | `yeniden` (restarting).
- `duraklar`: the six temperature colour stops, cold to hot, `c` in °C of the averaged temperature.

### `isik` (the light the case shows right now, 30 Hz while a window is connected)

```json
{ "tip": "isik", "acik": true,
  "onizleme": [120, 200, 255],
  "cikis": [118, 196, 255],
  "halka": [[r,g,b], ... 84 entries],
  "klavye": [[r,g,b], ... 10 entries] }
```

- `onizleme`: the base colour (temperature or override) even when RGB is off; for the scale marker.
- `cikis`: average colour actually sent to the devices (after effects). All zero when off. This is the scene's key light.
- `halka`: the 84 AIO LEDs in chain order (24 fan, 24 fan, 12 pump(?), 24 fan; the physical order is confirmed in the morning). `klavye`: the 10 keyboard zones.
- 0-255 ints, device values before per-device calibration gains.

### `olay` (one-off results)

```json
{ "tip": "olay", "tur": "fan-kasa", "sonuc": "tamam", "metin": "Fanlar en yüksek hızda" }
```

`tur`: `fan-kasa` | `fan-gpu` | `rgb` | `uyanis` (re-applied after wake). `sonuc`: `tamam` | `hata`.

## Client -> service

```json
{ "komut": "fan-kasa" }               // toggle CPU+case fans: max <-> BIOS
{ "komut": "fan-gpu" }                // toggle GPU fans: max <-> card auto
{ "komut": "rgb", "acik": true }      // all RGB on (temperature colour) / off
```

## Window host <-> page (WebView2, not the service)

Page -> host strings: `ready`, `close`, `minimize`, `maximize`, `drag`, `perf:<text>` (logged), and JSON `{"komut":...}` which the host forwards to the service unchanged.

Host -> page: every service message unchanged, plus
`{"tip":"baglanti","durum":"bagli"|"yok"|"baslatiliyor"}` and `{"tip":"gorunur","visible":true,"focused":true}`.

Outside WebView2 (`window.chrome.webview` absent: browser, headless Edge measurement) the page runs its own simulated service so it can be developed and measured alone.
