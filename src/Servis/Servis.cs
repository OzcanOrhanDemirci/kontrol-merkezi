// The background service: owns every device and runs for the whole logon session.
//
// Threads: light (30 Hz colour engine + RGB writes), sensors (2 Hz temperatures, loads, fan states, local model),
// fan worker (switching takes about a second and must not stall the light), Jarvis poller, pipe server, and this
// thread's hidden window for power and session messages (sleep/wake, logoff).
//
// Safety: fan chip writes are Fan Anahtarı's proven sequence (FanCipi). GPU fans: the driver setting is restored
// to the card's auto control on exit and on crash where possible; a failed switch leaves fans where they are, and
// MAX is the safe side. RGB: only volatile direct-mode colour data; lights start off after every boot.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Collections.Concurrent;
using System.Windows.Forms;
using KontrolMerkezi.Donanim;
using KontrolMerkezi.Durum;
using KontrolMerkezi.Isik;
using KontrolMerkezi.Rgb;
using LibreHardwareMonitor.Hardware;

namespace KontrolMerkezi.Servis;

sealed class Servis : IDisposable
{
    public const string MutexName = @"Local\KontrolMerkezi.Servis";
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    static string StatePath => Path.Combine(Program.DataDir, "durum.json");
    static string HistoryPath => Path.Combine(Program.DataDir, "isi-gecmisi.csv");

    readonly bool _admin;
    volatile Ayarlar _ayar;
    volatile RenkMotoru _motor;
    // Development/calibration overrides (pipe command "onizle"); null = live value. Not reachable from the window.
    volatile Zorla _zorla = new();

    sealed class Zorla
    {
        public double? C;
        public bool? YapayZeka, Islemci;
        public int? YzEfekt, IslemciEfekt;
        public JarvisDurum? Jarvis;
        public bool Bos => C == null && YapayZeka == null && Islemci == null && Jarvis == null && YzEfekt == null && IslemciEfekt == null;
    }
    readonly YerelModel _model = new();
    readonly Afterburner _ab = new();
    JarvisIzleyici _jarvis;
    BoruSunucu _boru;

    Computer _lhm;
    FanCipi _fan;
    string _fanNeden;
    Islemci _cpu;
    Nvml _nvml;
    GpuFan _gpuFan;
    string _gpuNeden;
    readonly List<IRgbCihaz> _rgb;
    readonly List<CihazYazici> _yazicilar;

    volatile Girdi _girdi = new();
    double _cpuEma;
    DateTime _islemciSince = DateTime.MinValue, _islemciOffSince = DateTime.MinValue;
    bool _islemci, _beklemede;

    // fan state (guarded by _lock)
    readonly object _lock = new();
    string _kasaHedef = "bios", _gpuHedef = "oto";
    bool _kasaBusy, _gpuBusy, _gpuBizim;
    FanSnap _kasaSnap;
    GpuFan.Durum _gpuSnap;
    bool _rgbAcik;
    readonly BlockingCollection<string> _fanQueue = new();
    Thread _fanThread;

    volatile bool _stop;
    volatile bool _uyku;            // between suspend and resume: no device writes
    bool _karanlik = true;          // master reached zero and the devices were told to go dark
    string _lastDurum;
    DateTime _lastHistory = DateTime.MinValue;

    public Action KapatIstegi;

    public Servis()
    {
        _admin = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        _ayar = Ayarlar.Yukle();
        _motor = new RenkMotoru(_ayar);
        _rgb = RgbCihazlari.Olustur();
        _yazicilar = _rgb.Select(d => new CihazYazici(d)).ToList();
        Program.Log("servis başladı | yönetici=" + _admin + " | sürüm " + typeof(Servis).Assembly.GetName().Version);

        OpenHardware();
        LoadState();

        _boru = new BoruSunucu(OnCommand, () => DurumJson());
        _jarvis = new JarvisIzleyici();
        _jarvis.Degisti += () => { var g = _girdi; _girdi = With(g, j: _jarvis.Durum); Publish(); };

        _fanThread = new Thread(FanWorker) { IsBackground = true, Name = "fan" };
        _fanThread.Start();
        new Thread(SensorLoop) { IsBackground = true, Name = "sensor", Priority = ThreadPriority.AboveNormal }.Start();
        new Thread(LightLoop) { IsBackground = true, Name = "isik", Priority = ThreadPriority.Highest }.Start();
    }

    // ---------------------------------------------------------------- hardware

