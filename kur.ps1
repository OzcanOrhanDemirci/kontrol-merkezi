# Kontrol Merkezi kurulum betiği. Kurulum.cmd çağırır (tek UAC onayı); elle de YÖNETİCİ PowerShell'de çalışır:
#   powershell -ExecutionPolicy Bypass -File kur.ps1            kurar ya da günceller (tek adım)
#   powershell -ExecutionPolicy Bypass -File kur.ps1 -Kaldir    görevi, kısayolları ve program klasörünü kaldırır
#
# Kurulum ne yapar:
#   1. bin\Release'i C:\Program Files\KontrolMerkezi'ye kopyalar (yalnız yöneticinin yazabildiği yer: görev
#      yönetici olarak çalıştığı için exe'yi kimse değiştiremesin).
#   2. "KontrolMerkezi" zamanlanmış görevini kaydeder: oturum açılınca servisi arka planda, UAC sormadan,
#      yönetici yetkisiyle başlatır (Fan Anahtarı'nın yolu). Işıklar her açılışta kapalı başlar.
#   3. Masaüstüne ve Başlat menüsüne "Kontrol Merkezi" kısayolu koyar (pencere yetkisiz açılır).
#   4. Servisi hemen başlatır ve salt okuma bir döküm alır (okuma.txt): işlemci sıcaklığı ve fan çipi okunuyor mu.
# Fan Anahtarı'na ve PawnIO'ya dokunmaz. Çıktı: kur-gunluk.txt (bu klasörde).
param([switch]$Kaldir)

$ErrorActionPreference = 'Stop'
$kaynak = $PSScriptRoot
$hedef = Join-Path $env:ProgramFiles 'KontrolMerkezi'
$gorevAdi = 'KontrolMerkezi'
$veri = Join-Path $env:LOCALAPPDATA 'KontrolMerkezi'
Start-Transcript -Path (Join-Path $kaynak 'kur-gunluk.txt') -Force | Out-Null

function Servisi-Durdur {
    # Önce nazikçe: servis ekran kartı fanlarını otomatiğe döndürüp ışıkları karartarak kapanır.
    try {
        $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'KontrolMerkezi', [System.IO.Pipes.PipeDirection]::InOut)
        $c.Connect(1500)
        $w = New-Object System.IO.StreamWriter($c)
        $w.Write("{`"komut`":`"kapat`"}`n"); $w.Flush()
        Start-Sleep -Milliseconds 1500
        $c.Dispose()
        'Servis kapatma isteği gönderildi.'
    } catch { 'Çalışan servis yok (boru bulunamadı).' }
    $kalan = Get-Process KontrolMerkezi -ErrorAction SilentlyContinue
    if ($kalan) { $kalan | Stop-Process -Force; 'Kalan KontrolMerkezi süreçleri durduruldu.' }
    # The window's WebView2 holds runtimes\...\WebView2Loader.dll until its process has really gone (11-16: an update
    # failed on that lock); wait for the processes to exit before copying.
    Get-Process KontrolMerkezi -ErrorAction SilentlyContinue | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

function Kisayol([string]$yol, [string]$exe) {
    $sh = New-Object -ComObject WScript.Shell
    $k = $sh.CreateShortcut($yol)
    $k.TargetPath = $exe
    $k.WorkingDirectory = Split-Path $exe
    $k.IconLocation = "$exe,0"
    $k.Description = 'Kontrol Merkezi: fanlar ve RGB'
    $k.Save()
}

try {
    $yonetici = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $yonetici) { throw 'Bu betik yönetici olarak çalışmalı (Başlat > PowerShell > Yönetici olarak çalıştır).' }

    $masaustu = [Environment]::GetFolderPath('Desktop')
    $baslat = Join-Path ([Environment]::GetFolderPath('Programs')) 'Kontrol Merkezi.lnk'
    $masaustuKisayol = Join-Path $masaustu 'Kontrol Merkezi.lnk'

    if ($Kaldir) {
        Unregister-ScheduledTask -TaskName $gorevAdi -Confirm:$false -ErrorAction SilentlyContinue
        Servisi-Durdur
        foreach ($k in $masaustuKisayol, $baslat) { if (Test-Path $k) { Remove-Item $k -Force } }
        if (Test-Path $hedef) { Remove-Item $hedef -Recurse -Force }
        "Görev, kısayollar ve $hedef kaldırıldı. Veri klasörü yerinde: $veri"
        'BITTI'
        return
    }

    $cikti = Join-Path $kaynak 'bin\Release'
    if (-not (Test-Path (Join-Path $cikti 'KontrolMerkezi.exe'))) { throw "Hazır derleme bulunamadı ($cikti). Claude'dan derlemesini isteyin." }

    # PawnIO (işlemci sıcaklığı ve fan çipi için) Fan Anahtarı'yla birlikte kuruldu; yoksa söyle, kurma.
    $pawn = Get-Service PawnIO -ErrorAction SilentlyContinue
    if ($pawn) { "PawnIO sürücüsü: $($pawn.Status)" } else { 'UYARI: PawnIO sürücüsü bulunamadı; fan düğmesi ve işlemci sıcaklığı çalışmaz.' }

    Servisi-Durdur
    New-Item -ItemType Directory -Force $hedef | Out-Null
    # salonun veri paketi her derlemede baştan yazılır: eskisinden dosya kalmasın
    $eskiPaket = Join-Path $hedef 'sahne'
    if (Test-Path $eskiPaket) { Remove-Item $eskiPaket -Recurse -Force }
    Copy-Item (Join-Path $cikti '*') -Destination $hedef -Recurse -Force
    "Kopyalandı -> $hedef"
    Get-ChildItem $hedef -File | Select-Object Name, Length | Format-Table -AutoSize | Out-String
    $exe = Join-Path $hedef 'KontrolMerkezi.exe'

    $eylem = New-ScheduledTaskAction -Execute $exe -Argument 'servis' -WorkingDirectory $hedef
    $tetik = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $kisi = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
    $ayar = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 4 `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $gorevAdi -Action $eylem -Trigger $tetik -Principal $kisi -Settings $ayar -Force `
        -Description 'Kontrol Merkezi servisi: fanlar ve RGB. Oturum açılınca yönetici olarak arka planda çalışır; pencere: KontrolMerkezi.exe (argümansız).' |
        Select-Object TaskName, State | Format-Table -AutoSize | Out-String

    Kisayol $masaustuKisayol $exe
    Kisayol $baslat $exe
    'Kısayollar: masaüstü ve Başlat menüsü.'

    Start-ScheduledTask -TaskName $gorevAdi
    Start-Sleep -Seconds 4
    $calisan = Get-Process KontrolMerkezi -ErrorAction SilentlyContinue
    "Servis çalışıyor: $([bool]$calisan)"

    # Salt okuma döküm (yönetici): işlemci sıcaklığı ve fan çipi gerçekten okunuyor mu.
    $p = Start-Process $exe -ArgumentList 'oku' -Wait -PassThru
    "Okuma çıkış kodu: $($p.ExitCode)"
    $okuma = Join-Path $veri 'okuma.txt'
    if (Test-Path $okuma) { Get-Content $okuma -Encoding UTF8 }
    'BITTI'
}
catch {
    "HATA: $_"
    $_.ScriptStackTrace
}
finally {
    Stop-Transcript | Out-Null
}
