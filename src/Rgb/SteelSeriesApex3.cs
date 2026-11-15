// SteelSeries Apex 3 (USB 1038:161A, interface 3, usage page 0xFFC0): 10 lighting zones.
//
// OpenRGB 1.1 drives PID 161A with SteelSeriesApexTZoneController (SteelSeriesControllerDetect.cpp DetectSteelSeriesApex3Full,
// REGISTER_HID_DETECTOR_I ... STEELSERIES_APEX_3_PID, interface 3). Protocol (reimplemented, see docs/RGB_SURUCULER.md),
// 33-byte output reports, byte 0 = report id 0:
//   brightness: [1]=0x0A [3]=0..0x64
//   colours:    [1]=0x0B [3+3i]=R [4+3i]=G [5+3i]=B for zone i = 0..9
//
// SAFETY: only 0x0A and 0x0B are ever written. The save sequence (0x06 .. [3]=0x08, then 0x09) that stores the current
// colours as the keyboard's power-on lighting is never sent; Rapor() refuses any other command byte.

using System;
using System.Diagnostics;

namespace KontrolMerkezi.Rgb;

public sealed class SteelSeriesApex3 : IRgbCihaz
{
    const int Vid = 0x1038, Pid = 0x161A, ArayuzNo = 3;
    const uint UsagePage = 0xFFC0;
    const int RaporBoyu = 33;
    const byte CmdParlaklik = 0x0A, CmdRenk = 0x0B;
    public const byte ParlaklikMax = 0x64;
    const int Bolge = 10;

    /// <summary>An unchanged frame is re-sent after this long (keep-alive in case the firmware times out direct colours).</summary>
    public int TekrarMs { get; set; } = 1000;

    readonly object kilit = new();
    HidKanal kanal;
    Rgb[] sonKare;
    long sonKareTick;

    public string Kimlik => "klavye";
    public string Ad => "SteelSeries Apex 3";
    public int LedSayisi => Bolge;
    public bool Bagli { get; private set; }
    public string Hata { get; private set; }
    public double SonYazmaMs { get; private set; }

    public bool Ac()
    {
        lock (kilit)
        {
            Kapat();
            Hata = null;
            kanal = HidKanal.Ac(Vid, Pid, ArayuzNo, UsagePage, RaporBoyu, out var h);
            if (kanal == null) { Hata = "Klavye: " + h; return false; }
            Bagli = true;
            return true;
        }
    }

    public bool Yaz(Rgb[] renkler)
    {
        lock (kilit)
        {
            if (kanal == null || renkler == null) return false;
            long simdi = Stopwatch.GetTimestamp();
            if (sonKare != null && Ayni(renkler, sonKare) && (simdi - sonKareTick) * 1000 / Stopwatch.Frequency < TekrarMs)
                return true;
            try
            {
                long t0 = Stopwatch.GetTimestamp();
                Gonder(renkler, ParlaklikMax);
                SonYazmaMs = (Stopwatch.GetTimestamp() - t0) * 1000.0 / Stopwatch.Frequency;
                sonKare = (Rgb[])renkler.Clone();
                sonKareTick = t0;
                Bagli = true;
                return true;
            }
            catch (Exception ex)
            {
                Hata = "Klavye yazılamadı: " + ex.Message;
                Kapat();
                return false;
            }
        }
    }

    /// <summary>All zones black (volatile). The keyboard keeps showing black until it loses power, then it comes up with
    /// whatever lighting it has stored itself, which this driver never changes.</summary>
    public void Sondur()
    {
        lock (kilit)
        {
            if (kanal == null) return;
            try
            {
                Gonder(new Rgb[Bolge], ParlaklikMax);
                sonKare = null;
            }
            catch (Exception ex)
            {
                Hata = "Klavye söndürülemedi: " + ex.Message;
                Kapat();
            }
        }
    }

    public void Birak()
    {
        lock (kilit) Kapat();
    }

    public void Dispose() => Birak();

    void Gonder(Rgb[] renkler, byte parlaklik)
    {
        // Same order as OpenRGB's SetColor: brightness report, then colour report.
        var r = new byte[RaporBoyu];
        r[1] = CmdParlaklik;
        r[3] = Math.Min(parlaklik, ParlaklikMax);
        Rapor(r);
        r = new byte[RaporBoyu];
        r[1] = CmdRenk;
        for (int i = 0; i < Bolge && i < renkler.Length; i++)
        {
            r[3 + i * 3] = renkler[i].R;
            r[4 + i * 3] = renkler[i].G;
            r[5 + i * 3] = renkler[i].B;
        }
        Rapor(r);
    }

    void Rapor(byte[] r)
    {
        if (r[1] != CmdParlaklik && r[1] != CmdRenk)
            throw new InvalidOperationException($"Klavye: 0x{r[1]:X2} komutu bu sürücüde yasak");
        kanal.Yaz(r);
    }

    static bool Ayni(Rgb[] a, Rgb[] b)
    {
        if (a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++) if (!a[i].Equals(b[i])) return false;
        return true;
    }

    void Kapat()
    {
        kanal?.Dispose();
        kanal = null;
        Bagli = false;
        sonKare = null;
    }
}
