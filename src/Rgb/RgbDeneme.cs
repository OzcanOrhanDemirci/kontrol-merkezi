// Short light tests, one device at a time. Every command that lights something ends with Sondur (dark, nothing stored).
//
//   rgb-dene liste                          HID collections of both devices (read-only)
//   rgb-dene aio oku                        firmware, topology, current hardware effect per target (read-only)
//   rgb-dene <aio|klavye> renk RRGGBB [s]   solid colour for s seconds (default 3), then off
//   rgb-dene <aio|klavye> dalga [s]         LED-order pattern at 30 Hz for s seconds (default 10) with timing, then off
//   rgb-dene <aio|klavye> sondur            off (AIO: leave realtime so the controller shows its own "Off" effect)
//   option  --aralik <ms>                   AIO: spacing between realtime reports (default 2.5)
//   option  --hz <n>                        frame rate for renk/dalga (default 30)
//   option  --acik-birak                    renk/dalga: exit WITHOUT turning off (simulates a crash; follow with sondur)
//
//   rgb-dene gpu ...                        the graphics card's lights: GpuDeneme.cs (only with --karta-yaz, in a GPU_ISIK build)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Threading;
using HidSharp;

namespace KontrolMerkezi.Rgb;

static class RgbDeneme
{
    static bool acikBirak;

    static void Yaz(string s)
    {
        Console.WriteLine(s);
        Program.Log("rgb-dene: " + s);
    }

    public static int Calistir(string[] args)
    {
        try { var o = new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true }; Console.SetOut(o); } catch { }
        var a = args.ToList();
        double aralik = Secenek(a, "--aralik", 2.5);
        double hz = Secenek(a, "--hz", 30);
        acikBirak = a.Remove("--acik-birak");

        if (a.Count == 0) { Yaz("kullanım: rgb-dene liste | <aio|klavye> <oku|renk RRGGBB [s]|dalga [s]|sondur>"); return 64; }
        if (a[0] == "liste") return Liste();
        if (a[0] == "gpu") return GpuDeneme.Calistir(a.Skip(1).ToList());
        if (a.Count < 2) { Yaz("komut eksik"); return 64; }

        IRgbCihaz cihaz = a[0] switch
        {
            "aio" => new CoolerMasterA1 { PaketAraligiMs = aralik },
            "klavye" => new SteelSeriesApex3(),
            _ => null,
        };
        if (cihaz == null) { Yaz("bilinmeyen cihaz: " + a[0] + " (aio | klavye)"); return 64; }

