// Short runs on the graphics card's lights (docs/GPU_ISIK_PLANI.md).
//
//   rgb-dene gpu sondur --karta-yaz    zones off (one write, 2D=03)
//   rgb-dene gpu sira --karta-yaz      white 5 s (MSI's full sequence), blue 5 s (colour + steady), then dark
//   rgb-dene gpu tekrar [s] --karta-yaz white, then the same white re-sent as colour + steady ~10 times a second for s (15)
//   rgb-dene gpu gecis --karta-yaz    A/B: the preview transition on the card alone, linear values, then sRGB-encoded
//   rgb-dene gpu gecis-dokum           computation only: what the card receives in gecis.py's transition
//   rgb-dene gpu servis                card-less build only: the service's writer through start, on, off, wake, exit
//
// Do not run these while the installed service drives the card (both would write). Every write goes to the console
// and to %LOCALAPPDATA%\KontrolMerkezi\gpu-deneme.txt with its time, and every run ends dark. In a build without
// GPU_ISIK (-p:GpuIsik=kapali) there is no path to the card at all: the same commands run against KayitYolu and print
// the writes they would make (BENZETİM). In a GPU_ISIK build nothing runs without --karta-yaz.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using KontrolMerkezi.Isik;

namespace KontrolMerkezi.Rgb;

static class GpuDeneme
{
    static StreamWriter dosya;

    static void Yaz(string s)
    {
        Console.WriteLine(s);
        try { dosya?.WriteLine(s); dosya?.Flush(); } catch { }
    }

