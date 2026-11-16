# Removes MSI Center (installed 2026-11-16 for the GPU lighting proof) and everything it brought, plus the proof's
# leftovers. Runs elevated (msi-kaldir.cmd). Sends nothing to any device and runs no MSI program: MSI's own uninstaller
# would start MSI executables (service --uninstall, sub-uninstallers), so MSI Center is taken apart by hand after all
# of its processes are stopped. Third-party plug-ins MSI installed (ENE, WD, Verbatim HALs, AMD Ryzen Master SDK) are
# removed with their own quiet uninstallers, after MSI's processes are gone.
# Kept on purpose: MSI Afterburner + RTSS (his tools), MSI_Driver_Utility_Installer and the msiswacpi driver (put there
# by the motherboard's BIOS in February, not by MSI Center).
# Result: msi-kaldir-sonuc.txt next to this script.
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
Start-Transcript -Path (Join-Path $here 'msi-kaldir-sonuc.txt') -Force | Out-Null

Add-Type -Namespace KM -Name Dosya -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern bool MoveFileEx(string existing, System.IntPtr newName, int flags);
'@
$gecikmeli = New-Object System.Collections.Generic.List[string]
function Sil-AcilistaSil([string]$p) { if ([KM.Dosya]::MoveFileEx($p, [IntPtr]::Zero, 4)) { $gecikmeli.Add($p) } else { "  silinemedi ve ertelenemedi: $p" } }
function Klasor-Sil([string]$d) {
    if (-not (Test-Path -LiteralPath $d)) { return }
    Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $d) {
        Get-ChildItem -LiteralPath $d -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object { Sil-AcilistaSil $_.FullName }
        Get-ChildItem -LiteralPath $d -Recurse -Force -Directory -ErrorAction SilentlyContinue | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object { Sil-AcilistaSil $_.FullName }
        Sil-AcilistaSil $d
        "  klasor (kilitli dosyalar acilista silinecek): $d"
    } else { "  klasor silindi: $d" }
}
function Calistir([string]$exe, [string]$argv, [int]$sn = 300) {
    $p = Start-Process -FilePath $exe -ArgumentList $argv -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit($sn * 1000)) { "  ZAMAN ASIMI ($sn sn): $exe $argv"; try { $p.Kill() } catch { } ; return -1 }
    return $p.ExitCode
}

