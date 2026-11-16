# Kontrol Merkezi penceresinde donma testi (sabah, RTSS/Afterburner açıkken ve kapalıyken bir kez):
# pencereyi tam ekran açar, -Sure saniye çizdirir, 100 ms'yi aşan kare aralıklarını sayar ve pencerenin WebView2
# süreçlerinde RTSS kancasının (RTSSHooks64.dll) olup olmadığını söyler. Kurulu programı (Program Files) kullanır,
# yoksa bin\Release'in bir kopyasını.
#   powershell -ExecutionPolicy Bypass -File araclar\donma-testi.ps1 [-Sure 120]
param([int]$Sure = 120)
$ErrorActionPreference = "Stop"
$kok = Split-Path -Parent $PSScriptRoot
$kurulu = Join-Path $env:ProgramFiles "KontrolMerkezi\KontrolMerkezi.exe"
if (Test-Path $kurulu) { $exe = $kurulu }
else {
    $kopya = Join-Path $kok ".tmp\donma-testi"
    if (Test-Path $kopya) { Remove-Item -Recurse -Force $kopya }
    Copy-Item -Recurse (Join-Path $kok "bin\Release") $kopya
    $exe = Join-Path $kopya "KontrolMerkezi.exe"
}
Add-Type -Namespace Dt -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'
if (Get-Process KontrolMerkezi -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ceq "Kontrol Merkezi" }) { "Kontrol Merkezi penceresi açık; önce kapatın."; exit 1 }
$log = Join-Path $env:LOCALAPPDATA "KontrolMerkezi\gunluk.txt"
$once = if (Test-Path $log) { (Get-Content $log -Encoding utf8).Count } else { 0 }
$p = Start-Process $exe -PassThru
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 100 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 200; $p.Refresh(); $h = $p.MainWindowHandle }
if ($h -eq [IntPtr]::Zero) { "pencere açılmadı"; exit 1 }
[void][Dt.U]::ShowWindow($h, 3)
Start-Sleep -Seconds 10
$kanca = @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Modules | Where-Object ModuleName -eq 'RTSSHooks64.dll' } catch { $false } }).Count
Start-Sleep -Seconds ([Math]::Max(1, $Sure - 10))
[void][Dt.U]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Seconds 2
if (-not $p.HasExited) { $p.Kill() }
$satirlar = Get-Content $log -Encoding utf8 | Select-Object -Skip $once | Where-Object { $_ -match "pencere: kare" } | Select-Object -Skip 1
$donma = 0; $enCok = 0.0
foreach ($s in $satirlar) {
    if ($s -cmatch 'max=([0-9.]+) uzun=([0-9]+)') {
        $m = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
        if ($m -gt 100) { $donma++ }
        if ($m -gt $enCok) { $enCok = $m }
    }
}
"Süre: $Sure sn | 10 sn'lik pencereler: $($satirlar.Count) | 100 ms'yi aşan donma içeren pencere: $donma | en uzun kare aralığı: $enCok ms"
"RTSS kancası olan WebView2 süreci: $kanca"