    public static int Calistir(List<string> a)
    {
        bool kartaYaz = a.Remove("--karta-yaz");
        if (a.Count == 0) { Yaz("kullanım: rgb-dene gpu <sondur|sira> --karta-yaz"); return 64; }
#if !GPU_ISIK
        if (a[0] == "servis") return ServisBenzetimi();
#endif
        if (a[0] == "gecis-dokum") return GecisDokumu();   // computation only, reaches no device

        KayitYolu kayit = null;
#pragma warning disable CS0162
        if (MsiGpuV2.KartaYazabilir)
        {
            if (!kartaYaz) { Yaz("Karta yazmak için --karta-yaz gerekli. Hiçbir şey gönderilmedi."); return 64; }
        }
        else
        {
            kayit = new KayitYolu();
            Yaz("BENZETİM: bu derleme karta yazamaz (GPU_ISIK yok); yazmalar yalnız listelenir.");
        }
#pragma warning restore CS0162

        try
        {
            dosya = new StreamWriter(Path.Combine(Program.DataDir, "gpu-deneme.txt"), true, new System.Text.UTF8Encoding(false));
            Yaz($"== {DateTime.Now:yyyy-MM-dd HH:mm:ss} rgb-dene gpu {string.Join(" ", a)}{(kayit != null ? " (BENZETİM)" : "")}");
        }
        catch { }

        var kart = kayit == null ? new MsiGpuV2() : new MsiGpuV2(kayit);
        kart.Iz = Yaz;
        bool bitti = false;
        ConsoleCancelEventHandler kes = (_, e) => { e.Cancel = true; bitti = true; };
        Console.CancelKeyPress += kes;
        try
        {
            if (!kart.Ac()) { Yaz("açılamadı: " + kart.Hata + " (hiçbir şey gönderilmedi)"); return 2; }
            Yaz("kart bulundu: " + kart.Ad);
            switch (a[0])
            {
                case "sondur":
                    return 0;   // the finally below is the run
                case "sira":
                    foreach (var (ad, c) in new[] { ("beyaz (tam sıra)", new Rgb(255, 255, 255)), ("mavi (renk + sabit)", new Rgb(0, 0, 255)) })
                    {
                        if (bitti) break;
                        Yaz($"-- {ad}, 5 sn");
                        if (!kart.Yaz(new[] { c })) return 1;
                        var sw = Stopwatch.StartNew();
                        while (!bitti && sw.Elapsed.TotalSeconds < 5) Thread.Sleep(50);
                    }
                    return 0;
                case "gecis":
                {
                    // A/B of the same transition on the card alone: the engine's values as now (linear light), then the
                    // same values sRGB-encoded (in case the card's chip applies its own curve and the dark end steps).
                    var ayar = Ayarlar.Yukle();
                    ayar.EfektlerKapali = true;
                    kart.YazmaArasiMs = 25;
                    Zamanlayici.Iste();
                    try
                    {
                        foreach (bool gama in new[] { false, true })
                        {
                            if (bitti) break;
                            Yaz($"-- {(gama ? "2: göze göre kodlanmış" : "1: şimdiki gibi (doğrusal)")}: 5 sn beyaz, sonra beyazdan maviye, sarıya ~30 sn");
                            var m = new RenkMotoru(ayar) { Acik = true };
                            var iz = kart.Iz; kart.Iz = null;
                            var sw = Stopwatch.StartNew();
                            double last = 0;
                            while (!bitti && sw.Elapsed.TotalSeconds < 40)
                            {
                                double t = sw.Elapsed.TotalSeconds, c = t < 5 ? 45 : 64;
                                m.Hesapla(new Girdi { CpuC = c, GpuC = c }, t, Math.Min(0.25, t - last));
                                last = t;
                                var l = m.Gpu[0];
                                Rgb r;
                                if (gama) { l.ToSrgb(out int rr, out int gg, out int bb); r = new Rgb((byte)rr, (byte)gg, (byte)bb); }
                                else { byte B8(double x) => (byte)Math.Round(Lin.Clamp(x) * 255); r = new Rgb(B8(l.R), B8(l.G), B8(l.B)); }
                                if (!kart.Yaz(new[] { r })) { kart.Iz = iz; return 1; }
                                Thread.Sleep(5);
                            }
                            kart.Iz = iz;
                            if (!gama) { Yaz("-- 3 sn karanlık"); kart.Sondur(); var s3 = Stopwatch.StartNew(); while (!bitti && s3.Elapsed.TotalSeconds < 3) Thread.Sleep(50); }
                        }
                    }
                    finally { Zamanlayici.Birak(); }
                    return 0;
                }
                case "tekrar":
                {
                    double sn = a.Count > 1 ? double.Parse(a[1], System.Globalization.CultureInfo.InvariantCulture) : 15;
                    var beyaz = new Rgb(255, 255, 255);
                    kart.YazmaArasiMs = 25;
                    Yaz("-- beyaz (tam sıra), 3 sn sabit");
                    if (!kart.Yaz(new[] { beyaz })) return 1;
                    var sw0 = Stopwatch.StartNew();
                    while (!bitti && sw0.Elapsed.TotalSeconds < 3) Thread.Sleep(50);
                    var iz = kart.Iz;
                    kart.Iz = null;
                    Yaz($"-- aynı beyaz, renk + sabit olarak yeniden, {sn:0} sn");
                    var sw = Stopwatch.StartNew();
                    int n = 0;
                    while (!bitti && sw.Elapsed.TotalSeconds < sn) { if (!kart.AyniRengiYinele(beyaz)) { kart.Iz = iz; return 1; } n++; }
                    kart.Iz = iz;
                    Yaz($"   {n} yineleme / {sw.Elapsed.TotalSeconds:F1} sn = {n / sw.Elapsed.TotalSeconds:F1}/sn");
                    return 0;
                }
                default:
                    Yaz("bilinmeyen komut: " + a[0] + " (yalnız söndürülecek)");
                    return 64;
            }
        }
        finally
        {
            Console.CancelKeyPress -= kes;
            Yaz("-- karanlık (bölgeler kapalı)");
            kart.Sondur();
            Yaz(kart.Hata == null ? "bitti: kart karanlık olmalı; kaydetme gönderilmedi" : "söndürme HATA: " + kart.Hata);
            if (kayit != null)
                Yaz($"BENZETİM: {kayit.Yazilanlar.Count} yazma; kayıtlar: " + string.Join(" ", kayit.Yazilanlar.Select(x => x.kayit.ToString("X2")).Distinct()));
            kart.Birak();
            try { dosya?.Dispose(); } catch { }
            dosya = null;
        }
    }

