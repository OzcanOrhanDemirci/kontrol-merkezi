# Kontrol Merkezi penceresine gerçek girdi (SendInput) ile tıklar: önce pencereyi öne alır ve öne geldiğini
# doğrular; öne gelmediyse TIKLAMAZ (tık başka bir pencereye gitmesin). Koordinatlar pencerenin istemci alanına göre.
#   powershell -File araclar\pencere-tikla.ps1 -X 1351 -Y 66
param([int]$X, [int]$Y)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Si {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTU { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTU u; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  public static void Key(ushort vk, bool up) { var a = new INPUT[1]; a[0].type = 1; a[0].u.ki.vk = vk; a[0].u.ki.flags = up ? 2u : 0u; SendInput(1, a, Marshal.SizeOf(typeof(INPUT))); }
  public static void Click(int x, int y) {
    int w = GetSystemMetrics(78), h = GetSystemMetrics(79), l = GetSystemMetrics(76), t = GetSystemMetrics(77);
    var a = new INPUT[3];
    for (int i = 0; i < 3; i++) { a[i].type = 0; a[i].u.mi.dx = (int)((x - l) * 65535.0 / (w - 1)); a[i].u.mi.dy = (int)((y - t) * 65535.0 / (h - 1)); }
    a[0].u.mi.flags = 0x8001 | 0x4000;  // MOVE | ABSOLUTE | VIRTUALDESK
    a[1].u.mi.flags = 0x0002 | 0x8000 | 0x4000;  // LEFTDOWN
    a[2].u.mi.flags = 0x0004 | 0x8000 | 0x4000;  // LEFTUP
    SendInput(3, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
$p = Get-Process KontrolMerkezi -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ceq "Kontrol Merkezi" } | Select-Object -First 1
if (-not $p) { "pencere yok"; exit 1 }
$h = $p.MainWindowHandle
for ($i = 0; $i -lt 5 -and [Si]::GetForegroundWindow() -ne $h; $i++) {
    [Si]::Key(0x12, $false); [Si]::Key(0x12, $true)   # an Alt tap lets this process move the foreground
    [void][Si]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 250
}
if ([Si]::GetForegroundWindow() -ne $h) { "pencere öne gelmedi; tıklanmadı"; exit 2 }
$pt = New-Object Si+POINT; $pt.X = $X; $pt.Y = $Y
[void][Si]::ClientToScreen($h, [ref]$pt)
[Si]::Click($pt.X, $pt.Y)
"tıklandı: istemci $X,$Y -> ekran $($pt.X),$($pt.Y)"
