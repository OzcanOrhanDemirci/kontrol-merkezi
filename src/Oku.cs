// `oku`: read-only dump of everything the service would see, to okuma.txt in the data folder. Writes nothing to
// any device. `oku palet` also writes palet.html: the temperature colours from 30 to 95 °C, for a look by eye.

using System;
using System.IO;
using System.Linq;
using System.Security.Principal;
using System.Text;
using KontrolMerkezi.Donanim;
using KontrolMerkezi.Isik;
using LibreHardwareMonitor.Hardware;

namespace KontrolMerkezi;

static class Oku
{
    public static int Calistir(string[] args = null)
    {
        var sb = new StringBuilder();
        void L(string s) => sb.AppendLine(s);
        bool admin = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        L("Kontrol Merkezi — okuma  " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", Program.Inv) + "  yönetici=" + admin);
        L("");

        try
        {
            var n = Nvml.Open();
            L("NVML: GPU " + n.Sicaklik() + " °C, yük %" + n.Yuk() + ", fan %" + n.FanYuzde());
            var use = n.SurecKullanimi();
            L("  GPU kullanan süreçler: " + (use.Count == 0 ? "yok" : string.Join(", ", use.Select(kv => kv.Key + "=" + kv.Value + "%"))));
        }
        catch (Exception ex) { L("NVML: " + ex.Message); }

        try
        {
            var g = GpuFan.Open();
            var d = g.Oku();
            L("NvAPI fan: aygıt 0x" + g.DeviceId.ToString("X8") + " alt 0x" + g.SubSystemId.ToString("X8") + " | " + d.Count + " soğutucu");
            for (int i = 0; i < d.Count; i++)
                L("  soğutucu " + i + ": devir " + d.Rpm[i] + ", seviye %" + d.Level[i] + ", denetim " + (d.Manual[i] ? "ELLE" : "otomatik") + " (ayar %" + d.SetLevel[i] + ")");
        }
        catch (Exception ex) { L("NvAPI fan: " + ex.Message); }

        var ab = new Durum.Afterburner();
        ab.Yenile();
        L("Afterburner: çalışıyor=" + ab.Calisiyor + ", yazılım fan eğrisi=" + ab.YazilimEgrisi);

        if (admin)
        {
            try
            {
                var c = new Computer { IsMotherboardEnabled = true, IsCpuEnabled = true };
                c.Open();
                var cpu = new Islemci(c);
                L("İşlemci: " + (cpu.Kaynak ?? "sıcaklık sensörü yok") + " = " + cpu.Sicaklik());
                using var fan = FanCipi.Open(c);
                L("Fan çipi: " + fan.Board + " / " + fan.Chip + " | " + fan.Snapshot());
                c.Close();
            }
            catch (Exception ex) { L("LHM: " + ex.Message); }
        }
        else L("İşlemci sıcaklığı ve fan çipi: yönetici gerekli, okunmadı.");

        var path = Path.Combine(Program.DataDir, "okuma.txt");
        File.WriteAllText(path, sb.ToString(), new UTF8Encoding(true));
        Console.Write(sb.ToString());

        if (args != null && args.Contains("palet")) Palet();
        return 0;
    }

    static void Palet()
    {
        var a = Ayarlar.Yukle();
        var m = new RenkMotoru(a);
        var sb = new StringBuilder("<!doctype html><meta charset=utf-8><body style='background:#111;color:#ccc;font:13px sans-serif;margin:20px'>");
        sb.Append("<div style='display:flex;height:120px'>");
        for (double c = 30; c <= 95; c += 0.5)
        {
            m.Palet(c).ToSrgb(out int r, out int g, out int b);
            sb.Append($"<div title='{c}' style='flex:1;background:rgb({r},{g},{b})'></div>");
        }
        sb.Append("</div><div style='display:flex;justify-content:space-between'>");
        for (int c = 30; c <= 95; c += 5) sb.Append($"<span>{c}</span>");
        sb.Append("</div><p>");
        foreach (var d in a.Duraklar) sb.Append($"<span style='display:inline-block;width:120px'><b style='display:inline-block;width:14px;height:14px;background:rgb({d.Renk[0]},{d.Renk[1]},{d.Renk[2]})'></b> {d.C} °C {d.Ad}</span>");
        sb.Append("</p></body>");
        File.WriteAllText(Path.Combine(Program.DataDir, "palet.html"), sb.ToString(), new UTF8Encoding(false));
    }
}
