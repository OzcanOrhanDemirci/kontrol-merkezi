// The light engine: from temperatures, loads and states to one colour per LED, 30 times a second.
//
//   base   = temperature palette at the smoothed CPU/GPU average (OKLCh blend between stops, full brightness)
//   blend  -> override colour (local model generating), each fading in and out softly
//   motion -> the override's own slow pattern, then the Jarvis effects on top (thinking shimmer, waiting breath, ...)
//   master -> RGB on/off fade
//
// Everything is driven by elapsed seconds, never by frame count, so an uneven tick cannot change an effect's speed.

using System;

namespace KontrolMerkezi.Isik;

public enum JarvisDurum { Yok, Dusunuyor, Bekliyor, Hazir, Kapali, Yeniden }
public enum IsikKipi { Sicaklik, YapayZeka }

public sealed class Girdi
{
    public double? CpuC, GpuC;
    public double CpuYuk, GpuYuk;      // 0..100
    public bool YapayZeka;             // local model generating right now
    public JarvisDurum Jarvis;
}

public sealed class RenkMotoru
{
    const double TempTau = 5.0;        // s: "average over a few seconds so CPU spikes do not make the lights flicker"
    const double OverrideTau = 0.7;    // s: override enters/leaves over ~2-3 s
    const double MasterTau = 0.3;      // s: on/off fade ~1 s
    const double White = 1.0;

    readonly Ayarlar _a;

    // One palette per device: the stop colours and override colours that make that device show what the reference
    // (the keyboard) shows. LED errors depend on hue, so per-channel gains cannot match devices across the palette.
    sealed class Palette
    {
        public Lab[] Stops;
        public Lab Ai;
        public Lin AiLight, AiShimmer;
    }
    readonly Palette _ref, _aioPal;
    readonly int[] _ringStart;
    readonly int _aioCount;

    double? _smooth;
    double _wAi, _master;
    double _eThink, _eWait, _eClosed, _eRestart;
    double _hazirAt = -100, _wakeAt = -100;
    JarvisDurum _lastJ = JarvisDurum.Yok;

    public readonly Lin[] Aio;
    public readonly Lin[] Klavye = new Lin[10];
    public readonly Lin[] Gpu = new Lin[1];

    public bool Acik { get; set; }
    public double? Yumusak => _smooth;
    public double? Ortalama { get; private set; }
    public Lin Taban { get; private set; } = new Lin(1, 1, 1);   // base colour before motion/effects (also shown when off)
    public Lin Cikis { get; private set; }                        // average of what goes to the devices
    public IsikKipi Kip { get; private set; }

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

    static Lin L(int[] c) => Lin.FromSrgb(c[0], c[1], c[2]).Full();

    static Palette Build(Ayarlar a, CihazRenk own)
    {
        var p = new Palette { Stops = new Lab[a.Duraklar.Count] };
        for (int i = 0; i < p.Stops.Length; i++)
        {
            var c = own?.Duraklar != null && i < own.Duraklar.Length && own.Duraklar[i] != null ? own.Duraklar[i] : a.Duraklar[i].Renk;
            p.Stops[i] = Lab.From(L(c));
        }
        p.AiLight = L(own?.YapayZeka ?? a.YapayZekaRengi);
        p.Ai = Lab.From(p.AiLight);
        p.AiShimmer = Lin.Mix(p.AiLight, new Lin(1, 0.45, 0.75), 0.6).Full();
        return p;
    }

    /// <summary>Carry the running state over from the engine this one replaces (live settings reload: no fade, no jump).</summary>
    public void DevamEt(RenkMotoru o)
    {
        _smooth = o._smooth; _wAi = o._wAi; _master = o._master;
        _eThink = o._eThink; _eWait = o._eWait; _eClosed = o._eClosed; _eRestart = o._eRestart;
        _hazirAt = o._hazirAt; _wakeAt = o._wakeAt; _lastJ = o._lastJ;
    }

    /// <summary>Palette colour for an averaged temperature (full brightness, linear light), reference device.</summary>
    public Lin Palet(double c) => Palet(_ref, c);

    Lin Palet(Palette pal, double c)
    {
        var _stopLab = pal.Stops;
        var d = _a.Duraklar;
        if (c <= d[0].C) return _stopLab[0].ToLin().Full();
        for (int i = 1; i < d.Count; i++)
        {
            if (c <= d[i].C)
            {
                double t = (c - d[i - 1].C) / (d[i].C - d[i - 1].C);
                t = t * t * (3 - 2 * t) * 0.35 + t * 0.65;   // a little ease so a stop's colour is held a touch longer
                return Lab.MixHue(_stopLab[i - 1], _stopLab[i], t).ToLin().Full();
            }
        }
        return _stopLab[d.Count - 1].ToLin().Full();
    }

