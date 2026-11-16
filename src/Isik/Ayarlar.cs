// Light settings: the temperature stops, the two override colours, per-device calibration gains and the AIO
// ring layout. There is no settings page; this file (%LOCALAPPDATA%\KontrolMerkezi\ayarlar.json) is where the
// morning calibration lands. Missing or broken file -> defaults (and a fresh file is written if none exists).

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

namespace KontrolMerkezi.Isik;

public sealed class Durak
{
    public double C;       // °C of the smoothed CPU/GPU average
    public int[] Renk;     // sRGB as designed on screen
    public string Ad;
    public bool Gizli;     // a blend point only (e.g. a device correction inside a transition): no label on the scale
}

/// <summary>A device's own stop colours: what to send it so it shows what the reference device (keyboard) shows.
/// Null entries fall back to the shared colour.</summary>
public sealed class CihazRenk
{
    public int[][] Duraklar;   // one per stop, same order as Ayarlar.Duraklar
}

public sealed class Ayarlar
{
    /// <summary>Per-device colour per stop (hue-dependent matching), e.g. "aio". The keyboard is the reference.</summary>
    public Dictionary<string, CihazRenk> CihazRenkleri = new();

    // Stops from cold to hot, set 11-16 from his own readings (isi-gecmisi.csv, 09:29-10:25, CPU and GPU average):
    // at the desk (GPU under 40 °C) median 46.6, 90 % under 51.9, peak 57.9; with the GPU working 10 % under 57.4.
    // Özcan: "Genelde beyaz olsun [...] hafif anlık ılımalarda da o beyazlığı korusun. Ilıyınca [...] koyu mavi olsun;
    // koyuya geçerken açık mavi ister istemez o geçişte var." So white holds flat up to 52 (desk work and short
    // warm-ups, which the 30 s drift also absorbs), dark blue is sustained warmth from 58, light blue is only the
    // middle of that blend. Red at (94 + 67) / 2 = 80.5, his CPU 94 / GPU 67 reading, and above.
    public List<Durak> Duraklar = new()
    {
        new Durak { C = 52, Renk = new[] { 255, 255, 255 }, Ad = "beyaz" },
        new Durak { C = 58, Renk = new[] { 20, 50, 255 }, Ad = "ılık koyu mavi" },
        new Durak { C = 64, Renk = new[] { 255, 210, 0 }, Ad = "sıcak sarı" },
        new Durak { C = 74, Renk = new[] { 255, 110, 0 }, Ad = "çok sıcak turuncu" },
        new Durak { C = 80.5, Renk = new[] { 255, 0, 0 }, Ad = "kırmızı" },
    };

    /// <summary>Average temperature (raw, not the 30 s drift) above which the lights blink as a warning; off 2 °C below.
    /// Özcan: "Ortalama sıcaklık 90 dereceyi geçerse ışıklar yanıp sönsün, uyarı gibi efekt olarak."</summary>
    public double UyariDerece = 90;

    /// <summary>Local model generating an answer: rose pink, the one hue family the temperature palette never visits.</summary>
    /// <summary>Which candidate pattern plays for the two load effects (local model 1-5, CPU 1-2; RenkMotoru.YzFactor/CpuFactor).
    /// Hue never changes for them: "rengi sadece sıcaklığa bağlayalım" (Özcan 11-16).</summary>
    // Local model: 1 "akış" on the case and keyboard. Özcan 11-16: first meant for the GPU's own LEDs, but the card
    // cannot show effects ("efekt değil, sıcaklıkla aynı senkronizede"), so "akış" on the keyboard and fans.
    public int YapayZekaEfekti = 1, IslemciEfekti = 1;

    /// <summary>All effects off (local model, CPU load, Jarvis): only the temperature colour; the 90 °C warning stays.</summary>
    public bool EfektlerKapali;

    /// <summary>The card lights its stored Steady white whenever it gets power (its on/off switch is never stored, and
    /// Özcan chose 11-16 never to save: "açılışta beyaz olması benim için sorun değil"). At service start and after
    /// sleep the service takes that white over: dark, or the temperature colour if RGB is on.</summary>
    public bool GpuAcilistaKarart = true;

    /// <summary>Pause after each write to the card's light controller, ms (MSI's pace 30 = ~8 colour changes/s).</summary>
    public int GpuYazmaArasiMs = 30;
    /// <summary>Pause after the card's steady-mode write instead of GpuYazmaArasiMs, ms; -1 = the same.</summary>
    public int GpuSabitSonrasiMs = -1;


