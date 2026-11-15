// CPU and case fans: Nuvoton NCT6687D embedded controller, MAX <-> BIOS.
//
// Taken over from Fan Anahtarı (C:\dev\fan-toggle\Program.cs, measured end to end on this board 09-30 and 10-27).
// LibreHardwareMonitor 0.9.6's own fan commands (SetSoftware/SetDefault) are deliberately NOT used: its NCT6687D
// restore clears the manual-mode bit only if it was set at the start, so a fan that began under BIOS control stays
// pinned at the saved value instead of returning to the curve. Here each fan's mode bit and duty byte are read
// from the chip and saved before MAX, written back exactly on return, and verified by reading.
//
// Rule: no value that was not read from the chip is ever written. The one new value is 0xFF (100 %). Without a
// saved state the fans stay at 100 % (the safe side); a reboot always returns them to BIOS control.
//
// Register map (LHM 0.9.6 Nct677X.cs): 0xA00 manual-mode bits (bit i -> control i), 0xA01 request handshake
// (0x80 begin, 0x40 end), 0xA28+i manual duty (0-255), 0x160+i live PWM output, 0x140+2k tach (16-bit big endian).

using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using LibreHardwareMonitor.Hardware;

namespace KontrolMerkezi.Donanim;

sealed class FanCipi : IDisposable
{
    public const int ControlCount = 8;
    const ushort ModeReg = 0xA00, RequestReg = 0xA01, CmdBase = 0xA28, PwmOutBase = 0x160, RpmBase = 0x140;
    static readonly string[] FanNames = { "CPU_FAN", "PUMP_FAN", "SYS_FAN1", "SYS_FAN2", "SYS_FAN3", "SYS_FAN4", "SYS_FAN5", "SYS_FAN6" };
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    readonly object _sio;
    readonly MethodInfo _read, _write;
    readonly Mutex _isaBus;

    public string Board { get; }
    public string Chip { get; }

    FanCipi(IHardware board, IHardware sioHw)
    {
        Board = board.Name;
        const BindingFlags priv = BindingFlags.NonPublic | BindingFlags.Instance;
        _sio = sioHw.GetType().GetField("_superIO", priv)?.GetValue(sioHw)
               ?? throw new InvalidOperationException("LHM iç yapısı beklenenden farklı (_superIO yok)");
        var t = _sio.GetType();
        Chip = t.GetProperty("Chip")?.GetValue(_sio)?.ToString() ?? "?";
        _read = t.GetMethod("ReadByte", priv, null, new[] { typeof(ushort) }, null)
                ?? throw new InvalidOperationException("LHM iç yapısı beklenenden farklı (ReadByte yok)");
        _write = t.GetMethod("WriteByte", priv, null, new[] { typeof(ushort), typeof(byte) }, null)
                 ?? throw new InvalidOperationException("LHM iç yapısı beklenenden farklı (WriteByte yok)");
        // The ISA bus lock shared by LHM and other monitoring tools.
        _isaBus = new Mutex(false, @"Global\Access_ISABUS.HTP.Method");
    }

    /// <summary>Open on an LHM Computer that has the motherboard enabled. Throws with a Turkish reason when absent.</summary>
    public static FanCipi Open(Computer computer)
    {
        var board = computer.Hardware.FirstOrDefault(h => h.HardwareType == HardwareType.Motherboard);
        var sio = board?.SubHardware.FirstOrDefault(h => h.HardwareType == HardwareType.SuperIO);
        if (board == null || sio == null)
            throw new InvalidOperationException("Fan denetim çipi bulunamadı (PawnIO sürücüsü ve yönetici yetkisi gerekir).");
        return new FanCipi(board, sio);
    }

    public bool Supported => Chip == "NCT6687D";

    void RequireSupported()
    {
        // The map is verified for this chip only; never write to another.
        if (!Supported) throw new NotSupportedException("Bu çipe yazma desteklenmiyor: " + Chip);
    }

    T Locked<T>(Func<T> f)
    {
        bool got;
        try { got = _isaBus.WaitOne(2000); }
        catch (AbandonedMutexException) { got = true; }
        if (!got) throw new TimeoutException("ISA veri yolu kilidi alınamadı");
        try { return f(); }
        finally { _isaBus.ReleaseMutex(); }
    }

    byte Read(int addr) => (byte)_read.Invoke(_sio, new object[] { (ushort)addr });
    void Write(int addr, byte v) => _write.Invoke(_sio, new object[] { (ushort)addr, v });

    public FanSnap Snapshot() => Locked(() =>
    {
        var s = new FanSnap { Mode = Read(ModeReg), Request = Read(RequestReg) };
        for (int i = 0; i < ControlCount; i++)
        {
            s.Cmd[i] = Read(CmdBase + i);
            s.PwmOut[i] = Read(PwmOutBase + i);
        }
        for (int k = 0; k < FanSnap.RpmCount; k++)
            s.Rpm[k] = (Read(RpmBase + 2 * k) << 8) | Read(RpmBase + 2 * k + 1);
        return s;
    });

    /// <summary>Every control to manual mode with duty 0xFF (LHM SetControl order).</summary>
    public void ApplyMax()
    {
        RequireSupported();
        for (int i = 0; i < ControlCount; i++)
        {
            int idx = i;
            Locked(() =>
            {
                Write(RequestReg, 0x80);
                Thread.Sleep(50);
                byte mode = Read(ModeReg);
                Write(ModeReg, (byte)(mode | (1 << idx)));
                Write(CmdBase + idx, 0xFF);
                Write(RequestReg, 0x40);
                Thread.Sleep(50);
                return 0;
            });
        }
    }

