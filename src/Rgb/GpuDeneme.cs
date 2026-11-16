// Short runs on the graphics card's lights, each one only with Özcan's go for that run (docs/GPU_ISIK_PLANI.md).
//
//   rgb-dene gpu sondur --karta-yaz            zones off (one write, 2D=03)
//   rgb-dene gpu baslangic [s] --karta-yaz     the service's start: from the card's own white to dark over s (2) seconds
//   rgb-dene gpu sira --karta-yaz              white 5 s, blue 5 s, then dark
//   rgb-dene gpu hiz --karta-yaz               speed check: R/G/B-only updates after one full sequence, then dark
//   rgb-dene gpu efekt <1|2|3> [s] --karta-yaz the local-model candidate on the temperature colour for s (20) seconds
//   option   --yalniz-renk                     colour changes as R/G/B only (efekt, baslangic)
//
// Every write goes to the console and to %LOCALAPPDATA%\KontrolMerkezi\gpu-deneme.txt with its time. Every run ends
// dark. Do not run these while the installed service drives the card (both would write). In a build without
// GPU_ISIK (-p:GpuIsik=kapali) there is no path to the card at all: the same commands run against KayitYolu and
// print the writes they would make (BENZETİM). In a GPU_ISIK build nothing runs without --karta-yaz.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
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
        bool yalnizRenk = a.Remove("--yalniz-renk");
        if (a.Count == 0) { Yaz("kullanım: rgb-dene gpu <sondur|baslangic [s]|sira|hiz|efekt N [s]> --karta-yaz"); return 64; }
#if !GPU_ISIK
        if (a[0] == "servis") return ServisBenzetimi();
#endif

        IGpuYolu yol;
        KayitYolu kayit = null;
#pragma warning disable CS0162
        if (MsiGpuV2.KartaYazabilir)
        {
            if (!kartaYaz) { Yaz("Karta yazmak için --karta-yaz gerekli (Özcan'ın o koşu için onayıyla). Hiçbir şey gönderilmedi."); return 64; }
            yol = null;   // the real card
        }
        else
        {
            yol = kayit = new KayitYolu();
            Yaz("BENZETİM: bu derleme karta yazamaz (GPU_ISIK yok); yazmalar yalnız listelenir.");
        }
#pragma warning restore CS0162

        try
        {
            dosya = new StreamWriter(Path.Combine(Program.DataDir, "gpu-deneme.txt"), true, new System.Text.UTF8Encoding(false));
            Yaz($"== {DateTime.Now:yyyy-MM-dd HH:mm:ss} rgb-dene gpu {string.Join(" ", a)}{(yalnizRenk ? " --yalniz-renk" : "")}{(kayit != null ? " (BENZETİM)" : "")}");
        }
        catch { }

        var kart = yol == null ? new MsiGpuV2() : new MsiGpuV2(yol);
        kart.Iz = Yaz;
        kart.YalnizRenk = yalnizRenk;
        bool bitti = false;
        ConsoleCancelEventHandler kes = (_, e) => { e.Cancel = true; bitti = true; };
        Console.CancelKeyPress += kes;
        int sonuc = 0;
        try
        {
            if (!kart.Ac()) { Yaz("açılamadı: " + kart.Hata + " (hiçbir şey gönderilmedi)"); return 2; }
            Yaz("kart bulundu: " + kart.Ad);
            switch (a[0])
            {
                case "sondur":
                    break;   // the finally below is the run
                case "baslangic":
                {
                    double sn = a.Count > 1 ? double.Parse(a[1], CultureInfo.InvariantCulture) : 2;
                    Yaz($"-- kartın kendi beyazından karanlığa, {sn:0.#} sn");
                    var beyaz = new Rgb(255, 255, 255);
                    var sw = Stopwatch.StartNew();
                    while (!bitti && sw.Elapsed.TotalSeconds < sn)
                    {
                        if (!kart.Yaz(new[] { Rgb.Gecis(beyaz, Rgb.Black, sw.Elapsed.TotalSeconds / sn) })) { sonuc = 1; break; }
                        Thread.Sleep(10);
                    }
                    break;
                }
                case "sira":
                    foreach (var (ad, c) in new[] { ("beyaz", new Rgb(255, 255, 255)), ("mavi", new Rgb(0, 0, 255)) })
                    {
                        if (bitti) break;
                        Yaz($"-- {ad}, 5 sn");
                        if (!kart.Yaz(new[] { c })) { sonuc = 1; break; }
                        Bekle(5, ref bitti);
                    }
                    break;
                case "hiz":
                    sonuc = Hiz(kart, ref bitti);
                    break;
                case "efekt":
                {
                    int v = a.Count > 1 ? int.Parse(a[1], CultureInfo.InvariantCulture) : 1;
                    double sn = a.Count > 2 ? double.Parse(a[2], CultureInfo.InvariantCulture) : 20;
                    sonuc = Efekt(kart, v, sn, ref bitti);
                    break;
                }
                default:
                    Yaz("bilinmeyen komut: " + a[0] + " (yalnız söndürülecek)");
                    sonuc = 64;
                    break;
            }
            return sonuc;
        }
        finally
        {
            Console.CancelKeyPress -= kes;
            Yaz("-- karanlık (bölgeler kapalı)");
            kart.Sondur();
            Yaz(kart.Hata == null ? "bitti: kart karanlık olmalı; kaydetme gönderilmedi" : "söndürme HATA: " + kart.Hata);
            if (kayit != null)
            {
                var y = kayit.Yazilanlar;
                Yaz($"BENZETİM: {y.Count} yazma, {(y.Count > 0 ? y[y.Count - 1].ms : 0)} ms; kayıtlar: " +
                    string.Join(" ", y.Select(x => x.kayit.ToString("X2")).Distinct()));
            }
            kart.Birak();
            try { dosya?.Dispose(); } catch { }
            dosya = null;
        }
    }

