# Kontrol Merkezi simgesini (kontrol.ico) uretir: koyu zemin, sicaklik paletinden bir isik halkasi, ortada pervane.
# Her boyut ayri cizilir ki kucukte bulanmasin. Kullanim: powershell -NoProfile -File araclar\ikon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$stops = @(
    @(0.00, 230, 240, 255), @(0.17, 110, 190, 255), @(0.34, 20, 50, 255), @(0.50, 0, 200, 170),
    @(0.66, 255, 210, 0), @(0.83, 255, 110, 0), @(1.00, 255, 0, 0)
)
function Palet([double]$t) {
    for ($i = 1; $i -lt $stops.Count; $i++) {
        if ($t -le $stops[$i][0]) {
            $a = $stops[$i - 1]; $b = $stops[$i]
            $u = ($t - $a[0]) / ($b[0] - $a[0])
            return [System.Drawing.Color]::FromArgb(255, [int]($a[1] + ($b[1] - $a[1]) * $u), [int]($a[2] + ($b[2] - $a[2]) * $u), [int]($a[3] + ($b[3] - $a[3]) * $u))
        }
    }
    return [System.Drawing.Color]::FromArgb(255, 255, 0, 0)
}

function Draw([int]$n) {
    $bmp = New-Object System.Drawing.Bitmap $n, $n, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)

    $r = [Math]::Max(2, [int]($n * 0.22))
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90); $p.AddArc($n - 2 * $r - 1, 0, 2 * $r, 2 * $r, 270, 90)
    $p.AddArc($n - 2 * $r - 1, $n - 2 * $r - 1, 2 * $r, 2 * $r, 0, 90); $p.AddArc(0, $n - 2 * $r - 1, 2 * $r, 2 * $r, 90, 90)
    $p.CloseFigure()
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point 0, $n), ([System.Drawing.Color]::FromArgb(255, 24, 26, 32)), ([System.Drawing.Color]::FromArgb(255, 6, 7, 10))
    $g.FillPath($bg, $p)

    # halka: 270 derecelik palet yayi (soguktan sicaga), altta bosluk
    $c = $n / 2.0; $rad = $n * 0.33; $w = [Math]::Max(1.5, $n * 0.085)
    $seg = 120
    for ($k = 0; $k -lt $seg; $k++) {
        $t = $k / ($seg - 1)
        $pen = New-Object System.Drawing.Pen (Palet $t), $w
        $start = 135 + 270 * $k / $seg
        $g.DrawArc($pen, [float]($c - $rad), [float]($c - $rad), [float](2 * $rad), [float](2 * $rad), [float]$start, [float](270 / $seg + 0.8))
        $pen.Dispose()
    }

    # pervane: uc kanat
    $blade = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 222, 226, 234))
    for ($k = 0; $k -lt 3; $k++) {
        $g.ResetTransform(); $g.TranslateTransform($c, $c); $g.RotateTransform(120 * $k + 20)
        $g.FillEllipse($blade, [float](-0.075 * $n), [float](-0.215 * $n), [float](0.15 * $n), [float](0.215 * $n))
    }
    $g.ResetTransform()
    $hub = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 12, 13, 17))
    $g.FillEllipse($hub, [float]($c - $n * 0.05), [float]($c - $n * 0.05), [float]($n * 0.1), [float]($n * 0.1))
    $g.Dispose()
    return $bmp
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) { $b = Draw $s; $ms = New-Object System.IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); if ($s -eq 256) { $b.Save((Join-Path $PSScriptRoot 'cikti\ikon-256.png')) }; $b.Dispose(); , $ms.ToArray() }
$out = Join-Path (Split-Path $PSScriptRoot) 'kontrol.ico'
$fs = [System.IO.File]::Create($out); $bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$off = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $d = $pngs[$i]
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$d.Length); $bw.Write([uint32]$off); $off += $d.Length
}
foreach ($d in $pngs) { $bw.Write($d) }
$bw.Close()
"yazildi: $out"
