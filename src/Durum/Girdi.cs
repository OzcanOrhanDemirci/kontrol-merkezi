// When did Özcan last touch the mouse or keyboard? Low-level input hooks on the service's window thread see every
// input in his session; events flagged as injected (SendInput from scripts, our own test tools, remote-input
// software) are ignored, so background work and automation never count as him being at the desk.
// GetLastInputInfo is not used: it counts injected input too.

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace KontrolMerkezi.Durum;

static class KullaniciGirdisi
{
    const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
    const uint LLKHF_INJECTED = 0x10, LLMHF_INJECTED = 0x01;

    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    static HookProc _kb, _ms;   // kept referenced: the hooks call them for the process lifetime
    static IntPtr _hKb, _hMs;
    static long _lastTicks = Environment.TickCount;

    /// <summary>Time since the last real (not injected) mouse or keyboard input.</summary>
    public static TimeSpan Bosta => TimeSpan.FromMilliseconds(unchecked(Environment.TickCount - (int)System.Threading.Interlocked.Read(ref _lastTicks)));

    /// <summary>Install on a thread that runs a message loop (the service's hidden window thread).</summary>
    public static void Kur()
    {
        if (_hKb != IntPtr.Zero) return;
        _kb = (code, w, l) =>
        {
            if (code >= 0 && (Marshal.ReadInt32(l, 8) & LLKHF_INJECTED) == 0) Touch();   // KBDLLHOOKSTRUCT.flags
            return CallNextHookEx(IntPtr.Zero, code, w, l);
        };
        _ms = (code, w, l) =>
        {
            if (code >= 0 && (Marshal.ReadInt32(l, 12) & LLMHF_INJECTED) == 0) Touch();   // MSLLHOOKSTRUCT.flags
            return CallNextHookEx(IntPtr.Zero, code, w, l);
        };
        var mod = GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName);
        _hKb = SetWindowsHookEx(WH_KEYBOARD_LL, _kb, mod, 0);
        _hMs = SetWindowsHookEx(WH_MOUSE_LL, _ms, mod, 0);
        Program.Log("girdi izleme: klavye kancası " + (_hKb != IntPtr.Zero) + ", fare kancası " + (_hMs != IntPtr.Zero));
    }

    static void Touch() => System.Threading.Interlocked.Exchange(ref _lastTicks, Environment.TickCount);

    public static void Kaldir()
    {
        if (_hKb != IntPtr.Zero) UnhookWindowsHookEx(_hKb);
        if (_hMs != IntPtr.Zero) UnhookWindowsHookEx(_hMs);
        _hKb = _hMs = IntPtr.Zero;
    }

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
}
