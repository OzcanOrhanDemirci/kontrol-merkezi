# Measures the frame pacing of the real Kontrol Merkezi window. Copies bin\Release to .tmp\ui-olcum (the running
# service holds bin\Release), starts the window from the copy (it connects to the service already running),
# maximizes it (or not), waits, then prints the perf lines the page wrote to gunluk.txt during the run, takes a
# PrintWindow screenshot and closes the window. Usage:
#   powershell -File araclar\pencere-tempo.ps1 [-Sure 45] [-Normal] [-Ad etiket]
param([int]$Sure = 45, [switch]$Normal, [string]$Ad = "tempo")
$ErrorActionPreference = "Stop"
$kok = Split-Path -Parent $PSScriptRoot
$kopya = Join-Path $kok ".tmp\ui-olcum"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Pt {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
if (Get-Process KontrolMerkezi -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ceq "Kontrol Merkezi" }) { "bir pencere zaten açık; önce kapatın"; exit 1 }
if (Test-Path $kopya) { Remove-Item -Recurse -Force $kopya }
Copy-Item -Recurse (Join-Path $kok "bin\Release") $kopya
$log = Join-Path $env:LOCALAPPDATA "KontrolMerkezi\gunluk.txt"
$once = if (Test-Path $log) { (Get-Content $log -Encoding utf8).Count } else { 0 }
$p = Start-Process (Join-Path $kopya "KontrolMerkezi.exe") -PassThru
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 100 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 200; $p.Refresh(); $h = $p.MainWindowHandle }
if ($h -eq [IntPtr]::Zero) { "pencere açılmadı"; exit 1 }
if (-not $Normal) { [void][Pt]::ShowWindow($h, 3) }
[void][Pt]::SetForegroundWindow($h)
Start-Sleep -Seconds $Sure
& (Join-Path $PSScriptRoot "pencere-goruntu.ps1") (Join-Path $kok "araclar\cikti\pencere-$Ad.png")
[void][Pt]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Seconds 2
if (-not $p.HasExited) { $p.Kill() }
(Get-Content $log -Encoding utf8 | Select-Object -Skip $once) | Where-Object { $_ -match "pencere: (kare|ilk-kare)" }