    void OpenHardware()
    {
        if (_admin)
        {
            try
            {
                _lhm = new Computer { IsMotherboardEnabled = true, IsCpuEnabled = true };
                _lhm.Open();
            }
            catch (Exception ex) { Program.Log("LHM açılamadı: " + ex.Message); _lhm = null; }
        }
        try
        {
            if (!_admin) throw new InvalidOperationException("Yönetici servisi gerekli: kurulum henüz yapılmadı.");
            if (_lhm == null) throw new InvalidOperationException("Donanım kütüphanesi açılamadı.");
            _fan = FanCipi.Open(_lhm);
            if (!_fan.Supported) throw new InvalidOperationException("Beklenmeyen fan çipi: " + _fan.Chip);
            _kasaSnap = _fan.Snapshot();
            Program.Log("fan çipi: " + _fan.Board + " / " + _fan.Chip + " | " + _kasaSnap);
        }
        catch (Exception ex) { _fanNeden = ex.Message; Program.Log("fan çipi yok: " + ex.Message); }

        try { _cpu = new Islemci(_lhm); Program.Log("işlemci sıcaklığı: " + (_cpu.Kaynak ?? "yok (yönetici gerekli)")); }
        catch (Exception ex) { Program.Log("işlemci sensörü: " + ex.Message); }

        try { _nvml = Nvml.Open(); }
        catch (Exception ex) { Program.Log("NVML yok: " + ex.Message); }

        try
        {
            _gpuFan = GpuFan.Open();
            _gpuSnap = _gpuFan.Oku();
            Program.Log("ekran kartı fanları: " + _gpuSnap.Count + " soğutucu | devir " + string.Join(",", _gpuSnap.Rpm) + " | elle=" + string.Join(",", _gpuSnap.Manual));
        }
        catch (Exception ex) { _gpuNeden = "Ekran kartı fan denetimine ulaşılamadı: " + ex.Message; Program.Log(_gpuNeden); }
    }

    // ---------------------------------------------------------------- persisted targets

    // UTC, so a DST change or clock correction does not make one boot look like another
    static DateTime BootTime() => DateTime.UtcNow - TimeSpan.FromMilliseconds(GetTickCount64());
    static readonly object SaveLock = new();

    void LoadState()
    {
        bool sameBoot = false, gpuMax = false, rgbOn = false;
        try
        {
            if (File.Exists(StatePath))
            {
                var d = Json.Parse(File.ReadAllText(StatePath, Encoding.UTF8));
                if (d != null && d.TryGetValue("acilis", out var b) && DateTime.TryParse(b as string, Inv, DateTimeStyles.RoundtripKind, out var boot))
                    sameBoot = Math.Abs((boot.ToUniversalTime() - BootTime()).TotalMinutes) < 2;
                gpuMax = Json.B(d, "gpuMax") == true;
                rgbOn = Json.B(d, "rgbAcik") == true;
            }
        }
        catch { }

        // Case fans: the chip is the truth (MAX survives only until reboot).
        if (_kasaSnap != null) _kasaHedef = _kasaSnap.IsMax ? "max" : "bios";
        // GPU fans: ours only if we set them in this boot and they still read MAX.
        if (sameBoot && gpuMax && _gpuSnap != null && _gpuSnap.AllMax) { _gpuHedef = "max"; _gpuBizim = true; }
        // Lights start off after every boot; within the same boot (service restart) they keep their state.
        _rgbAcik = sameBoot && rgbOn;
        _motor.Acik = _rgbAcik;
        Program.Log("başlangıç durumu: kasa=" + _kasaHedef + " gpu=" + _gpuHedef + " rgb=" + _rgbAcik + " (aynı açılış=" + sameBoot + ")");
    }

    void SaveState()
    {
        try
        {
            string text;
            lock (_lock)
                text = new Json().Obj().Str("acilis", BootTime().ToString("o", Inv)).Bool("gpuMax", _gpuHedef == "max" && _gpuBizim).Bool("rgbAcik", _rgbAcik).End().ToString();
            lock (SaveLock)
            {
                var tmp = StatePath + ".yeni";
                File.WriteAllText(tmp, text, new UTF8Encoding(false));
                if (File.Exists(StatePath)) File.Replace(tmp, StatePath, null);
                else File.Move(tmp, StatePath);
            }
        }
        catch (Exception ex) { Program.Log("durum kaydedilemedi: " + ex.Message); }
    }

    // ---------------------------------------------------------------- commands

    readonly object _cmdLock = new();