#if !GPU_ISIK
    /// <summary>Card-less build only: the service's writer (CihazYazici) driving the card driver against KayitYolu, through
    /// the four situations the service meets. Prints the writes per step.</summary>
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
        var kirmizi = new[] { new Rgb(255, 0, 0) };
        Adim("açılış, ışıklar kapalı: beyazdan karanlığa 2 sn", () => w.BeyazdanBasla(2), 3.5);
        Adim("ışıklar açıldı: kırmızı kareler 1 sn", () => { for (int i = 0; i < 30; i++) { w.Kare(kirmizi); Thread.Sleep(33); } }, 0.5);
        Adim("ışıklar kapandı", () => w.Sondur(), 1.5);
        Adim("uyanış, ışıklar açık: beyazdan kırmızıya 2 sn", () =>
        {
            w.BeyazdanBasla(2);
            for (int i = 0; i < 90; i++) { w.Kare(kirmizi); Thread.Sleep(33); }
        }, 0.5);
        Adim("çıkış", () => w.Dispose(), 0.5);
        bool kaydetme = kayit.Yazilanlar.Any(x => !MsiGpuV2.Izinli(x.kayit, x.deger));
        Console.WriteLine(kaydetme ? "HATA: izinli olmayan yazma" : "tüm yazmalar izin listesinde");
        return kaydetme ? 1 : 0;
    }
#endif

    static void Bekle(double sn, ref bool bitti)
    {
        var sw = Stopwatch.StartNew();
        while (!bitti && sw.Elapsed.TotalSeconds < sn) Thread.Sleep(50);
    }

    /// <summary>Run 2: after one full red, the colour changes as R/G/B only. He reports whether the card followed:
    /// green, blue, white, then a 4 s fade white -> dim -> white as fast as the bus allows.</summary>
    static int Hiz(MsiGpuV2 kart, ref bool bitti)
    {
        Yaz("-- kırmızı (tam sıra), 3 sn");
        if (!kart.Yaz(new[] { new Rgb(255, 0, 0) })) return 1;
        Bekle(3, ref bitti);
        kart.YalnizRenk = true;
        foreach (var (ad, c) in new[] { ("yeşil", new Rgb(0, 255, 0)), ("mavi", new Rgb(0, 0, 255)), ("beyaz", new Rgb(255, 255, 255)) })
        {
            if (bitti) return 0;
            Yaz($"-- {ad} (yalnız R/G/B), 3 sn");
            if (!kart.Yaz(new[] { c })) return 1;
            Bekle(3, ref bitti);
        }
        foreach (int ara in new[] { 30, 10 })
        {
            if (bitti) return 0;
            kart.YazmaArasiMs = ara;
            Yaz($"-- beyaz sönükleşip geri gelir, 4 sn, yalnız R/G/B, yazma arası {ara} ms");
            var sw = Stopwatch.StartNew();
            int n = 0;
            while (!bitti && sw.Elapsed.TotalSeconds < 4)
            {
                double s = 0.5 - 0.5 * Math.Cos(2 * Math.PI * sw.Elapsed.TotalSeconds / 4);
                byte v = (byte)Math.Round(255 * Math.Pow(1 - 0.9 * s, 2.2));
                if (!kart.Yaz(new[] { new Rgb(v, v, v) })) return 1;
                n++;
            }
            Yaz($"   {n} güncelleme / {sw.Elapsed.TotalSeconds:F1} sn = {n / sw.Elapsed.TotalSeconds:F1} güncelleme/sn");
        }
        kart.YazmaArasiMs = 30;
        return 0;
    }

    /// <summary>Run 3: the engine itself, at the current settings, with "local model generating" forced on and a fixed
    /// desk temperature (white), so the candidate looks as it will in the service.</summary>
    static int Efekt(MsiGpuV2 kart, int v, double sn, ref bool bitti)
    {
        var ayar = Ayarlar.Yukle();
        var m = new RenkMotoru(ayar) { Acik = true };
        var g = new Girdi { CpuC = 45, GpuC = 45, YapayZeka = true, GpuYzEfekt = v };
        string[] ad = { "yok", "nefes", "yanıp söner", "akış" };
        Yaz($"-- aday {v} ({(v >= 0 && v < ad.Length ? ad[v] : "?")}), {sn:0} sn, sıcaklık rengi (beyaz) üzerinde");
        var gain = ayar.Kazanc.TryGetValue("gpu", out var k) ? k : new[] { 1.0, 1.0, 1.0 };
        var iz = kart.Iz;
        kart.Iz = null;   // the effect makes hundreds of writes; count them instead
        var sw = Stopwatch.StartNew();
        double last = 0;
        int n = 0;
        while (!bitti && sw.Elapsed.TotalSeconds < sn)
        {
            double t = sw.Elapsed.TotalSeconds;
            m.Hesapla(g, t, Math.Min(0.25, t - last));
            last = t;
            var c = m.Gpu[0];
            byte B8(double x) => (byte)Math.Round(Lin.Clamp(x) * 255);
            if (!kart.Yaz(new[] { new Rgb(B8(c.R * gain[0]), B8(c.G * gain[1]), B8(c.B * gain[2])) })) { kart.Iz = iz; return 1; }
            n++;
            Thread.Sleep(15);
        }
        kart.Iz = iz;
        Yaz($"   {n} kare / {sw.Elapsed.TotalSeconds:F1} sn");
        return 0;
    }
}
