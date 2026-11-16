# Read-only diagnosis (runs elevated via teshis.cmd): which MSI process has which nvapi / NDA / NTIOLib module loaded,
# from where. Lists modules of every MSI process with both a 64-bit and a 32-bit PowerShell (a 64-bit process cannot
# see a 32-bit process's own DLLs). Writes teshis-sonuc.txt next to this script. Changes nothing.
param([switch]$Ic)
$out = Join-Path $PSScriptRoot ($(if ($Ic) { 'teshis-32.txt' } else { 'teshis-sonuc.txt' }))
$lines = @("== " + [IntPtr]::Size * 8 + "-bit PowerShell, " + (Get-Date -Format 'HH:mm:ss'))
foreach ($p in Get-Process) {
    $path = $null; try { $path = $p.Path } catch { }
    if (-not $path -or $path -notmatch 'MSI|Micro') { continue }
    try {
        $mods = $p.Modules | Where-Object { $_.ModuleName -match '^(nvapi|nvapi64|NDA|MysticLight|NTIO|MSI.*I2C|.*Vga|.*VGA)' -or $_.FileName -match 'nvapi' }
        foreach ($m in $mods) { $lines += "{0} ({1}): {2}" -f $p.ProcessName, $p.Id, $m.FileName }
        $lines += "{0} ({1}) {2}: {3} modül görüldü" -f $p.ProcessName, $p.Id, $path, $p.Modules.Count
    } catch { $lines += "{0} ({1}): modüller okunamadı: {2}" -f $p.ProcessName, $p.Id, $_.Exception.Message }
}
$lines | Set-Content -Path $out -Encoding UTF8
if (-not $Ic) {
    & "$env:windir\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Ic
    Get-Content (Join-Path $PSScriptRoot 'teshis-32.txt') | Add-Content -Path $out -Encoding UTF8
    "BITTI" | Add-Content -Path $out -Encoding UTF8
}