    /// <summary>What the card receives in the preview transition (gecis.py 45 -> 64): the light engine at 30 frames/s with
    /// Özcan's settings and effects off; the card takes the newest frame every 1/rate s. For 30/s (the fans and keyboard)
    /// and the card's ~10/s: how large each step is to the eye (OKLab distance; ~0.02 is about the smallest visible).</summary>
    static int GecisDokumu()
    {
        var ayar = Ayarlar.Yukle();
        ayar.EfektlerKapali = true;
        foreach (double hiz in new[] { 30.0, 9.6 })
        {
            var m = new RenkMotoru(ayar) { Acik = true };
            var adimlar = new List<(double t, Rgb c, double d)>();
            Rgb? onceki = null;
            double sonraki = 0;
            for (int i = 0; i <= 50 * 30; i++)
            {
                double t = i / 30.0;
                double c = t < 10 ? 45 : 64;
                m.Hesapla(new Girdi { CpuC = c, GpuC = c }, t, 1 / 30.0);
                if (t < sonraki) continue;
                sonraki += 1 / hiz;
                var l = m.Gpu[0];
                byte B8(double x) => (byte)Math.Round(Lin.Clamp(x) * 255);
                var r = new Rgb(B8(l.R), B8(l.G), B8(l.B));
                if (onceki is Rgb o && !o.Equals(r))
                {
                    var la = Lab.From(new Lin(o.R / 255.0, o.G / 255.0, o.B / 255.0));
                    var lb = Lab.From(new Lin(r.R / 255.0, r.G / 255.0, r.B / 255.0));
                    double d = Math.Sqrt((la.L - lb.L) * (la.L - lb.L) + (la.A - lb.A) * (la.A - lb.A) + (la.B - lb.B) * (la.B - lb.B));
                    if (t >= 10) adimlar.Add((t, r, d));
                }
                onceki = r;
            }
            var ds = adimlar.Select(x => x.d).OrderBy(x => x).ToList();
            Console.WriteLine($"== {hiz:0.#}/sn: geçişte {adimlar.Count} değişim; adım büyüklüğü (OKLab): ortanca {ds[ds.Count / 2]:0.000}, %90 {ds[(int)(ds.Count * 0.9)]:0.000}, en büyük {ds[ds.Count - 1]:0.000}; 0,02'yi aşan {ds.Count(x => x > 0.02)}");
            foreach (var x in adimlar.OrderByDescending(x => x.d).Take(6).OrderBy(x => x.t))
                Console.WriteLine($"   t={x.t - 10:00.0} sn  {x.c}  adım {x.d:0.000}");
            int sec = 0;
            Console.Write("   saniye başına toplam adım (göz): ");
            for (int k = 0; k < 40; k += 4) { double sum = adimlar.Where(x => x.t - 10 >= k && x.t - 10 < k + 4).Sum(x => x.d); Console.Write($"{k}-{k + 4}s:{sum / 4:0.00} "); sec++; }
            Console.WriteLine();
        }
        return 0;
    }

#if !GPU_ISIK
    /// <summary>Card-less build only: the service's writer (CihazYazici) driving the card driver against KayitYolu, through
    /// the situations the service meets. Prints the writes per step.</summary>
    static int ServisBenzetimi()
    {
        var kayit = new KayitYolu();
        var kart = new MsiGpuV2(kayit);
        var w = new Servis.CihazYazici(kart);
        int bas = 0;
        void Adim(string ad, Action yap, double sn)
        {
            yap();
            Thread.Sleep((int)(sn * 1000));
            List<(long ms, byte kayit, byte deger)> y;
            lock (kayit.Yazilanlar) y = kayit.Yazilanlar.Skip(bas).ToList();
            bas += y.Count;
            Console.WriteLine($"-- {ad}: {y.Count} yazma");
            Console.WriteLine("   " + string.Join(" ", y.Select(x => $"{x.kayit:X2}={x.deger:X2}")));
        }
        Rgb[] Renk(byte r, byte g, byte b) => new[] { new Rgb(r, g, b) };
        Adim("açılış, ışıklar kapalı (kart kendi beyazında)", () => w.KaranligaZorla(), 0.5);
        Adim("ışıklar açıldı: beyaz kareler 1 sn", () => { for (int i = 0; i < 30; i++) { w.Kare(Renk(255, 255, 255)); Thread.Sleep(33); } }, 0.3);
        Adim("sıcaklık geçişi: beyazdan maviye 1 sn", () => { for (int i = 0; i < 30; i++) { byte v = (byte)(255 - i * 8); w.Kare(Renk(v, v, 255)); Thread.Sleep(33); } }, 0.3);
        Adim("ışıklar kapandı", () => w.Sondur(), 0.5);
        Adim("uyku", () => w.Uyu(TimeSpan.FromSeconds(1)), 0.2);
        Adim("uyanış, ışıklar kapalı", () => { w.Uyan(); w.KaranligaZorla(); }, 0.5);
        Adim("ışıklar açık, çıkış", () => { for (int i = 0; i < 10; i++) { w.Kare(Renk(255, 0, 0)); Thread.Sleep(33); } w.Dispose(); }, 0.3);
        bool kotu = kayit.Yazilanlar.Any(x => !MsiGpuV2.Izinli(x.kayit, x.deger));
        Console.WriteLine(kotu ? "HATA: izinli olmayan yazma" : "tüm yazmalar izin listesinde");
        return kotu ? 1 : 0;
    }
#endif
}
