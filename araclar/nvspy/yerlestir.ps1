# Places / removes the nvspy logger next to MSI Mystic Light (runs elevated; called by yerlestir.cmd).
#   -Is kur     stop Mystic Light, copy nvapi.dll (x86) and nvapi64.dll (x64) loggers into its folder, start it,
#               then report which MSI processes loaded which nvapi file (proves the logger is in the path)
#   -Is kaldir  stop Mystic Light, delete the two logger files, start it again
# Result: yerlestir-sonuc.txt next to this script.
param([ValidateSet('kur', 'kaldir')][string]$Is = 'kur')
$ErrorActionPreference = 'Stop'
$ml = 'C:\Program Files (x86)\MSI\MSI Center\Mystic Light'
$src = $PSScriptRoot
$out = Join-Path $src 'yerlestir-sonuc.txt'
Start-Transcript -Path $out -Force | Out-Null
try {
    $svcs = 'Mystic_Light_Service', 'LightKeeperService'
    "Mystic Light durduruluyor..."
    foreach ($s in $svcs) { Stop-Service $s -Force -ErrorAction SilentlyContinue }
    Get-Process LEDKeeper2 -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    if ($Is -eq 'kur') {
        Copy-Item (Join-Path $src 'out\x86\nvapi.dll') $ml -Force
        Copy-Item (Join-Path $src 'out\x64\nvapi64.dll') $ml -Force
        "Kayıtçı yerleştirildi: $ml\nvapi.dll, $ml\nvapi64.dll"
    } else {
        foreach ($f in 'nvapi.dll', 'nvapi64.dll') { $p = Join-Path $ml $f; if (Test-Path $p) { Remove-Item $p -Force; "Silindi: $p" } }
    }
    foreach ($s in $svcs) { Start-Service $s -ErrorAction SilentlyContinue }
    "Mystic Light başlatıldı; 15 sn bekleniyor..."
    Start-Sleep -Seconds 15
    "== nvapi yükleyen süreçler (yol ile)"
    foreach ($p in Get-Process) {
        try {
            foreach ($m in $p.Modules) {
                if ($m.ModuleName -match '^nvapi(64)?\.dll$') { "{0} ({1}): {2}" -f $p.ProcessName, $p.Id, $m.FileName }
            }
        } catch { }
    }
    "== MSI süreçleri"
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -match 'MSI' } | ForEach-Object { "{0} ({1}) {2}" -f $_.Name, $_.ProcessId, $_.ExecutablePath }
    "== kayıt dosyaları"
    Get-ChildItem 'C:\ProgramData\KontrolMerkezi-nvspy' -ErrorAction SilentlyContinue | ForEach-Object { "{0} {1} bayt" -f $_.Name, $_.Length }
    'BITTI'
}
catch { "HATA: $_" }
finally { Stop-Transcript | Out-Null }
