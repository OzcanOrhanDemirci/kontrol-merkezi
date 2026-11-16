# The window's opening, measured the way Özcan sees it: records the monitor (ffmpeg ddagrab) from before the window
# starts, starts the real window (connected to the service already running), waits for the page's opening line in
# gunluk.txt ("pencere: açılış ..."), lets the opening play a few seconds, closes the window and cuts the video into
# frames with each frame's brightness, so the time from the double-click to the first light can be read off.
#
#   powershell -File araclar\acilis-olc.ps1 [-Kaynak <bin\Release>] [-Sonra 4] [-Fps 60] [-Ekran 0] [-BosSure 60]
#
# Output: .tmp\acilis\<time>\ : kayit.mkv, kareler\NNNN.jpg (every frame, 960 px), parlaklik.txt (per frame: seconds
# from the window's start, mean luma of the whole frame), olaylar.txt, the opening line.
#
# Safety: the window holds no hardware; the script refuses to start without the service's pipe (else the window would
# start a service of its own), while another Kontrol Merkezi window is open (Özcan's), while the real-window lock
# .tmp\pencere.lock exists (someone else's run), or while someone used the mouse or keyboard in the last -BosSure
# seconds. It holds the lock for its run (well under a minute) and stops if the mouse moves.
param([string]$Kaynak = "", [double]$Sonra = 4, [int]$Fps = 60, [int]$Ekran = 0, [int]$BosSure = 60, [string]$Ad = "acilis-olc")
$ErrorActionPreference = "Stop"
$inv = [Globalization.CultureInfo]::InvariantCulture
$kok = Split-Path -Parent $PSScriptRoot
if (-not $Kaynak) { $Kaynak = Join-Path $kok "bin\Release" }
$exe = Join-Path (Resolve-Path $Kaynak).Path "KontrolMerkezi.exe"
$anaKok = if ($kok -match '\\\.claude\\worktrees\\') { $kok -replace '\\\.claude\\worktrees\\.*$', '' } else { $kok }
$kilit = Join-Path $anaKok ".tmp\pencere.lock"
$cikti = Join-Path $anaKok (".tmp\acilis\" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$gunluk = Join-Path $env:LOCALAPPDATA "KontrolMerkezi\gunluk.txt"

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Ac {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  /// <summary>An Alt tap lets a background process hand the foreground to the window (a double-click would).</summary>
  public static bool Front(IntPtr h) {
    for (int i = 0; i < 6 && GetForegroundWindow() != h; i++) { keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); SetForegroundWindow(h); System.Threading.Thread.Sleep(30); }
    return GetForegroundWindow() == h;
  }
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cb, t; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO l);
  public static uint IdleMs() { var l = new LASTINPUTINFO(); l.cb = 8; GetLastInputInfo(ref l); return unchecked((uint)Environment.TickCount - l.t); }
}
"@

if (Test-Path $kilit) { "Gerçek pencere kilidi var (başkasının koşusu): $(Get-Content $kilit -Raw)"; exit 2 }
if (Get-Process KontrolMerkezi -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ceq "Kontrol Merkezi" }) { "Bir Kontrol Merkezi penceresi açık; koşu başlamaz."; exit 2 }
if (-not (Test-Path "\\.\pipe\KontrolMerkezi")) { "Servisin borusu yok; koşu başlamaz."; exit 2 }
if ([Ac]::IdleMs() / 1000 -lt $BosSure) { "Son girdi $([int]([Ac]::IdleMs() / 1000)) sn önce; en az $BosSure sn girdisiz olmalı."; exit 2 }
if (-not (Test-Path $exe)) { "Yok: $exe"; exit 2 }

