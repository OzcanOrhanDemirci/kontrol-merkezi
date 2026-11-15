// Cooler Master ARGB Gen 2 A1 (USB 2516:0173, interface 1, usage page 0xFF01): the Halo 360 AIO lighting.
//
// Protocol facts from OpenRGB 1.1 Controllers/CoolerMasterController/CMARGBGen2A1Controller (reimplemented, see
// docs/RGB_SURUCULER.md). 65-byte reports, byte 0 = report id 0.
//   Command page:  [1]=0x80 [2]=cmd [3]=op (1 read, 2 write) [4..]=payload; reply [0]=0x80 [1]=cmd [2]=0x03 [3..]=echo/data.
//   Realtime RGB:  three reports per target (one Gen2 sub-device, up to 60 LEDs = 180 bytes):
//                  [1]=0x00 [2]=0x09 [3]=port mask [4]=sub-device mask [5]=60 [6..64]=bytes 0..58
//                  [1]=0x01 [2]=0x09 [3..64]=bytes 59..120
//                  [1]=0x82 [2]=0x09 [3..61]=bytes 121..179
//
// SAFETY: this driver only ever WRITES command 0x01 (realtime on/off, a runtime session flag) and the 0x09 realtime
// colour stream. Everything else it sends is a READ (0xB4 firmware, 0x0B generation, 0x07 topology, 0x03 current effect).
// It never sends 0xB0 (save to flash), 0xB1 (reset), or a write of 0x0B/0x06/0x03/0x08/0x0D/0x10/0x11/0xB5/0xC0, all of
// which change what the controller stores or shows on its own. Komut() refuses any such write at runtime.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace KontrolMerkezi.Rgb;

public sealed class CoolerMasterA1 : IRgbCihaz
{
    const int Vid = 0x2516, Pid = 0x0173, ArayuzNo = 1;
    const uint UsagePage = 0xFF01;
    const int RaporBoyu = 65;

    const byte Sayfa = 0x80, Oku_ = 0x01, Yaz_ = 0x02, Yanit = 0x03;
    const byte CmdGercekZamanli = 0x01, CmdEfekt = 0x03, CmdTopoloji = 0x07, CmdRenkAkisi = 0x09, CmdNesil = 0x0B, CmdSurum = 0xB4;
    const int HedefMaxLed = 60;
    const int YanitZamanAsimiMs = 150;

    /// <summary>Minimum spacing between two realtime reports, ms. MasterPlus spaces them ~3 ms (OpenRGB: 2 ms sleep after each write).</summary>
    public double PaketAraligiMs { get; set; } = 2.5;
    /// <summary>An unchanged frame is re-sent after this long, so a controller watchdog (if any) never drops realtime.</summary>
    public int TekrarMs { get; set; } = 1000;

    readonly object kilit = new();
    HidKanal kanal;
    bool gercekZamanli;
    long sonPaketTick;
    long sonKareTick;
    Rgb[] sonKare;

    public sealed class Hedef
    {
        public byte Port, Alt;
        public int Led;
        public override string ToString() => $"port{Port:X2}/alt{Alt:X2}:{Led}";
    }

    public List<Hedef> Hedefler { get; } = new();
    public string Surum { get; private set; }

    public string Kimlik => "aio";
    public string Ad => "Cooler Master Halo 360";
    public int LedSayisi => Hedefler.Count == 0 ? 84 : Hedefler.Sum(h => h.Led);
    public bool Bagli { get; private set; }
    public string Hata { get; private set; }
    public bool GercekZamanli => gercekZamanli;

    /// <summary>Last frame's write time in ms (all reports of the frame).</summary>
    public double SonYazmaMs { get; private set; }

    public bool Ac()
    {
        lock (kilit)
        {
            Kapat();
            Hata = null;
            kanal = HidKanal.Ac(Vid, Pid, ArayuzNo, UsagePage, RaporBoyu, out var h);
            if (kanal == null) { Hata = "AIO ışık kartı: " + h; return false; }
            try
            {
                kanal.Bosalt();
                var r = Komut(CmdSurum, Oku_, new byte[0], null);
                Surum = r == null ? null : "0x" + (r[3] | (r[4] << 8)).ToString("X4");

                Hedefler.Clear();
                for (int port = 0; port < 3; port++)
                {
                    byte maske = (byte)(1 << port);
                    var g = Komut(CmdNesil, Oku_, new[] { maske }, new[] { maske });
                    if (g == null || g[4] != 0x00) continue;   // only Gen2 ports are driven; Gen1 / unknown ports skipped
                    for (int deneme = 0; deneme < 3; deneme++)
                    {
                        var t = Komut(CmdTopoloji, Oku_, new[] { maske }, new[] { maske });
                        if (t == null) continue;
                        int n = Math.Min((int)t[4], 5);
                        for (int i = 0; i < n; i++)
                        {
                            byte alt = t[5 + i * 2], led = t[6 + i * 2];
                            if (alt != 0 && led != 0)
                                Hedefler.Add(new Hedef { Port = maske, Alt = alt, Led = Math.Min((int)led, HedefMaxLed) });
                        }
                        break;
                    }
                }
                if (Hedefler.Count == 0) { Hata = "AIO ışık kartı: bağlı fan/pompa bulunamadı"; Kapat(); return false; }
                Bagli = true;
                return true;
            }
            catch (Exception ex)
            {
                Hata = "AIO ışık kartı: " + ex.Message;
                Kapat();
                return false;
            }
        }
    }

