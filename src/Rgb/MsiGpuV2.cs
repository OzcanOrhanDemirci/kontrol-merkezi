// MSI RTX 4080 Gaming X Trio lighting (PCI 10DE:2704, subsystem 1462:5111): "MSI GPU v2" (ITE9) registers on the
// card's I2C port 1, address 0x68, reached through NvAPI I2C.
//
// LOCKED. This class has never talked to the card. It cannot run unless BOTH switches are on:
//   1. compile time: DerlemeIzni below is const false in the committed code;
//   2. run time:     environment variable KONTROL_GPU_ISIK must equal "acik" (unset on this PC).
// Until both are on, the constructor throws before NvAPI is loaded, and every method that could reach the card checks
// again. Nothing in the program constructs it (RgbDeneme and the service do not). The proof plan that must come first is
// docs/GPU_ISIK_PLANI.md: record MSI Center's own writes, replay only those.
//
// Register facts from OpenRGB 1.1 Controllers/MSIGPUController/MSIGPUv2Controller (reimplemented, see docs/RGB_SURUCULER.md):
//   0x22 mode (0x1C idle/programming, 0x13 static, 0x01 off), 0x2E unknown (written 0 before a mode change),
//   0x30/0x31/0x32 colour R/G/B, 0x27/0x28/0x29 three-byte colour blocks (B,G,R), 0x36 brightness (20 * 1..5),
//   0x38 speed, 0x46 direction/control. Register 0x3F is "save to the card's memory" and is NOT in this file's
//   write list: KayitYaz() refuses it, and no code path names it. OpenRGB waits 20 ms after every write.
// The NvAPI I2C call shape follows OpenRGB's i2c_smbus_nvapi.cpp (port 1, register address one byte, default speed).

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace KontrolMerkezi.Rgb;

public sealed class MsiGpuV2 : IRgbCihaz
{
    /// <summary>Compile-time switch. Must stay false until the morning proof (docs/GPU_ISIK_PLANI.md) is done.</summary>
    internal const bool DerlemeIzni = false;
    const string CalismaDegiskeni = "KONTROL_GPU_ISIK";

    /// <summary>Both switches on? Pure: reads one constant and one environment variable, touches no hardware.</summary>
    public static bool IzinVar =>
#pragma warning disable CS0162
        DerlemeIzni && Environment.GetEnvironmentVariable(CalismaDegiskeni) == "acik";
#pragma warning restore CS0162

    const uint PciCihaz = 0x270410DE;    // device << 16 | vendor
    const uint PciAlt = 0x51111462;      // subsystem device << 16 | subsystem vendor
    const byte Adres = 0x68;

    const byte RegMod = 0x22, RegBilinmeyen = 0x2E, RegR = 0x30, RegG = 0x31, RegB = 0x32, RegParlaklik = 0x36;
    const byte ModBosta = 0x1C, ModSabit = 0x13;
    const int YazmaSonrasiMs = 20;

    /// <summary>The only registers this class may ever write. 0x3F (save) is deliberately absent.</summary>
    static readonly HashSet<byte> IzinliKayitlar = new()
    {
        // exactly what OpenRGB writes: mode, colour blocks 0x27-0x29 (3 bytes each -> up to 0x2B), 0x2E, R/G/B,
        // brightness, speed, control. To be narrowed further to MSI's recorded writes (GPU_ISIK_PLANI.md step 3).
        0x22, 0x27, 0x28, 0x29, 0x2A, 0x2B, 0x2E, 0x30, 0x31, 0x32, 0x36, 0x38, 0x46,
    };

    /// <summary>Full register sequence takes ~7 x 20 ms; the engine's 30 Hz frames are thinned to this.</summary>
    public int EnKisaAralikMs { get; set; } = 250;

    readonly object kilit = new();
    NvApi nv;
    IntPtr gpu;
    Rgb son;
    bool sonVar;
    long sonTick;

    public MsiGpuV2()
    {
        if (!IzinVar) throw new InvalidOperationException("GPU ışığı kilitli (docs/GPU_ISIK_PLANI.md)");
    }

    public string Kimlik => "gpu";
    public string Ad => "MSI RTX 4080 Gaming X Trio";
    public int LedSayisi => 1;
    public bool Bagli { get; private set; }
    public string Hata { get; private set; }

    public bool Ac()
    {
        lock (kilit)
        {
            if (!IzinVar) { Hata = "GPU ışığı kilitli"; return false; }
            try
            {
                nv ??= NvApi.Yukle();
                gpu = nv.KartBul(PciCihaz, PciAlt);
                if (gpu == IntPtr.Zero) { Hata = "Ekran kartı bulunamadı"; return false; }
                Bagli = true;
                Hata = null;
                return true;
            }
            catch (Exception ex)
            {
                Hata = "GPU ışığı: " + ex.Message;
                Bagli = false;
                return false;
            }
        }
    }

