# Kontrol Merkezi penceresini sürer (geliştirme): büyüt, öne getir, tuş gönder.
#   powershell -File araclar\pencere-sur.ps1 buyut | normal | tus "{TAB}"
param([string]$Is = "buyut", [string]$Tus = "")
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Ws {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$p = Get-Process KontrolMerkezi -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ceq "Kontrol Merkezi" } | Select-Object -First 1
if (-not $p) { "pencere yok"; exit 1 }
$h = $p.MainWindowHandle
switch ($Is) {
  "buyut" { [void][Ws]::ShowWindow($h, 3) }
  "normal" { [void][Ws]::ShowWindow($h, 9) }
  "tus" {
    [void][Ws]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 300
    (New-Object -ComObject WScript.Shell).SendKeys($Tus)
  }
}
"tamam: $Is $Tus"
