// The light engine: from temperatures, loads and states to one colour per LED, 30 times a second.
//
//   hue    = temperature palette at the smoothed CPU/GPU average (OKLCh blend between stops, full brightness), always.
//            Özcan 11-16: "rengi sadece sıcaklığa bağlayalım [...] işlemci ve yerel yapay zekayı efektlerle ifade edelim."
//   effects ride on that colour as brightness and motion only, never a different hue:
//            local model generating, CPU under sustained heavy load (two candidate patterns each, he picks by eye),
//            then the Jarvis effects (thinking orbit, waiting breath, restart point, closed ember, bloom)
//   master -> RGB on/off fade
//
// Everything is driven by elapsed seconds, never by frame count, so an uneven tick cannot change an effect's speed.

using System;

namespace KontrolMerkezi.Isik;

public enum JarvisDurum { Yok, Dusunuyor, Bekliyor, Hazir, Kapali, Yeniden }

public sealed class Girdi
{
    public double? CpuC, GpuC;
    public double CpuYuk, GpuYuk;      // 0..100
    public bool YapayZeka;             // local model generating right now
    public bool Islemci;               // CPU under sustained heavy load (decided with hysteresis by the caller)
    public JarvisDurum Jarvis;
    public int? YzEfekt, IslemciEfekt; // preview only: play this candidate instead of the chosen one
    public bool? Uyari;                // preview only: force the over-temperature warning
}

public sealed class RenkMotoru
{
    // Temperature drift: two cascaded first-order stages (critically damped, no overshoot). A step change starts
    // gently, eases out, and is ~95 % there after 30 s (1-(1+t/tau)e^(-t/tau) at t = 4.74 tau); fluctuations
    // shorter than that are absorbed. Özcan 11-16: "bir anda sarı turuncu [...] yerine 30 saniye içinde yumuşak geçiş".
    const double TempTau = 6.3;
    const double EffectTau = 1.0;      // s: the two load effects ease in and out over ~3 s
    const double MasterTau = 0.3;      // s: on/off fade ~1 s
    const double White = 1.0;

    readonly Ayarlar _a;

    // One palette per device: the stop colours that make that device show what the reference (the keyboard) shows.
    // LED errors depend on hue, so per-channel gains cannot match devices across the palette.
    readonly Lab[] _ref, _aioPal;
    readonly int[] _ringStart;
    readonly int _aioCount;

    double? _smooth1, _smooth;
    double _eAi, _eCpu, _eWarn, _master;
    bool _warn;
    double _eThink, _eWait, _eClosed, _eRestart;
    double _hazirAt = -100, _wakeAt = -100;
    JarvisDurum _lastJ = JarvisDurum.Yok;

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
    public bool YapayZekaEfekti => _eAi > 0.05;
    public bool IslemciEfekti => _eCpu > 0.05;
    public bool Uyari => _eWarn > 0.05;

