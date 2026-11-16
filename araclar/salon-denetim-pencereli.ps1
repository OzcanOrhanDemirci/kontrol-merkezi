# The -Pencereli run of salon-denetim.ps1 (dot-sourced by it; not run on its own). The window is started with
# KM_DENETIM=1: 1280x720 in the corner, never activated, a DevTools port on 127.0.0.1:$Port. No key or mouse input:
# the camera moves through the page's own window.__km.go(), the hardware through the service's pipe. Every state it
# changes is put back in finally (GeriAlVeKapat).

function Js([string]$ifade, [int]$ms = 15000) {
    $y = $script:cdp.Eval($ifade, $ms)
    if (-not $y) { throw "sayfa yanıt vermedi: $ifade" }
    $o = $y | ConvertFrom-Json
    if ($o.result.exceptionDetails) { throw "sayfada hata: $($o.result.exceptionDetails.exception.description)" }
    return $o.result.result.value
}
$durumJs = "(() => { const k = window.__km; if (!k) return { yok: true }; return { hazir: !!(k.S && k.S.ready), nogl: document.body.classList.contains('nogl'), yer: k.M.place, s: k.M.s, v: k.M.v, baglanti: k.D.link }; })()"
function Sayfa { Js $durumJs }
# moves the camera and waits until it stands at the goal; logs the arc length along the way
function Yolculuk([string]$hedef, [double[]]$anlar, [string]$ad) {
    Js "window.__km.go('$hedef'), true" | Out-Null
    $tt = Get-Date
    Olay "yolculuk: __km.go('$hedef')" -Kare
    $yol = @(); $kalan = New-Object System.Collections.Generic.Queue[double]
    foreach ($a in $anlar) { $kalan.Enqueue($a) }
    $son = $null
    while (((Get-Date) - $tt).TotalSeconds -lt 40) {
        $g = Sayfa
        $yol += ("{0}:{1}" -f ((Get-Date) - $tt).TotalSeconds.ToString("0.0", $inv), ([double]$g.s).ToString("0", $inv))
        if ($kalan.Count -and ((Get-Date) - $tt).TotalSeconds -ge $kalan.Peek()) { $a = $kalan.Dequeue(); [void](Kare ("{0}-{1}sn" -f $ad, $a.ToString($inv))) }
        if (((Get-Date) - $tt).TotalSeconds -gt 1 -and [double]$g.v -eq 0 -and $g.yer -eq $hedef) { $son = $g; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $son) { Bulgu "kamera 40 sn'de '$hedef'e varmadı (yol $($yol -join ' '))"; return $null }
    Olay ("{0}: vardı, {1} sn, s={2} m (yol, sn:m: {3})" -f $ad, ((Get-Date) - $tt).TotalSeconds.ToString("0.0", $inv), ([double]$son.s).ToString("0", $inv), ($yol -join " "))
    return $son
}

$script:boru = $null
try {
    $script:boru = New-Object DnBoru
    for ($i = 0; $i -lt 30 -and -not $script:boru.Durum; $i++) { Bekle 0.1 }
    $d0 = Durum
    if (-not $d0) { throw "servis durum göndermedi" }
    $ilk.kasa = [string]$d0.fan.kasa.durum; $ilk.gpu = [string]$d0.fan.gpu.durum; $ilk.rgb = [bool]$d0.rgb.acik
    Olay "başta: $(FanOzet) | rgb açık=$($ilk.rgb)"

    # ---------------------------------------------------------- the window, small, in the corner, never activated
    $env:KM_DENETIM = "1"; $env:KM_DENETIM_PORT = "$Port"
    try { $p = Start-Process $exe -PassThru } finally { Remove-Item Env:KM_DENETIM, Env:KM_DENETIM_PORT -ErrorAction SilentlyContinue }
    $pencereZaman = Get-Date
    Olay "pencere başlatıldı (KM_DENETIM, port $Port)"
    for ($i = 0; $i -lt 100 -and $script:h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 100; $p.Refresh(); $script:h = $p.MainWindowHandle }
    if ($script:h -eq [IntPtr]::Zero) { throw "pencere açılmadı" }
    $r = New-Object Dn+RECT; [void][Dn]::GetClientRect($script:h, [ref]$r)
    Olay ("pencere göründü: istemci {0}x{1}, öndeki pencere {2}" -f ($r.R - $r.L), ($r.B - $r.T), $(if ([Dn]::GetForegroundWindow() -eq $script:h) { "BU PENCERE (odak alınmamalıydı)" } else { "başka (doğru)" }))
    if ([Dn]::GetForegroundWindow() -eq $script:h) { Bulgu "denetim penceresi odağı aldı" }

    # the DevTools port, then the long-task record (buffered: the loading's tasks too)
    $url = $null
    for ($i = 0; $i -lt 100 -and -not $url; $i++) { try { $url = [DnCdp]::SayfaAdresi($Port) } catch { }; if (-not $url) { Start-Sleep -Milliseconds 200 } }
    if (-not $url) { throw "DevTools portu açılmadı ($Port): pencere KM_DENETIM'i tanımıyor mu (eski derleme)?" }
    $script:cdp = New-Object DnCdp $url
    [void]$script:cdp.Call("Runtime.enable", "{}", 5000)
    [void]$script:cdp.Call("Log.enable", "{}", 5000)
    Js "(() => { if (window.__dn) return true; window.__dn = { lt: [] }; try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__dn.lt.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true }); } catch (e) { window.__dn.hata = String(e); } return true; })()" | Out-Null

    # ---------------------------------------------------------- the opening
    $g = $null
    while (((Get-Date) - $pencereZaman).TotalSeconds -lt 180) {
        try { $g = Sayfa } catch { $g = $null }
        if ($g -and ($g.hazir -or $g.nogl)) { break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $g -or $g.nogl) {
        $neden = try { Js "(document.getElementById('fallback') || {}).textContent || ''" } catch { "" }
        throw "sahne yüklenmedi: $neden"
    }
    Olay ("sahne yüklendi: pencere başlatıldıktan {0} sn sonra, bağlantı={1}" -f ((Get-Date) - $pencereZaman).TotalSeconds.ToString("0.0", $inv), $g.baglanti) -Kare
    Bekle 1.0; [void](Kare "acilis-1sn")
    Bekle 7; [void](Kare "acilis-fanlar")
    $kanca = @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Modules | Where-Object ModuleName -eq 'RTSSHooks64.dll' } catch { $false } }).Count
    Olay "RTSS kancası yüklü WebView2 süreci: $kanca"

    # ---------------------------------------------------------- the journey both ways
    if ($Bolum -eq "yolculuk" -or $Bolum -eq "hepsi") {
        Olay "bölüm: yolculuk"
        $v = Yolculuk "rgb" @(1.5, 3.5, 5.5) "yolculuk-gidis"
        if ($v) { [void](Kare "yolculuk-varis-rgb"); if ([double]$v.s -lt 50) { Bulgu "gidişte kamera yalnız $([double]$v.s) m yol aldı" } }
        Bekle 2
        $v = Yolculuk "fanlar" @(2, 5) "yolculuk-donus"
        if ($v) { [void](Kare "yolculuk-varis-fanlar"); if ([double]$v.s -gt 0.5) { Bulgu "dönüşte kamera başa dönmedi (s=$([double]$v.s))" } }
    }

    # ---------------------------------------------------------- the fans, both states, through the pipe
    if ($Bolum -eq "fanlar" -or $Bolum -eq "hepsi") {
        Olay "bölüm: fanlar"
        $karsi = @{ kasa = @{ max = "bios"; bios = "max" }; gpu = @{ max = "oto"; oto = "max" } }
        foreach ($k in "kasa", "gpu") {
            $s = FanBekle $k @("max", "bios", "oto") 20
            if (-not $karsi[$k].ContainsKey($s)) { throw "$k fanı bilinen bir durumda değil ('$s'); fanlara dokunulmadı" }
        }
        [void](Kare "fanlar-once")
        Olay "fanlar önce: $(FanOzet)"
        $hedefK = $karsi.kasa[(FanDurum "kasa")]
        $script:boru.Send('{"komut":"fan-kasa"}')
        $s = FanBekle "kasa" @($hedefK) 45
        if ($s -ne $hedefK) { throw "kasa fanı '$hedefK' olmadı ('$s')" }
        Olay "kasa: $s" -Kare
        Bekle 8; [void](Kare "fanlar-kasa-$s"); Olay "fanlar: $(FanOzet)"
        $hedefG = $karsi.gpu[(FanDurum "gpu")]
        $script:boru.Send('{"komut":"fan-gpu"}')
        $s = FanBekle "gpu" @($hedefG) 45
        if ($s -ne $hedefG) { throw "GPU fanı '$hedefG' olmadı ('$s')" }
        Olay "gpu: $s" -Kare
        Bekle 8; [void](Kare "fanlar-kasa-$hedefK-gpu-$s"); Olay "fanlar: $(FanOzet)"
        $script:boru.Send('{"komut":"fan-gpu"}')
        $s = FanBekle "gpu" @($ilk.gpu) 45; Olay "gpu geri: $s" -Kare
        $script:boru.Send('{"komut":"fan-kasa"}')
        $s = FanBekle "kasa" @($ilk.kasa) 60; Olay "kasa geri: $s" -Kare
        Bekle 8; [void](Kare "fanlar-geri"); Olay "fanlar geri: $(FanOzet)"
    }

    # ---------------------------------------------------------- at the arch: a hot preview, then the lights off
    if ($Bolum -eq "sicaklik" -or $Bolum -eq "hepsi") {
        Olay "bölüm: sicaklik"
        [void](Yolculuk "rgb" @() "kemere")
        [void](Kare "sicaklik-once")
        $script:boru.Send('{"komut":"rgb","acik":true}')
        $script:boru.Send('{"komut":"onizle","c":' + $Sicaklik.ToString($inv) + '}')
        $onizlemeVerildi = $true
        Olay "önizleme: $Sicaklik °C (rgb açık)" -Kare
        Bekle 2.5; [void](Kare ("sicaklik-{0}-2sn" -f $Sicaklik))
        Bekle 8; [void](Kare ("sicaklik-{0}-10sn" -f $Sicaklik))
        $iz = if ($script:boru.Isik) { $script:boru.Isik | ConvertFrom-Json } else { $null }
        if ($iz) { Olay "ışık mesajı: önizleme=$($iz.onizleme -join ',') çıkış=$($iz.cikis -join ',')" }
        $script:boru.Send('{"komut":"onizle"}')
        $onizlemeVerildi = $false
        Olay "önizleme temizlendi" -Kare
        Bekle 5; [void](Kare "sicaklik-sonra")
        # the RGB off look (Özcan 11-16: the hall sinks into a darkness you can still see in)
        $onizlemeVerildi = $true      # from here finally puts RGB back too
        $script:boru.Send('{"komut":"rgb","acik":false}')
        Olay "rgb kapalı" -Kare
        Bekle 3; [void](Kare "rgb-kapali-3sn")
        Bekle 6; [void](Kare "rgb-kapali-9sn")
        $script:boru.Send('{"komut":"rgb","acik":' + ([bool]$ilk.rgb).ToString().ToLowerInvariant() + '}')
        $onizlemeVerildi = $false
        Olay "rgb geri: açık=$($ilk.rgb)" -Kare
        Bekle 5; [void](Kare "rgb-geri")
        [void](Yolculuk "fanlar" @() "fanlara-donus")
    }
    Bekle 2
}
catch {
    Bulgu ("HATA: " + $_.Exception.Message)
}
finally {
    # what the page said: console errors and warnings, uncaught exceptions, long tasks
    if ($script:cdp) {
        try {
            $lt = Js "JSON.stringify(window.__dn || {})" 5000 | ConvertFrom-Json
            $uzun = @($lt.lt)
            if ($uzun.Count) {
                $sirali = $uzun | Sort-Object { -$_[1] }
                Olay ("sayfanın uzun görevleri: {0} adet, en uzunları (sayfa açılışından ms @ süre ms): {1}" -f $uzun.Count, (($sirali | Select-Object -First 8 | ForEach-Object { "$($_[0])@$($_[1])" }) -join ", "))
                $script:uzunGorev = $uzun
            } else { Olay "sayfanın uzun görevi yok$(if ($lt.hata) { " (gözlemci: $($lt.hata))" })" }
        } catch { Olay "uzun görevler okunamadı: $($_.Exception.Message)" }
        $sayfaLog = @()
        lock = $null
        foreach ($e in @($script:cdp.Olaylar)) {
            $zaman = $e.Substring(0, 12); $o = $e.Substring(13) | ConvertFrom-Json
            if ($o.method -ceq "Runtime.exceptionThrown") { $sayfaLog += "$zaman HATA: $($o.params.exceptionDetails.exception.description)" }
            elseif ($o.method -ceq "Runtime.consoleAPICalled") { $sayfaLog += "$zaman console.$($o.params.type): " + (($o.params.args | ForEach-Object { if ($_.value -ne $null) { $_.value } else { $_.description } }) -join " ") }
            elseif ($o.method -ceq "Log.entryAdded") { $sayfaLog += "$zaman log.$($o.params.entry.level): $($o.params.entry.text) $($o.params.entry.url)" }
        }
        $sayfaLog | Set-Content (Join-Path $cikti "sayfa-gunlugu.txt") -Encoding utf8
        $hatalar = @($sayfaLog | Where-Object { $_ -cmatch "HATA:|console\.error|log\.error" })
        Olay ("sayfa günlüğü: {0} satır, {1} hata (sayfa-gunlugu.txt)" -f $sayfaLog.Count, $hatalar.Count)
        foreach ($h in ($hatalar | Select-Object -First 5)) { Bulgu "sayfa: $h" }
        $script:cdp.Dispose()
    }
    GeriAlVeKapat
    if ($script:boru) { $script:boru.Dispose() }
}