    void OnCommand(string line)
    {
        var d = Json.Parse(line);
        lock (_cmdLock)   // several clients: commands are applied one at a time
        switch (Json.S(d, "komut"))
        {
            case "kapat":
                // installer/update: stop cleanly so GPU fans return to auto and the lights go dark
                Program.Log("servis: kapatma isteği");
                KapatIstegi?.Invoke();
                break;
            case "onizle":
            {
                // {"komut":"onizle","c":64,"yapayzeka":true,"yzEfekt":2,"islemci":true,"islemciEfekt":1,"jarvis":"dusunuyor"} ; {"komut":"onizle"} clears
                var z = new Zorla();
                if (d.TryGetValue("c", out var c) && c != null) z.C = Convert.ToDouble(c, Inv);
                z.YapayZeka = Json.B(d, "yapayzeka");
                z.Islemci = Json.B(d, "islemci");
                if (d.TryGetValue("yzEfekt", out var ye) && ye != null) z.YzEfekt = Convert.ToInt32(ye);
                if (d.TryGetValue("islemciEfekt", out var ie) && ie != null) z.IslemciEfekt = Convert.ToInt32(ie);
                var jv = Json.S(d, "jarvis");
                if (jv != null && Enum.TryParse<JarvisDurum>(jv, true, out var jd)) z.Jarvis = jd;
                _zorla = z;
                Program.Log("önizleme: " + (z.Bos ? "kapalı" : "c=" + z.C + " yz=" + z.YapayZeka + "/" + z.YzEfekt + " işlemci=" + z.Islemci + "/" + z.IslemciEfekt + " jarvis=" + z.Jarvis));
                break;
            }
            case "ayar-yukle":
            {
                var a = Ayarlar.Yukle();
                bool acik;
                lock (_lock) acik = _rgbAcik;
                var m = new RenkMotoru(a) { Acik = acik, Beklemede = _beklemede };
                m.DevamEt(_motor);
                _ayar = a;
                _motor = m;
                Program.Log("ayarlar yeniden yüklendi");
                Publish();
                break;
            }
            case "fan-kasa": if (!_fanQueue.IsAddingCompleted) _fanQueue.Add("kasa"); break;
            case "fan-gpu": if (!_fanQueue.IsAddingCompleted) _fanQueue.Add("gpu"); break;
            case "rgb":
                bool on = Json.B(d, "acik") == true;
                lock (_lock) _rgbAcik = on;
                _motor.Acik = on;
                Program.Log("rgb: " + (on ? "açık" : "kapalı"));
                SaveState();
                Event("rgb", true, on ? "Işıklar açık" : "Işıklar kapalı");
                Publish();
                break;
        }
    }

    void Event(string kind, bool ok, string text) =>
        _boru?.Broadcast(new Json().Obj().Str("tip", "olay").Str("tur", kind).Str("sonuc", ok ? "tamam" : "hata").Str("metin", text).End().ToString());

    void FanWorker()
    {
        foreach (var job in _fanQueue.GetConsumingEnumerable())
        {
            try
            {
                if (job == "kasa") ToggleKasa();
                else if (job == "gpu") ToggleGpu();
                else if (job == "uyanis") AfterWake();
            }
            catch (Exception ex)
            {
                Program.Log("fan işi (" + job + ") hata: " + ex);
                Event(job == "gpu" ? "fan-gpu" : "fan-kasa", false, ex.Message);
            }
            finally
            {
                lock (_lock) { _kasaBusy = false; _gpuBusy = false; }
                Publish();
            }
        }
    }

    void ToggleKasa()
    {
        if (_fan == null) { Event("fan-kasa", false, _fanNeden ?? "Fan çipi yok"); return; }
        lock (_lock) _kasaBusy = true;
        Publish();
        var before = _fan.Snapshot();
        Program.Log("kasa fanları: geçiş başladı | önce: " + before);
        if (!before.IsMax)
        {
            // An unarchived record of our own means an earlier switch did not finish cleanly (a failed verify): the chip
            // may be half-way and must not overwrite the genuine BIOS bytes recorded then.
            FanSnap own = null;
            if (File.Exists(FanCipi.StatePath)) { own = FanCipi.LoadState(out var s0); if (s0 != FanCipi.StatePath) own = null; }
            if (own != null && own.Mode != before.Mode)
                Program.Log("kasa fanları: çip temiz BIOS durumunda değil, önceki kayıt korunuyor (" + own.RegText() + ")");
            else
                FanCipi.SaveState(before);
            _fan.ApplyMax();
            var after = _fan.Snapshot();
            Program.Log("kasa fanları: MAX yazıldı | sonra: " + after + (after.IsMax ? "" : "  !! doğrulama BAŞARISIZ"));
            lock (_lock) { _kasaSnap = after; _kasaHedef = "max"; }
            Event("fan-kasa", after.IsMax, after.IsMax ? "Kasa ve işlemci fanları en yüksek hızda" : "MAX doğrulanamadı; ayrıntı günlükte");
        }
        else
        {
            var saved = FanCipi.LoadState(out var src);
            if (saved == null)
            {
                Program.Log("kasa fanları: BIOS kaydı yok; fanlar %100'de bırakıldı");
                lock (_lock) _kasaHedef = "max";
                Event("fan-kasa", false, "BIOS kaydı bulunamadı; fanlar en yüksekte kaldı. Yeniden başlatınca BIOS ayarına döner.");
                return;
            }
            _fan.Restore(saved);
            var after = _fan.Snapshot();
            bool ok = after.MatchesSaved(saved);
            Program.Log("kasa fanları: BIOS geri yazıldı (" + src + ") | sonra: " + after + (ok ? "" : "  !! kayıtla EŞLEŞMEDİ"));
            if (ok && src == FanCipi.StatePath) FanCipi.ArchiveState();
            if (!ok)
            {
                // half-restored: go back to MAX so the chip matches the target (the safe side)
                _fan.ApplyMax();
                after = _fan.Snapshot();
                Program.Log("kasa fanları: dönüş doğrulanamadı, MAX yeniden yazıldı | " + after);
            }
            lock (_lock) { _kasaSnap = after; _kasaHedef = ok ? "bios" : "max"; }
            Event("fan-kasa", ok, ok ? "Fanlar BIOS ayarına döndü" : "BIOS'a dönüş doğrulanamadı; ayrıntı günlükte");
        }
    }

