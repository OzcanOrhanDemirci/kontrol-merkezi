// Named pipe between the service and its clients (the window, test tools). One JSON object per line, both ways.
// The service may run elevated while the window does not: the pipe's DACL names the logged-on user explicitly.

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace KontrolMerkezi.Servis;

sealed class BoruSunucu : IDisposable
{
    public const string Name = "KontrolMerkezi";

    sealed class Istemci
    {
        public NamedPipeServerStream Pipe;
        public StreamWriter Writer;
        public readonly object Lock = new();
    }

    readonly List<Istemci> _clients = new();
    readonly Action<string> _onLine;
    readonly Func<string> _hello;
    volatile bool _stop;

    public int Count { get { lock (_clients) return _clients.Count; } }

    public BoruSunucu(Action<string> onLine, Func<string> hello)
    {
        _onLine = onLine;
        _hello = hello;
        new Thread(AcceptLoop) { IsBackground = true, Name = "boru" }.Start();
    }

    static PipeSecurity Security()
    {
        var ps = new PipeSecurity();
        var user = WindowsIdentity.GetCurrent().User;
        ps.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
        ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        return ps;
    }

    void AcceptLoop()
    {
        while (!_stop)
        {
            NamedPipeServerStream pipe = null;
            try
            {
                pipe = new NamedPipeServerStream(Name, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 1 << 16, 1 << 16, Security());
                pipe.WaitForConnection();
                var c = new Istemci { Pipe = pipe, Writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = false, NewLine = "\n" } };
                lock (_clients) _clients.Add(c);
                Send(c, _hello());
                new Thread(() => ReadLoop(c)) { IsBackground = true, Name = "boru-oku" }.Start();
            }
            catch (Exception ex)
            {
                pipe?.Dispose();
                if (_stop) return;
                Program.Log("boru: bağlantı kabul edilemedi: " + ex.Message);
                Thread.Sleep(1000);
            }
        }
    }

    void ReadLoop(Istemci c)
    {
        try
        {
            using var reader = new StreamReader(c.Pipe, Encoding.UTF8);
            string line;
            while (!_stop && (line = reader.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                try { _onLine(line); }
                catch (Exception ex) { Program.Log("boru: komut işlenemedi: " + ex.Message); }
            }
        }
        catch { }
        Drop(c);
    }

    void Drop(Istemci c)
    {
        lock (_clients) _clients.Remove(c);
        try { c.Pipe.Dispose(); } catch { }
    }

    static bool Send(Istemci c, string line)
    {
        lock (c.Lock)
        {
            try
            {
                c.Writer.Write(line);
                c.Writer.Write('\n');
                c.Writer.Flush();
                return true;
            }
            catch { return false; }
        }
    }

    public void Broadcast(string line)
    {
        Istemci[] list;
        lock (_clients) list = _clients.ToArray();
        foreach (var c in list)
            if (!Send(c, line)) Drop(c);
    }

    public void Dispose()
    {
        _stop = true;
        Istemci[] list;
        lock (_clients) list = _clients.ToArray();
        foreach (var c in list) Drop(c);
        // unblock WaitForConnection
        try { using var dummy = new NamedPipeClientStream(".", Name, PipeDirection.InOut); dummy.Connect(200); } catch { }
    }
}