    /// <summary>Lights fade out after this many minutes without real mouse/keyboard input (0 = never). Özcan 11-16:
    /// "15 dakika işlem yoksa, ama mouse klavye hareketi olarak [...] RGB'ler yumuşak şekilde kapanır".</summary>
    public int BeklemeDakika = 15;

    /// <summary>Per-device channel gains (R, G, B) for matching the three devices' whites; 1 = untouched.</summary>
    public Dictionary<string, double[]> Kazanc = new()
    {
        ["aio"] = new[] { 1.0, 1.0, 1.0 },
        ["klavye"] = new[] { 1.0, 1.0, 1.0 },
        ["gpu"] = new[] { 1.0, 1.0, 1.0 },
    };

    /// <summary>LED counts of the devices chained on AIO port 1, in chain order (24+24+12+24 measured).</summary>
    public int[] AioHalkalari = { 24, 24, 12, 24 };
    /// <summary>Which ring is the pump (index into AioHalkalari); the 12-LED one until the morning check says otherwise.</summary>
    public int PompaHalkasi = 2;

    public static string Yol => Path.Combine(Program.DataDir, "ayarlar.json");

    public static Ayarlar Yukle()
    {
        var a = new Ayarlar();
        try
        {
            if (!File.Exists(Yol)) { a.Kaydet(); return a; }
            var d = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(Yol, Encoding.UTF8)) as Dictionary<string, object>;
            if (d == null) return a;
            if (d.TryGetValue("duraklar", out var ds) && ds is IEnumerable dl)
            {
                var list = new List<Durak>();
                foreach (var o in dl)
                    if (o is Dictionary<string, object> x)
                        list.Add(new Durak { C = Convert.ToDouble(x["c"]), Renk = Ints(x["renk"], 3), Ad = x.TryGetValue("ad", out var ad) ? ad as string : "", Gizli = x.TryGetValue("gizli", out var gz) && gz is bool gb && gb });
                if (list.Count >= 2 && list.Zip(list.Skip(1), (p, q) => q.C > p.C).All(v => v)) a.Duraklar = list;
                else Program.Log("ayarlar: duraklar geçersiz (en az 2, artan sıcaklık), varsayılan kullanılıyor");
            }
            if (d.TryGetValue("uyariDerece", out var ud)) a.UyariDerece = Convert.ToDouble(ud);
            if (d.TryGetValue("beklemeDakika", out var bd)) a.BeklemeDakika = Math.Max(0, Convert.ToInt32(bd));
            if (d.TryGetValue("efektler", out var ef) && ef is Dictionary<string, object> efd)
            {
                if (efd.TryGetValue("yapayzeka", out var e1)) a.YapayZekaEfekti = Math.Max(0, Math.Min(5, Convert.ToInt32(e1)));
                if (efd.TryGetValue("islemci", out var e2)) a.IslemciEfekti = Convert.ToInt32(e2) == 2 ? 2 : 1;
                if (efd.TryGetValue("kapali", out var e4) && e4 is bool e4b) a.EfektlerKapali = e4b;
            }
            if (d.TryGetValue("kazanc", out var kz) && kz is Dictionary<string, object> kd)
                foreach (var kv in kd) a.Kazanc[kv.Key] = Doubles(kv.Value, 3);
            if (d.TryGetValue("cihazRenkleri", out var crs) && crs is Dictionary<string, object> crd)
                foreach (var kv in crd)
                {
                    if (kv.Value is not Dictionary<string, object> x) continue;
                    var cr = new CihazRenk();
                    if (x.TryGetValue("duraklar", out var dd) && dd is IEnumerable dl2)
                        cr.Duraklar = dl2.Cast<object>().Select(o => o == null ? null : Ints(o, 3)).ToArray();
                    a.CihazRenkleri[kv.Key] = cr;
                }
            if (d.TryGetValue("aioHalkalari", out var ah))
            {
                var rings = Ints(ah, -1);
                if (rings.Length > 0 && rings.All(n => n > 0 && n <= 60)) a.AioHalkalari = rings;
                else Program.Log("ayarlar: aioHalkalari geçersiz, varsayılan kullanılıyor");
            }
            if (d.TryGetValue("pompaHalkasi", out var ph)) a.PompaHalkasi = Convert.ToInt32(ph);
            if (d.TryGetValue("gpuAcilistaKarart", out var gk) && gk is bool gkb) a.GpuAcilistaKarart = gkb;
            if (d.TryGetValue("gpuYazmaArasiMs", out var gm)) a.GpuYazmaArasiMs = Math.Max(0, Math.Min(50, Convert.ToInt32(gm)));
            if (d.TryGetValue("gpuSabitSonrasiMs", out var gs)) a.GpuSabitSonrasiMs = Math.Max(-1, Math.Min(100, Convert.ToInt32(gs)));
            var all = a.Duraklar.Select(x => x.Renk)
                .Concat(a.CihazRenkleri.Values.SelectMany(c => c.Duraklar ?? new int[0][]))
                .Where(x => x != null);
            foreach (var arr in all)
                for (int i = 0; i < arr.Length; i++) arr[i] = Math.Max(0, Math.Min(255, arr[i]));
        }
        catch (Exception ex)
        {
            Program.Log("ayarlar okunamadı, varsayılan kullanılıyor: " + ex.Message);
        }
        return a;
    }

    public void Kaydet()
    {
        try
        {
            var d = new Dictionary<string, object>
            {
                ["aciklama"] = "Kontrol Merkezi ışık ayarları. duraklar: soğuktan sıcağa, c = CPU ve GPU ortalaması (°C), renk = sRGB. kazanc: cihaz başına R,G,B çarpanı. cihazRenkleri: cihaz başına her durağın karşılığı (null = ortak renk); klavye referanstır. efektler: kapali = true ise hiçbir efekt yok, yalnız sıcaklık rengi (90 °C uyarısı kalır); yerel model (0 = yok, 1-5) ve işlemci yükü (1-2) efektinin adayı. gpuAcilistaKarart: kart her güç alışında kendi kayıtlı beyazını yakar; servis açılışta ve uykudan sonra onu karartır (RGB açıksa sıcaklık rengine geçirir). gpuYazmaArasiMs: karta her yazmadan sonraki bekleme (ms; MSI'ınki 30, saniyede ~8 renk adımı); canlı uygulanır. beklemeDakika: klavye ve fare bu kadar dakika kullanılmazsa ışıklar yumuşakça söner (0 = hiç). Canlı uygulamak: python araclar/onizle.py yukle.",
                ["duraklar"] = Duraklar.Select(x => { var o = new Dictionary<string, object> { ["c"] = x.C, ["renk"] = x.Renk, ["ad"] = x.Ad }; if (x.Gizli) o["gizli"] = true; return o; }).ToList(),
                ["uyariDerece"] = UyariDerece,
                ["beklemeDakika"] = BeklemeDakika,
                ["efektler"] = new Dictionary<string, object> { ["kapali"] = EfektlerKapali, ["yapayzeka"] = YapayZekaEfekti, ["islemci"] = IslemciEfekti },
                ["gpuAcilistaKarart"] = GpuAcilistaKarart,
                ["gpuYazmaArasiMs"] = GpuYazmaArasiMs,
                ["gpuSabitSonrasiMs"] = GpuSabitSonrasiMs,
                ["kazanc"] = Kazanc,
                ["cihazRenkleri"] = CihazRenkleri.ToDictionary(kv => kv.Key, kv => (object)new Dictionary<string, object>
                {
                    ["duraklar"] = kv.Value.Duraklar,
                }),
                ["aioHalkalari"] = AioHalkalari,
                ["pompaHalkasi"] = PompaHalkasi,
            };
            File.WriteAllText(Yol, Json.Pretty(new JavaScriptSerializer().Serialize(d)), new UTF8Encoding(false));
        }
        catch (Exception ex)
        {
            Program.Log("ayarlar yazılamadı: " + ex.Message);
        }
    }

    static int[] Ints(object o, int n)
    {
        var r = ((IEnumerable)o).Cast<object>().Select(Convert.ToInt32).ToArray();
        if (n > 0 && r.Length != n) throw new FormatException("beklenen " + n + " değer");
        return r;
    }

    static double[] Doubles(object o, int n)
    {
        var r = ((IEnumerable)o).Cast<object>().Select(Convert.ToDouble).ToArray();
        if (r.Length != n) throw new FormatException("beklenen " + n + " değer");
        return r;
    }
}
