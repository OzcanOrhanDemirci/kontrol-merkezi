// Graphics-card fans through NVIDIA's driver API (nvapi64.dll), MAX <-> the card's own automatic control.
//
// This is the driver's cooler interface (what Afterburner uses), not I2C: no traffic to the card's lighting chip.
// The setting lives in the driver until reboot; it does not persist on the card.
//
// Function ids and struct layouts are the ones LibreHardwareMonitor 0.9.6 uses (ids confirmed as ldc.i4 operands in
// lib/LibreHardwareMonitorLib.dll, layouts read from its NvApi types by reflection, 11-16):
//   ClientFanCoolersGetStatus  0x35AED5E8  NvFanCoolersStatus  = 40-byte header + 32 x 52-byte items (1704)
//   ClientFanCoolersGetControl 0x814B209F  NvFanCoolerControl  = 44-byte header + 32 x 44-byte items (1452)
//   ClientFanCoolersSetControl 0xA58971A5
//   control item: CoolerId, Level (%), ControlMode (0 auto, 1 manual), 8 reserved
// Raw byte buffers keep the layout exact and every reserved field as the driver returned it.
//
// MAX: read the control block, set every cooler to manual 100 %, write, read back.
// AUTO: read the control block, set every cooler's mode to auto (level left as read), write, read back: done only
// when every cooler reports auto. Failure keeps the fans where they are; MAX is the safe side.

using System;
using System.Runtime.InteropServices;

namespace KontrolMerkezi.Donanim;

sealed class GpuFan
{
    const uint IdInitialize = 0x0150E828, IdEnumPhysicalGPUs = 0xE5AC921F, IdGetPciIds = 0x2DDFB66E;
    const uint IdGetStatus = 0x35AED5E8, IdGetControl = 0x814B209F, IdSetControl = 0xA58971A5;
    const int StatusSize = 40 + 32 * 52, ControlSize = 44 + 32 * 44;
    const int StatusItem = 52, ControlItem = 44;

