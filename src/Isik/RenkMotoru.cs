// The light engine: from the temperatures to one colour per LED, 30 times a second.
//
//   colour = temperature palette at the smoothed CPU/GPU average (OKLCh blend between stops, full brightness).
//   master = RGB on/off (~1 s) and the idle fade after 15 minutes without mouse or keyboard (~5 s).
// Nothing else: Özcan 11-16, after seeing every effect on the real lights: "Efektlerin hepsini kaldıralım, 90 dereceyi
// de. Sıcaklık + 15 dakika yeterli."

using System;

namespace KontrolMerkezi.Isik;

public sealed class Girdi
{
    public double? CpuC, GpuC;
    public double CpuYuk, GpuYuk;      // 0..100 (shown in the window)
}

public sealed class RenkMotoru
{
    // Temperature drift: two cascaded first-order stages (critically damped, no overshoot). A step change starts
    // gently, eases out, and is ~95 % there after 30 s (1-(1+t/tau)e^(-t/tau) at t = 4.74 tau); fluctuations
    // shorter than that are absorbed. Özcan 11-16: "bir anda sarı turuncu [...] yerine 30 saniye içinde yumuşak geçiş".
    const double TempTau = 6.3;
    const double MasterTau = 0.3;      // s: on/off fade ~1 s

    readonly Ayarlar _a;

    // One palette per device: the stop colours that make that device show what the reference (the keyboard) shows.
    // LED errors depend on hue, so per-channel gains cannot match devices across the palette.
    readonly Lab[] _ref, _aioPal, _gpuPal;
    readonly int _aioCount;

    double? _smooth1, _smooth;
    double _master;

    public readonly Lin[] Aio;
    public readonly Lin[] Klavye = new Lin[10];
    public readonly Lin[] Gpu = new Lin[1];

    public bool Acik { get; set; }
    /// <summary>No real input for the idle time: fade to dark (switch stays on); the first input brings the light back.</summary>
    public bool Beklemede { get; set; }
    public double? Yumusak => _smooth;
    public double? Ortalama { get; private set; }
    public Lin Taban { get; private set; } = new Lin(1, 1, 1);   // temperature colour (also shown when off)
    public Lin Cikis { get; private set; }                        // average of what goes to the devices

    public RenkMotoru(Ayarlar a)
    {
        _a = a;
        _ref = Build(a, null);
        _aioPal = Build(a, a.CihazRenkleri.TryGetValue("aio", out var cr) ? cr : null);
        _gpuPal = Build(a, a.CihazRenkleri.TryGetValue("gpu", out var cg) ? cg : null);
        foreach (var n in a.AioHalkalari) _aioCount += n;
        Aio = new Lin[_aioCount];
    }

    static Lab[] Build(Ayarlar a, CihazRenk own)
    {
        var stops = new Lab[a.Duraklar.Count];
        for (int i = 0; i < stops.Length; i++)
        {
            var c = own?.Duraklar != null && i < own.Duraklar.Length && own.Duraklar[i] != null ? own.Duraklar[i] : a.Duraklar[i].Renk;
            stops[i] = Lab.From(Lin.FromSrgb(c[0], c[1], c[2]).Full());
        }
        return stops;
    }

    /// <summary>Carry the running state over from the engine this one replaces (live settings reload: no fade, no jump).</summary>
    public void DevamEt(RenkMotoru o)
    {
        _smooth1 = o._smooth1; _smooth = o._smooth; _master = o._master;
    }

    /// <summary>Palette colour for an averaged temperature (full brightness, linear light), reference device.</summary>
    public Lin Palet(double c) => Palet(_ref, c);

    Lin Palet(Lab[] stops, double c)
    {
        var d = _a.Duraklar;
        if (c <= d[0].C) return stops[0].ToLin().Full();
        for (int i = 1; i < d.Count; i++)
        {
            if (c <= d[i].C)
            {
                double t = (c - d[i - 1].C) / (d[i].C - d[i - 1].C);
                t = t * t * (3 - 2 * t) * 0.35 + t * 0.65;   // a little ease so a stop's colour is held a touch longer
                return Lab.MixHue(stops[i - 1], stops[i], t).ToLin().Full();
            }
        }
        return stops[d.Count - 1].ToLin().Full();
    }

    static double Approach(double v, double target, double dt, double tau) => v + (target - v) * (1 - Math.Exp(-dt / tau));

    public void Hesapla(Girdi g, double t, double dt)
    {
        double? avg = g.CpuC.HasValue && g.GpuC.HasValue ? (g.CpuC + g.GpuC) / 2 : g.CpuC ?? g.GpuC;
        Ortalama = avg;
        if (avg.HasValue)
        {
            _smooth1 = _smooth1.HasValue ? Approach(_smooth1.Value, avg.Value, dt, TempTau) : avg;
            _smooth = _smooth.HasValue ? Approach(_smooth.Value, _smooth1.Value, dt, TempTau) : avg;
        }
        double tc = _smooth ?? _a.Duraklar[0].C;
        var baseCol = Palet(_ref, tc);      // keyboard, and what the window shows
        var aioBase = Palet(_aioPal, tc);
        var gpuBase = Palet(_gpuPal, tc);   // the card's own stop colours if calibrated, else the reference
        Taban = baseCol;

        bool lit = Acik && !Beklemede;
        // idle fade-out is slow (~5 s, "yumuşak şekilde kapanır"); on/off and coming back keep the ~1 s fade
        _master = Approach(_master, lit ? 1 : 0, dt, !lit && Acik ? 1.6 : MasterTau);
        double master = _master * _master * (3 - 2 * _master);

        var aio = (aioBase * master).Clamped();
        for (int i = 0; i < Aio.Length; i++) Aio[i] = aio;
        var kl = (baseCol * master).Clamped();
        for (int z = 0; z < Klavye.Length; z++) Klavye[z] = kl;
        for (int i = 0; i < Gpu.Length; i++) Gpu[i] = (gpuBase * master).Clamped();
        Cikis = aio;
    }
}
