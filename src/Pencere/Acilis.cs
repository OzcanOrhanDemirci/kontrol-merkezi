// The loading screen's picture: the hall before its lights strike. Near-dark haze, and down the middle the shaft's
// light through a hatch not yet open: a thin beam from the ceiling onto a small pool on the floor, where the scene's
// shaft falls once it strikes (the fanlar view: the shaft's column at the centre, its pool at ~73 % of the height).
// Made once at the window's size, painted by the window from its first frame and handed to the page
// (/acilis.bmp), which shows the same pixels under its loading screen (ui/index.html, #acilis), so there is no seam
// between the window, the page and, at the end, the scene's own opening.

using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Threading.Tasks;

namespace KontrolMerkezi.Pencere;

static class Acilis
{
    /// <summary>The field far from the light (the window's background colour).</summary>
    public static readonly Color Zemin = Color.FromArgb(3, 3, 3);

    // geometry in units of the height (the scene's vertical field of view is fixed, so this is the scene's layout on
    // any aspect): the beam's centre x = 0, the pool's height
    const double PoolV = 0.735;

    public static unsafe Bitmap Resim(int w, int h)
    {
        var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        var d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
        byte* scan0 = (byte*)d.Scan0;
        int stride = d.Stride;
        double inv = 1.0 / h;
        Parallel.For(0, h, y =>
        {
            byte* row = scan0 + (long)y * stride;
            double v = (y + 0.5) * inv;
            // the beam: thin, widening a little as it falls, dimming towards the floor, ending in the pool
            double s = 0.0032 + 0.0055 * v;
            double fall = (1 - 0.35 * Math.Min(1, v / PoolV)) * (1 - Smooth(PoolV - 0.07, PoolV + 0.004, v));
            double dvPool = v - PoolV;
            for (int x = 0; x < w; x++)
            {
                double u = (x + 0.5 - w * 0.5) * inv, u2 = u * u;
                double haze = 3.0 + 4.2 * Math.Exp(-(u2 / 0.10 + (v - 0.6) * (v - 0.6) / 0.16));
                double beam = fall * (30 * Math.Exp(-u2 / (2 * s * s)) + 6 * Math.Exp(-u2 / (50 * s * s)) + 2.2 * Math.Exp(-u2 / (2 * 0.05 * 0.05)));
                double pool = 20 * Math.Exp(-(u2 / (2 * 0.045 * 0.045) + dvPool * dvPool / (2 * 0.007 * 0.007)))
                            + 5 * Math.Exp(-(u2 / (2 * 0.15 * 0.15) + dvPool * dvPool / (2 * 0.028 * 0.028)));
                double r = Math.Sqrt(u2 * 0.7 + (v - 0.55) * (v - 0.55) * 1.3);
                double L = (haze + beam + pool) * (1 - 0.5 * Smooth(0.35, 1.0, r));
                double n = (Hash(x, y) - 0.5) * 1.5;                       // grain: no banding in the dark steps
                row[x * 3 + 2] = Byte(L * 1.03 + n);                      // warm grey: R
                row[x * 3 + 1] = Byte(L + n);                             // G
                row[x * 3 + 0] = Byte(L * 0.92 + n);                      // B
            }
        });
        bmp.UnlockBits(d);
        return bmp;
    }

    static double Smooth(double a, double b, double x) { double t = Math.Max(0, Math.Min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
    static byte Byte(double v) => (byte)Math.Max(0, Math.Min(255, Math.Round(v)));
    static double Hash(int x, int y)
    {
        uint q = (uint)x * 0x8da6b343u ^ (uint)y * 0xd8163841u;
        q ^= q >> 15; q *= 0x2c1b3c6du; q ^= q >> 12; q *= 0x297a2d39u; q ^= q >> 15;
        return (q & 0xffffff) / 16777216.0;
    }
}
