// GPU temperature, load and per-process GPU use through NVML (nvml.dll from the driver, documented API, read only).

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace KontrolMerkezi.Donanim;

sealed class Nvml
{
    const string Dll = "nvml.dll";
    [DllImport(Dll)] static extern int nvmlInit_v2();
    [DllImport(Dll)] static extern int nvmlDeviceGetHandleByIndex_v2(uint index, out IntPtr device);
    [DllImport(Dll)] static extern int nvmlDeviceGetTemperature(IntPtr device, int sensor, out uint temp);
    [DllImport(Dll)] static extern int nvmlDeviceGetUtilizationRates(IntPtr device, out Utilization u);
    [DllImport(Dll)] static extern int nvmlDeviceGetProcessUtilization(IntPtr device, [Out] ProcessSample[] samples, ref uint count, ulong lastSeenTimeStamp);
    [DllImport(Dll)] static extern int nvmlDeviceGetFanSpeed(IntPtr device, out uint speed);

    [StructLayout(LayoutKind.Sequential)] struct Utilization { public uint Gpu, Memory; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessSample { public uint Pid; public ulong TimeStamp; public uint SmUtil, MemUtil, EncUtil, DecUtil; }

    const int NVML_SUCCESS = 0, NVML_ERROR_INSUFFICIENT_SIZE = 7, NVML_ERROR_NOT_FOUND = 6;

    readonly IntPtr _dev;
    ulong _lastTs;
    readonly ProcessSample[] _buf = new ProcessSample[256];

    Nvml(IntPtr dev) { _dev = dev; }

    public static Nvml Open()
    {
        int r = nvmlInit_v2();
        if (r != NVML_SUCCESS) throw new InvalidOperationException("NVML başlatılamadı (" + r + ")");
        r = nvmlDeviceGetHandleByIndex_v2(0, out var dev);
        if (r != NVML_SUCCESS) throw new InvalidOperationException("NVML aygıtı yok (" + r + ")");
        return new Nvml(dev);
    }

    public double? Sicaklik() => nvmlDeviceGetTemperature(_dev, 0, out uint t) == NVML_SUCCESS ? t : null;

    public double? Yuk() => nvmlDeviceGetUtilizationRates(_dev, out var u) == NVML_SUCCESS ? u.Gpu : null;

    public double? FanYuzde() => nvmlDeviceGetFanSpeed(_dev, out uint s) == NVML_SUCCESS ? s : null;

    /// <summary>SM use per process since the previous call (pid -> %). Empty when nothing ran on the GPU.</summary>
    public Dictionary<int, int> SurecKullanimi()
    {
        var map = new Dictionary<int, int>();
        uint n = (uint)_buf.Length;
        int r = nvmlDeviceGetProcessUtilization(_dev, _buf, ref n, _lastTs);
        if (r == NVML_SUCCESS)
        {
            for (int i = 0; i < n; i++)
            {
                var s = _buf[i];
                if (s.TimeStamp > _lastTs) _lastTs = s.TimeStamp;
                map[(int)s.Pid] = map.TryGetValue((int)s.Pid, out var v) ? Math.Max(v, (int)s.SmUtil) : (int)s.SmUtil;
            }
        }
        return map;   // NOT_FOUND = no samples in the window: nothing used the GPU
    }
}
