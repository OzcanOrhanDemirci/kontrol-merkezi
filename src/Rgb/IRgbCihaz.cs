// RGB device contract. Every driver here writes ONLY volatile/direct-mode colour data:
// nothing a driver does may change what the controller stores (its power-on state stays "off"),
// and no live colour path may go through a command that commits to the device's flash.

using System;

namespace KontrolMerkezi.Rgb;

public struct Rgb
{
    public byte R, G, B;
    public Rgb(byte r, byte g, byte b) { R = r; G = g; B = b; }
    public static readonly Rgb Black = new Rgb(0, 0, 0);
    public bool Equals(Rgb o) => R == o.R && G == o.G && B == o.B;
    public override string ToString() => $"{R:X2}{G:X2}{B:X2}";
}

public interface IRgbCihaz : IDisposable
{
    /// <summary>Stable id used in the protocol: "aio", "klavye", "gpu".</summary>
    string Kimlik { get; }
    /// <summary>Turkish display name.</summary>
    string Ad { get; }
    /// <summary>Number of addressable LEDs / zones written by Yaz.</summary>
    int LedSayisi { get; }
    /// <summary>True while the device is open and the last write succeeded.</summary>
    bool Bagli { get; }
    /// <summary>Last error in plain Turkish, null if none.</summary>
    string Hata { get; }

    /// <summary>Find and open the device and put it in its volatile direct mode. False if absent or failed (Hata says why).
    /// Safe to call again after a failure or after sleep/wake (re-opens).</summary>
    bool Ac();

    /// <summary>Write one frame of colours (length LedSayisi), volatile only. Drivers skip the USB write when the frame is
    /// unchanged. Returns false on failure and sets Bagli=false.</summary>
    bool Yaz(Rgb[] renkler);

    /// <summary>Lights off: the visible state becomes dark without touching stored settings.</summary>
    void Sondur();

    /// <summary>Release the handle. Leaves the lights as they are (call Sondur first for off).</summary>
    void Birak();
}