    void ToggleGpu()
    {
        if (_gpuFan == null) { Event("fan-gpu", false, _gpuNeden ?? "Ekran kartı fan denetimi yok"); return; }
        string target;
        lock (_lock) { _gpuBusy = true; target = _gpuHedef == "max" ? "oto" : "max"; }
        Publish();
        var before = _gpuFan.Oku();
        Program.Log("ekran kartı fanları: " + target + " | önce: elle=" + string.Join(",", before.Manual) + " seviye=" + string.Join(",", before.SetLevel) + " devir=" + string.Join(",", before.Rpm));
        if (target == "max")
        {
            lock (_lock) _gpuBizim = true;
            _gpuFan.Max();
            Thread.Sleep(300);
            var after = _gpuFan.Oku();
            bool ok = after.AllMax;
            Program.Log("ekran kartı fanları: MAX yazıldı | elle=" + string.Join(",", after.Manual) + " seviye=" + string.Join(",", after.SetLevel) + (ok ? "" : "  !! doğrulama BAŞARISIZ"));
            lock (_lock) { _gpuSnap = after; _gpuHedef = "max"; }
            SaveState();
            Event("fan-gpu", ok, ok ? "Ekran kartı fanları en yüksek hızda" : "MAX doğrulanamadı; ayrıntı günlükte");
        }
        else
        {
            _gpuFan.Oto();
            Thread.Sleep(300);
            var after = _gpuFan.Oku();
            bool ok = after.AllAuto;
            Program.Log("ekran kartı fanları: otomatiğe dönüldü | elle=" + string.Join(",", after.Manual) + (ok ? "" : "  !! doğrulama BAŞARISIZ"));
            lock (_lock) { _gpuSnap = after; if (ok) { _gpuHedef = "oto"; _gpuBizim = false; } }
            SaveState();
            Event("fan-gpu", ok, ok ? "Ekran kartı fanları kendi otomatiğine döndü" : "Otomatiğe dönüş doğrulanamadı; ayrıntı günlükte");
        }
    }

    /// <summary>After wake: MAX targets are re-applied when the hardware lost them (Fan Anahtarı never tested sleep).</summary>
    void AfterWake()
    {
        Thread.Sleep(2500);
        var notes = new List<string>();
        if (_fan != null)
        {
            var s = _fan.Snapshot();
            Program.Log("uyanış: kasa fanları " + s);
            bool wantMax;
            lock (_lock) wantMax = _kasaHedef == "max";
            if (wantMax && !s.IsMax)
            {
                _fan.ApplyMax();
                var a = _fan.Snapshot();
                Program.Log("uyanış: kasa fanları MAX yeniden yazıldı | " + a);
                notes.Add(a.IsMax ? "kasa fanları yeniden en yükseğe alındı" : "kasa fanları yeniden alınamadı");
            }
            lock (_lock) _kasaSnap = _fan.Snapshot();
        }
        if (_gpuFan != null)
        {
            var g = _gpuFan.Oku();
            bool wantMax;
            lock (_lock) wantMax = _gpuHedef == "max";
            Program.Log("uyanış: ekran kartı fanları elle=" + string.Join(",", g.Manual) + " seviye=" + string.Join(",", g.SetLevel));
            if (wantMax && !g.AllMax)
            {
                _gpuFan.Max();
                Thread.Sleep(300);
                g = _gpuFan.Oku();
                Program.Log("uyanış: ekran kartı fanları MAX yeniden yazıldı | tamam=" + g.AllMax);
                notes.Add(g.AllMax ? "ekran kartı fanları yeniden en yükseğe alındı" : "ekran kartı fanları yeniden alınamadı");
            }
            lock (_lock) _gpuSnap = g;
        }
        if (notes.Count > 0) Event("uyanis", true, "Uykudan sonra: " + string.Join(", ", notes));
    }

    // ---------------------------------------------------------------- sensors

    static Girdi With(Girdi g, JarvisDurum? j = null) => new()
    {
        CpuC = g.CpuC, GpuC = g.GpuC, CpuYuk = g.CpuYuk, GpuYuk = g.GpuYuk, YapayZeka = g.YapayZeka, Islemci = g.Islemci,
        Jarvis = j ?? g.Jarvis,
    };

