// Colour maths for the light engine: sRGB <-> linear <-> OKLab/OKLCh.
// Device LEDs are driven with linear-light values (PWM duty mixes linearly), the window gets sRGB.

using System;

namespace KontrolMerkezi.Isik;

/// <summary>Linear-light RGB, components nominally 0..1.</summary>
public struct Lin
{
    public double R, G, B;
    public Lin(double r, double g, double b) { R = r; G = g; B = b; }

    public static Lin operator +(Lin a, Lin b) => new(a.R + b.R, a.G + b.G, a.B + b.B);
    public static Lin operator *(Lin a, double k) => new(a.R * k, a.G * k, a.B * k);
    public static Lin Mix(Lin a, Lin b, double t) => new(a.R + (b.R - a.R) * t, a.G + (b.G - a.G) * t, a.B + (b.B - a.B) * t);
    public double Max => Math.Max(R, Math.Max(G, B));

    /// <summary>Scale so the strongest channel is 1: the lights are always at full brightness ("kısık olmasın").</summary>
    public Lin Full()
    {
        double m = Max;
        return m <= 1e-6 ? new Lin(1, 1, 1) : new Lin(Clamp(R / m), Clamp(G / m), Clamp(B / m));
    }

    public Lin Clamped() => new(Clamp(R), Clamp(G), Clamp(B));

    public static Lin FromSrgb(int r, int g, int b) => new(ToLin(r / 255.0), ToLin(g / 255.0), ToLin(b / 255.0));

    public void ToSrgb(out int r, out int g, out int b)
    {
        r = (int)Math.Round(ToSrgbC(Clamp(R)) * 255);
        g = (int)Math.Round(ToSrgbC(Clamp(G)) * 255);
        b = (int)Math.Round(ToSrgbC(Clamp(B)) * 255);
    }

    static double ToLin(double c) => c <= 0.04045 ? c / 12.92 : Math.Pow((c + 0.055) / 1.055, 2.4);
    static double ToSrgbC(double c) => c <= 0.0031308 ? c * 12.92 : 1.055 * Math.Pow(c, 1 / 2.4) - 0.055;
    internal static double Clamp(double v) => v < 0 ? 0 : v > 1 ? 1 : v;
}

/// <summary>OKLab (Björn Ottosson, 2020).</summary>
public struct Lab
{
    public double L, A, B;
    public Lab(double l, double a, double b) { L = l; A = a; B = b; }

    public static Lab From(Lin c)
    {
        double l = 0.4122214708 * c.R + 0.5363325363 * c.G + 0.0514459929 * c.B;
        double m = 0.2119034982 * c.R + 0.6806995451 * c.G + 0.1073969566 * c.B;
        double s = 0.0883024619 * c.R + 0.2817188376 * c.G + 0.6299787005 * c.B;
        l = Math.Pow(Math.Max(l, 0), 1.0 / 3); m = Math.Pow(Math.Max(m, 0), 1.0 / 3); s = Math.Pow(Math.Max(s, 0), 1.0 / 3);
        return new Lab(
            0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
    }

    public Lin ToLin()
    {
        double l = L + 0.3963377774 * A + 0.2158037573 * B;
        double m = L - 0.1055613458 * A - 0.0638541728 * B;
        double s = L - 0.0894841775 * A - 1.2914855480 * B;
        l = l * l * l; m = m * m * m; s = s * s * s;
        return new Lin(
            +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
    }

    public static Lab Mix(Lab a, Lab b, double t) => new(a.L + (b.L - a.L) * t, a.A + (b.A - a.A) * t, a.B + (b.B - a.B) * t);

    /// <summary>Blend through OKLCh along the shorter hue arc. Between dark blue and yellow this passes through teal and
    /// green instead of a grey midpoint; Özcan accepted green/purple appearing inside transitions. Near-grey ends take
    /// the other end's hue so white -> light blue does not swing round the wheel.</summary>
    public static Lab MixHue(Lab a, Lab b, double t)
    {
        double ca = Math.Sqrt(a.A * a.A + a.B * a.B), cb = Math.Sqrt(b.A * b.A + b.B * b.B);
        double ha = Math.Atan2(a.B, a.A), hb = Math.Atan2(b.B, b.A);
        if (ca < 0.04) ha = hb;
        if (cb < 0.04) hb = ha;
        double dh = hb - ha;
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        double h = ha + dh * t, c = ca + (cb - ca) * t, l = a.L + (b.L - a.L) * t;
        return new Lab(l, c * Math.Cos(h), c * Math.Sin(h));
    }
}
