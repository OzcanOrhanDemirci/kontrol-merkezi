// CPU temperature (LibreHardwareMonitor via PawnIO; needs the elevated service) and CPU load (GetSystemTimes).

using System;
using System.Linq;
using System.Runtime.InteropServices;
using LibreHardwareMonitor.Hardware;

namespace KontrolMerkezi.Donanim;

sealed class Islemci
{
    readonly IHardware _cpu;
    readonly ISensor _temp;
    long _idle0, _kernel0, _user0;

    public string Kaynak { get; }

    public Islemci(Computer computer)
    {
        _cpu = computer?.Hardware.FirstOrDefault(h => h.HardwareType == HardwareType.Cpu);
        if (_cpu != null)
        {
            _cpu.Update();
            // Zen 4: Tctl equals Tdie (no offset on the 7000 series). Prefer it, then any "Core" or "Package" sensor.
            var temps = _cpu.Sensors.Where(s => s.SensorType == SensorType.Temperature).ToList();
            _temp = temps.FirstOrDefault(s => s.Name.IndexOf("Tctl", StringComparison.OrdinalIgnoreCase) >= 0)
                    ?? temps.FirstOrDefault(s => s.Name.IndexOf("Package", StringComparison.OrdinalIgnoreCase) >= 0)
                    ?? temps.FirstOrDefault(s => s.Name.IndexOf("Core", StringComparison.OrdinalIgnoreCase) >= 0);
            Kaynak = _temp != null ? _cpu.Name + " / " + _temp.Name : null;
        }
        GetSystemTimes(out _idle0, out _kernel0, out _user0);
    }

    public bool SicaklikVar => _temp != null;

    public double? Sicaklik()
    {
        if (_temp == null) return null;
        try
        {
            _cpu.Update();
            var v = _temp.Value;
            return v.HasValue && v.Value > 1 && v.Value < 125 ? v.Value : null;
        }
        catch { return null; }
    }

    /// <summary>Whole-CPU load in % since the previous call.</summary>
    public double Yuk()
    {
        if (!GetSystemTimes(out long idle, out long kernel, out long user)) return 0;
        long di = idle - _idle0, dk = kernel - _kernel0, du = user - _user0;
        _idle0 = idle; _kernel0 = kernel; _user0 = user;
        long total = dk + du;   // kernel time includes idle time
        return total <= 0 ? 0 : Math.Max(0, Math.Min(100, 100.0 * (total - di) / total));
    }

    [DllImport("kernel32.dll")]
    static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
}