    void SensorLoop()
    {
        int tick = 0;
        var next = DateTime.UtcNow;
        while (!_stop)
        {
            try { SensorTick(tick++); }
            catch (Exception ex) { Program.Log("sensör turu hata: " + ex.Message); }
            next += TimeSpan.FromMilliseconds(500);
            var wait = next - DateTime.UtcNow;
            if (wait < TimeSpan.Zero) { next = DateTime.UtcNow; wait = TimeSpan.Zero; }
            Thread.Sleep(wait);
        }
    }

    void SensorTick(int tick)
    {
        var g = new Girdi { Jarvis = _jarvis?.Durum ?? JarvisDurum.Yok };
        g.CpuC = _cpu?.Sicaklik();
        g.CpuYuk = _cpu?.Yuk() ?? 0;
        if (_nvml != null)
        {
            g.GpuC = _nvml.Sicaklik();
            g.GpuYuk = _nvml.Yuk() ?? 0;
            _model.Besle(_nvml.SurecKullanimi());
        }
        g.YapayZeka = _model.Uretiyor;

        // CPU under sustained heavy load: on after 30 s above 80 %, off after 10 s below 60 %, so a compile spike or a
        // short burst never starts it (the earlier 3 s rule flickered 9 times in 30 minutes on 11-16).
        _cpuEma += (g.CpuYuk - _cpuEma) * (1 - Math.Exp(-0.5 / 3.0));
        var now = DateTime.UtcNow;
        if (_cpuEma >= 80) { _islemciOffSince = DateTime.MinValue; if (_islemciSince == DateTime.MinValue) _islemciSince = now; }
        else _islemciSince = DateTime.MinValue;
        if (_cpuEma < 60) { if (_islemciOffSince == DateTime.MinValue) _islemciOffSince = now; }
        else _islemciOffSince = DateTime.MinValue;
        if (!_islemci && _islemciSince != DateTime.MinValue && now - _islemciSince > TimeSpan.FromSeconds(30)) { _islemci = true; Program.Log("ışık: işlemci yoğun yükte (30 sn)"); }
        if (_islemci && _islemciOffSince != DateTime.MinValue && now - _islemciOffSince > TimeSpan.FromSeconds(10)) { _islemci = false; Program.Log("ışık: işlemci yükü bitti"); }
        g.Islemci = _islemci;

        // idle: no real (not injected) mouse/keyboard input for the configured minutes
        int dk = _ayar.BeklemeDakika;
        bool idle = dk > 0 && KullaniciGirdisi.Bosta > TimeSpan.FromMinutes(dk);
        if (idle != _beklemede) { _beklemede = idle; Program.Log(idle ? "ışık: " + dk + " dk girdi yok, beklemede (söner)" : "ışık: girdi geldi, beklemeden çıktı"); }
        _motor.Beklemede = idle;

        _girdi = g;

        if (tick % 2 == 0 && !_uyku)
        {
            if (_fan != null) { var s = _fan.Snapshot(); lock (_lock) _kasaSnap = s; }
            if (_gpuFan != null) { try { var s = _gpuFan.Oku(); lock (_lock) _gpuSnap = s; } catch (Exception ex) { Program.Log("ekran kartı fan okuması: " + ex.Message); } }
        }
        if (tick % 10 == 0) { _ab.Yenile(); Takili(); }

        if (DateTime.UtcNow - _lastHistory > TimeSpan.FromSeconds(60))
        {
            _lastHistory = DateTime.UtcNow;
            WriteHistory(g);
        }
        Publish();
    }

    readonly System.Collections.Concurrent.ConcurrentDictionary<string, bool> _takili = new();

    /// <summary>Which devices are plugged in: USB enumeration only (no handle opened, nothing sent to a device).</summary>
    void Takili()
    {
        try
        {
            var list = HidSharp.DeviceList.Local;
            _takili["aio"] = list.GetHidDevices(0x2516, 0x0173).Any();
            _takili["klavye"] = list.GetHidDevices(0x1038, 0x161A).Any();
        }
        catch (Exception ex) { Program.Log("usb listesi okunamadı: " + ex.Message); }
    }

    void WriteHistory(Girdi g)
    {
        try
        {
            if (!File.Exists(HistoryPath)) File.WriteAllText(HistoryPath, "zaman,cpu,gpu,ort,yumusak,cpu_yuk,gpu_yuk\r\n", new UTF8Encoding(false));
            var fi = new FileInfo(HistoryPath);
            if (fi.Length > 4 << 20)
            {
                var keep = File.ReadAllLines(HistoryPath);
                File.WriteAllLines(HistoryPath, new[] { keep[0] }.Concat(keep.Skip(keep.Length / 2)));
            }
            string F(double? v) => v.HasValue ? v.Value.ToString("0.0", Inv) : "";
            File.AppendAllText(HistoryPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm", Inv) + "," + F(g.CpuC) + "," + F(g.GpuC) + ","
                + F(_motor.Ortalama) + "," + F(_motor.Yumusak) + "," + g.CpuYuk.ToString("0", Inv) + "," + g.GpuYuk.ToString("0", Inv) + "\r\n");
        }
        catch { }
    }