    public bool Yaz(Rgb[] renkler)
    {
        lock (kilit)
        {
            if (kanal == null || renkler == null) return false;
            long simdi = Stopwatch.GetTimestamp();
            if (sonKare != null && gercekZamanli && Ayni(renkler, sonKare)
                && (simdi - sonKareTick) * 1000 / Stopwatch.Frequency < TekrarMs)
                return true;
            try
            {
                if (!gercekZamanli) GercekZamanliGir();
                long t0 = Stopwatch.GetTimestamp();
                int i0 = 0;
                foreach (var h in Hedefler)
                {
                    KareGonder(h.Port, h.Alt, renkler, i0, h.Led);
                    i0 += h.Led;
                }
                SonYazmaMs = (Stopwatch.GetTimestamp() - t0) * 1000.0 / Stopwatch.Frequency;
                sonKare = (Rgb[])renkler.Clone();
                sonKareTick = t0;
                Bagli = true;
                return true;
            }
            catch (Exception ex)
            {
                Hata = "AIO ışık kartı yazılamadı: " + ex.Message;
                Bagli = false;
                Kapat();
                return false;
            }
        }
    }

    /// <summary>Dark without storing anything: black realtime frame, then leave realtime so the controller falls back to
    /// its own current effect (here "Off", which Özcan set and stored himself).</summary>
    public void Sondur()
    {
        lock (kilit)
        {
            if (kanal == null) return;
            try
            {
                if (gercekZamanli)
                {
                    var siyah = new Rgb[LedSayisi];
                    int i0 = 0;
                    foreach (var h in Hedefler) { KareGonder(h.Port, h.Alt, siyah, i0, h.Led); i0 += h.Led; }
                }
                GercekZamanliCik();
                sonKare = null;
            }
            catch (Exception ex)
            {
                Hata = "AIO ışık kartı söndürülemedi: " + ex.Message;
                Bagli = false;
            }
        }
    }

    public void Birak()
    {
        lock (kilit) Kapat();
    }

    public void Dispose() => Birak();

    // ---- reads used by the test command (all read-only) ----

    /// <summary>Current hardware effect record of one target: mode, speed, brightness, r, g, b, random, smode.</summary>
    public byte[] EfektOku(byte port, byte alt)
    {
        lock (kilit)
        {
            var r = Komut(CmdEfekt, Oku_, new[] { port, alt }, new[] { port, alt });
            if (r == null) return null;
            var e = new byte[8];
            Array.Copy(r, 5, e, 0, 8);
            return e;
        }
    }

    // ---- protocol ----

    void GercekZamanliGir()
    {
        Zamanlayici.Iste();
        // MasterPlus's entry, as OpenRGB captured it (CMARGBGen2A1Controller.cpp SendRealtimePreamble):
        // ON, two global black frames, ON again, five global black frames, then target frames ~104 ms after the 2nd ON.
        if (Komut(CmdGercekZamanli, Yaz_, new byte[] { 0x01 }, new byte[] { 0x01 }) == null)
            throw new Exception("gerçek zamanlı kip açılmadı");
        gercekZamanli = true;
        var siyah = new Rgb[HedefMaxLed];
        for (int i = 0; i < 2; i++) KareGonder(0xFF, 0xFF, siyah, 0, HedefMaxLed);
        long ikinci = Stopwatch.GetTimestamp();
        if (Komut(CmdGercekZamanli, Yaz_, new byte[] { 0x01 }, new byte[] { 0x01 }) == null)
            throw new Exception("gerçek zamanlı kip açılmadı");
        for (int i = 0; i < 5; i++) KareGonder(0xFF, 0xFF, siyah, 0, HedefMaxLed);
        Zamanlayici.Bekle(ikinci, 104);
    }