    [DllImport("nvapi64.dll", EntryPoint = "nvapi_QueryInterface", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr QueryInterface(uint id);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int InitFn();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int EnumFn([Out] IntPtr[] handles, out int count);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int PciFn(IntPtr gpu, out uint deviceId, out uint subSystemId, out uint revisionId, out uint extDeviceId);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int BufFn(IntPtr gpu, IntPtr buffer);

    readonly IntPtr _gpu;
    readonly BufFn _getStatus, _getControl, _setControl;

    public uint DeviceId { get; }
    public uint SubSystemId { get; }

    GpuFan(IntPtr gpu, uint dev, uint sub, BufFn st, BufFn gc, BufFn sc)
    {
        _gpu = gpu; DeviceId = dev; SubSystemId = sub; _getStatus = st; _getControl = gc; _setControl = sc;
    }

    static T Fn<T>(uint id) where T : class
    {
        var p = QueryInterface(id);
        if (p == IntPtr.Zero) throw new InvalidOperationException("NvAPI işlevi yok: 0x" + id.ToString("X8"));
        return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
    }

    /// <summary>Open the RTX 4080 (10DE:2704, MSI 1462:5111). Throws with a Turkish reason.</summary>
    public static GpuFan Open()
    {
        int r = Fn<InitFn>(IdInitialize)();
        if (r != 0) throw new InvalidOperationException("NvAPI başlatılamadı (" + r + ")");
        var handles = new IntPtr[64];
        r = Fn<EnumFn>(IdEnumPhysicalGPUs)(handles, out int n);
        if (r != 0 || n < 1) throw new InvalidOperationException("NVIDIA ekran kartı bulunamadı (" + r + ")");
        var pci = Fn<PciFn>(IdGetPciIds);
        for (int i = 0; i < n; i++)
        {
            if (pci(handles[i], out uint dev, out uint sub, out _, out _) != 0) continue;
            // deviceId packs device<<16 | vendor: 0x270410DE for the RTX 4080; subsystem 0x51111462 for MSI's board.
            if (dev == 0x270410DE)
                return new GpuFan(handles[i], dev, sub, Fn<BufFn>(IdGetStatus), Fn<BufFn>(IdGetControl), Fn<BufFn>(IdSetControl));
        }
        throw new InvalidOperationException("RTX 4080 bulunamadı");
    }

    public sealed class Durum
    {
        public int Count;
        public int[] Rpm = Array.Empty<int>();
        public int[] Level = Array.Empty<int>();     // current level %, from status
        public bool[] Manual = Array.Empty<bool>();  // control mode per cooler
        public int[] SetLevel = Array.Empty<int>();  // level in the control block
        public bool AllAuto { get { foreach (var m in Manual) if (m) return false; return Count > 0; } }
        public bool AllMax { get { if (Count == 0) return false; for (int i = 0; i < Count; i++) if (!Manual[i] || SetLevel[i] != 100) return false; return true; } }
        public bool AnyManual { get { foreach (var m in Manual) if (m) return true; return false; } }
    }

    byte[] Call(BufFn fn, int size, byte[] input = null)
    {
        var mem = Marshal.AllocHGlobal(size);
        try
        {
            if (input != null) Marshal.Copy(input, 0, mem, size);
            else
            {
                Marshal.Copy(new byte[size], 0, mem, size);
                Marshal.WriteInt32(mem, 0, size | (1 << 16));   // struct version 1
            }
            int r = fn(_gpu, mem);
            if (r != 0) throw new InvalidOperationException("NvAPI hata kodu " + r);
            var buf = new byte[size];
            Marshal.Copy(mem, buf, 0, size);
            return buf;
        }
        finally { Marshal.FreeHGlobal(mem); }
    }

    // The sensor, fan and shutdown threads all call in: one driver call sequence at a time.
    readonly object _io = new();

    public Durum Oku()
    {
        lock (_io) return OkuKilitli();
    }

    Durum OkuKilitli()
    {
        var st = Call(_getStatus, StatusSize);
        var ct = Call(_getControl, ControlSize);
        int ns = Math.Min(BitConverter.ToInt32(st, 4), 32);
        int nc = Math.Min(BitConverter.ToInt32(ct, 8), 32);
        int n = Math.Min(ns, nc);
        var d = new Durum { Count = n, Rpm = new int[n], Level = new int[n], Manual = new bool[n], SetLevel = new int[n] };
        for (int i = 0; i < n; i++)
        {
            int so = 40 + i * StatusItem, co = 44 + i * ControlItem;
            d.Rpm[i] = BitConverter.ToInt32(st, so + 4);
            d.Level[i] = BitConverter.ToInt32(st, so + 16);
            d.SetLevel[i] = BitConverter.ToInt32(ct, co + 4);
            d.Manual[i] = BitConverter.ToInt32(ct, co + 8) != 0;
        }
        return d;
    }

    /// <summary>Every cooler to manual 100 %.</summary>
    public void Max() => Yaz(manual: true);

    /// <summary>Every cooler back to the card's automatic control.</summary>
    public void Oto() => Yaz(manual: false);

    void Yaz(bool manual)
    {
        lock (_io) YazKilitli(manual);
    }

    void YazKilitli(bool manual)
    {
        var ct = Call(_getControl, ControlSize);
        int n = Math.Min(BitConverter.ToInt32(ct, 8), 32);
        if (n < 1) throw new InvalidOperationException("Fan denetim bloğu boş");
        for (int i = 0; i < n; i++)
        {
            int co = 44 + i * ControlItem;
            if (manual) WriteInt(ct, co + 4, 100);
            WriteInt(ct, co + 8, manual ? 1 : 0);
        }
        Call(_setControl, ControlSize, ct);
    }

    static void WriteInt(byte[] b, int off, int v)
    {
        b[off] = (byte)v; b[off + 1] = (byte)(v >> 8); b[off + 2] = (byte)(v >> 16); b[off + 3] = (byte)(v >> 24);
    }
}
