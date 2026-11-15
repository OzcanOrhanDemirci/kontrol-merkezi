# Kontrol Merkezi penceresinin görüntüsünü alır (PrintWindow, PW_RENDERFULLCONTENT): pencere başka pencerelerin
# altında kalsa da içeriği doğru yakalanır. Kullanım: powershell -File araclar\pencere-goruntu.ps1 <cikti.png>
param([string]$Cikti = "pencere.png")
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Pw {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$p = Get-Process KontrolMerkezi -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ceq "Kontrol Merkezi" } | Select-Object -First 1
$h = if ($p) { $p.MainWindowHandle } else { [IntPtr]::Zero }
if ($h -eq [IntPtr]::Zero) { "pencere yok"; exit 1 }
$r = New-Object Pw+RECT
[void][Pw]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[void][Pw]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc); $g.Dispose()
$bmp.Save($Cikti, [System.Drawing.Imaging.ImageFormat]::Png)
"$w x $hh -> $Cikti"