    /// <summary>Each control's mode bit and duty back to the saved state.</summary>
    public void Restore(FanSnap saved)
    {
        RequireSupported();
        for (int i = 0; i < ControlCount; i++)
        {
            int idx = i;
            Locked(() =>
            {
                byte bit = (byte)(1 << idx);
                Write(RequestReg, 0x80);
                Thread.Sleep(50);
                Write(CmdBase + idx, saved.Cmd[idx]);
                byte mode = Read(ModeReg);
                Write(ModeReg, (byte)((mode & ~bit) | (saved.Mode & bit)));
                Write(RequestReg, 0x40);
                Thread.Sleep(50);
                return 0;
            });
        }
    }

    public static string FanName(int k) => k < FanNames.Length ? FanNames[k] : "FAN" + k;

    public void Dispose() => _isaBus.Dispose();

    // ---------------------------------------------------------------- saved BIOS state

    /// <summary>The saved state lives next to the installed exe (Program Files: only an administrator can change what
    /// the elevated service will write back to the chip); a development run falls back to the data folder.</summary>
    public static string StatePath
    {
        get
        {
            var dir = Program.AppDir;
            try
            {
                var probe = Path.Combine(dir, ".yazma-denemesi");
                File.WriteAllText(probe, "");
                File.Delete(probe);
            }
            catch { dir = Program.DataDir; }
            return Path.Combine(dir, "bios-durumu.txt");
        }
    }

    // Fan Anahtarı's own saved state (same format), read only: if it switched the fans to MAX, its file holds the
    // BIOS bytes it read from the chip just before.
    const string FanAnahtariState = @"C:\Program Files\FanToggle\bios-durumu.txt";

    public static void SaveState(FanSnap s)
    {
        var path = StatePath;
        var text = "# Kontrol Merkezi: MAX'tan hemen önce çipten okunan BIOS durumu. Elle değiştirmeyin.\r\n"
                 + "zaman=" + DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss", Inv) + "\r\n"
                 + "kip=" + s.Mode.ToString("X2", Inv) + "\r\n"
                 + "gorev=" + string.Join(" ", s.Cmd.Select(b => b.ToString("X2", Inv))) + "\r\n";
        var tmp = path + ".yeni";
        File.WriteAllText(tmp, text, new UTF8Encoding(false));
        if (File.Exists(path)) File.Delete(path);
        File.Move(tmp, path);
    }

    public static FanSnap LoadState(out string source)
    {
        source = StatePath;
        var s = LoadFrom(source);
        if (s != null) return s;
        if (File.Exists(FanAnahtariState))
        {
            s = LoadFrom(FanAnahtariState);
            if (s != null) { source = FanAnahtariState; return s; }
        }
        return null;
    }

    static FanSnap LoadFrom(string path)
    {
        if (!File.Exists(path)) return null;
        try
        {
            byte? mode = null;
            byte[] cmd = null;
            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.StartsWith("kip=", StringComparison.Ordinal))
                    mode = byte.Parse(line.Substring(4), NumberStyles.HexNumber, Inv);
                else if (line.StartsWith("gorev=", StringComparison.Ordinal))
                    cmd = line.Substring(6).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)
                              .Select(h => byte.Parse(h, NumberStyles.HexNumber, Inv)).ToArray();
            }
            if (mode == null || cmd == null || cmd.Length != ControlCount) return null;
            var s = new FanSnap { Mode = mode.Value };
            Array.Copy(cmd, s.Cmd, cmd.Length);
            // A saved state that itself looks like MAX is useless to write back.
            return s.IsMax ? null : s;
        }
        catch (Exception ex)
        {
            Program.Log("fan: kayıt okunamadı (" + path + "): " + ex.Message);
            return null;
        }
    }

    public static void ArchiveState()
    {
        var path = StatePath;
        var old = Path.Combine(Path.GetDirectoryName(path), "bios-durumu.onceki.txt");
        if (File.Exists(old)) File.Delete(old);
        if (File.Exists(path)) File.Move(path, old);
    }
}

sealed class FanSnap
{
    public const int RpmCount = 16;
    public byte Mode, Request;
    public readonly byte[] Cmd = new byte[FanCipi.ControlCount];
    public readonly byte[] PwmOut = new byte[FanCipi.ControlCount];
    public readonly int[] Rpm = new int[RpmCount];

    public bool IsMax
    {
        get
        {
            for (int i = 0; i < FanCipi.ControlCount; i++)
                if ((Mode & (1 << i)) == 0 || Cmd[i] != 0xFF) return false;
            return true;
        }
    }

    /// <summary>Mode byte exactly; the duty byte only matters for controls in manual mode.</summary>
    public bool MatchesSaved(FanSnap saved)
    {
        if (Mode != saved.Mode) return false;
        for (int i = 0; i < FanCipi.ControlCount; i++)
            if ((saved.Mode & (1 << i)) != 0 && Cmd[i] != saved.Cmd[i]) return false;
        return true;
    }

    public string RegText() =>
        "kip=" + Mode.ToString("X2", CultureInfo.InvariantCulture) + " istek=" + Request.ToString("X2", CultureInfo.InvariantCulture)
        + " görev=[" + string.Join(" ", Cmd.Select(b => b.ToString("X2", CultureInfo.InvariantCulture))) + "]";

    public string PwmText() => "[" + string.Join(" ", PwmOut.Select(b => b.ToString("X2", CultureInfo.InvariantCulture))) + "]";

    public string RpmText() => string.Join(" ", Rpm.Select((r, k) => r == 0 ? null : FanCipi.FanName(k) + "=" + r).Where(x => x != null));

    public override string ToString() => RegText() + " pwm=" + PwmText() + " devir: " + RpmText();
}
