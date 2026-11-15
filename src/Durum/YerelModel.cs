// "The local AI model is generating an answer": a process of LM Studio's family is using the GPU's shader cores.
// A loaded but idle model holds memory and uses no SM time, so loaded-but-waiting does not count.
// Source: NVML per-process SM utilisation, sampled by the sensor thread.

using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace KontrolMerkezi.Durum;

sealed class YerelModel
{
    const int OnSmPercent = 10;
    static readonly TimeSpan OnAfter = TimeSpan.FromSeconds(0.9), OffAfter = TimeSpan.FromSeconds(2.5);

    readonly Dictionary<int, (string name, DateTime at)> _names = new();
    DateTime _activeSince = DateTime.MinValue, _lastActive = DateTime.MinValue;

    public bool Uretiyor { get; private set; }
    public string SonSurec { get; private set; }

    static bool IsModelProcess(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        var n = name.ToLowerInvariant();
        return n.Contains("lm studio") || n.Contains("lmstudio") || n.Contains("lm-studio") || n == "lms"
               || n.Contains("llama") || n.Contains("llmworker") || n.Contains("ollama");
    }

    string NameOf(int pid)
    {
        if (_names.TryGetValue(pid, out var e) && DateTime.UtcNow - e.at < TimeSpan.FromMinutes(5)) return e.name;
        string name = null;
        try { using var p = Process.GetProcessById(pid); name = p.ProcessName; } catch { }
        _names[pid] = (name, DateTime.UtcNow);
        return name;
    }

    /// <summary>Feed one NVML sample (pid -> SM %). Returns true when the state changed.</summary>
    public bool Besle(Dictionary<int, int> usage)
    {
        bool active = false;
        foreach (var kv in usage)
        {
            if (kv.Value < OnSmPercent) continue;
            var name = NameOf(kv.Key);
            if (IsModelProcess(name)) { active = true; SonSurec = name; break; }
        }
        var now = DateTime.UtcNow;
        if (active)
        {
            if (_activeSince == DateTime.MinValue) _activeSince = now;
            _lastActive = now;
        }
        else if (now - _lastActive > OffAfter) _activeSince = DateTime.MinValue;

        bool next = Uretiyor ? now - _lastActive <= OffAfter : active && now - _activeSince >= OnAfter;
        if (next == Uretiyor) return false;
        Uretiyor = next;
        Program.Log("yerel model: " + (next ? "üretiyor (" + SonSurec + ")" : "durdu"));
        return true;
    }
}