    // ---------------------------------------------------------------- light

    void LightLoop()
    {
        using var timer = new HiResTimer();
        const double period = 1.0 / 30;
        var clock = System.Diagnostics.Stopwatch.StartNew();
        double last = 0, nextAt = 0;
        int frame = 0;
        while (!_stop)
        {
            double t = clock.Elapsed.TotalSeconds;
            double dt = Math.Min(0.25, t - last);
            last = t;
            try
            {
                var gi = _girdi;
                var z = _zorla;
                if (!z.Bos)
                    gi = new Girdi
                    {
                        CpuC = z.C ?? gi.CpuC, GpuC = z.C ?? gi.GpuC, CpuYuk = gi.CpuYuk, GpuYuk = gi.GpuYuk,
                        YapayZeka = z.YapayZeka ?? gi.YapayZeka, Islemci = z.Islemci ?? gi.Islemci, Jarvis = z.Jarvis ?? gi.Jarvis,
                        YzEfekt = z.YzEfekt, IslemciEfekt = z.IslemciEfekt,
                    };
                _motor.Hesapla(gi, t, dt);
                if (!_uyku) WriteDevices();
                if (_boru != null && _boru.Count > 0) _boru.Broadcast(IsikJson());
            }
            catch (Exception ex)
            {
                if (frame % 300 == 0) Program.Log("ışık turu hata: " + ex.Message);
            }
            frame++;
            nextAt += period;
            double wait = nextAt - clock.Elapsed.TotalSeconds;
            if (wait < -0.2) { nextAt = clock.Elapsed.TotalSeconds; wait = 0; }   // fell far behind (sleep): resync
            if (wait > 0) timer.Wait(wait);
        }
    }

    readonly Dictionary<IRgbCihaz, Rgb.Rgb[]> _frames = new();

    /// <summary>Hand each device writer its newest frame. Nothing reaches a device while the lights are off, so a
    /// boot with the lights off never touches the controllers at all.</summary>
    void WriteDevices()
    {
        bool lit = _motor.Acik || _motor.Cikis.Max > 0.002;
        if (!lit)
        {
            if (!_karanlik) { foreach (var w in _yazicilar) w.Sondur(); _karanlik = true; }
            return;
        }
        _karanlik = false;
        foreach (var w in _yazicilar)
        {
            var d = w.Cihaz;
            Lin[] src = d.Kimlik == "aio" ? _motor.Aio : d.Kimlik == "klavye" ? _motor.Klavye : _motor.Gpu;
            if (!_frames.TryGetValue(d, out var frame) || frame.Length != d.LedSayisi) _frames[d] = frame = new Rgb.Rgb[d.LedSayisi];
            var gain = _ayar.Kazanc.TryGetValue(d.Kimlik, out var k) ? k : new[] { 1.0, 1.0, 1.0 };
            for (int j = 0; j < frame.Length; j++)
            {
                var c = src[j < src.Length ? j : src.Length - 1];
                frame[j] = new Rgb.Rgb(B8(c.R * gain[0]), B8(c.G * gain[1]), B8(c.B * gain[2]));
            }
            w.Kare(frame);
        }
    }

    static byte B8(double v) => (byte)Math.Round(Lin.Clamp(v) * 255);

    // ---------------------------------------------------------------- messages

    string IsikJson()
    {
        var j = new Json().Obj().Str("tip", "isik").Bool("acik", _motor.Acik);
        _motor.Taban.ToSrgb(out int r, out int g, out int b);
        j.Rgb("onizleme", r, g, b);
        _motor.Cikis.ToSrgb(out r, out g, out b);
        j.Rgb("cikis", r, g, b);
        j.Arr("halka");
        foreach (var c in _motor.Aio) { c.ToSrgb(out r, out g, out b); j.Rgb(null, r, g, b); }
        j.End().Arr("klavye");
        foreach (var c in _motor.Klavye) { c.ToSrgb(out r, out g, out b); j.Rgb(null, r, g, b); }
        return j.End().End().ToString();
    }