        using (cihaz)
        {
            var sw = Stopwatch.StartNew();
            if (!cihaz.Ac()) { Yaz("açılamadı: " + cihaz.Hata); return 2; }
            Yaz($"{cihaz.Ad} açıldı ({sw.Elapsed.TotalMilliseconds:F0} ms), {cihaz.LedSayisi} LED");
            if (cihaz is CoolerMasterA1 cm)
                Yaz($"  sürüm {cm.Surum ?? "?"}, hedefler: {string.Join(" ", cm.Hedefler)}");

            string komut = a[1];
            switch (komut)
            {
                case "oku":
                    return Oku(cihaz);
                case "sondur":
                    cihaz.Sondur();
                    Yaz(cihaz.Hata == null ? "söndürüldü" : "HATA: " + cihaz.Hata);
                    if (cihaz is CoolerMasterA1 c1) EfektYaz(c1);
                    return cihaz.Hata == null ? 0 : 1;
                case "renk":
                {
                    if (a.Count < 3 || !RenkAyikla(a[2], out var renk)) { Yaz("renk RRGGBB gerekli"); return 64; }
                    double sn = a.Count > 3 ? double.Parse(a[3], CultureInfo.InvariantCulture) : 3;
                    var dolu = Enumerable.Repeat(renk, cihaz.LedSayisi).ToArray();
                    return Akit(cihaz, sn, hz, (t, i) => dolu);
                }
                case "dalga":
                {
                    double sn = a.Count > 2 ? double.Parse(a[2], CultureInfo.InvariantCulture) : 10;
                    var bolumler = cihaz is CoolerMasterA1 c2 ? c2.Hedefler.Select(h => h.Led).ToArray() : new[] { cihaz.LedSayisi };
                    return Akit(cihaz, sn, hz, (t, i) => Dalga(bolumler, t, i));
                }
                default:
                    Yaz("bilinmeyen komut: " + komut);
                    return 64;
            }
        }
    }

    static int Liste()
    {
        foreach (var (vid, pid) in new[] { (0x2516, 0x0173), (0x1038, 0x161A) })
            foreach (var d in HidKanal.Bul(vid, pid))
                Yaz($"{vid:X4}:{pid:X4} mi={HidKanal.Arayuz(d)} up={HidKanal.KullanimSayfasi(d):X4} " +
                    $"out={d.GetMaxOutputReportLength()} in={d.GetMaxInputReportLength()} feat={d.GetMaxFeatureReportLength()} {d.DevicePath}");
        return 0;
    }

    static int Oku(IRgbCihaz cihaz)
    {
        if (cihaz is CoolerMasterA1 cm) { EfektYaz(cm); return 0; }
        Yaz("klavye: bu protokolde geri okunacak durum yok; açılış ve rapor uzunlukları doğrulandı");
        return 0;
    }

    static readonly string[] ModAdi = { "Spectrum", "Static", "Reload", "Recoil", "Breathing", "Refill", "Demo", "FillFlow", "Rainbow", "Off" };

    static void EfektYaz(CoolerMasterA1 cm)
    {
        foreach (var h in cm.Hedefler)
        {
            var e = cm.EfektOku(h.Port, h.Alt);
            if (e == null) { Yaz($"  {h}: efekt okunamadı"); continue; }
            string ad = e[0] < ModAdi.Length ? ModAdi[e[0]] : e[0] == 0xC0 ? "Custom" : "?";
            Yaz($"  {h}: efekt 0x{e[0]:X2} ({ad}) hız {e[1]} parlaklık {e[2]} renk {e[3]:X2}{e[4]:X2}{e[5]:X2} rastgele {e[6]} smode {e[7]}");
        }
    }

    /// <summary>Streams frames at hz for sn seconds, measures every write, then turns the device off.</summary>
    static int Akit(IRgbCihaz cihaz, double sn, double hz, Func<double, int, Rgb[]> kare)
    {
        Zamanlayici.Iste();
        var sureler = new List<double>();
        int hata = 0, gec = 0;
        double periyot = 1000.0 / hz;
        var sw = Stopwatch.StartNew();
        double ilkKare = -1;
        try
        {
            int i = 0;
            while (sw.Elapsed.TotalSeconds < sn)
            {
                double hedef = i * periyot;
                double t = sw.Elapsed.TotalMilliseconds;
                long t0 = Stopwatch.GetTimestamp();
                bool ok = cihaz.Yaz(kare(t / 1000.0, i));
                double ms = (Stopwatch.GetTimestamp() - t0) * 1000.0 / Stopwatch.Frequency;
                if (i == 0) ilkKare = ms; else sureler.Add(ms);
                if (!ok) { hata++; Yaz("yazma hatası: " + cihaz.Hata); break; }
                i++;
                double bekle = i * periyot - sw.Elapsed.TotalMilliseconds;
                if (bekle < 0) { gec++; i = (int)Math.Ceiling(sw.Elapsed.TotalMilliseconds / periyot); }
                else if (bekle > 1) Thread.Sleep((int)bekle);
            }
            double toplam = sw.Elapsed.TotalSeconds;
            Yaz($"ilk kare (kip girişi dahil): {ilkKare:F1} ms");
            if (sureler.Count > 0)
            {
                var s = sureler.OrderBy(x => x).ToList();
                Yaz($"{sureler.Count + 1} kare / {toplam:F1} s = {(sureler.Count + 1) / toplam:F1} kare/s (hedef {hz})");
                Yaz($"kare yazma süresi ms: en az {s[0]:F2}, ortalama {s.Average():F2}, p50 {s[s.Count / 2]:F2}, p99 {s[(int)(s.Count * 0.99)]:F2}, en çok {s[s.Count - 1]:F2}");
                Yaz($"periyodu kaçıran kare: {gec}, {periyot:F1} ms'yi aşan yazma: {sureler.Count(x => x > periyot)}");
            }
        }
        finally
        {
            if (acikBirak)
            {
                // Crash simulation for the morning check: release the handle with the lights on, store nothing.
                cihaz.Birak();
                Zamanlayici.Birak();
                Yaz("ışık AÇIK bırakıldı (çökme benzetimi); kapatmak için: rgb-dene " + cihaz.Kimlik + " sondur");
            }
            else
            {
                cihaz.Sondur();
                Zamanlayici.Birak();
                Yaz(cihaz.Hata == null ? "söndürüldü" : "söndürme HATA: " + cihaz.Hata);
                if (cihaz is CoolerMasterA1 cm) EfektYaz(cm);
            }
        }
        return hata == 0 && cihaz.Hata == null ? 0 : 1;
    }

    static readonly Rgb[] BolumRengi = { new(255, 0, 0), new(0, 255, 0), new(0, 0, 255), new(255, 160, 0), new(255, 0, 255) };

    /// <summary>LED-order pattern. Each segment (AIO sub-device; the keyboard is one segment) has its own base colour,
    /// gently breathing so every frame differs, and a white head with a fading tail runs from LED 0 upward
    /// (one LED per 100 ms) so the start and direction of each ring can be seen.</summary>
    static Rgb[] Dalga(int[] bolumler, double t, int i)
    {
        var k = new Rgb[bolumler.Sum()];
        double nefes = 0.10 + 0.08 * Math.Sin(t * 2 * Math.PI / 2.0);
        int bas = 0;
        for (int b = 0; b < bolumler.Length; b++)
        {
            int n = bolumler[b];
            var c = BolumRengi[b % BolumRengi.Length];
            int kafa = (int)(t * 10) % n;
            for (int j = 0; j < n; j++)
            {
                int geri = (kafa - j + n) % n;
                if (geri == 0) k[bas + j] = new Rgb(255, 255, 255);
                else if (geri <= 3)
                {
                    double f = 1.0 - geri / 4.0;
                    k[bas + j] = Karistir(c, nefes, f);
                }
                else k[bas + j] = Olcekle(c, nefes);
            }
            bas += n;
        }
        return k;
    }

    static Rgb Olcekle(Rgb c, double f) => new((byte)(c.R * f), (byte)(c.G * f), (byte)(c.B * f));

    static Rgb Karistir(Rgb c, double taban, double beyaz)
    {
        byte M(byte v) => (byte)Math.Min(255, v * taban + 255 * beyaz * 0.8);
        return new Rgb(M(c.R), M(c.G), M(c.B));
    }

    static bool RenkAyikla(string s, out Rgb r)
    {
        r = default;
        s = s.TrimStart('#');
        if (s.Length != 6 || !uint.TryParse(s, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var v)) return false;
        r = new Rgb((byte)(v >> 16), (byte)(v >> 8), (byte)v);
        return true;
    }

    static double Secenek(List<string> a, string ad, double varsayilan)
    {
        int i = a.IndexOf(ad);
        if (i < 0 || i + 1 >= a.Count) return varsayilan;
        double v = double.Parse(a[i + 1], CultureInfo.InvariantCulture);
        a.RemoveRange(i, 2);
        return v;
    }
}