    public RenkMotoru(Ayarlar a)
    {
        _a = a;
        _ref = Build(a, null);
        _aioPal = Build(a, a.CihazRenkleri.TryGetValue("aio", out var cr) ? cr : null);
        _ringStart = new int[a.AioHalkalari.Length + 1];
        for (int i = 0; i < a.AioHalkalari.Length; i++) _ringStart[i + 1] = _ringStart[i] + a.AioHalkalari[i];
        _aioCount = _ringStart[a.AioHalkalari.Length];
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
        _smooth1 = o._smooth1; _smooth = o._smooth; _eAi = o._eAi; _eCpu = o._eCpu; _eWarn = o._eWarn; _warn = o._warn; _master = o._master;
        _eThink = o._eThink; _eWait = o._eWait; _eClosed = o._eClosed; _eRestart = o._eRestart;
        _hazirAt = o._hazirAt; _wakeAt = o._wakeAt; _lastJ = o._lastJ;
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

    // ------------------------------------------------------------------ the two load effects (brightness only)
    //
    // Each returns a brightness factor (<= 1) for one LED. ring/angle place an AIO LED (ring -1 = keyboard zone at x),
    // p is the LED's place along the whole system (fan 1 .. pump .. fan 4 .. keyboard left to right), 0..1.
    // They avoid what the Jarvis effects use: no white, no single orbiting highlight, no whole-system slow sine.

    /// <summary>Local model generating. 1 "akış": three soft dark gaps drift round every ring, like text streaming
    /// out; the keyboard carries them left to right. 2 "kıpırtı": every LED dims and recovers on its own slow,
    /// unsynchronised rhythm, a quiet living texture.</summary>
    static double YzFactor(int variant, int ring, double ang, double x, int led, double t, double e)
    {
        if (e < 0.001) return 1;
        if (variant == 2)
        {
            double h1 = Hash(led * 1.7 + 0.3) * 6.283, h2 = Hash(led * 3.1 + 0.9) * 6.283;
            double n = 0.5 + 0.5 * Math.Sin(t * 1.6 + h1) * Math.Sin(t * 0.97 + h2);   // 0..1, slow
            return 1 - e * 0.55 * n * n;
        }
        double ph = ring >= 0 ? 3 * ang - 2 * Math.PI * t / 3.4 + ring * 1.1 : 2 * Math.PI * (2.2 * x - t / 3.4);
        double gap = Math.Pow(Math.Max(0, Math.Cos(ph)), 4);
        return 1 - e * 0.6 * gap;
    }

    /// <summary>CPU under sustained heavy load. 1 "kalp": a calm lub-dub, the light rests a little lower and each
    /// beat brings it back to full (1.5 s). 2 "yük dalgası": a soft shade travels through the whole case, fan to fan,
    /// pump, last fan, then across the keyboard, every 3 s, as if the work flows through the machine.</summary>
    static double CpuFactor(int variant, double p, double t, double e)
    {
        if (e < 0.001) return 1;
        if (variant == 2)
        {
            double w = 0.5 - 0.5 * Math.Cos(2 * Math.PI * (p - t / 3.0));
            return 1 - e * 0.5 * Math.Pow(w, 3);
        }
        double ph = Frac(t / 1.5);
        double beat = Math.Exp(-Sq((ph - 0.05) / 0.055)) + 0.75 * Math.Exp(-Sq((ph - 0.27) / 0.055));
        return (1 - e * 0.42) + e * 0.42 * Math.Min(1, beat);
    }

    public void Hesapla(Girdi g, double t, double dt)
    {
        // ---- temperature: the only source of hue
        double? avg = g.CpuC.HasValue && g.GpuC.HasValue ? (g.CpuC + g.GpuC) / 2 : g.CpuC ?? g.GpuC;
        Ortalama = avg;
        if (avg.HasValue)
        {
            _smooth1 = _smooth1.HasValue ? Approach(_smooth1.Value, avg.Value, dt, TempTau) : avg;
            _smooth = _smooth.HasValue ? Approach(_smooth.Value, _smooth1.Value, dt, TempTau) : avg;
        }
        double tc = _smooth ?? _a.Duraklar[0].C;
        var baseCol = Palet(_ref, tc);          // keyboard, GPU, and what the window shows
        var aioBase = Palet(_aioPal, tc);
        Taban = baseCol;

        // ---- load effects
        _eAi = Approach(_eAi, g.YapayZeka ? 1 : 0, dt, EffectTau);
        _eCpu = Approach(_eCpu, g.Islemci ? 1 : 0, dt, EffectTau);
        int yzV = g.YzEfekt ?? _a.YapayZekaEfekti, cpuV = g.IslemciEfekt ?? _a.IslemciEfekti;
        double eAi = Smooth01(Math.Min(1, _eAi)), eCpu = Smooth01(Math.Min(1, _eCpu));

        // over-temperature warning: the raw average (not the 30 s drift, a warning must not wait) above the limit,
        // off 2 °C below. A clear blink, unlike the calm effects; the hue stays the temperature's (red up there).
        if (avg.HasValue) _warn = _warn ? avg.Value > _a.UyariDerece - 2 : avg.Value > _a.UyariDerece;
        bool warn = g.Uyari ?? _warn;
        _eWarn = Approach(_eWarn, warn ? 1 : 0, dt, 0.25);
        double blink = 1;
        if (_eWarn > 0.001)
        {
            double s = 0.5 + 0.5 * Math.Cos(2 * Math.PI * t / 1.1);          // 1.1 s cycle
            double on = Smooth01(Math.Max(0, Math.Min(1, (s - 0.3) * 2.5))); // mostly on or off, short soft edges
            blink = 1 - _eWarn * 0.9 * (1 - on);
        }

        // ---- Jarvis envelopes
        var j = g.Jarvis;
        if (j != _lastJ)
        {
            if (j == JarvisDurum.Hazir && _lastJ == JarvisDurum.Dusunuyor) _hazirAt = t;
            if ((_lastJ == JarvisDurum.Kapali || _lastJ == JarvisDurum.Yeniden) && j != JarvisDurum.Kapali && j != JarvisDurum.Yeniden && j != JarvisDurum.Yok) _wakeAt = t;
            _lastJ = j;
        }
        _eThink = Approach(_eThink, j == JarvisDurum.Dusunuyor ? 1 : 0, dt, 0.5);
        _eWait = Approach(_eWait, j == JarvisDurum.Bekliyor ? 1 : 0, dt, 0.9);
        _eClosed = Approach(_eClosed, j == JarvisDurum.Kapali ? 1 : 0, dt, 1.5);
        _eRestart = Approach(_eRestart, j == JarvisDurum.Yeniden ? 1 : 0, dt, 0.8);
        // idle fade-out is slow (~5 s, "yumuşak şekilde kapanır"); on/off and coming back keep the ~1 s fade
        bool lit = Acik && !Beklemede;
        _master = Approach(_master, lit ? 1 : 0, dt, !lit && Acik ? 1.6 : MasterTau);

        // global factors
        double breath = 1 - _eWait * 0.62 * Smooth01(0.5 - 0.5 * Math.Cos(2 * Math.PI * t / 5.2));   // 1 -> 0.38 -> 1, 5.2 s
        double hz = t - _hazirAt;
        double settle = hz >= 0 && hz < 1.8 ? 0.38 * Math.Sin(Math.PI * hz / 1.8) : 0;               // one soft swell
        double wk = t - _wakeAt;
        double wake = wk >= 0 && wk < 2.2 ? 0.7 * Math.Exp(-wk * 2.2) * Math.Min(1, wk * 8) : 0;      // back alive: bloom
        double master = _master * _master * (3 - 2 * _master);

        double sr = 0, sg = 0, sb = 0;
        int pump = _a.PompaHalkasi, rings = _a.AioHalkalari.Length;
        double span = rings + 1;   // places along the system: each ring one slot, the keyboard the last

        // ---- AIO rings
        for (int r = 0; r < rings; r++)
        {
            int n = _a.AioHalkalari[r];
            for (int i = 0; i < n; i++)
            {
                double ang = 2 * Math.PI * i / n;
                int led = _ringStart[r] + i;
                var c = aioBase * (YzFactor(yzV, r, ang, 0, led, t, eAi) * CpuFactor(cpuV, (r + (double)i / n * 0.3) / span, t, eCpu));

                // thinking: a soft highlight orbits every ring (2.6 s per turn), pulled toward white
                if (_eThink > 0.001)
                {
                    double ph = ang - 2 * Math.PI * t / 2.6 + r * 0.9;
                    double lobe = Math.Pow(Math.Max(0, Math.Cos(ph)), 5);
                    c = Lin.Mix(c, new Lin(White, White, White), 0.55 * lobe * _eThink);
                }
                if (settle > 0) c = Lin.Mix(c, new Lin(1, 1, 1), settle);
                if (wake > 0) c = Lin.Mix(c, new Lin(1, 1, 1), wake);
                c = c * breath;

                if (r == pump)
                {
                    // Jarvis closed: the pump ring, the centre of the AIO, rests as a slow ember
                    if (_eClosed > 0.001)
                    {
                        double ember = 0.10 + 0.07 * (0.5 - 0.5 * Math.Cos(2 * Math.PI * t / 8));
                        c = c * (1 - _eClosed * (1 - ember));
                    }
                    // restarting: a white point circles the pump ring like a loading mark
                    if (_eRestart > 0.001)
                    {
                        double ph = ang - 2 * Math.PI * t / 1.6;
                        double lobe = Math.Pow(Math.Max(0, Math.Cos(ph)), 14);
                        c = Lin.Mix(c * (1 - 0.7 * _eRestart), new Lin(1, 1, 1), lobe * _eRestart);
                    }
                }
                c = (c * (blink * master)).Clamped();
                Aio[led] = c;
                sr += c.R; sg += c.G; sb += c.B;
            }
        }

        // ---- keyboard zones (left to right)
        for (int z = 0; z < Klavye.Length; z++)
        {
            double x = (z + 0.5) / Klavye.Length;
            var c = baseCol * (YzFactor(yzV, -1, 0, x, 100 + z, t, eAi) * CpuFactor(cpuV, (rings + x) / span, t, eCpu));
            if (_eThink > 0.001)
            {
                double pos = -0.25 + 1.5 * Frac(t / 2.6);
                double lobe = Math.Exp(-(x - pos) * (x - pos) / (2 * 0.11 * 0.11));
                c = Lin.Mix(c, new Lin(1, 1, 1), 0.5 * lobe * _eThink);
            }
            if (settle > 0) c = Lin.Mix(c, new Lin(1, 1, 1), settle);
            if (wake > 0) c = Lin.Mix(c, new Lin(1, 1, 1), wake);
            Klavye[z] = (c * (breath * blink * master)).Clamped();
        }

        for (int i = 0; i < Gpu.Length; i++) Gpu[i] = (baseCol * (CpuFactor(cpuV, 0.5, t, eCpu) * breath * blink * master)).Clamped();

        Cikis = _aioCount > 0 ? new Lin(sr / _aioCount, sg / _aioCount, sb / _aioCount) : baseCol * master;
    }

    static double Smooth01(double x) => x * x * (3 - 2 * x);
    static double Frac(double x) => x - Math.Floor(x);
    static double Sq(double x) => x * x;
    static double Hash(double x) => Frac(Math.Sin(x * 12.9898) * 43758.5453);
}
