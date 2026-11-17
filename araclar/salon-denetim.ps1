# Real-window check of the underground hall, the way Özcan sees it: starts the REAL WebView2 window (from a copy of a
# built bin\Release or of the installed folder, connected to the service already running), maximized, records the
# monitor with ffmpeg ddagrab from before the window appears (so the opening is on the video), drives it by keyboard
# (Tab = journey, Left/Right = which fan lever, Enter = pull it), takes PrintWindow screenshots, toggles the real fans
# and puts them back, holds a hot preview temperature on the real lights and clears it, then closes the window and
# writes the frame pacing the page logged plus the freezes visible on the video.
#
#   powershell -File araclar\salon-denetim.ps1 [-Bolum acilis|yolculuk|fanlar|sicaklik|hepsi] [-Kaynak <klasör>]
#              [-Sicaklik 72] [-Ekran 0] [-KayitYok]
#
#   -Kaynak   bin\Release of this repository (default) or the installed folder (C:\Program Files\KontrolMerkezi)
#   -Ekran    ddagrab output index of the monitor the window opens on (the one under the mouse)
#   -BosSure  seconds without keyboard/mouse input required before it starts (default 300): the window is topmost
#             and covers the screen for minutes, so it does not start under someone working at the desk, and it
#             stops (putting everything back) the moment the mouse moves during the run
#
# Run it with no bake running (it refuses while salon.exe runs) and with Özcan's own window closed. A full run
# (hepsi) takes about 3-4 minutes; the hall renders on the GPU all that time.
#
# Output: .tmp\denetim\<time>\ : NN-*.png screenshots, kayit.mp4 (and kayit.mkv), video-kareler\*.jpg (frames from
# the video at the moments in olaylar.txt), olaylar.txt (timeline: wall clock and seconds into the video),
# tempo.txt (the page's perf lines), ozet.txt (everything the run found, Turkish).
#
# Safety (docs and the project notebook): the window holds no hardware, the running service does. The script refuses
# to start unless the service's pipe is there, so the window never falls back to starting a service of its own from
# the copy. Fans are toggled through the window's own levers and each is put back to the state it was found in, also
# on error (finally; through the pipe if the window is gone). The preview temperature ("onizle", volatile colours on
# the real devices, the GPU's light included) and the RGB on/off state are restored in finally too. The service is
# never stopped or restarted.
param(
    [ValidateSet("acilis", "yolculuk", "fanlar", "sicaklik", "hepsi")][string]$Bolum = "hepsi",
    [string]$Kaynak = "",
    [double]$Sicaklik = 72,
    [int]$Ekran = 0,
    [int]$BosSure = 300,
    [switch]$KayitYok,
    [int]$Hz = 30
)
$ErrorActionPreference = "Stop"
$inv = [Globalization.CultureInfo]::InvariantCulture
$kok = Split-Path -Parent $PSScriptRoot
if (-not $Kaynak) { $Kaynak = Join-Path $kok "bin\Release" }
$Kaynak = (Resolve-Path $Kaynak).Path
$cikti = Join-Path $kok (".tmp\denetim\" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$kopya = Join-Path $kok ".tmp\denetim\uygulama"
$gunluk = Join-Path $env:LOCALAPPDATA "KontrolMerkezi\gunluk.txt"

Add-Type -ReferencedAssemblies System.Drawing, System.Core @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Dn {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTU { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTU u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  /// <summary>Keeps the window above every other window for the run (the recording films the monitor).</summary>
  public static void Topmost(IntPtr h, bool on) { SetWindowPos(h, new IntPtr(on ? -1 : -2), 0, 0, 0, 0, 0x0013); }

  public static void Key(ushort vk, bool up) {
    var a = new INPUT[1];
    a[0].type = 1; a[0].u.ki.vk = vk; a[0].u.ki.scan = (ushort)MapVirtualKey(vk, 0);
    bool ext = vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28;   // arrows are extended keys
    a[0].u.ki.flags = (up ? 2u : 0u) | (ext ? 1u : 0u);
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Tap(ushort vk) { Key(vk, false); Thread.Sleep(90); Key(vk, true); }
  /// <summary>Brings the window to the front (an Alt tap lets a background process move the foreground).</summary>
  public static bool Front(IntPtr h) {
    for (int i = 0; i < 6 && GetForegroundWindow() != h; i++) {
      Key(0x12, false); Key(0x12, true);
      SetForegroundWindow(h);
      Thread.Sleep(250);
    }
    return GetForegroundWindow() == h;
  }

  /// <summary>PrintWindow (PW_CLIENTONLY | PW_RENDERFULLCONTENT) of the client area: what the page draws, without
  /// the invisible frame a maximized window hangs off the screen.</summary>
  public static Bitmap Capture(IntPtr h) {
    RECT r; GetClientRect(h, out r);
    int w = r.R - r.L, hh = r.B - r.T;
    if (w <= 0 || hh <= 0) return null;
    var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr dc = g.GetHdc();
      PrintWindow(h, dc, 3);
      g.ReleaseHdc(dc);
    }
    return bmp;
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cb, t; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO l);
  /// <summary>Milliseconds since the last keyboard or mouse input on this desktop.</summary>
  public static uint IdleMs() { var l = new LASTINPUTINFO(); l.cb = 8; GetLastInputInfo(ref l); return unchecked((uint)Environment.TickCount - l.t); }
  /// <summary>A cheap look at the screen under the window's client area (the window is topmost): for polling,
  /// it does not ask the page to render the way PrintWindow does.</summary>
  public static Bitmap Screen(IntPtr h) {
    RECT r; GetClientRect(h, out r);
    var p = new POINT(); ClientToScreen(h, ref p);
    int w = r.R - r.L, hh = r.B - r.T;
    if (w <= 0 || hh <= 0) return null;
    var bmp = new Bitmap(w, hh, PixelFormat.Format24bppRgb);
    using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(p.X, p.Y, 0, 0, new Size(w, hh));
    return bmp;
  }
  /// <summary>A 160x90 luma thumbnail (0..255) for comparing pictures.</summary>
  public static byte[] Thumb(Bitmap b) {
    using (var t = new Bitmap(160, 90, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(t)) {
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
        g.DrawImage(b, 0, 0, 160, 90);
      }
      var d = t.LockBits(new Rectangle(0, 0, 160, 90), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
      var raw = new byte[d.Stride * 90];
      Marshal.Copy(d.Scan0, raw, 0, raw.Length);
      t.UnlockBits(d);
      var y = new byte[160 * 90];
      for (int j = 0; j < 90; j++) for (int i = 0; i < 160; i++) {
        int o = j * d.Stride + i * 3;
        y[j * 160 + i] = (byte)((raw[o] * 29 + raw[o + 1] * 150 + raw[o + 2] * 77) >> 8);
      }
      return y;
    }
  }
  public static double Mean(byte[] a) { double s = 0; foreach (var v in a) s += v; return s / a.Length; }
  public static double Diff(byte[] a, byte[] b) { double s = 0; for (int i = 0; i < a.Length; i++) s += Math.Abs(a[i] - b[i]); return s / a.Length; }
}

/// <summary>A second client of the service's pipe: keeps the latest "durum" and "isik" lines, sends commands.</summary>
public sealed class DnBoru : IDisposable {
  NamedPipeClientStream _p; StreamWriter _w; Thread _t; volatile bool _end;
  public volatile string Durum, Isik;
  public DnBoru() {
    _p = new NamedPipeClientStream(".", "KontrolMerkezi", PipeDirection.InOut, PipeOptions.Asynchronous);
    _p.Connect(3000);
    _w = new StreamWriter(_p, new UTF8Encoding(false)); _w.NewLine = "\n";
    _t = new Thread(Read); _t.IsBackground = true; _t.Start();
  }
  void Read() {
    try {
      var r = new StreamReader(_p, Encoding.UTF8);
      string line;
      while (!_end && (line = r.ReadLine()) != null) {
        if (line.StartsWith("{\"tip\":\"durum\"")) Durum = line;
        else if (line.StartsWith("{\"tip\":\"isik\"")) Isik = line;
      }
    } catch { }
  }
  public void Send(string json) { lock (this) { _w.Write(json + "\n"); _w.Flush(); } }
  public void Dispose() { _end = true; try { _p.Dispose(); } catch { } }
}
"@

# ------------------------------------------------------------------ small helpers
$script:t0 = $null          # wall clock of the recording's start
$script:olaylar = New-Object System.Collections.Generic.List[string]
$script:videoAnlari = New-Object System.Collections.Generic.List[object]
$script:sira = 0
$script:h = [IntPtr]::Zero
function Saniye { if ($script:t0) { ((Get-Date) - $script:t0).TotalSeconds } else { 0 } }
function Olay([string]$metin, [switch]$Kare) {
    $s = Saniye
    $satir = "{0}  video {1,6}s  {2}" -f (Get-Date -Format "HH:mm:ss.fff"), $s.ToString("0.0", $inv), $metin
    $script:olaylar.Add($satir); Write-Host $satir
    if ($Kare) { $script:videoAnlari.Add(@{ s = $s; ad = $metin }) }
}
# Someone at the desk: the script only uses the keyboard, so a moving mouse is a person (11-16: a test window over
# Özcan's screen took his clicks on the fan levers). Every wait watches the cursor and stops the run if it moves.
$script:imlec = $null
function ImlecDenetle {
    if (-not $script:imlec) { return }
    $c = New-Object Dn+POINT; [void][Dn]::GetCursorPos([ref]$c)
    if ($c.X -ne $script:imlec.X -or $c.Y -ne $script:imlec.Y) { $script:imlec = $null; throw "fare kıpırdadı: masada biri var, denetim durduruldu" }
}
function Bekle([double]$sn) {
    $son = (Get-Date).AddMilliseconds($sn * 1000)
    do { ImlecDenetle; $k = [Math]::Min(100, ($son - (Get-Date)).TotalMilliseconds); if ($k -gt 0) { Start-Sleep -Milliseconds ([int]$k) } } while ((Get-Date) -lt $son)
}
function AnaKadar([datetime]$t, [double]$sn) { $k = ($t.AddSeconds($sn) - (Get-Date)).TotalSeconds; if ($k -gt 0) { Bekle $k } }
function Kare([string]$ad) {
    $script:sira++
    $b = [Dn]::Capture($script:h)
    if (-not $b) { Olay "görüntü alınamadı: $ad"; return $null }
    $yol = Join-Path $cikti ("{0:00}-{1}.png" -f $script:sira, $ad)
    $b.Save($yol, [System.Drawing.Imaging.ImageFormat]::Png)
    $t = [Dn]::Thumb($b); $b.Dispose()
    Olay ("görüntü {0:00}-{1} (parlaklık {2})" -f $script:sira, $ad, [Dn]::Mean($t).ToString("0.0", $inv))
    return , $t
}
function Iz {   # a thumbnail of the screen under the window, without saving
    $b = [Dn]::Screen($script:h); if (-not $b) { return $null }
    $t = [Dn]::Thumb($b); $b.Dispose(); return , $t
}
function Tus([int]$vk, [string]$ad) {
    ImlecDenetle
    if (-not [Dn]::Front($script:h)) { throw "pencere öne gelmedi; '$ad' tuşu gönderilmedi" }
    [Dn]::Tap([uint16]$vk)
    Olay "tuş: $ad" -Kare
}
function Durum { if ($script:boru -and $script:boru.Durum) { $script:boru.Durum | ConvertFrom-Json } else { $null } }
function FanDurum([string]$k) { $d = Durum; if ($d -and $d.fan -and $d.fan.$k) { [string]$d.fan.$k.durum } else { "" } }
function FanOzet {
    $d = Durum; if (-not $d -or -not $d.fan) { return "fan bilgisi yok" }
    $k = ($d.fan.kasa.rpm | ForEach-Object { "$($_.ad) $($_.rpm)" }) -join ", "
    $g = ($d.fan.gpu.rpm | ForEach-Object { "$_" }) -join "/"
    "kasa=$($d.fan.kasa.durum) [$k] | gpu=$($d.fan.gpu.durum) [$g rpm, %$($d.fan.gpu.yuzde)]"
}
# waits until a fan leaves "geciyor" and reaches one of the given states; returns the state
function FanBekle([string]$k, [string[]]$hedef, [int]$sn) {
    $son = (Get-Date).AddSeconds($sn)
    do { $s = FanDurum $k; if ($hedef -contains $s) { return $s }; Bekle 0.3 } while ((Get-Date) -lt $son)
    return (FanDurum $k)
}
# waits until the camera arrived: the change between looks 0.8 s apart falls to a small share of the largest change
# seen on the way (at rest the rotors turn and the camera drifts, so it never reaches zero). The changes are logged
# so the threshold can be checked against a real run.
function VarisBekle([string]$ad, [double]$enAz, [double]$enCok) {
    $basla = Get-Date; $once = Iz; $sakin = 0; $tepe = 0.0; $farklar = @()
    while (((Get-Date) - $basla).TotalSeconds -lt $enCok) {
        Bekle 0.8
        $simdi = Iz
        if ($once -and $simdi) {
            $f = [Dn]::Diff($once, $simdi); $farklar += $f.ToString("0.0", $inv)
            if ($f -gt $tepe) { $tepe = $f }
            $esik = [Math]::Max(1.5, 0.15 * $tepe)
            if (((Get-Date) - $basla).TotalSeconds -ge $enAz -and $f -lt $esik) { $sakin++ } else { $sakin = 0 }
            if ($sakin -ge 2) { Olay ("{0}: durdu ({1} sn; farklar {2})" -f $ad, ((Get-Date) - $basla).TotalSeconds.ToString("0.0", $inv), ($farklar -join " ")); return $true }
        }
        $once = $simdi
    }
    Olay "${ad}: $enCok sn içinde durulmadı (farklar $($farklar -join ' '))"; return $false
}
$script:bulgular = New-Object System.Collections.Generic.List[string]
function Bulgu([string]$m) { $script:bulgular.Add($m); Olay "BULGU: $m" }

# ------------------------------------------------------------------ checks before anything starts
if (Get-Process KontrolMerkezi -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ceq "Kontrol Merkezi" }) {
    "Kontrol Merkezi penceresi zaten açık (Özcan'ın penceresi olabilir); kapatılmadan denetim başlamaz."; exit 1
}
if (-not (Test-Path "\\.\pipe\KontrolMerkezi")) {
    "Servisin borusu yok: servis çalışmıyor. Pencere bu durumda kendi servisini başlatmaya kalkar; denetim başlamaz."; exit 1
}
$bos = [Dn]::IdleMs() / 1000
if ($bos -lt $BosSure) {
    "Son klavye/fare girdisi $([int]$bos) sn önce: masada biri olabilir. Pencere ekranın tamamını alır; en az $BosSure sn girdi olmadan başlar (-BosSure)."; exit 1
}
$bake = @(Get-Process salon -ErrorAction SilentlyContinue)
if ($bake.Count) { "salon.exe (fırın) çalışıyor; GPU onun. Bitince yeniden deneyin."; exit 1 }
if (-not (Test-Path (Join-Path $Kaynak "KontrolMerkezi.exe"))) { "KontrolMerkezi.exe yok: $Kaynak"; exit 1 }
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue)
if (-not $ffmpeg -and -not $KayitYok) { "ffmpeg bulunamadı (-KayitYok ile kayıtsız koşulur)"; exit 1 }

New-Item -ItemType Directory -Force $cikti | Out-Null
# the copy: everything but the scene pack; the pack (hundreds of MB) is linked, not copied
if (Test-Path $kopya) {
    $eskiPaket = Join-Path $kopya "sahne"
    if (Test-Path $eskiPaket) { [System.IO.Directory]::Delete($eskiPaket, $false) }   # the junction only, never its target
    Remove-Item -Recurse -Force $kopya
}
New-Item -ItemType Directory -Force $kopya | Out-Null
Get-ChildItem $Kaynak -Force | Where-Object { $_.Name -cne "sahne" } | ForEach-Object { Copy-Item -Recurse $_.FullName $kopya }
$paket = $null
if (Test-Path (Join-Path $Kaynak "sahne\sahne.json")) {
    cmd /c mklink /J "$(Join-Path $kopya 'sahne')" "$(Join-Path $Kaynak 'sahne')" | Out-Null
    $paket = Join-Path $Kaynak "sahne"
} else {
    # the window looks for sahne\paket upwards from the exe (development), as Pencere.cs FindPack does
    for ($d = Get-Item $kopya; $d; $d = $d.Parent) {
        if (Test-Path (Join-Path $d.FullName "sahne\paket\sahne.json")) { $paket = Join-Path $d.FullName "sahne\paket"; break }
    }
}
if (-not $paket) { "Sahne paketi bulunamadı (kaynakta sahne\ yok, yukarıda sahne\paket yok)."; exit 1 }
$exe = Join-Path $kopya "KontrolMerkezi.exe"
# the GPU-light build bytes (notebook): the window never writes to the card, this only tells which build it is
$bytes = [IO.File]::ReadAllBytes($exe); $kartBayt = 0
for ($i = 0; $i -lt $bytes.Length - 3; $i++) { if ($bytes[$i] -eq 0x5A -and $bytes[$i + 1] -eq 0xC6 -and $bytes[$i + 2] -eq 0x3A -and $bytes[$i + 3] -eq 0x28) { $kartBayt++ } }
$bytes = $null
$uiYeri = if (Test-Path (Join-Path $kopya "ui\index.html")) { "exe'nin yanındaki ui\" } else { "exe'ye gömülü ui (%LOCALAPPDATA%\KontrolMerkezi\ui'ye açılır)" }

$basZaman = Get-Date
Olay "denetim: bölüm=$Bolum kaynak=$Kaynak paket=$paket arayüz=$uiYeri kart-baytları=$kartBayt"

$ff = $null; $p = $null
$script:boru = $null
$ilk = @{}          # the state found at the start: kasa, gpu, rgb
$onizlemeVerildi = $false
try {
    $script:boru = New-Object DnBoru
    for ($i = 0; $i -lt 30 -and -not $script:boru.Durum; $i++) { Bekle 0.1 }
    $d0 = Durum
    if (-not $d0) { throw "servis durum göndermedi" }
    $ilk.kasa = [string]$d0.fan.kasa.durum; $ilk.gpu = [string]$d0.fan.gpu.durum; $ilk.rgb = [bool]$d0.rgb.acik
    Olay "başta: $(FanOzet) | rgb açık=$($ilk.rgb)"

    # ---------------------------------------------------------- recording, then the window
    if (-not $KayitYok) {
        $mkv = Join-Path $cikti "kayit.mkv"
        $ffLog = Join-Path $cikti "ffmpeg.txt"
        # ddagrab hands D3D11 frames straight to NVENC; mkv survives a hard stop
        $arg = "-hide_banner -y -f lavfi -i ddagrab=output_idx=${Ekran}:framerate=${Hz}:draw_mouse=0 " +
               "-c:v h264_nvenc -preset p4 -rc vbr -cq 27 -b:v 8M -maxrate 16M -g 60 `"$mkv`""
        $psi = New-Object System.Diagnostics.ProcessStartInfo "cmd.exe", "/c `"`"$($ffmpeg.Source)`" $arg 2> `"$ffLog`"`""
        $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.CreateNoWindow = $true
        $ff = [System.Diagnostics.Process]::Start($psi)
        for ($i = 0; $i -lt 50 -and -not ((Test-Path $mkv) -and (Get-Item $mkv).Length -gt 2048); $i++) { Bekle 0.1 }
        if ($ff.HasExited) { throw "ffmpeg başlamadı: $(Get-Content $ffLog -Raw)" }
        $script:t0 = Get-Date
        Olay "kayıt başladı"
        Bekle 1
    }
    $p = Start-Process $exe -PassThru
    $pencereZaman = Get-Date
    Olay "pencere başlatıldı" -Kare
    for ($i = 0; $i -lt 100 -and $script:h -eq [IntPtr]::Zero; $i++) { Bekle 0.1; $p.Refresh(); $script:h = $p.MainWindowHandle }
    if ($script:h -eq [IntPtr]::Zero) { throw "pencere açılmadı" }
    # the window opens borderless over the whole monitor by itself; SW_MAXIMIZE (3) would drop it to the work area
    [void][Dn]::ShowWindow($script:h, 5)
    [Dn]::Topmost($script:h, $true)
    if (-not [Dn]::Front($script:h)) { Olay "pencere öne gelmedi (yine de en üstte)" }
    $script:imlec = New-Object Dn+POINT; [void][Dn]::GetCursorPos([ref]$script:imlec)
    $r = New-Object Dn+RECT; [void][Dn]::GetClientRect($script:h, [ref]$r)
    Olay "pencere göründü: istemci $($r.R - $r.L)x$($r.B - $r.T)" -Kare
    # the opening: the pack loads (~15 s in the first real run), then the lights strike and the arch follows in ~2 s;
    # the first light is found on the screen, the rest is given 8 s
    $basla = Get-Date; $yandi = $null
    while (((Get-Date) - $basla).TotalSeconds -lt 120) {
        Bekle 0.5
        $t = Iz; if (-not $t) { continue }
        $parlak = [Dn]::Mean($t)
        if ($parlak -gt 4) { $yandi = Get-Date; Olay ("açılış: ilk ışık, pencere başlatıldıktan {0} sn sonra (parlaklık {1})" -f ($yandi - $pencereZaman).TotalSeconds.ToString("0.0", $inv), $parlak.ToString("0.0", $inv)) -Kare; break }
    }
    if (-not $yandi) { throw "açılış: 120 sn'de ekranda ışık yok (sahne yüklenmedi mi? gunluk.txt)" }
    Bekle 8
    [void](Kare "acilis-fanlar")
    $kanca = @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Modules | Where-Object ModuleName -eq 'RTSSHooks64.dll' } catch { $false } }).Count
    Olay "RTSS kancası yüklü WebView2 süreci: $kanca"
    # a quiet stretch: nothing captured, nothing pressed, so the pacing of the hall at rest is measured clean
    Olay "bölüm: dinlenme (20 sn, yakalama yok)"
    Bekle 20
    Olay "bölüm: dinlenme bitti"

    # ---------------------------------------------------------- the journey there and back
    if ($Bolum -eq "yolculuk" -or $Bolum -eq "hepsi") {
        Olay "bölüm: yolculuk"
        $once = Kare "yolculuk-baslangic"
        Tus 0x09 "Tab (RGB'ye yolculuk)"
        $tt = Get-Date
        foreach ($an in 1.5, 3.5, 5.5) { AnaKadar $tt $an; [void](Kare ("yolculuk-gidis-{0}sn" -f $an.ToString($inv))) }
        [void](VarisBekle "gidiş" 3 30)
        $varis = Kare "yolculuk-varis-rgb"
        $fark = [Dn]::Diff($once, $varis)
        Olay ("gidiş: başlangıçla varış farkı {0}" -f $fark.ToString("0.0", $inv))
        if ($fark -lt 6) { Bulgu "Tab'dan sonra kamera yer değiştirmemiş görünüyor (fark $($fark.ToString('0.0', $inv)))" }
        Bekle 3
        Tus 0x09 "Tab (fanlara dönüş)"
        $tt = Get-Date
        foreach ($an in 2, 5) { AnaKadar $tt $an; [void](Kare ("yolculuk-donus-{0}sn" -f $an)) }
        [void](VarisBekle "dönüş" 3 30)
        $donus = Kare "yolculuk-varis-fanlar"
        $f1 = [Dn]::Diff($varis, $donus); $f2 = [Dn]::Diff($once, $donus)
        Olay ("dönüş: rgb'den fark {0}, ilk fanlar görünümünden fark {1}" -f $f1.ToString("0.0", $inv), $f2.ToString("0.0", $inv))
        if ($f1 -lt 6) { Bulgu "dönüşte kamera RGB'den ayrılmamış görünüyor" }
        if ($f2 -gt 8) { Bulgu "dönüş sonrası görüntü ilk fanlar görünümünden belirgin farklı (fark $($f2.ToString('0.0', $inv)))" }
    }

    # ---------------------------------------------------------- the fans, both states, through the window's levers
    if ($Bolum -eq "fanlar" -or $Bolum -eq "hepsi") {
        Olay "bölüm: fanlar"
        $karsi = @{ kasa = @{ max = "bios"; bios = "max" }; gpu = @{ max = "oto"; oto = "max" } }
        foreach ($k in "kasa", "gpu") {
            $s = FanBekle $k @("max", "bios", "oto") 20
            if (-not $karsi[$k].ContainsKey($s)) { throw "$k fanı bilinen bir durumda değil ('$s'); fan bölümü atlanmadan önce durduruldu" }
        }
        [void](Kare "fanlar-once")
        Olay "fanlar önce: $(FanOzet)"
        Tus 0x25 "Sol (kasa kolu)"
        Bekle 0.4
        $hedefK = $karsi.kasa[(FanDurum "kasa")]
        Tus 0x0D "Enter (kasa kolu)"
        $s = FanBekle "kasa" @($hedefK) 45
        if ($s -ne $hedefK) { throw "kasa kolu çekildi ama servis '$hedefK' olmadı ('$s')" }
        Olay "kasa: $s" -Kare
        Bekle 8
        [void](Kare "fanlar-kasa-$s")
        Olay "fanlar: $(FanOzet)"
        Tus 0x27 "Sağ (GPU kolu)"
        Bekle 0.4
        $hedefG = $karsi.gpu[(FanDurum "gpu")]
        Tus 0x0D "Enter (GPU kolu)"
        $s = FanBekle "gpu" @($hedefG) 45
        if ($s -ne $hedefG) { throw "GPU kolu çekildi ama servis '$hedefG' olmadı ('$s')" }
        Olay "gpu: $s" -Kare
        Bekle 8
        [void](Kare "fanlar-ikisi-kasa-$hedefK-gpu-$s")
        Olay "fanlar: $(FanOzet)"
        # back, through the levers too (GPU lever has the focus)
        Tus 0x0D "Enter (GPU kolu, geri)"
        $s = FanBekle "gpu" @($ilk.gpu) 45
        Olay "gpu geri: $s" -Kare
        Tus 0x25 "Sol (kasa kolu)"
        Bekle 0.4
        Tus 0x0D "Enter (kasa kolu, geri)"
        $s = FanBekle "kasa" @($ilk.kasa) 60
        Olay "kasa geri: $s" -Kare
        Bekle 8
        [void](Kare "fanlar-geri")
        Olay "fanlar geri: $(FanOzet)"
    }

    # ---------------------------------------------------------- a hot temperature on the real lights, seen at the arch
    if ($Bolum -eq "sicaklik" -or $Bolum -eq "hepsi") {
        Olay "bölüm: sicaklik"
        Tus 0x09 "Tab (kemere)"
        [void](VarisBekle "kemere gidiş" 3 30)
        [void](Kare "sicaklik-once")
        $script:boru.Send('{"komut":"rgb","acik":true}')
        $script:boru.Send('{"komut":"onizle","c":' + $Sicaklik.ToString($inv) + '}')
        $onizlemeVerildi = $true
        Olay "önizleme: $Sicaklik °C (rgb açık)" -Kare
        Bekle 2.5; [void](Kare ("sicaklik-{0}-2sn" -f $Sicaklik))
        Bekle 8; [void](Kare ("sicaklik-{0}-10sn" -f $Sicaklik))
        $iz = if ($script:boru.Isik) { $script:boru.Isik | ConvertFrom-Json } else { $null }
        if ($iz) { Olay "ışık mesajı: önizleme=$($iz.onizleme -join ',') çıkış=$($iz.cikis -join ',')" }
        $script:boru.Send('{"komut":"onizle"}')
        $script:boru.Send('{"komut":"rgb","acik":' + $ilk.rgb.ToString().ToLowerInvariant() + '}')
        $onizlemeVerildi = $false
        Olay "önizleme temizlendi, rgb açık=$($ilk.rgb)" -Kare
        Bekle 5; [void](Kare "sicaklik-sonra")
        Tus 0x09 "Tab (fanlara)"
        [void](VarisBekle "fanlara dönüş" 3 30)
    }
    Bekle 3
}
catch {
    Bulgu ("HATA: " + $_.Exception.Message)
}
finally {
    # ---------------------------------------------------------- put everything back
    if ($script:boru) {
        try {
            if ($onizlemeVerildi) {
                $script:boru.Send('{"komut":"onizle"}')
                $script:boru.Send('{"komut":"rgb","acik":' + ([bool]$ilk.rgb).ToString().ToLowerInvariant() + '}')
                Olay "finally: önizleme temizlendi, rgb geri"
            }
            foreach ($k in "kasa", "gpu") {
                if (-not $ilk[$k]) { continue }
                $s = FanBekle $k @("max", "bios", "oto", "baska") 60
                if ($s -ne $ilk[$k] -and @("max", "bios", "oto") -contains $s) {
                    $script:boru.Send('{"komut":"fan-' + $k + '"}')
                    $s = FanBekle $k @($ilk[$k]) 60
                    Olay "finally: $k fanı boru üzerinden geri alındı: $s"
                }
                if ($s -ne $ilk[$k]) { Bulgu "$k fanı başladığı duruma ('$($ilk[$k])') dönmedi: '$s'" }
            }
            $d = Durum
            if ($d -and [bool]$d.rgb.acik -ne [bool]$ilk.rgb) { $script:boru.Send('{"komut":"rgb","acik":' + ([bool]$ilk.rgb).ToString().ToLowerInvariant() + '}'); Olay "finally: rgb geri" }
            Olay "sonda: $(FanOzet) | rgb açık=$((Durum).rgb.acik)"
        } catch { Bulgu ("geri alma hatası: " + $_.Exception.Message) }
    }
    if ($script:h -ne [IntPtr]::Zero) { [void][Dn]::PostMessage($script:h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
    if ($p) { if (-not $p.WaitForExit(4000)) { $p.Kill() } ; Olay "pencere kapandı" -Kare }
    # nothing from the copy may stay behind (and never a service from it)
    Get-Process KontrolMerkezi -ErrorAction SilentlyContinue | Where-Object { $yol = $null; try { $yol = $_.Path } catch { }; $yol -and $yol.StartsWith($kopya, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Olay "kopyadan kalan süreç kapatıldı: $($_.Id)"; $_.Kill() }
    if ($ff) {
        Bekle 1.5
        try { $ff.StandardInput.Write("q"); $ff.StandardInput.Flush() } catch { }
        if (-not $ff.WaitForExit(15000)) { $ff.Kill(); Olay "ffmpeg durdurulamadı, öldürüldü (mkv yine de oynar)" }
        Olay "kayıt durdu"
    }
    if ($script:boru) { $script:boru.Dispose() }
}

# ------------------------------------------------------------------ after the run: video, pacing, summary
$ErrorActionPreference = "Continue"     # ffmpeg talks on stderr
$ozet = New-Object System.Collections.Generic.List[string]
$ozet.Add("Salon denetimi $($basZaman.ToString('yyyy-MM-dd HH:mm')) | bölüm: $Bolum | kaynak: $Kaynak")
$ozet.Add("Süre: {0} sn" -f ((Get-Date) - $basZaman).TotalSeconds.ToString("0", $inv))
$donmalar = @()
if ($ff -and (Test-Path (Join-Path $cikti "kayit.mkv"))) {
    $mkv = Join-Path $cikti "kayit.mkv"; $mp4 = Join-Path $cikti "kayit.mp4"
    & $ffmpeg.Source -hide_banner -loglevel error -y -i $mkv -c copy -movflags +faststart $mp4
    # freezes on the screen: no change for 150 ms or more (the camera drifts and the rotors turn, so a still
    # picture is a stall). The black seconds before the window appears are frozen too and are not reported.
    $fd = & $ffmpeg.Source -hide_banner -i $mkv -vf "scale=640:-1,freezedetect=n=-55dB:d=0.15" -map 0:v -f null - 2>&1 | Out-String
    $bas = [regex]::Matches($fd, "freeze_start: ([0-9.]+)") | ForEach-Object { [double]::Parse($_.Groups[1].Value, $inv) }
    $sur = [regex]::Matches($fd, "freeze_duration: ([0-9.]+)") | ForEach-Object { [double]::Parse($_.Groups[1].Value, $inv) }
    $acilisS = $null
    foreach ($o in $script:videoAnlari) { if ($o.ad -clike "açılış: ilk ışık*") { $acilisS = $o.s } }
    for ($i = 0; $i -lt @($bas).Count; $i++) {
        $b = @($bas)[$i]; $u = if ($i -lt @($sur).Count) { @($sur)[$i] } else { $null }
        if ($acilisS -and $b -lt $acilisS) { continue }
        $yakin = ($script:olaylar | Where-Object { $_ -cmatch "video +([0-9.]+)s" -and [double]::Parse($Matches[1], $inv) -le $b } | Select-Object -Last 1)
        $donmalar += ("  {0}s, {1}  (önceki olay: {2})" -f $b.ToString("0.00", $inv), $(if ($u) { ($u * 1000).ToString("0", $inv) + " ms" } else { "sona kadar" }), $yakin)
    }
    # frames from the video at the marked moments (and the opening, every half second for 4 s after the first light)
    $vk = Join-Path $cikti "video-kareler"; New-Item -ItemType Directory -Force $vk | Out-Null
    $anlar = New-Object System.Collections.Generic.List[object]
    foreach ($o in $script:videoAnlari) { $anlar.Add(@{ s = $o.s + 0.3; ad = $o.ad }) }
    if ($acilisS) { for ($j = -1.0; $j -le 4; $j += 0.5) { $anlar.Add(@{ s = $acilisS + $j; ad = "acilis" + $j.ToString("+0.0;-0.0", $inv) }) } }
    $n = 0
    foreach ($a in $anlar) {
        $n++
        $temiz = ($a.ad -creplace '[^0-9A-Za-zçğıöşüÇĞİÖŞÜ+.-]+', '_').Trim('_')
        if ($temiz.Length -gt 50) { $temiz = $temiz.Substring(0, 50) }
        $jpg = Join-Path $vk ("{0:000}s-{1}.jpg" -f [int]$a.s, $temiz)
        & $ffmpeg.Source -hide_banner -loglevel error -y -ss $a.s.ToString("0.00", $inv) -i $mp4 -frames:v 1 -vf "scale=1600:-1" -q:v 3 $jpg
    }
    $ozet.Add("Video: $mp4 ({0} MB)" -f ((Get-Item $mp4).Length / 1MB).ToString("0", $inv))
}

# the page's perf lines (one per 10 s: that window's frame intervals) from the run
$tempo = @()
if (Test-Path $gunluk) {
    $tempo = Get-Content $gunluk -Encoding utf8 | Where-Object {
        $_ -cmatch "^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)  pencere: kare" -and [datetime]::ParseExact($Matches[1], "yyyy-MM-dd HH:mm:ss.fff", $inv) -ge $basZaman }
}
$tempo | Set-Content (Join-Path $cikti "tempo.txt") -Encoding utf8
$p50 = @(); $p99 = @(); $uzunlar = @(); $dinlenme = @(); $toplamN = 0
foreach ($s in $tempo) {
    if ($s -cmatch "p50=([0-9.]+) p95=[0-9.]+ p99=([0-9.]+) max=([0-9.]+) uzun=(\d+).* n=(\d+)") {
        $a50 = [double]::Parse($Matches[1], $inv); $a99 = [double]::Parse($Matches[2], $inv); $mx = [double]::Parse($Matches[3], $inv)
        $nn = [int]$Matches[5]; $toplamN += $nn
        $p50 += $a50; $p99 += $a99
        $saat = $s.Substring(11, 12)
        # the section the window's 10 s ended in (the timeline's "bölüm:" marks)
        $bolumu = ($script:olaylar | Where-Object { $_ -clike "*bölüm: *" -and $_.Substring(0, 12) -le $saat } | Select-Object -Last 1)
        $bolumu = if ($bolumu) { ($bolumu -csplit "bölüm: ")[1] } else { "açılış" }
        if ($bolumu -ceq "dinlenme (20 sn, yakalama yok)") { $dinlenme += $s }
        if ($mx -gt 50) { $uzunlar += ("  " + $saat + "  [" + $bolumu + "]  max=" + $mx + " ms  " + (($s -csplit "yer=")[1])) }
    }
}
if ($p50.Count) {
    $s50 = $p50 | Sort-Object; $s99 = $p99 | Sort-Object
    $ozet.Add(("Kare temposu ({0} pencere, {1} kare): p50 {2} ms (10 sn'lik pencerelerin ortancası), p99 en kötü pencerede {3} ms, ortanca pencerede {4} ms" -f
        $p50.Count, $toplamN, $s50[[int]($s50.Count / 2)], $s99[-1], $s99[[int]($s99.Count / 2)]))
    if ($dinlenme.Count) { $ozet.Add("Dinlenmede (yakalama ve tuş yok): " + (($dinlenme | ForEach-Object { ($_ -csplit "pencere: kare ")[1] }) -join " || ")) }
    if ($uzunlar.Count) { $ozet.Add("50 ms'yi aşan karesi olan 10 sn'lik pencereler:"); $uzunlar | ForEach-Object { $ozet.Add($_) } }
    else { $ozet.Add("50 ms'yi aşan kare yok.") }
} else { $ozet.Add("Sayfa tempo satırı yazmadı (pencere 10 sn'den kısa mı açık kaldı?).") }
if ($ff) {
    if ($donmalar.Count) { $ozet.Add("Videoda donma (150 ms+ hiç değişmeyen ekran), ilk ışıktan sonra:"); $donmalar | ForEach-Object { $ozet.Add($_) } }
    else { $ozet.Add("Videoda ilk ışıktan sonra 150 ms+ donma yok.") }
}
if ($script:bulgular.Count) { $ozet.Add("Bulgular:"); $script:bulgular | ForEach-Object { $ozet.Add("  " + $_) } }
$ozet.Add("Olaylar: olaylar.txt; görüntüler: NN-*.png; videodan kareler: video-kareler\")
$script:olaylar | Set-Content (Join-Path $cikti "olaylar.txt") -Encoding utf8
$ozet | Set-Content (Join-Path $cikti "ozet.txt") -Encoding utf8
""
$ozet
"Çıktı: $cikti"
