// The fixed device set of this PC. The GPU's lighting is in only in a build that can drive it (the normal build;
// -p:GpuIsik=kapali leaves it out, src/Rgb/MsiGpuV2.cs); such a build shows it as locked and cannot reach the card.

using System.Collections.Generic;
using KontrolMerkezi.Isik;
using KontrolMerkezi.Rgb;

namespace KontrolMerkezi.Servis;

static class RgbCihazlari
{
    public static List<IRgbCihaz> Olustur(Ayarlar a)
    {
        var list = new List<IRgbCihaz> { new CoolerMasterA1(), new SteelSeriesApex3() };
#pragma warning disable CS0162
        if (MsiGpuV2.KartaYazabilir) list.Add(new MsiGpuV2 { YazmaArasiMs = a.GpuYazmaArasiMs });
#pragma warning restore CS0162
        return list;
    }
}
