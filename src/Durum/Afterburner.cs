// Is MSI Afterburner's fan control on? If it is, it fights the GPU fan button.
// "On" = Afterburner is running and either its user-defined software fan curve is enabled (SwAutoFanControl=1 in
// MSIAfterburner.cfg) or the card's coolers are in manual mode without this app having put them there (the service
// passes that in). Afterburner's "Auto" (firmware control, SwAutoFanControl=0) does not write to the fans.

using System;
using System.Diagnostics;
using System.IO;

namespace KontrolMerkezi.Durum;

sealed class Afterburner
{
    const string Cfg = @"C:\Program Files (x86)\MSI Afterburner\Profiles\MSIAfterburner.cfg";

    public bool Calisiyor { get; private set; }
    public bool YazilimEgrisi { get; private set; }

    public void Yenile()
    {
        bool running = false;
        try
        {
            foreach (var p in Process.GetProcessesByName("MSIAfterburner")) { running = true; p.Dispose(); }
        }
        catch { }
        Calisiyor = running;

        bool curve = false;
        try
        {
            if (File.Exists(Cfg))
                foreach (var line in File.ReadAllLines(Cfg))
                    if (line.StartsWith("SwAutoFanControl=", StringComparison.Ordinal)) { curve = line.Trim() == "SwAutoFanControl=1"; break; }
        }
        catch { }
        YazilimEgrisi = curve;
    }

    public bool FanKontrolu(bool manualNotOurs) => Calisiyor && (YazilimEgrisi || manualNotOurs);
}
