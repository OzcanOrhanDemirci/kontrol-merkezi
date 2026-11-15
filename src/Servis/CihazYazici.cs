// One thread per RGB device. A USB frame write blocks (AIO ~29 ms for 84 LEDs in 12 packets, keyboard ~11 ms), so
// the 30 Hz light loop only hands over its newest frame and never waits; a slow device simply skips stale frames.
// The thread also does the slow opens (AIO ~750 ms) and keeps calling Yaz at least once a second while lit, which
// lets the drivers re-send an unchanged frame as a keep-alive.

using System;
using System.Threading;
using KontrolMerkezi.Rgb;

namespace KontrolMerkezi.Servis;

sealed class CihazYazici : IDisposable
{
    public readonly IRgbCihaz Cihaz;
    readonly Thread _thread;
    readonly AutoResetEvent _signal = new(false);
    readonly object _lock = new();
    Rgb.Rgb[] _pending, _spare, _current;
    bool _wantLit, _wantRelease, _stop;
    bool _isLit;          // the device is showing our frames (needs Sondur to go dark)
    DateTime _nextOpenTry = DateTime.MinValue;
    string _lastError;

    public CihazYazici(IRgbCihaz cihaz)
    {
        Cihaz = cihaz;
        _thread = new Thread(Loop) { IsBackground = true, Name = "rgb-" + cihaz.Kimlik, Priority = ThreadPriority.AboveNormal };
        _thread.Start();
    }

    /// <summary>Newest frame from the light loop (copied; the caller may reuse its array).</summary>
    public void Kare(Rgb.Rgb[] frame)
    {
        lock (_lock)
        {
            if (_spare == null || _spare.Length != frame.Length) _spare = new Rgb.Rgb[frame.Length];
            Array.Copy(frame, _spare, frame.Length);
            (_pending, _spare) = (_spare, _pending);
            _wantLit = true;
            _wantRelease = false;
        }
        _signal.Set();
    }

    /// <summary>Lights off (once); the handle stays open for the next "on".</summary>
    public void Sondur()
    {
        lock (_lock) { _wantLit = false; _pending = null; }
        _signal.Set();
    }

    /// <summary>Off and close the handle (sleep, or before a re-open after wake).</summary>
    public void Birak()
    {
        lock (_lock) { _wantLit = false; _pending = null; _wantRelease = true; }
        _signal.Set();
    }

    void Loop()
    {
        while (true)
        {
            _signal.WaitOne(1000);
            Rgb.Rgb[] frame;
            bool lit, release;
            lock (_lock)
            {
                if (_stop) return;
                lit = _wantLit; release = _wantRelease;
                frame = _pending; _pending = null;
                if (frame != null) { (_current, frame) = (frame, _current); frame = _current; }
                else if (lit) frame = _current;   // keep-alive: Yaz re-sends an unchanged frame once a second
            }
            try
            {
                if (lit && frame != null)
                {
                    if (!Cihaz.Bagli)
                    {
                        if (DateTime.UtcNow < _nextOpenTry) continue;
                        if (!Cihaz.Ac())
                        {
                            _nextOpenTry = DateTime.UtcNow.AddSeconds(5);
                            if (Cihaz.Hata != _lastError) { _lastError = Cihaz.Hata; Program.Log("rgb: " + Cihaz.Ad + " açılamadı: " + Cihaz.Hata); }
                            continue;
                        }
                        Program.Log("rgb: " + Cihaz.Ad + " açıldı");
                        _lastError = null;
                    }
                    _isLit = true;
                    if (!Cihaz.Yaz(frame))
                    {
                        Program.Log("rgb: " + Cihaz.Ad + " yazılamadı: " + Cihaz.Hata);
                        _nextOpenTry = DateTime.UtcNow.AddSeconds(2);
                    }
                }
                else if (!lit && _isLit)
                {
                    if (Cihaz.Bagli) Cihaz.Sondur();
                    _isLit = false;
                }
                if (release)
                {
                    if (_isLit && Cihaz.Bagli) Cihaz.Sondur();
                    _isLit = false;
                    Cihaz.Birak();
                    lock (_lock) _wantRelease = false;
                }
            }
            catch (Exception ex)
            {
                Program.Log("rgb: " + Cihaz.Ad + " hata: " + ex.Message);
            }
        }
    }

    /// <summary>Stop the thread, then dark and closed synchronously (exit, logoff, crash).</summary>
    public void Dispose()
    {
        lock (_lock) _stop = true;
        _signal.Set();
        _thread.Join(1500);
        try { if (Cihaz.Bagli) Cihaz.Sondur(); } catch { }
        try { Cihaz.Birak(); } catch { }
    }
}
