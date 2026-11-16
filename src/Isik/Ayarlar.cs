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
}

/// <summary>A device's own colours: what to send it so it shows what the reference device (keyboard) shows.
/// Null entries fall back to the shared colour.</summary>
public sealed class CihazRenk
{
    public int[][] Duraklar;   // one per stop, same order as Ayarlar.Duraklar
    public int[] YapayZeka, Islemci;
}

public sealed class Ayarlar
{
    /// <summary>Per-device colour per stop (hue-dependent matching), e.g. "aio". The keyboard is the reference.</summary>
    public Dictionary<string, CihazRenk> CihazRenkleri = new();

    // Stops from cold to hot. Temperatures come from this machine's range: GPU idles at ~37 °C with its fans
    // stopped (measured 11-16 02:10), the 7900X idles in the 40s and runs to its 95 °C design limit under all-core
    // load; gaming puts both in the 60-80 band. Average: idle ~41-45, desk work ~45-50, games ~63-75, both maxed ~85.
    // The service writes isi-gecmisi.csv so the morning refinement uses his real days, not this estimate.
    public List<Durak> Duraklar = new()
    {
        new Durak { C = 38, Renk = new[] { 230, 240, 255 }, Ad = "soğuk beyaz" },
        new Durak { C = 46, Renk = new[] { 110, 190, 255 }, Ad = "serin açık mavi" },
        new Durak { C = 54, Renk = new[] { 20, 50, 255 }, Ad = "ılık koyu mavi" },
        new Durak { C = 64, Renk = new[] { 255, 210, 0 }, Ad = "sıcak sarı" },
        new Durak { C = 74, Renk = new[] { 255, 110, 0 }, Ad = "çok sıcak turuncu" },
        new Durak { C = 84, Renk = new[] { 255, 0, 0 }, Ad = "en sıcak kırmızı" },
    };

    /// <summary>Local model generating an answer: rose pink, the one hue family the temperature palette never visits.</summary>
    public int[] YapayZekaRengi = { 255, 36, 128 };
    /// <summary>CPU at full load while the GPU idles: cyan, with its own slow pulse so it never reads as a transition.</summary>
    public int[] IslemciRengi = { 0, 235, 255 };

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
                        list.Add(new Durak { C = Convert.ToDouble(x["c"]), Renk = Ints(x["renk"], 3), Ad = x.TryGetValue("ad", out var ad) ? ad as string : "" });
                if (list.Count >= 2 && list.Zip(list.Skip(1), (p, q) => q.C > p.C).All(v => v)) a.Duraklar = list;
                else Program.Log("ayarlar: duraklar geçersiz (en az 2, artan sıcaklık), varsayılan kullanılıyor");
            }
            if (d.TryGetValue("yapayZekaRengi", out var yz)) a.YapayZekaRengi = Ints(yz, 3);
            if (d.TryGetValue("islemciRengi", out var ir)) a.IslemciRengi = Ints(ir, 3);
            if (d.TryGetValue("kazanc", out var kz) && kz is Dictionary<string, object> kd)
                foreach (var kv in kd) a.Kazanc[kv.Key] = Doubles(kv.Value, 3);
            if (d.TryGetValue("cihazRenkleri", out var crs) && crs is Dictionary<string, object> crd)
                foreach (var kv in crd)
                {
                    if (kv.Value is not Dictionary<string, object> x) continue;
                    var cr = new CihazRenk();
                    if (x.TryGetValue("duraklar", out var dd) && dd is IEnumerable dl2)
                        cr.Duraklar = dl2.Cast<object>().Select(o => o == null ? null : Ints(o, 3)).ToArray();
                    if (x.TryGetValue("yapayZeka", out var yz2) && yz2 != null) cr.YapayZeka = Ints(yz2, 3);
                    if (x.TryGetValue("islemci", out var ic2) && ic2 != null) cr.Islemci = Ints(ic2, 3);
                    a.CihazRenkleri[kv.Key] = cr;
                }
            if (d.TryGetValue("aioHalkalari", out var ah))
            {
                var rings = Ints(ah, -1);
                if (rings.Length > 0 && rings.All(n => n > 0 && n <= 60)) a.AioHalkalari = rings;
                else Program.Log("ayarlar: aioHalkalari geçersiz, varsayılan kullanılıyor");
            }
            if (d.TryGetValue("pompaHalkasi", out var ph)) a.PompaHalkasi = Convert.ToInt32(ph);
            var all = new[] { a.YapayZekaRengi, a.IslemciRengi }.Concat(a.Duraklar.Select(x => x.Renk))
                .Concat(a.CihazRenkleri.Values.SelectMany(c => (c.Duraklar ?? new int[0][]).Concat(new[] { c.YapayZeka, c.Islemci })))
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
                ["aciklama"] = "Kontrol Merkezi ışık ayarları. duraklar: soğuktan sıcağa, c = CPU ve GPU ortalaması (°C), renk = sRGB. kazanc: cihaz başına R,G,B çarpanı. cihazRenkleri: cihaz başına her durağın ve iki özel durumun rengi (null = ortak renk); klavye referanstır. Canlı uygulamak: python araclar/onizle.py yukle.",
                ["duraklar"] = Duraklar.Select(x => new Dictionary<string, object> { ["c"] = x.C, ["renk"] = x.Renk, ["ad"] = x.Ad }).ToList(),
                ["yapayZekaRengi"] = YapayZekaRengi,
                ["islemciRengi"] = IslemciRengi,
                ["kazanc"] = Kazanc,
                ["cihazRenkleri"] = CihazRenkleri.ToDictionary(kv => kv.Key, kv => (object)new Dictionary<string, object>
                {
                    ["duraklar"] = kv.Value.Duraklar, ["yapayZeka"] = kv.Value.YapayZeka, ["islemci"] = kv.Value.Islemci,
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
