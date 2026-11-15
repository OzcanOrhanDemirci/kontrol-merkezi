// Kontrol Merkezi: fans and RGB of this PC from one window.
//
//   KontrolMerkezi.exe              the window (unelevated); talks to the service over a named pipe
//   KontrolMerkezi.exe servis       background service (elevated scheduled task at logon); owns every device
//   KontrolMerkezi.exe rgb-dene ... short light tests, one device at a time (Rgb/RgbDeneme.cs)
//   KontrolMerkezi.exe oku          read-only dump of sensors and devices to okuma.txt
//
// Process layout and the message protocol: docs/PROTOKOL.md.

using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace KontrolMerkezi;

static class Program
{
    internal static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    internal static readonly string DataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KontrolMerkezi");
    internal static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory;

    [STAThread]
    static int Main(string[] args)
    {
        Directory.CreateDirectory(DataDir);
        string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "";
        try
        {
            switch (mode)
            {
                case "": return 0;
                case "rgb-dene": return Rgb.RgbDeneme.Calistir(args.Skip(1).ToArray());
                default:
                    Log("Bilinmeyen komut: " + mode);
                    return 64;
            }
        }
        catch (Exception ex)
        {
            Log("HATA (" + mode + "): " + ex);
            return 1;
        }
    }

    static readonly object LogLock = new();

    internal static void Log(string msg)
    {
        try
        {
            lock (LogLock)
            {
                var path = Path.Combine(DataDir, "gunluk.txt");
                var fi = new FileInfo(path);
                if (fi.Exists && fi.Length > 512 * 1024)
                {
                    var keep = File.ReadAllLines(path);
                    File.WriteAllLines(path, keep.Skip(keep.Length / 2), new UTF8Encoding(true));
                }
                File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", Inv) + "  " + msg + "\r\n", new UTF8Encoding(true));
            }
        }
        catch
        {
            // a log that cannot be written must not stop the work
        }
    }
}
