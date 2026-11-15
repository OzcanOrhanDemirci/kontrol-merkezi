// Thin HID transport over HidSharp: find one top-level collection by VID/PID/interface/usage page,
// write fixed-length output reports, read input reports with a timeout.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using HidSharp;

namespace KontrolMerkezi.Rgb;

sealed class HidKanal : IDisposable
{
    readonly HidDevice cihaz;
    HidStream akis;

    public int CikisUzunlugu { get; }
    public int GirisUzunlugu { get; }
    public string Yol => cihaz.DevicePath;

    HidKanal(HidDevice d, HidStream s)
    {
        cihaz = d;
        akis = s;
        CikisUzunlugu = d.GetMaxOutputReportLength();
        GirisUzunlugu = d.GetMaxInputReportLength();
    }

    /// <summary>Usage page of the collection's first top-level item (0 if the descriptor cannot be parsed).</summary>
    public static uint KullanimSayfasi(HidDevice d)
    {
        try
        {
            var items = d.GetReportDescriptor().DeviceItems;
            foreach (var it in items)
                foreach (var u in it.Usages.GetAllValues())
                    return u >> 16;
        }
        catch
        {
            // descriptor unreadable: treated as no match
        }
        return 0;
    }

    public static int Arayuz(HidDevice d)
    {
        var p = d.DevicePath.ToLowerInvariant();
        int i = p.IndexOf("&mi_", StringComparison.Ordinal);
        if (i < 0 || i + 6 > p.Length) return -1;
        return int.TryParse(p.Substring(i + 4, 2), System.Globalization.NumberStyles.HexNumber, null, out var n) ? n : -1;
    }

    public static IEnumerable<HidDevice> Bul(int vid, int pid) =>
        DeviceList.Local.GetHidDevices(vid, pid);

    /// <summary>Opens the matching collection. usagePage 0 = any. minOutput: required output report length (incl. report id).</summary>
    public static HidKanal Ac(int vid, int pid, int arayuz, uint usagePage, int minOutput, out string hata)
    {
        hata = null;
        var adaylar = Bul(vid, pid)
            .Where(d => arayuz < 0 || Arayuz(d) == arayuz)
            .Where(d => usagePage == 0 || KullanimSayfasi(d) == usagePage)
            .Where(d => SafeLen(d) >= minOutput)
            .ToList();
        if (adaylar.Count == 0)
        {
            hata = "Cihaz bulunamadı";
            return null;
        }
        foreach (var d in adaylar)
        {
            if (d.TryOpen(out var s))
            {
                s.ReadTimeout = 150;
                s.WriteTimeout = 500;
                return new HidKanal(d, s);
            }
        }
        hata = "Cihaz açılamadı (başka bir program tutuyor olabilir)";
        return null;
    }

    static int SafeLen(HidDevice d)
    {
        try { return d.GetMaxOutputReportLength(); } catch { return 0; }
    }

    /// <summary>Writes one output report. The buffer is padded/required to the device's output report length.</summary>
    public void Yaz(byte[] rapor)
    {
        if (akis == null) throw new IOException("kanal kapalı");
        if (rapor.Length != CikisUzunlugu)
        {
            var b = new byte[CikisUzunlugu];
            Buffer.BlockCopy(rapor, 0, b, 0, Math.Min(rapor.Length, b.Length));
            rapor = b;
        }
        akis.Write(rapor, 0, rapor.Length);
    }

    /// <summary>Reads one input report (byte 0 = report id). Returns null on timeout.</summary>
    public byte[] Oku(int zamanAsimiMs)
    {
        if (akis == null) throw new IOException("kanal kapalı");
        var b = new byte[Math.Max(GirisUzunlugu, 1)];
        akis.ReadTimeout = Math.Max(1, zamanAsimiMs);
        try
        {
            int n = akis.Read(b, 0, b.Length);
            if (n <= 0) return null;
            if (n < b.Length) Array.Resize(ref b, n);
            return b;
        }
        catch (TimeoutException)
        {
            return null;
        }
    }

    /// <summary>Discards input reports already queued (replies to fire-and-forget packets).</summary>
    public void Bosalt()
    {
        if (GirisUzunlugu <= 0) return;
        for (int i = 0; i < 64; i++)
            if (Oku(1) == null) break;
    }

    public void Dispose()
    {
        try { akis?.Dispose(); } catch { }
        akis = null;
    }
}

/// <summary>1 ms system timer resolution while lights stream (Thread.Sleep(1) is otherwise ~15.6 ms).</summary>
static class Zamanlayici
{
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);

    static int sayac;
    static readonly object kilit = new();

    public static void Iste()
    {
        lock (kilit) { if (sayac++ == 0) timeBeginPeriod(1); }
    }

    public static void Birak()
    {
        lock (kilit) { if (sayac > 0 && --sayac == 0) timeEndPeriod(1); }
    }

    /// <summary>Waits until at least ms have passed since the stopwatch tick 'baslangic'.</summary>
    public static void Bekle(long baslangicTick, double ms)
    {
        while (true)
        {
            double gecen = (Stopwatch.GetTimestamp() - baslangicTick) * 1000.0 / Stopwatch.Frequency;
            double kalan = ms - gecen;
            if (kalan <= 0) return;
            if (kalan > 1.5) System.Threading.Thread.Sleep(1);
            else System.Threading.Thread.SpinWait(200);
        }
    }
}