    string DurumJson()
    {
        var gi = _girdi;
        var j = new Json().Obj().Str("tip", "durum");
        j.Obj("servis").Bool("yonetici", _admin).Str("surum", typeof(Servis).Assembly.GetName().Version.ToString(3)).End();
        j.Obj("isi").Num("cpu", gi.CpuC).Num("gpu", gi.GpuC).Num("ort", _motor.Ortalama).Num("yumusak", _motor.Yumusak)
         .Num("cpuYuk", Math.Round(gi.CpuYuk)).Num("gpuYuk", Math.Round(gi.GpuYuk)).End();
        lock (_lock)
        {
            j.Obj("fan").Obj("kasa").Str("hedef", _kasaHedef)
             .Str("durum", _kasaBusy ? "geciyor" : _kasaSnap == null ? "bilinmiyor" : _kasaSnap.IsMax ? "max" : "bios")
             .Bool("kullanilabilir", _fan != null).Str("neden", _fan != null ? null : _fanNeden).Arr("rpm");
            if (_kasaSnap != null)
                for (int k = 0; k < FanSnap.RpmCount; k++)
                    if (_kasaSnap.Rpm[k] > 0) j.Obj().Str("ad", FanCipi.FanName(k)).Int("rpm", _kasaSnap.Rpm[k]).End();
            j.End().End();

            var gs = _gpuSnap;
            bool manualNotOurs = gs != null && gs.AnyManual && !_gpuBizim;
            string gd = _gpuBusy ? "geciyor" : gs == null ? "bilinmiyor" : gs.AllMax && _gpuBizim ? "max" : gs.AllAuto ? "oto" : gs.AnyManual ? "baska" : "bilinmiyor";
            j.Obj("gpu").Str("hedef", _gpuHedef).Str("durum", gd).Bool("kullanilabilir", _gpuFan != null).Str("neden", _gpuFan != null ? null : _gpuNeden).Arr("rpm");
            if (gs != null) foreach (var r in gs.Rpm) j.Int(null, r);
            j.End().Num("yuzde", gs != null && gs.Count > 0 ? gs.Level.Average() : (double?)null)
             .Obj("afterburner").Bool("calisiyor", _ab.Calisiyor).Bool("fanKontrolu", _ab.FanKontrolu(manualNotOurs)).End()
             .End().End();
        }

        j.Obj("rgb").Bool("acik", _motor.Acik)
         .Bool("beklemede", _motor.Acik && _beklemede).Int("beklemeDakika", _ayar.BeklemeDakika)
         .Obj("efektler").Bool("yapayzeka", _motor.YapayZekaEfekti).Bool("islemci", _motor.IslemciEfekti).End()
         .Str("jarvis", (_jarvis?.Durum ?? JarvisDurum.Yok) switch
         {
             JarvisDurum.Dusunuyor => "dusunuyor", JarvisDurum.Bekliyor => "bekliyor", JarvisDurum.Hazir => "hazir",
             JarvisDurum.Kapali => "kapali", JarvisDurum.Yeniden => "yeniden", _ => "yok",
         });
        j.Arr("cihazlar");
        foreach (var d in _rgb)
        {
            // While the lights are off the devices are never opened; "connected" then means present on USB.
            bool present = d.Bagli || (_takili.TryGetValue(d.Kimlik, out var t) && t);
            j.Obj().Str("kimlik", d.Kimlik).Str("ad", d.Ad).Bool("bagli", present).Str("hata", present ? null : d.Hata).End();
        }
        if (!_rgb.Any(d => d.Kimlik == "gpu"))
            j.Obj().Str("kimlik", "gpu").Str("ad", "MSI RTX 4080 Gaming X Trio").Bool("bagli", false).Bool("kilitli", true).Null("hata").End();
        j.End().Arr("duraklar");
        foreach (var s in _ayar.Duraklar) j.Obj().Num("c", s.C).Rgb("renk", s.Renk[0], s.Renk[1], s.Renk[2]).Str("ad", s.Ad).End();
        j.End().End();
        return j.End().ToString();
    }

    readonly object _publishLock = new();

    void Publish()
    {
        lock (_publishLock)
        {
            var s = DurumJson();
            if (s == _lastDurum) return;
            _lastDurum = s;
            _boru?.Broadcast(s);
        }
    }

    // ---------------------------------------------------------------- power and shutdown

    /// <summary>Before sleep: every device dark and released, waiting up to a second each (Windows allows ~2 s).</summary>
    public void OnSuspend()
    {
        Program.Log("uyku: ışıklar karartılıyor");
        _uyku = true;
        foreach (var w in _yazicilar)
            if (!w.Uyu(TimeSpan.FromMilliseconds(1000))) Program.Log("uyku: " + w.Cihaz.Ad + " bir saniyede kararmadı");
        _karanlik = true;
    }

    System.Threading.Timer _wakeTimer;

    public void OnResume()
    {
        Program.Log("uyanış");
        foreach (var w in _yazicilar) w.Uyan();
        _karanlik = true;
        _uyku = false;
        // Fans: check right after wake and once more later, in case the EC or the driver resets after a delay.
        try
        {
            _fanQueue.Add("uyanis");
            _wakeTimer?.Dispose();
            _wakeTimer = new System.Threading.Timer(_ => { try { _fanQueue.Add("uyanis"); } catch { } }, null, 20000, Timeout.Infinite);
        }
        catch (InvalidOperationException) { /* shutting down */ }
    }

    int _shutdown;