New-Item -ItemType Directory -Force $cikti | Out-Null
Set-Content -Path $kilit -Value "$Ad $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -Encoding UTF8
Start-Sleep -Milliseconds 300
if (-not ((Get-Content $kilit -Raw) -like "$Ad *")) { "Kilidi başkası aldı: $(Get-Content $kilit -Raw)"; exit 2 }
$olaylar = New-Object System.Collections.Generic.List[string]
function Olay([string]$m) { $s = "{0}  {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $m; $olaylar.Add($s); Write-Host $s }
$ff = $null; $p = $null
try {
    $mkv = Join-Path $cikti "kayit.mkv"
    $arg = "-hide_banner -y -f lavfi -i ddagrab=output_idx=${Ekran}:framerate=${Fps}:draw_mouse=0 -c:v h264_nvenc -preset p4 -rc vbr -cq 23 -g 60 `"$mkv`""
    $psi = New-Object System.Diagnostics.ProcessStartInfo "cmd.exe", "/c `"ffmpeg $arg 2> `"$(Join-Path $cikti 'ffmpeg.txt')`"`""
    $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.CreateNoWindow = $true
    $ff = [System.Diagnostics.Process]::Start($psi)
    for ($i = 0; $i -lt 50 -and -not ((Test-Path $mkv) -and (Get-Item $mkv).Length -gt 2048); $i++) { Start-Sleep -Milliseconds 100 }
    if ($ff.HasExited) { throw "ffmpeg başlamadı" }
    $kayitT = Get-Date
    Olay "kayıt başladı"
    Start-Sleep -Milliseconds 700
    $imlec = New-Object Ac+POINT; [void][Ac]::GetCursorPos([ref]$imlec)
    $satir0 = if (Test-Path $gunluk) { (Get-Content $gunluk -Encoding UTF8).Count } else { 0 }
    $baslaT = Get-Date
    $p = Start-Process $exe -PassThru
    Olay ("pencere başlatıldı (videoda {0} sn)" -f (($baslaT - $kayitT).TotalSeconds.ToString("0.000", $inv)))
    for ($i = 0; $i -lt 300 -and $p.MainWindowHandle -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 10; $p.Refresh() }
    $on = [Ac]::Front($p.MainWindowHandle)
    Olay ("pencere tutamağı {0} sn sonra, önde: {1}" -f ((Get-Date) - $baslaT).TotalSeconds.ToString("0.000", $inv), $on)
    $acilis = $null
    while (((Get-Date) - $baslaT).TotalSeconds -lt 60 -and -not $acilis) {
        Start-Sleep -Milliseconds 200
        $c = New-Object Ac+POINT; [void][Ac]::GetCursorPos([ref]$c)
        if ($c.X -ne $imlec.X -or $c.Y -ne $imlec.Y) { throw "fare kıpırdadı: masada biri var, koşu durduruldu" }
        $yeni = @(Get-Content $gunluk -Encoding UTF8 | Select-Object -Skip $satir0)
        $acilis = $yeni | Where-Object { $_ -like "*pencere: açılış*" } | Select-Object -First 1
        $hata = $yeni | Where-Object { $_ -like "*sahne-yuklenemedi*" -or $_ -like "*WebView2 yüklenemedi*" } | Select-Object -First 1
        if ($hata) { throw "sayfa: $hata" }
    }
    if (-not $acilis) { throw "60 sn'de açılış satırı yok" }
    Olay $acilis
    $p.Refresh()
    $r = New-Object Ac+RECT; [void][Ac]::GetWindowRect($p.MainWindowHandle, [ref]$r)
    Olay "pencere dikdörtgeni: $($r.L),$($r.T) - $($r.R),$($r.B)"
    Start-Sleep -Milliseconds ([int]($Sonra * 1000))
}
catch { Olay "HATA: $_" }
finally {
    if ($p -and -not $p.HasExited) {
        $p.Refresh(); [void][Ac]::PostMessage($p.MainWindowHandle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
        if (-not $p.WaitForExit(5000)) { $p.Kill() }
        Olay "pencere kapandı"
    }
    if ($ff -and -not $ff.HasExited) {
        Start-Sleep -Milliseconds 300
        # ffmpeg (under cmd.exe, which hands it its stdin) stops cleanly on "q"
        try { $ff.StandardInput.WriteLine("q"); $ff.StandardInput.Flush() } catch { }
        if (-not $ff.WaitForExit(8000)) {
            Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.ParentProcessId -eq $ff.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            try { $ff.Kill() } catch { }
        }
    }
    # only our own lock: another run may have written its own meanwhile
    if ((Test-Path $kilit) -and ((Get-Content $kilit -Raw) -like "$Ad *")) { Remove-Item $kilit -Force }
    $olaylar | Set-Content (Join-Path $cikti "olaylar.txt") -Encoding UTF8
}
if ($baslaT -and (Test-Path $mkv)) {
    $kareler = Join-Path $cikti "kareler"; New-Item -ItemType Directory -Force $kareler | Out-Null
    $bas = ($baslaT - $kayitT).TotalSeconds - 0.3
    & ffmpeg -hide_banner -loglevel error -ss $bas.ToString("0.000", $inv) -i $mkv -vf "scale=960:-1" -q:v 3 (Join-Path $kareler "%04d.jpg")
    $py = @"
import sys, os, glob
from PIL import Image, ImageStat
d, fps, off = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
out = []
for i, f in enumerate(sorted(glob.glob(os.path.join(d, '*.jpg')))):
    im = Image.open(f).convert('L')
    out.append('%7.3f  %6.2f  %s' % (i / fps + off, ImageStat.Stat(im).mean[0], os.path.basename(f)))
open(os.path.join(os.path.dirname(d), 'parlaklik.txt'), 'w').write('\n'.join(out) + '\n')
"@
    $pyf = Join-Path $cikti "parlaklik.py"; Set-Content $pyf $py -Encoding UTF8
    & python $pyf $kareler $Fps (-0.3)
    "çıktı: $cikti"
}
