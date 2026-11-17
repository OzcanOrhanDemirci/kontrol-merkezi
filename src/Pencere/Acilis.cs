// The loading screen's first picture: the hall in the dark, its service lamps at an ember. It is a frame of the
// scene itself (ui/acilis/taban.jpg, made by araclar/acilis_kareler.py and embedded with the rest of ui/), drawn once
// at the window's size, painted by the window from its first frame and handed to the page (/acilis.bmp), which shows
// the same pixels under its loading screen (ui/index.html, #acilis; ui/acilis.js strikes the hall's lighting circuits
// over it), so there is no seam between the window, the page and, at the end, the scene's first frame.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace KontrolMerkezi.Pencere;

static class Acilis
{
    /// <summary>The field around the picture (the window's background colour).</summary>
    public static readonly Color Zemin = Color.FromArgb(3, 3, 3);

    /// <summary>The picture at the window's size: fitted to the height and centred, as the scene is (its vertical
    /// field of view is fixed) and as the page lays its own pictures (acilis.js, fit). On the 2560x1440 monitor it
    /// is the file's own pixels. Without the file: the field colour.</summary>
    public static unsafe Bitmap Resim(int w, int h)
    {
        var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        try
        {
            // (a resource under a folder keeps the build's backslash in its name)
            var asm = typeof(Acilis).Assembly;
            var name = Array.Find(asm.GetManifestResourceNames(), n => n.Replace((char)92, '/') == "ui/acilis/taban.jpg");
            using var s = name == null ? null : asm.GetManifestResourceStream(name);
            using var src = s == null ? null : new Bitmap(s);
            if (src != null && src.Width == w && src.Height == h)
            {
                // the monitor's own size: the decoded rows as they are (~10 ms; drawing them through GDI+ took ~100)
                var all = new Rectangle(0, 0, w, h);
                var from = src.LockBits(all, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                var to = bmp.LockBits(all, ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
                long bytes = (long)Math.Min(from.Stride, to.Stride) * h;
                Buffer.MemoryCopy((void*)from.Scan0, (void*)to.Scan0, bytes, bytes);
                bmp.UnlockBits(to);
                src.UnlockBits(from);
                return bmp;
            }
            using var g = Graphics.FromImage(bmp);
            g.Clear(Zemin);
            if (src == null) return bmp;
            int dw = (int)Math.Round(src.Width * (double)h / src.Height);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.CompositingMode = CompositingMode.SourceCopy;
            using var attr = new ImageAttributes();
            attr.SetWrapMode(WrapMode.TileFlipXY);                        // no dark fringe at the edges when scaled
            g.DrawImage(src, new Rectangle((w - dw) / 2, 0, dw, h), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, attr);
        }
        catch (Exception ex) { Program.Log("pencere: açılış resmi okunamadı: " + ex.Message); }
        return bmp;
    }
}
