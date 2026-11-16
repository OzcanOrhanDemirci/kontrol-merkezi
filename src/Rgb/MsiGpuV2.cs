// MSI RTX 4080 Gaming X Trio lighting (PCI 10DE:2704, subsystem 1462:5111): the light controller at I2C address 0x68
// on the card's port 1, reached through NvAPI I2C.
//
// What is sent are writes MSI Mystic Light made on 2026-11-16 (docs/gpu-kayit/), never its save:
//   first colour : 2D=00 (zones on), 22=1C (programming), 36=64 (full brightness), 38=02, 30=R, 31=G, 32=B, 22=13 (steady)
//   next colours : 30=R, 31=G, 32=B, 22=13. The colour latches on the steady-mode write; R/G/B alone is ignored, and
//                  the programming step darkens the LEDs for a moment, so a full sequence per change blinks (viewings
//                  1 and 2 with Özcan, 11-16). Brightness fades do not read on this card (viewing 3), only colour does.
//   off          : 2D=03 (both zones off)
// Every write is checked against an allow-list of (register, value) pairs taken from that capture. The controller's
// save register is not in the list, and Yol (the bus) refuses it on its own as well: nothing here can change what
// the card stores. Proven on the card: colour/mode writes are lost at power-off (step 4, 11:10 -> 11:54); the zone
// switch 2D is never stored, not even by a save (power-off test 12:26: white at the logo after MSI's saved "off").
//
// The NvAPI write exists only in a build with the symbol GPU_ISIK (the normal build; -p:GpuIsik=kapali leaves it out).
// A build without it cannot reach the card at all: the I2C entry point is never looked up and the class below is not
// compiled; it drives the same code against KayitYolu, which only records the writes (checking sequences off the card).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace KontrolMerkezi.Rgb;

/// <summary>One register write on the card's light controller. Implementations: NvApiYolu (real, GPU_ISIK builds
/// only) and KayitYolu (records only).</summary>
public interface IGpuYolu
{
    bool Ac();
    void Yaz(byte kayit, byte deger);
    string Hata { get; }
}

public sealed class MsiGpuV2 : IRgbCihaz
{
#if GPU_ISIK
    /// <summary>True in a build that can drive the card (GPU_ISIK; not with -p:GpuIsik=kapali).</summary>
    public const bool KartaYazabilir = true;
#else
    public const bool KartaYazabilir = false;
#endif

    // ---- the sequence MSI used (docs/gpu-kayit/msi-mystic-light-2026-11-16*.txt)
    const byte RegBolge = 0x2D, RegMod = 0x22, RegParlaklik = 0x36, RegHiz = 0x38, RegR = 0x30, RegG = 0x31, RegB = 0x32;
    const byte BolgelerAcik = 0x00, BolgelerKapali = 0x03, ModProgram = 0x1C, ModSabit = 0x13, TamParlaklik = 0x64, Hiz = 0x02;

    /// <summary>Pause after each write. MSI waited ~30 ms (about 8 colour changes a second). Settable while running
    /// (ayarlar.json gpuYazmaArasiMs, live reload): Özcan 11-16 wants it raised in stages, like an overclock, and kept
    /// a step below the first stage that misbehaves.</summary>
    public int YazmaArasiMs { get => yazmaArasi; set => yazmaArasi = Math.Max(0, Math.Min(50, value)); }
    volatile int yazmaArasi = 30;

    /// <summary>Pause after the steady-mode write (22=13) instead of YazmaArasiMs; -1 = the same. Stages 11-16: 25 ms after
    /// every write is taken, 10 and 5 ms are silently ignored (the card stays on its colour, no error); this tests
    /// whether the chip needs the time after the latch rather than between the colour writes.</summary>
    public int SabitSonrasiMs { get => sabitSonrasi; set => sabitSonrasi = Math.Max(-1, Math.Min(100, value)); }
    volatile int sabitSonrasi = -1;

    /// <summary>Colour changes sent since start (the service logs the rate while the card is lit).</summary>
    public int Guncellemeler => guncellemeler;
    int guncellemeler;

    /// <summary>Shortest spacing between two colour updates; frames in between are skipped (the next carries the colour).</summary>
    public int EnKisaAralikMs { get; set; } = 0;

    /// <summary>Is this exact write one MSI made? The only gate every write passes. The save register is absent.</summary>
    public static bool Izinli(byte kayit, byte deger) => kayit switch
    {
        RegBolge => deger == BolgelerAcik || deger == BolgelerKapali,
        RegMod => deger == ModProgram || deger == ModSabit,
        RegParlaklik => deger == TamParlaklik,
        RegHiz => deger == Hiz,
        RegR or RegG or RegB => true,
        _ => false,
    };