    /// <summary>Exit, logoff, crash: GPU fans back to the card's auto control, lights off. Case fans stay as they
    /// are (MAX until reboot is the safe side; the EC returns to BIOS control on reboot).</summary>
    public void Kapanis(string why)
    {
        if (Interlocked.Exchange(ref _shutdown, 1) == 1) return;
        Program.Log("servis kapanıyor: " + why);
        _stop = true;
        // Let a fan switch in progress finish (a chip sequence cut between its begin and end is the one way a fan
        // could be left pinned low), and start no new one.
        try { _fanQueue.CompleteAdding(); } catch { }
        if (_fanThread != null && Thread.CurrentThread != _fanThread && !_fanThread.Join(4000))
            Program.Log("kapanış: fan işi 4 sn'de bitmedi");
        try
        {
            bool restore;
            lock (_lock) restore = _gpuBizim;   // we put the coolers in manual at some point: give them back
            if (restore && _gpuFan != null)
            {
                _gpuFan.Oto();
                var a = _gpuFan.Oku();
                Program.Log("kapanış: ekran kartı fanları otomatiğe döndü=" + a.AllAuto);
            }
        }
        catch (Exception ex) { Program.Log("kapanış: ekran kartı fanları geri alınamadı: " + ex.Message); }
        foreach (var w in _yazicilar) { try { w.Dispose(); } catch { } }
    }

    public void Dispose()
    {
        Kapanis("dispose");
        _jarvis?.Dispose();
        _boru?.Dispose();
        _fan?.Dispose();
        try { _lhm?.Close(); } catch { }
    }

    [DllImport("kernel32.dll")]
    static extern ulong GetTickCount64();
}

/// <summary>High-resolution waitable timer (Windows 10 1803+): precise waits without raising the system timer rate.</summary>
sealed class HiResTimer : IDisposable
{
    const uint CREATE_WAITABLE_TIMER_HIGH_RESOLUTION = 0x2, TIMER_ALL_ACCESS = 0x1F0003;
    readonly IntPtr _h;

    public HiResTimer()
    {
        _h = CreateWaitableTimerExW(IntPtr.Zero, null, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    }

    public void Wait(double seconds)
    {
        if (_h == IntPtr.Zero) { Thread.Sleep(Math.Max(1, (int)(seconds * 1000))); return; }
        long due = -(long)(seconds * 1e7);   // relative, 100 ns units
        if (SetWaitableTimer(_h, ref due, 0, IntPtr.Zero, IntPtr.Zero, false)) WaitForSingleObject(_h, 0xFFFFFFFF);
        else Thread.Sleep(Math.Max(1, (int)(seconds * 1000)));
    }

    public void Dispose() { if (_h != IntPtr.Zero) CloseHandle(_h); }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWaitableTimerExW(IntPtr attr, string name, uint flags, uint access);
    [DllImport("kernel32.dll")] static extern bool SetWaitableTimer(IntPtr h, ref long due, int period, IntPtr cb, IntPtr arg, bool resume);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
}

/// <summary>Entry for `servis`: single instance, hidden window for power/session messages, shutdown hooks.</summary>
static class ServisUygulamasi
{
    public static int Run()
    {
        using var single = new Mutex(true, Servis.MutexName, out bool fresh);
        if (!fresh) { Program.Log("servis zaten çalışıyor"); return 0; }
        var s = new Servis();
        AppDomain.CurrentDomain.UnhandledException += (_, e) => { Program.Log("ÇÖKME: " + e.ExceptionObject); s.Kapanis("çökme"); };
        AppDomain.CurrentDomain.ProcessExit += (_, _) => s.Kapanis("süreç çıkışı");
        var form = new GizliPencere(s);
        s.KapatIstegi = () => { try { form.BeginInvoke((Action)form.Close); } catch { } };
        Application.Run(form);
        s.Dispose();
        return 0;
    }

    sealed class GizliPencere : Form
    {
        const int WM_POWERBROADCAST = 0x218, WM_QUERYENDSESSION = 0x11, WM_ENDSESSION = 0x16;
        const int PBT_APMSUSPEND = 0x4, PBT_APMRESUMESUSPEND = 0x7, PBT_APMRESUMEAUTOMATIC = 0x12;
        readonly Servis _s;
        bool _suspended;

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            KullaniciGirdisi.Kur();   // low-level hooks need this thread's message loop
        }

        public GizliPencere(Servis s)
        {
            _s = s;
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
            Opacity = 0;
            Size = new System.Drawing.Size(1, 1);
            Text = "Kontrol Merkezi Servisi";
        }

        protected override void SetVisibleCore(bool value) { CreateHandle(); base.SetVisibleCore(false); }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_POWERBROADCAST)
            {
                int ev = m.WParam.ToInt32();
                if (ev == PBT_APMSUSPEND) { _suspended = true; _s.OnSuspend(); }
                else if ((ev == PBT_APMRESUMEAUTOMATIC || ev == PBT_APMRESUMESUSPEND) && _suspended)
                {
                    // both arrive on a user wake: act on the first resume after each suspend
                    _suspended = false;
                    _s.OnResume();
                }
            }
            else if (m.Msg == WM_ENDSESSION && m.WParam != IntPtr.Zero)
            {
                _s.Kapanis("oturum kapanıyor");
            }
            base.WndProc(ref m);
        }
    }
}
