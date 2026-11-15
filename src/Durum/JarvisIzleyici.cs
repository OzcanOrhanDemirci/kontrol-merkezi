// Jarvis's state for the lights: only the background session named "jarvis" (cwd C:\dev\jarvis) counts.
//
// Two sources, newest wins:
//  - `claude agents --json` every few seconds: is the session listed (alive), busy or idle, its sessionId.
//  - jarvis.json, written by araclar/jarvis-kanca.mjs from Jarvis's Claude Code hooks: prompt submitted, turn
//    stopped (and whether the last message asks Özcan something), notification, session start/end. Hook events
//    from any other session (a plain window opened in C:\dev\jarvis) are ignored by sessionId.
//
// Closed vs restarting: the \Jarvis\KeepAlive task reopens a missing Jarvis within five minutes, so for six
// minutes after Jarvis was last seen (or after this service started, e.g. at logon) a missing Jarvis is
// "restarting"; after that, or with the task disabled, it is "closed".

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using KontrolMerkezi.Isik;

namespace KontrolMerkezi.Durum;

sealed class JarvisIzleyici : IDisposable
{
    static readonly TimeSpan RestartWindow = TimeSpan.FromMinutes(6);
    public static string HookFile => Path.Combine(Program.DataDir, "jarvis.json");

    readonly Thread _thread;
    readonly FileSystemWatcher _watch;
    readonly DateTime _start = DateTime.UtcNow;
    volatile bool _stop;
    readonly object _lock = new();

    // poll
    bool _alive, _busy, _failed, _pollOk;
    string _sessionId;
    DateTime _lastSeen = DateTime.MinValue, _pollAt = DateTime.MinValue;
    // hook
    string _hookEvent, _hookSession;
    bool _hookQuestion;
    DateTime _hookAt = DateTime.MinValue;

    public event Action Degisti;
    public JarvisDurum Durum { get; private set; } = JarvisDurum.Yok;

    public JarvisIzleyici()
    {
        ReadHook();
        try
        {
            _watch = new FileSystemWatcher(Program.DataDir, "jarvis.json") { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName };
            _watch.Changed += (_, _) => OnHook();
            _watch.Created += (_, _) => OnHook();
            _watch.Renamed += (_, _) => OnHook();
            _watch.EnableRaisingEvents = true;
        }
        catch (Exception ex) { Program.Log("jarvis: dosya izlenemiyor: " + ex.Message); }
        _thread = new Thread(Loop) { IsBackground = true, Name = "jarvis", Priority = ThreadPriority.BelowNormal };
        _thread.Start();
    }

    void OnHook()
    {
        Thread.Sleep(30);   // the hook writes via rename; let it land
        ReadHook();
        Evaluate();
    }

    void ReadHook()
    {
        try
        {
            if (!File.Exists(HookFile)) return;
            string text;
            using (var fs = new FileStream(HookFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var sr = new StreamReader(fs, Encoding.UTF8)) text = sr.ReadToEnd();
            var d = Json.Parse(text);
            if (d == null) return;
            lock (_lock)
            {
                _hookEvent = Json.S(d, "olay");
                _hookSession = Json.S(d, "oturum");
                _hookQuestion = Json.B(d, "soru") == true;
                _hookAt = d.TryGetValue("zaman", out var z) ? DateTimeOffset.FromUnixTimeMilliseconds(Convert.ToInt64(z)).UtcDateTime : File.GetLastWriteTimeUtc(HookFile);
            }
        }
        catch { /* half-written file: the next change event reads it */ }
    }

    void Loop()
    {
        while (!_stop)
        {
            Poll();
            Evaluate();
            for (int i = 0; i < 40 && !_stop; i++) Thread.Sleep(100);
        }
    }

    static string ClaudeExe()
    {
        var local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "bin", "claude.exe");
        return File.Exists(local) ? local : "claude";
    }

    void Poll()
    {
        try
        {
            var psi = new ProcessStartInfo(ClaudeExe(), "agents --json")
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
                CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8,
            };
            psi.EnvironmentVariables.Remove("CLAUDE_CONFIG_DIR");
            using var p = Process.Start(psi);
            var outTask = p.StandardOutput.ReadToEndAsync();
            p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(15000)) { try { p.Kill(); } catch { } throw new TimeoutException("claude agents yanıt vermedi"); }
            var text = outTask.Result;
            int i = text.IndexOf('[');
            if (i < 0) throw new FormatException("liste yok");
            var list = new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(text.Substring(i)) as IEnumerable;
            Dictionary<string, object> row = null;
            foreach (var o in list ?? Array.Empty<object>())
                if (o is Dictionary<string, object> r && Json.S(r, "kind") == "background" && Json.S(r, "name") == "jarvis") row = r;
            lock (_lock)
            {
                _pollOk = true;
                _pollAt = DateTime.UtcNow;
                _alive = row != null;
                if (row != null)
                {
                    _lastSeen = DateTime.UtcNow;
                    _busy = Json.S(row, "status") == "busy";
                    var state = Json.S(row, "state") ?? "";
                    _failed = state.IndexOf("fail", StringComparison.OrdinalIgnoreCase) >= 0;
                    _sessionId = Json.S(row, "sessionId");
                }
            }
        }
        catch (Exception ex)
        {
            lock (_lock) _pollOk = false;
            Program.Log("jarvis: oturum listesi okunamadı: " + ex.Message);
        }
    }

    static bool KeepAliveEnabled()
    {
        try
        {
            dynamic svc = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
            svc.Connect();
            dynamic task = svc.GetFolder("\\Jarvis").GetTask("KeepAlive");
            return (bool)task.Enabled;
        }
        catch { return false; }
    }

    void Evaluate()
    {
        JarvisDurum d;
        lock (_lock)
        {
            if (!_pollOk && _pollAt == DateTime.MinValue) d = JarvisDurum.Yok;
            else if (!_alive || _failed)
            {
                var since = _lastSeen > _start ? _lastSeen : _start;
                d = !_failed && DateTime.UtcNow - since < RestartWindow && KeepAliveEnabled() ? JarvisDurum.Yeniden : JarvisDurum.Kapali;
            }
            else
            {
                bool hookOurs = _hookSession != null && _hookSession == _sessionId;
                bool hookNewer = hookOurs && _hookAt > _pollAt;
                if (hookNewer && _hookEvent == "istem") d = JarvisDurum.Dusunuyor;
                else if (hookNewer && (_hookEvent == "durdu" || _hookEvent == "bildirim"))
                    d = _hookEvent == "bildirim" || _hookQuestion ? JarvisDurum.Bekliyor : JarvisDurum.Hazir;
                else if (_busy) d = JarvisDurum.Dusunuyor;
                else if (hookOurs && (_hookEvent == "bildirim" || (_hookEvent == "durdu" && _hookQuestion))) d = JarvisDurum.Bekliyor;
                else d = JarvisDurum.Hazir;
            }
        }
        if (d != Durum)
        {
            Program.Log("jarvis: " + Durum + " -> " + d);
            Durum = d;
            Degisti?.Invoke();
        }
    }

    public void Dispose()
    {
        _stop = true;
        _watch?.Dispose();
    }
}