    public bool Yaz(Rgb[] renkler)
    {
        lock (kilit)
        {
            if (!IzinVar || gpu == IntPtr.Zero || renkler == null || renkler.Length < 1) return false;
            var c = renkler[0];
            long simdi = Environment.TickCount;
            if (sonVar && c.Equals(son)) return true;
            if (sonVar && simdi - sonTick < EnKisaAralikMs) return true;   // thinned; the next frame carries the colour
            try
            {
                Sabit(c);
                son = c; sonVar = true; sonTick = simdi;
                Bagli = true;
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

    /// <summary>Static black (no mode-off write, no save).</summary>
    public void Sondur()
    {
        lock (kilit)
        {
            if (!IzinVar || gpu == IntPtr.Zero) return;
            try { Sabit(Rgb.Black); son = Rgb.Black; sonVar = true; }
            catch (Exception ex) { Hata = "GPU ışığı söndürülemedi: " + ex.Message; Bagli = false; }
        }
    }

    public void Birak()
    {
        lock (kilit) { gpu = IntPtr.Zero; Bagli = false; sonVar = false; }
    }

    public void Dispose() => Birak();

    /// <summary>OpenRGB's "Direct" (static) sequence: 0x2E=0, 0x22=idle, R, G, B, brightness max, 0x22=static. No 0x3F.</summary>
    void Sabit(Rgb c)
    {
        KayitYaz(RegBilinmeyen, 0x00);
        KayitYaz(RegMod, ModBosta);
        KayitYaz(RegR, c.R);
        KayitYaz(RegG, c.G);
        KayitYaz(RegB, c.B);
        KayitYaz(RegParlaklik, 100);
        KayitYaz(RegMod, ModSabit);
    }

    void KayitYaz(byte kayit, byte deger)
    {
        if (!IzinVar) throw new InvalidOperationException("GPU ışığı kilitli");
        if (!IzinliKayitlar.Contains(kayit)) throw new InvalidOperationException($"GPU: 0x{kayit:X2} yazılamaz");
        nv.ByteYaz(gpu, Adres, kayit, deger);
        Thread.Sleep(YazmaSonrasiMs);
    }

    /// <summary>Minimal NvAPI access: initialise, find the card by PCI ids, I2C byte write on port 1. No reads.</summary>
    sealed class NvApi
    {
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
            public uint I2cSpeedKhz;         // 0 = default
            public byte PortId;
            public uint IsPortIdSet;
        }

        EnumPhysicalGpusT enumGpus;
        GetPciIdentifiersT pciIds;
        I2cWriteExT i2cWrite;

        static T Al<T>(uint id) where T : Delegate
        {
            var p = QueryInterface(id);
            if (p == IntPtr.Zero) throw new InvalidOperationException($"NvAPI 0x{id:X8} yok");
            return Marshal.GetDelegateForFunctionPointer<T>(p);
        }

        public static NvApi Yukle()
        {
            if (!IzinVar) throw new InvalidOperationException("GPU ışığı kilitli");
            var n = new NvApi();
            int s = Al<InitializeT>(0x0150E828)();
            if (s != 0) throw new InvalidOperationException("NvAPI başlatılamadı: " + s);
            n.enumGpus = Al<EnumPhysicalGpusT>(0xE5AC921F);
            n.pciIds = Al<GetPciIdentifiersT>(0x2DDFB66E);
            n.i2cWrite = Al<I2cWriteExT>(0x283AC65A);
            return n;
        }

        public IntPtr KartBul(uint cihaz, uint alt)
        {
            var h = new IntPtr[64];
            if (enumGpus(h, out int n) != 0) return IntPtr.Zero;
            for (int i = 0; i < n && i < h.Length; i++)
                if (pciIds(h[i], out uint d, out uint s, out _, out _) == 0 && d == cihaz && s == alt)
                    return h[i];
            return IntPtr.Zero;
        }

        public void ByteYaz(IntPtr gpu, byte adres, byte kayit, byte deger)
        {
            if (!IzinVar) throw new InvalidOperationException("GPU ışığı kilitli");
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
                    I2cDevAddress = (byte)(adres << 1),
                    I2cRegAddress = reg,
                    RegAddrSize = 1,
                    Data = veri,
                    Size = 1,
                    I2cSpeed = 0xFFFF,
                    I2cSpeedKhz = 0,
                    PortId = 1,
                    IsPortIdSet = 1,
                };
                int s = i2cWrite(gpu, ref info, out _);
                if (s != 0) throw new InvalidOperationException($"I2C yazma hatası {s} (0x{kayit:X2})");
            }
            finally
            {
                Marshal.FreeHGlobal(reg);
                Marshal.FreeHGlobal(veri);
            }
        }
    }
}
