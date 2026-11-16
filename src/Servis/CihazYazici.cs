// One thread per RGB device. A USB frame write blocks (AIO ~29 ms for 84 LEDs in 12 packets, keyboard ~11 ms), so
// the 30 Hz light loop only hands over its newest frame and never waits; a slow device simply skips stale frames.
// The thread also does the slow opens (AIO ~750 ms) and keeps calling Yaz at least once a second while lit, which
// lets the drivers re-send an unchanged frame as a keep-alive.
//
// "Dark" is never lost: while the device may still be showing our colours (_isLit), an off request keeps trying
// (re-opening the device if it dropped out) until Sondur succeeds. While suspended (sleep) frames are ignored.

using System;
using System.Threading;
using KontrolMerkezi.Rgb;

namespace KontrolMerkezi.Servis;

sealed class CihazYazici : IDisposable
{
    public readonly IRgbCihaz Cihaz;
    readonly Thread _thread;
    readonly AutoResetEvent _signal = new(false);
    readonly ManualResetEventSlim _dark = new(true);
    readonly object _lock = new();
    Rgb.Rgb[] _pending, _spare, _current;
    bool _wantLit, _wantRelease, _suspended, _stop;
    volatile bool _isLit;   // the device may be showing our frames (needs Sondur to go dark)
    DateTime _nextOpenTry = DateTime.MinValue;
    string _lastError;

    public CihazYazici(IRgbCihaz cihaz)
    {
        Cihaz = cihaz;
        _thread = new Thread(Loop) { IsBackground = true, Name = "rgb-" + cihaz.Kimlik, Priority = ThreadPriority.AboveNormal };
        _thread.Start();
    }

    /// <summary>Newest frame from the light loop (copied; the caller may reuse its array). Ignored while suspended.</summary>
    public void Kare(Rgb.Rgb[] frame)
    {
        lock (_lock)
        {
            if (_suspended || _stop) return;
            if (_spare == null || _spare.Length != frame.Length) _spare = new Rgb.Rgb[frame.Length];
            Array.Copy(frame, _spare, frame.Length);
            (_pending, _spare) = (_spare, _pending);
            _wantLit = true;
        }
        _signal.Set();
    }

    /// <summary>Lights off; the handle stays open for the next "on".</summary>
    public void Sondur()
    {
        lock (_lock) { _wantLit = false; _pending = null; }
        _signal.Set();
    }

    /// <summary>For a device that lights up on its own when it gets power (the GPU shows its stored white): treat it as
    /// possibly lit, so the loop opens it and darkens it, retrying until it is dark. Ignored while lights are wanted
    /// (the next frame paints it anyway).</summary>
    public void KaranligaZorla()
    {
        lock (_lock) { if (_wantLit || _suspended || _stop) return; _isLit = true; _dark.Reset(); }
        _signal.Set();
    }

    /// <summary>Sleep: off, close the handle, ignore frames until Uyan. Waits up to the timeout for the device to be dark.</summary>
    public bool Uyu(TimeSpan timeout)
    {
        lock (_lock) { _suspended = true; _wantLit = false; _pending = null; _wantRelease = true; }
        _signal.Set();
        Thread.Sleep(20);
        return _dark.Wait(timeout);
    }

    /// <summary>Wake: accept frames again; the next frame re-opens the device (USB re-enumerates on wake).</summary>
    public void Uyan()
    {
        lock (_lock) _suspended = false;   // handles were released at Uyu; a stale one fails its write and re-opens
        _signal.Set();
    }

    void Loop()
    {
        while (true)
        {
            _signal.WaitOne(_isLit ? 200 : 1000);
            Rgb.Rgb[] frame;
            bool lit, release;
            lock (_lock)
            {
                if (_stop) return;
                lit = _wantLit; release = _wantRelease;
                if (_pending != null) { (_current, _pending) = (_pending, _current); _pending = null; }
                frame = lit ? _current : null;   // keep-alive: Yaz re-sends an unchanged frame once a second
            }
            try
            {
                if (lit && frame != null && !release)
                {
                    if (!Open()) continue;
                    _isLit = true;
                    _dark.Reset();
                    if (!Cihaz.Yaz(frame))
                    {
                        Program.Log("rgb: " + Cihaz.Ad + " yazılamadı: " + Cihaz.Hata);
                        _nextOpenTry = DateTime.UtcNow.AddSeconds(1);
                    }
                    continue;
                }

                if (_isLit)
                {
                    // off (or release): keep trying until the device is really dark
                    if (!Cihaz.Bagli && !Open()) continue;
                    Cihaz.Sondur();
                    if (!Cihaz.Bagli) { _nextOpenTry = DateTime.UtcNow.AddSeconds(1); continue; }
                    _isLit = false;
                }
                if (release)
                {
                    Cihaz.Birak();
                    lock (_lock) _wantRelease = false;
                }
                _dark.Set();
            }
            catch (Exception ex)
            {
                Program.Log("rgb: " + Cihaz.Ad + " hata: " + ex.Message);
            }
        }
    }

    bool Open()
    {
        if (Cihaz.Bagli) return true;
        if (DateTime.UtcNow < _nextOpenTry) return false;
        if (!Cihaz.Ac())
        {
            _nextOpenTry = DateTime.UtcNow.AddSeconds(_isLit ? 1 : 5);
            if (Cihaz.Hata != _lastError) { _lastError = Cihaz.Hata; Program.Log("rgb: " + Cihaz.Ad + " açılamadı: " + Cihaz.Hata); }
            return false;
        }
        Program.Log("rgb: " + Cihaz.Ad + " açıldı");
        _lastError = null;
        return true;
    }

    /// <summary>Stop the thread, then dark and closed synchronously (exit, logoff, crash).</summary>
    public void Dispose()
    {
        lock (_lock) _stop = true;
        _signal.Set();
        _thread.Join(1500);
        try
        {
            if (_isLit)
            {
                if (!Cihaz.Bagli) Cihaz.Ac();
                if (Cihaz.Bagli) Cihaz.Sondur();
            }
        }
        catch { }
        try { Cihaz.Birak(); } catch { }
    }
}
