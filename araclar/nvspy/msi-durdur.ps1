# MSI Center'i karta dokunamayacak hale getirir ya da geri acar. Karta hicbir sey gondermez. msi-durdur.cmd cagirir (UAC).
#   -Is durdur  MSI hizmetlerinin baslangic turunu msi-hizmetler-onceki.txt'ye yazar, durdurur ve Disabled yapar;
#               LEDKeeper2 ve MSI.CentralServer sureclerini kapatir; Mystic Light'in yanindaki nvspy kayitci dosyalarini siler.
#   -Is geri    kayittaki baslangic turlerini geri yazar ve hizmetleri baslatir (Mystic Light yeniden calisir).
# Sonuc: msi-durdur-sonuc.txt (bu klasorde).
param([ValidateSet('durdur', 'geri')][string]$Is = 'durdur')
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$out = Join-Path $here 'msi-durdur-sonuc.txt'
$kayit = Join-Path $here 'msi-hizmetler-onceki.txt'
$names = 'LightKeeperService', 'Mystic_Light_Service', 'MSI_Center_Service', 'MSI_Case_Service'
$ml = 'C:\Program Files (x86)\MSI\MSI Center\Mystic Light'
Start-Transcript -Path $out -Force | Out-Null
try {
    if ($Is -eq 'durdur') {
        $lines = foreach ($n in $names) { $s = Get-Service $n -ErrorAction SilentlyContinue; if ($s) { "$n=$($s.StartType)" } }
        if (-not (Test-Path $kayit)) { $lines | Set-Content $kayit -Encoding ASCII; "Önceki başlangıç türleri kaydedildi: $kayit" } else { "Önceki kayıt zaten var, korunuyor: $kayit" }
        Get-Content $kayit
        foreach ($n in $names) {
            if (Get-Service $n -ErrorAction SilentlyContinue) {
                Set-Service $n -StartupType Disabled
                Stop-Service $n -Force -ErrorAction SilentlyContinue
            }
        }
        foreach ($p in 'LEDKeeper2', 'MSI.CentralServer', 'MSI.TerminalServer', 'CC_Engine_x64') { Get-Process $p -ErrorAction SilentlyContinue | Stop-Process -Force }
        Start-Sleep -Seconds 2
        foreach ($f in 'nvapi.dll', 'nvapi64.dll') { $p = Join-Path $ml $f; if (Test-Path $p) { Remove-Item $p -Force; "Kayıtçı silindi: $p" } }
    } else {
        if (-not (Test-Path $kayit)) { throw "Kayıt yok: $kayit" }
        foreach ($line in Get-Content $kayit) {
            $n, $t = $line -split '=', 2
            Set-Service $n -StartupType $t
            if ($t -ne 'Disabled') { Start-Service $n -ErrorAction SilentlyContinue }
            "$n -> $t"
        }
    }
    "== Durum"
    foreach ($n in $names) { $s = Get-Service $n -ErrorAction SilentlyContinue; if ($s) { "{0}: {1}, başlangıç {2}" -f $n, $s.Status, $s.StartType } }
    "MSI süreçleri: " + ((Get-Process LEDKeeper2, MSI.CentralServer, MSI.TerminalServer, CC_Engine_x64 -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName }) -join ', ')
    "Kayıtçı dosyaları: " + ((Get-ChildItem $ml -Filter 'nvapi*.dll' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ', ')
    'BITTI'
}
catch { "HATA: $_" }
finally { Stop-Transcript | Out-Null }