    /// <summary>The full colour sequence, in MSI's order.</summary>
    public static (byte kayit, byte deger)[] RenkSirasi(Rgb c) => new[]
    {
        (RegBolge, BolgelerAcik), (RegMod, ModProgram), (RegParlaklik, TamParlaklik), (RegHiz, Hiz),
        (RegR, c.R), (RegG, c.G), (RegB, c.B), (RegMod, ModSabit),
    };

    /// <summary>A colour change once the card is lit: colour, then steady (no programming step, no blink).</summary>
    public static (byte kayit, byte deger)[] DegisimSirasi(Rgb c) => new[] { (RegR, c.R), (RegG, c.G), (RegB, c.B), (RegMod, ModSabit) };

    public static (byte kayit, byte deger)[] KapatSirasi() => new[] { (RegBolge, BolgelerKapali) };

    readonly object kilit = new();
    readonly IGpuYolu yol;
    Rgb son;
    bool sabitKurulu;      // a full sequence went out since the last open/off: colour + steady may follow
    bool sonVar;
    long sonTick;

    /// <summary>The real card. Throws in a build that cannot drive it.</summary>
    public MsiGpuV2() : this(GercekYol()) { }

    public MsiGpuV2(IGpuYolu yol) { this.yol = yol ?? throw new ArgumentNullException(nameof(yol)); }

    static IGpuYolu GercekYol()
    {
#if GPU_ISIK
        return new NvApiYolu();
#else
        throw new InvalidOperationException("Bu derleme ekran kartına yazamaz (GPU_ISIK yok)");
#endif
    }

    public string Kimlik => "gpu";
    public string Ad => "MSI RTX 4080 Gaming X Trio";
    public int LedSayisi => 1;
    public bool Bagli { get; private set; }
    public string Hata { get; private set; }

    /// <summary>Optional trace of every write (tests and the card runs log it).</summary>
    public Action<string> Iz { get; set; }

    public bool Ac()
    {
        lock (kilit)
        {
            try
            {
                if (!yol.Ac()) { Hata = yol.Hata ?? "Ekran kartı bulunamadı"; Bagli = false; return false; }
                Bagli = true; Hata = null; sabitKurulu = false; sonVar = false;
                return true;
            }
            catch (Exception ex) { Hata = "GPU ışığı: " + ex.Message; Bagli = false; return false; }
        }
    }

    public bool Yaz(Rgb[] renkler)
    {
        lock (kilit)
        {
            if (!Bagli || renkler == null || renkler.Length < 1) return false;
            var c = renkler[0];
            long simdi = Environment.TickCount;
            if (sonVar && c.Equals(son)) return true;   // unchanged: the controller holds it, no keep-alive needed
            if (sonVar && EnKisaAralikMs > 0 && simdi - sonTick < EnKisaAralikMs) return true;
            try
            {
                if (sabitKurulu) Gonder(DegisimSirasi(c));
                else { Gonder(RenkSirasi(c)); sabitKurulu = true; }
                son = c; sonVar = true; sonTick = simdi;
                Interlocked.Increment(ref guncellemeler);
                return true;
            }
            catch (Exception ex)
            {
                Hata = "GPU ışığı yazılamadı: " + ex.Message;
                Bagli = false;
                return false;
            }
        }
    }

    /// <summary>Zones off (MSI's own off switch, never stored by the card).</summary>
    public void Sondur()
    {
        lock (kilit)
        {
            if (!Bagli) return;
            try { Gonder(KapatSirasi()); sabitKurulu = false; sonVar = false; }
            catch (Exception ex) { Hata = "GPU ışığı söndürülemedi: " + ex.Message; Bagli = false; }
        }
    }

    public void Birak()
    {
        lock (kilit) { Bagli = false; sabitKurulu = false; sonVar = false; }
    }

    public void Dispose() => Birak();

    void Gonder((byte kayit, byte deger)[] sira)
    {
        foreach (var (k, d) in sira) if (!Izinli(k, d)) throw new InvalidOperationException($"GPU: {k:X2}={d:X2} izinli değil");
        foreach (var (k, d) in sira)
        {
            yol.Yaz(k, d);
            Iz?.Invoke($"{DateTime.Now:HH:mm:ss.fff} yaz 0x68 port1 {k:X2}={d:X2}");
            int ara = k == RegMod && d == ModSabit && SabitSonrasiMs >= 0 ? SabitSonrasiMs : YazmaArasiMs;
            if (ara > 0) Thread.Sleep(ara);   // after every write, also the last (the next sequence may follow at once)
        }
    }

    /// <summary>The bus's own refusal, independent of the allow-list: the save register is never written.</summary>
    internal static void KayitKorumasi(byte kayit)
    {
        if (kayit == 0x3F) throw new InvalidOperationException("GPU: kaydetme yazmacı asla yazılmaz");
    }
}