$mc = 'C:\Program Files (x86)\MSI\MSI Center'
$yollar = @($mc, 'C:\Program Files\WindowsApps\9426MICRO-STARINTERNATION.MSICenter', 'C:\Program Files\AMD\RyzenMasterSDK', 'C:\Program Files\Verbatim', 'C:\Program Files\WD')
function MSI-Surecleri { Get-CimInstance Win32_Process | Where-Object { $e = $_.ExecutablePath; $e -and ($yollar | Where-Object { $e.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) } }

"== 1. MSI hizmetleri durduruluyor ve devre disi"
$hizmetler = 'LightKeeperService', 'Mystic_Light_Service', 'MSI_Center_Service', 'MSI_Case_Service'
foreach ($n in $hizmetler) { if (Get-Service $n -ErrorAction SilentlyContinue) { sc.exe config $n start= disabled | Out-Null; Stop-Service $n -Force -ErrorAction SilentlyContinue; "  $n durdu" } }
"== 2. MSI surecleri kapatiliyor"
for ($i = 0; $i -lt 3; $i++) { MSI-Surecleri | ForEach-Object { "  kapat: $($_.Name) ($($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 2 }
$kalan = @(MSI-Surecleri); if ($kalan.Count) { "  HALA CALISAN: " + (($kalan | ForEach-Object Name) -join ', ') } else { "  MSI sureci kalmadi" }

"== 3. MSI Center Store uygulamasi"
Get-AppxPackage -AllUsers -Name '9426MICRO-STARINTERNATION.MSICenter' | ForEach-Object { "  kaldir: $($_.PackageFullName)"; Remove-AppxPackage -Package $_.PackageFullName -AllUsers -ErrorAction Continue }
Get-AppxProvisionedPackage -Online | Where-Object { $_.DisplayName -eq '9426MICRO-STARINTERNATION.MSICenter' } | ForEach-Object { "  saglanan paket kaldir: $($_.PackageName)"; Remove-AppxProvisionedPackage -Online -PackageName $_.PackageName | Out-Null }

"== 4. MSI'in kurdugu eklentiler (ENE, WD, Verbatim, AMD Ryzen Master SDK)"
$adlar = '^(ENE_External_Device_HAL|ENE_EHD_M2_HAL|ENE_MousePad_HAL|ENE Video Capture Box HAL|ENE_X_AIC_HAL|WD P40 Game Drive|WD_BLACK D50|WD_BLACK AN1500|Verbatim_SureFireGaming_Product|AMD Ryzen Master SDK)$'
$kokler = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
function Eklentiler { foreach ($k in $kokler) { Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -cmatch $adlar } } }
$onbellek = @(Eklentiler | ForEach-Object { $_.PSChildName.ToUpperInvariant() })
# Bundles first (they remove their MSI), then any MSI left.
foreach ($e in @(Eklentiler | Where-Object { $_.QuietUninstallString -like '*Package Cache*AacSetup.exe*' })) {
    $exe = [regex]::Match($e.QuietUninstallString, '"([^"]+)"').Groups[1].Value
    if (Test-Path -LiteralPath $exe) { $r = Calistir $exe '/uninstall /quiet /norestart'; "  $($e.DisplayName) (paket): $r" }
}
foreach ($e in @(Eklentiler | Where-Object { $_.PSChildName -cmatch '^\{[0-9A-F-]{36}\}$' })) {
    $r = Calistir 'msiexec.exe' "/x $($e.PSChildName) /qn /norestart"; "  $($e.DisplayName) $($e.PSChildName): $r"
}
$kalanE = @(Eklentiler); if ($kalanE.Count) { "  KALAN KAYIT: " + (($kalanE | ForEach-Object { $_.DisplayName + ' ' + $_.PSChildName }) -join '; ') } else { "  eklenti kaydi kalmadi" }

"== 5. MSI hizmet ve surucu kayitlari"
foreach ($n in $hizmetler + 'NTIOLib_MysticLight', 'NTIOLib_CC_COMM', 'MSIO', 'AMDRyzenMasterDriverV29') {
    if (Test-Path "HKLM:\SYSTEM\CurrentControlSet\Services\$n") { sc.exe stop $n 2>&1 | Out-Null; sc.exe config $n start= disabled 2>&1 | Out-Null; $o = sc.exe delete $n 2>&1; "  $n : $($o -join ' ')" }
}
Sil-AcilistaSil 'C:\Windows\System32\drivers\MsIo64.sys'
Remove-Item -LiteralPath 'C:\Windows\System32\drivers\MsIo64.sys' -Force -ErrorAction SilentlyContinue

"== 6. Zamanlanmis gorevler"
Get-ScheduledTask | Where-Object { $a = ($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' '; $a -like '*MSI Center*' -or $a -like '*MICRO-STAR*' -or $_.TaskName -like 'MSI Center*' -or $_.TaskName -like 'MSI_*' } | ForEach-Object { "  sil: $($_.TaskPath)$($_.TaskName)"; Unregister-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath -Confirm:$false }

"== 7. Guvenlik duvari kurallari"
Get-NetFirewallRule | Where-Object { $_.DisplayName -like 'MSI Center*' } | ForEach-Object { "  sil: $($_.DisplayName)"; Remove-NetFirewallRule -Name $_.Name }

"== 8. Kayit defteri"
foreach ($k in 'HKLM:\SOFTWARE\WOW6432Node\MSI\LED', 'HKLM:\SOFTWARE\WOW6432Node\MSI\LED_Sync', 'HKLM:\SOFTWARE\WOW6432Node\MSI\MSI Center', 'HKLM:\SOFTWARE\WOW6432Node\MSI\Mystic_Light_SDK', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{15289038-41BE-48F8-B8B9-0B1021D3089E}}_is1') {
    if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force; "  sil: $k" }
}

"== 9. Klasorler"
Klasor-Sil $mc
Klasor-Sil 'C:\ProgramData\MSI\MSI Center'
if ((Test-Path 'C:\ProgramData\MSI') -and -not (Get-ChildItem 'C:\ProgramData\MSI' -Force)) { Klasor-Sil 'C:\ProgramData\MSI' }
Klasor-Sil 'C:\Program Files\AMD\RyzenMasterSDK'
if ((Test-Path 'C:\Program Files\AMD') -and -not (Get-ChildItem 'C:\Program Files\AMD' -Force)) { Klasor-Sil 'C:\Program Files\AMD' }
Klasor-Sil 'C:\Program Files\Verbatim'
Klasor-Sil 'C:\Program Files\WD'
Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter '9426MICRO-STARINTERNATION.MSICenter*' -ErrorAction SilentlyContinue | ForEach-Object { Klasor-Sil $_.FullName }
# Only the cache folders of the plug-ins removed in step 4 ('{guid}' for a bundle, '{GUID}v1.2.3' for its MSI).
Get-ChildItem 'C:\ProgramData\Package Cache' -Directory -ErrorAction SilentlyContinue | Where-Object { $onbellek -contains ($_.Name -replace '^(\{[0-9A-Fa-f-]{36}\}).*$', '$1').ToUpperInvariant() } | ForEach-Object { Klasor-Sil $_.FullName }
Klasor-Sil 'C:\ProgramData\KontrolMerkezi-nvspy'

"== 10. Denetim: geride kalan"
"  hizmet/surucu: " + ((Get-ChildItem HKLM:\SYSTEM\CurrentControlSet\Services | Where-Object { $_.PSChildName -in ($hizmetler + 'NTIOLib_MysticLight', 'NTIOLib_CC_COMM', 'MSIO', 'AMDRyzenMasterDriverV29') } | ForEach-Object PSChildName) -join ', ')
"  surec: " + ((MSI-Surecleri | ForEach-Object Name) -join ', ')
"  Store paketi: " + ((Get-AppxPackage -AllUsers -Name '9426MICRO-STARINTERNATION.MSICenter' | ForEach-Object PackageFullName) -join ', ')
"  eklenti kaydi: " + ((Eklentiler | ForEach-Object DisplayName) -join ', ')
"  MSI Center klasoru var mi: " + (Test-Path $mc)
"  acilista silinecek: $($gecikmeli.Count) oge"
"  kalan MSI kayit anahtarlari: " + ((Get-ChildItem 'HKLM:\SOFTWARE\WOW6432Node\MSI' -ErrorAction SilentlyContinue | ForEach-Object PSChildName) -join ', ')
"  Afterburner yerinde: " + (Test-Path 'C:\Program Files (x86)\MSI Afterburner\MSIAfterburner.exe')
'BITTI'
Stop-Transcript | Out-Null
