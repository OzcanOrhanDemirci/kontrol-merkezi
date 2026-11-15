// The fixed device set of this PC. The GPU's lighting is not constructed at all until the morning proof
// (docs/GPU_ISIK_PLANI.md); the window shows it as locked.

using System.Collections.Generic;
using KontrolMerkezi.Rgb;

namespace KontrolMerkezi.Servis;

static class RgbCihazlari
{
    public static List<IRgbCihaz> Olustur() => new()
    {
        new CoolerMasterA1(),
        new SteelSeriesApex3(),
    };
}