/// <summary>Records the writes instead of sending them. Reaches no hardware; used by tests and by builds without GPU_ISIK.</summary>
public sealed class KayitYolu : IGpuYolu
{
    public readonly List<(long ms, byte kayit, byte deger)> Yazilanlar = new();
    readonly Stopwatch sw = Stopwatch.StartNew();
    public string Hata => null;
    public bool Ac() => true;
    public void Yaz(byte kayit, byte deger)
    {
        MsiGpuV2.KayitKorumasi(kayit);
        lock (Yazilanlar) Yazilanlar.Add((sw.ElapsedMilliseconds, kayit, deger));
    }
}

#if GPU_ISIK
/// <summary>NvAPI I2C byte write on port 1, address 0x68, of the RTX 4080 with MSI's subsystem id. No reads.
/// Call shape as MSI's own calls were recorded (ver 3, address D0, port 1 set, i2cSpeed FFFF, 400 kHz), in the
/// 64-bit layout of the same structure (OpenRGB's i2c_smbus_nvapi.cpp uses it so); a layout NvAPI does not accept is
/// refused by the driver as a version mismatch, before anything reaches the bus.</summary>
sealed class NvApiYolu : IGpuYolu
{
    const uint PciCihaz = 0x270410DE;    // device << 16 | vendor
    const uint PciAlt = 0x51111462;      // subsystem device << 16 | subsystem vendor
    const byte Adres = 0x68;

    [DllImport("nvapi64.dll", EntryPoint = "nvapi_QueryInterface", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr QueryInterface(uint id);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int InitializeT();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int EnumPhysicalGpusT([Out] IntPtr[] handles, out int count);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int GetPciIdentifiersT(IntPtr gpu, out uint deviceId, out uint subSystemId, out uint revisionId, out uint extDeviceId);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int I2cWriteExT(IntPtr gpu, ref I2cInfoV3 info, out uint unknown);

    [StructLayout(LayoutKind.Sequential)]
    struct I2cInfoV3
    {
        public uint Version;
        public uint DisplayMask;
        public byte IsDdcPort;
        public byte I2cDevAddress;       // 7-bit address << 1
        public IntPtr I2cRegAddress;
        public uint RegAddrSize;
        public IntPtr Data;
        public uint Size;
        public uint I2cSpeed;            // 0xFFFF = use I2cSpeedKhz
        public uint I2cSpeedKhz;         // NV_I2C_SPEED: 6 = 400 kHz, as MSI
        public byte PortId;
        public uint IsPortIdSet;
    }

    I2cWriteExT i2cWrite;
    IntPtr gpu;
    public string Hata { get; private set; }

    static T Al<T>(uint id) where T : Delegate
    {
        var p = QueryInterface(id);
        if (p == IntPtr.Zero) throw new InvalidOperationException($"NvAPI 0x{id:X8} yok");
        return Marshal.GetDelegateForFunctionPointer<T>(p);
    }

    public bool Ac()
    {
        int s = Al<InitializeT>(0x0150E828)();
        if (s != 0) { Hata = "NvAPI başlatılamadı: " + s; return false; }
        var enumGpus = Al<EnumPhysicalGpusT>(0xE5AC921F);
        var pciIds = Al<GetPciIdentifiersT>(0x2DDFB66E);
        i2cWrite ??= Al<I2cWriteExT>(0x283AC65A);
        gpu = IntPtr.Zero;
        var h = new IntPtr[64];
        if (enumGpus(h, out int n) != 0) { Hata = "NvAPI kart listesi alınamadı"; return false; }
        for (int i = 0; i < n && i < h.Length; i++)
            if (pciIds(h[i], out uint d, out uint sub, out _, out _) == 0 && d == PciCihaz && sub == PciAlt) { gpu = h[i]; break; }
        if (gpu == IntPtr.Zero) { Hata = "MSI RTX 4080 Gaming X Trio bulunamadı"; return false; }
        Hata = null;
        return true;
    }

    public void Yaz(byte kayit, byte deger)
    {
        MsiGpuV2.KayitKorumasi(kayit);
        if (gpu == IntPtr.Zero || i2cWrite == null) throw new InvalidOperationException("kart açık değil");
        var reg = Marshal.AllocHGlobal(1);
        var veri = Marshal.AllocHGlobal(1);
        try
        {
            Marshal.WriteByte(reg, kayit);
            Marshal.WriteByte(veri, deger);
            var info = new I2cInfoV3
            {
                Version = (uint)Marshal.SizeOf<I2cInfoV3>() | (3u << 16),
                IsDdcPort = 0,
                I2cDevAddress = (byte)(Adres << 1),
                I2cRegAddress = reg,
                RegAddrSize = 1,
                Data = veri,
                Size = 1,
                I2cSpeed = 0xFFFF,
                I2cSpeedKhz = 6,
                PortId = 1,
                IsPortIdSet = 1,
            };
            int s = i2cWrite(gpu, ref info, out _);
            if (s != 0) throw new InvalidOperationException($"I2C yazma hatası {s} ({kayit:X2})");
        }
        finally
        {
            Marshal.FreeHGlobal(reg);
            Marshal.FreeHGlobal(veri);
        }
    }
}
#endif
