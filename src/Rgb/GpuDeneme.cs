// Short runs on the graphics card's lights (docs/GPU_ISIK_PLANI.md).
//
//   rgb-dene gpu sondur --karta-yaz    zones off (one write, 2D=03)
//   rgb-dene gpu sira --karta-yaz      white 5 s (MSI's full sequence), blue 5 s (colour + steady), then dark
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