    Lin Base(Palette pal, double tc)
    {
        var lab = Lab.From(Palet(pal, tc));
        if (_wAi > 0.001) lab = Lab.Mix(lab, pal.Ai, _wAi);
        return lab.ToLin().Full();
    }

    static double Approach(double v, double target, double dt, double tau) => v + (target - v) * (1 - Math.Exp(-dt / tau));

    public void Hesapla(Girdi g, double t, double dt)
    {
        // ---- temperature
        double? avg = g.CpuC.HasValue && g.GpuC.HasValue ? (g.CpuC + g.GpuC) / 2 : g.CpuC ?? g.GpuC;
        Ortalama = avg;
        if (avg.HasValue) _smooth = _smooth.HasValue ? Approach(_smooth.Value, avg.Value, dt, TempTau) : avg;
        double tc = _smooth ?? _a.Duraklar[0].C;

        // ---- overrides (soft)
        _wAi = Approach(_wAi, g.YapayZeka ? 1 : 0, dt, OverrideTau);
        var baseCol = Base(_ref, tc);       // keyboard, GPU, and what the window shows
        var aioBase = Base(_aioPal, tc);
        Taban = baseCol;
        Kip = g.YapayZeka ? IsikKipi.YapayZeka : IsikKipi.Sicaklik;

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
        _master = Approach(_master, Acik ? 1 : 0, dt, MasterTau);

        // global factors
        double breath = 1 - _eWait * 0.62 * Smooth01(0.5 - 0.5 * Math.Cos(2 * Math.PI * t / 5.2));   // 1 -> 0.38 -> 1, 5.2 s
        double hz = t - _hazirAt;
        double settle = hz >= 0 && hz < 1.8 ? 0.38 * Math.Sin(Math.PI * hz / 1.8) : 0;               // one soft swell
        double wk = t - _wakeAt;
        double wake = wk >= 0 && wk < 2.2 ? 0.7 * Math.Exp(-wk * 2.2) * Math.Min(1, wk * 8) : 0;      // back alive: bloom
        double master = _master * _master * (3 - 2 * _master);

        double sr = 0, sg = 0, sb = 0;
        int pump = _a.PompaHalkasi;

        // ---- AIO rings
        for (int r = 0; r < _a.AioHalkalari.Length; r++)
        {
            int n = _a.AioHalkalari[r];
            for (int i = 0; i < n; i++)
            {
                double ang = 2 * Math.PI * i / n;
                var c = aioBase;
                if (_wAi > 0.001)
                {
                    // flowing pink: a lighter rose drifts round each ring
                    double f = 0.5 + 0.5 * Math.Sin(ang * 2 - t * 2.4 + r * 1.3);
                    c = Lin.Mix(c, _aioPal.AiShimmer, 0.45 * f * _wAi);
                }

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
                c = (c * master).Clamped();
                Aio[_ringStart[r] + i] = c;
                sr += c.R; sg += c.G; sb += c.B;
            }
        }

        // ---- keyboard zones (left to right)
        for (int z = 0; z < Klavye.Length; z++)
        {
            double x = (z + 0.5) / Klavye.Length;
            var c = baseCol;
            if (_wAi > 0.001)
            {
                double f = 0.5 + 0.5 * Math.Sin(x * 6.3 - t * 2.4);
                c = Lin.Mix(c, _ref.AiShimmer, 0.45 * f * _wAi);
            }
            if (_eThink > 0.001)
            {
                double pos = -0.25 + 1.5 * Frac(t / 2.6);
                double lobe = Math.Exp(-(x - pos) * (x - pos) / (2 * 0.11 * 0.11));
                c = Lin.Mix(c, new Lin(1, 1, 1), 0.5 * lobe * _eThink);
            }
            if (settle > 0) c = Lin.Mix(c, new Lin(1, 1, 1), settle);
            if (wake > 0) c = Lin.Mix(c, new Lin(1, 1, 1), wake);
            Klavye[z] = (c * breath * master).Clamped();
        }

        for (int i = 0; i < Gpu.Length; i++) Gpu[i] = (baseCol * breath * master).Clamped();

        Cikis = _aioCount > 0 ? new Lin(sr / _aioCount, sg / _aioCount, sb / _aioCount) : baseCol * master;
    }

    static double Smooth01(double x) => x * x * (3 - 2 * x);
    static double Frac(double x) => x - Math.Floor(x);
}