    void GercekZamanliCik()
    {
        // Idempotent; sent even when this process never entered realtime (recovers a crashed run).
        Zamanlayici.Bekle(sonPaketTick, 10);
        bool tamam = false;
        for (int deneme = 0; deneme < 2 && !tamam; deneme++)
        {
            tamam = Komut(CmdGercekZamanli, Yaz_, new byte[] { 0x00 }, new byte[] { 0x00 }) != null;
            if (!tamam) System.Threading.Thread.Sleep(10);
        }
        if (gercekZamanli) Zamanlayici.Birak();
        gercekZamanli = false;
        if (!tamam) throw new Exception("gerçek zamanlı kipten çıkış onaylanmadı");
    }

    void KareGonder(byte port, byte alt, Rgb[] renkler, int bas, int adet)
    {
        var veri = new byte[HedefMaxLed * 3];
        for (int i = 0; i < adet && i < HedefMaxLed && bas + i < renkler.Length; i++)
        {
            veri[i * 3] = renkler[bas + i].R;
            veri[i * 3 + 1] = renkler[bas + i].G;
            veri[i * 3 + 2] = renkler[bas + i].B;
        }
        var r = new byte[RaporBoyu];
        r[1] = 0x00; r[2] = CmdRenkAkisi; r[3] = port; r[4] = alt; r[5] = HedefMaxLed;
        Array.Copy(veri, 0, r, 6, 59);
        Paket(r);
        r = new byte[RaporBoyu];
        r[1] = 0x01; r[2] = CmdRenkAkisi;
        Array.Copy(veri, 59, r, 3, 62);
        Paket(r);
        r = new byte[RaporBoyu];
        r[1] = 0x82; r[2] = CmdRenkAkisi;
        Array.Copy(veri, 121, r, 3, 59);
        Paket(r);
    }

    void Paket(byte[] r)
    {
        if (r[2] != CmdRenkAkisi) throw new InvalidOperationException("yalnız renk akışı paketi");
        Zamanlayici.Bekle(sonPaketTick, PaketAraligiMs);
        sonPaketTick = Stopwatch.GetTimestamp();
        kanal.Yaz(r);
    }

    /// <summary>Command-page request/response. Returns the 64-byte reply (index 0 = 0x80) or null on timeout/NAK.
    /// Refuses every write except 0x01 (realtime on/off).</summary>
    byte[] Komut(byte cmd, byte op, byte[] yuk, byte[] beklenen)
    {
        if (op != Oku_ && op != Yaz_) throw new InvalidOperationException("geçersiz işlem");
        if (op == Yaz_ && cmd != CmdGercekZamanli)
            throw new InvalidOperationException($"AIO: 0x{cmd:X2} yazma komutu bu sürücüde yasak (kalıcı ayar değiştirebilir)");
        if (op == Oku_ && cmd != CmdSurum && cmd != CmdNesil && cmd != CmdTopoloji && cmd != CmdEfekt)
            throw new InvalidOperationException($"AIO: 0x{cmd:X2} okuma komutu listede yok");

        var r = new byte[RaporBoyu];
        r[1] = Sayfa; r[2] = cmd; r[3] = op;
        Array.Copy(yuk, 0, r, 4, yuk.Length);
        kanal.Bosalt();
        Zamanlayici.Bekle(sonPaketTick, 1);
        sonPaketTick = Stopwatch.GetTimestamp();
        kanal.Yaz(r);

        var son = Stopwatch.GetTimestamp() + YanitZamanAsimiMs * Stopwatch.Frequency / 1000;
        while (Stopwatch.GetTimestamp() < son)
        {
            int kalan = (int)Math.Max(1, (son - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency);
            var raw = kanal.Oku(kalan);
            if (raw == null) return null;
            int o;
            if (raw.Length > 1 && raw[0] == 0x00 && raw[1] == Sayfa) o = 1;
            else if (raw[0] == Sayfa) o = 0;
            else continue;
            var c = new byte[64];
            Array.Copy(raw, o, c, 0, Math.Min(64, raw.Length - o));
            if (c[1] != cmd) continue;
            if (beklenen != null && !beklenen.Select((b, i) => c[3 + i] == b).All(x => x)) continue;
            return c[2] == Yanit ? c : null;
        }
        return null;
    }

    static bool Ayni(Rgb[] a, Rgb[] b)
    {
        if (a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++) if (!a[i].Equals(b[i])) return false;
        return true;
    }

    void Kapat()
    {
        if (gercekZamanli) Zamanlayici.Birak();
        gercekZamanli = false;   // the controller stays in realtime until Sondur, power loss or a watchdog
        kanal?.Dispose();
        kanal = null;
        Bagli = false;
        sonKare = null;
    }
}
