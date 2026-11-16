// The window: borderless WebView2 host for ui/index.html, unelevated, holds no hardware.
// It connects to the service's pipe and forwards messages both ways; if the service is not running it asks the
// scheduled task to start it (COM, no UAC prompt, the way Fan Anahtarı triggers its task).
// Window chrome handling (frameless with snap and shadow, drag, resize edges) follows Fan Anahtarı's Ui.cs.

using System;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace KontrolMerkezi.Pencere;

static class PencereUygulamasi
{
    public const string MutexName = @"Local\KontrolMerkezi.Pencere";
    public const string TaskName = "KontrolMerkezi";
    const string Title = "Kontrol Merkezi";

    public static int Run()
    {
        using var single = new Mutex(true, MutexName, out bool fresh);
        if (!fresh) { ActivateExisting(); return 0; }
        Application.EnableVisualStyles();
        Application.Run(new PencereForm());
        return 0;
    }

    static void ActivateExisting()
    {
        var h = FindWindow(null, Title);
        if (h == IntPtr.Zero) return;
        if (IsIconic(h)) ShowWindow(h, 9);
        SetForegroundWindow(h);
    }

    /// <summary>Start the service through its scheduled task. False when the task is not installed.</summary>
    public static bool StartTask(out string error)
    {
        error = null;
        try
        {
            dynamic svc = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
            svc.Connect();
            dynamic task = svc.GetFolder("\\").GetTask(TaskName);
            task.Run(null);
            return true;
        }
        catch (Exception ex) { error = ex.Message; return false; }
    }

    sealed class PencereForm : Form
    {
        const string HostName = "kontrol.app";
        const string PackHost = "sahne.kontrol.app";
        const int WM_NCCALCSIZE = 0x83, WM_NCHITTEST = 0x84;
        const uint WM_NCLBUTTONDOWN = 0xA1;
        const int HTCLIENT = 1, HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;

        WebView2 _wv;
        bool _pageReady;
        Thread _pipeThread;
        volatile bool _closing;
        NamedPipeClientStream _pipe;
        StreamWriter _writer;
        readonly object _writeLock = new();
        string _lastConn;

        public PencereForm()
        {
            Text = Title;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.Black;
            var wa = Screen.FromPoint(Cursor.Position).WorkingArea;
            int h = (int)(wa.Height * 0.80), w = (int)(h * 1.6);
            if (w > wa.Width * 0.92) { w = (int)(wa.Width * 0.92); h = (int)(w / 1.6); }
            Bounds = new Rectangle(wa.Left + (wa.Width - w) / 2, wa.Top + (wa.Height - h) / 2, w, h);
            MinimumSize = new Size(Math.Min(900, w), Math.Min(560, h));
            Padding = new Padding(LogicalToDeviceUnits(5));
            if (Denetim)
            {
                // the check beside someone at work: a 1280x720 page in the work area's bottom-right corner
                int pad = LogicalToDeviceUnits(5);
                Size sz = new Size(1280 + 2 * pad, 720 + 2 * pad);
                MinimumSize = sz;
                Bounds = new Rectangle(wa.Right - sz.Width, wa.Bottom - sz.Height, sz.Width, sz.Height);
            }
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            Load += OnLoadAsync;
            Activated += (_, _) => PostVis();
            Deactivate += (_, _) => PostVis();
            Resize += (_, _) => PostVis();
        }

        // Development only: the real-window check (araclar/salon-denetim.ps1 -Pencereli) sets KM_DENETIM=1 for the
        // window it starts. The window then never takes the focus, sits small in a corner and opens a local DevTools
        // port (KM_DENETIM_PORT, default 9333) through which the script moves the camera and reads the page's log.
        // The installed product never sets the variable.
        static readonly bool Denetim = Environment.GetEnvironmentVariable("KM_DENETIM") == "1";
        protected override bool ShowWithoutActivation => Denetim;

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.Style |= 0x40000 | 0x10000 | 0x20000; // WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            switch (m.Msg)
            {
                case WM_NCCALCSIZE when m.WParam != IntPtr.Zero:
                    // No frame. Maximized, Windows places the window so its (now invisible) resize border hangs off
                    // the screen; make the client rect exactly the monitor's work area so nothing is cut at the edges.
                    if (IsZoomed(Handle))
                    {
                        var mi = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
                        if (GetMonitorInfo(MonitorFromWindow(Handle, 2), ref mi))
                            Marshal.StructureToPtr(mi.rcWork, m.LParam, false);
                    }
                    m.Result = IntPtr.Zero;
                    return;
                case WM_NCHITTEST when WindowState != FormWindowState.Maximized:
                    var ht = HitTest(m.LParam);
                    if (ht != HTCLIENT) { m.Result = (IntPtr)ht; return; }
                    break;
            }
            base.WndProc(ref m);
        }

        int HitTest(IntPtr lParam)
        {
            var p = PointToClient(new Point((short)lParam, (short)((long)lParam >> 16)));
            int b = LogicalToDeviceUnits(8);
            bool left = p.X < b, right = p.X > ClientSize.Width - b, top = p.Y < b, bottom = p.Y > ClientSize.Height - b;
            if (top && left) return HTTOPLEFT;
            if (top && right) return HTTOPRIGHT;
            if (bottom && left) return HTBOTTOMLEFT;
            if (bottom && right) return HTBOTTOMRIGHT;
            if (left) return HTLEFT;
            if (right) return HTRIGHT;
            if (top) return HTTOP;
            if (bottom) return HTBOTTOM;
            return HTCLIENT;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            int on = 1, round = 2;
            DwmSetWindowAttribute(Handle, 20, ref on, sizeof(int));
            DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int));
        }

        async void OnLoadAsync(object sender, EventArgs e)
        {
            try
            {
                _wv = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
                Controls.Add(_wv);
                string uiDir = PrepareUi();
                var dataDir = Path.Combine(Program.DataDir, Denetim ? "WebView2-denetim" : "WebView2");
                var args = "--autoplay-policy=no-user-gesture-required";
                // the check's window keeps drawing while other windows cover it (it is never in front)
                if (Denetim) args += " --remote-debugging-port=" + (Environment.GetEnvironmentVariable("KM_DENETIM_PORT") ?? "9333") +
                                     " --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling";
                var opts = new CoreWebView2EnvironmentOptions(args);
                var env = await CoreWebView2Environment.CreateAsync(null, dataDir, opts);
                await _wv.EnsureCoreWebView2Async(env);
                var core = _wv.CoreWebView2;
                var s = core.Settings;
                s.AreDefaultContextMenusEnabled = false;
                s.IsStatusBarEnabled = false;
                s.AreBrowserAcceleratorKeysEnabled = false;
                s.IsZoomControlEnabled = false;
                s.IsPinchZoomEnabled = false;
                s.AreDevToolsEnabled = Denetim;
                s.AreDefaultScriptDialogsEnabled = false;
                s.IsSwipeNavigationEnabled = false;
                s.IsGeneralAutofillEnabled = false;
                // One handler serves the whole origin: ui\ and, under /sahne/, the hall's data pack (light maps, volumes,
                // geometry; docs/SALON.md), next to the exe when installed, the repository's sahne/paket in development.
                // Not SetVirtualHostNameToFolderMapping: requests to a mapped host never reach WebResourceRequested, so
                // the pack under it failed with "Failed to fetch" (first real-window run, 11-16); a second host would
                // be cross-origin for fetch and WebGL.
                _uiDir = uiDir;
                _pack = FindPack();
                if (_pack == null) Program.Log("pencere: sahne paketi bulunamadı (sahne/sahne.json)");
                core.AddWebResourceRequestedFilter("https://" + HostName + "/*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += OnRequest;
                core.WebMessageReceived += OnWebMessage;
                core.ProcessFailed += (_, ev) =>
                {
                    // a crashed renderer would leave a black window: log it and load the page again
                    Program.Log("pencere: WebView2 süreci düştü (" + ev.ProcessFailedKind + "), sayfa yeniden yükleniyor");
                    _pageReady = false;
                    try { BeginInvoke((Action)(() => { try { _wv.CoreWebView2.Reload(); } catch { } })); } catch { }
                };
                core.Navigate("https://" + HostName + "/index.html");
            }
            catch (Exception ex)
            {
                Program.Log("pencere: WebView2 yüklenemedi: " + ex);
                MessageBox.Show(this, "Arayüz yüklenemedi: " + ex.Message + "\n\nMicrosoft Edge WebView2 çalışma zamanı kurulu mu?",
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        string _pack, _uiDir;

        void OnRequest(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            try
            {
                var env = _wv.CoreWebView2.Environment;
                var path = Uri.UnescapeDataString(new Uri(e.Request.Uri).AbsolutePath);
                bool inPack = path.StartsWith("/sahne/", StringComparison.Ordinal);
                var root = inPack ? _pack : _uiDir;
                var rel = (inPack ? path.Substring("/sahne/".Length) : path.TrimStart('/')).Replace('/', Path.DirectorySeparatorChar);
                var full = root == null ? null : Path.GetFullPath(Path.Combine(root, rel));
                if (full == null || !full.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
                {
                    e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
                    return;
                }
                var fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16, FileOptions.SequentialScan);
                e.Response = env.CreateWebResourceResponse(fs, 200, "OK", "Content-Type: " + ContentType(full) + "\r\nContent-Length: " + fs.Length);
            }
            catch (Exception ex) { Program.Log("pencere: dosya okunamadı: " + ex.Message); }
        }

        static string ContentType(string file)
        {
            switch (Path.GetExtension(file).ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": return "application/json";
                case ".woff2": return "font/woff2";
                case ".png": return "image/png";
                case ".jpg": return "image/jpeg";
                case ".svg": return "image/svg+xml";
                case ".frag": case ".vert": case ".glsl": case ".txt": return "text/plain; charset=utf-8";
                default: return "application/octet-stream";
            }
        }

        static string FindPack()
        {
            var installed = Path.Combine(Program.AppDir, "sahne");
            if (File.Exists(Path.Combine(installed, "sahne.json"))) return installed;
            for (var d = new DirectoryInfo(Program.AppDir); d != null; d = d.Parent)
            {
                var dev = Path.Combine(d.FullName, "sahne", "paket");
                if (File.Exists(Path.Combine(dev, "sahne.json"))) return dev;
            }
            return null;
        }

        /// <summary>ui\ next to the exe in development; otherwise the embedded copy extracted to the data folder.</summary>
        static string PrepareUi()
        {
            var devDir = Path.Combine(Program.AppDir, "ui");
            if (File.Exists(Path.Combine(devDir, "index.html"))) return devDir;
            var dir = Path.Combine(Program.DataDir, "ui");
            var asm = typeof(PencereUygulamasi).Assembly;
            int n = 0;
            foreach (var name in asm.GetManifestResourceNames())
            {
                if (!name.StartsWith("ui/", StringComparison.Ordinal)) continue;
                var rel = name.Substring(3).Replace('\\', '/');
                var dst = Path.Combine(dir, rel.Replace('/', Path.DirectorySeparatorChar));
                using var rs = asm.GetManifestResourceStream(name);
                using var ms = new MemoryStream();
                rs.CopyTo(ms);
                var bytes = ms.ToArray();
                Directory.CreateDirectory(Path.GetDirectoryName(dst));
                if (!File.Exists(dst) || !File.ReadAllBytes(dst).SequenceEqual(bytes)) File.WriteAllBytes(dst, bytes);
                n++;
            }
            if (n == 0) throw new InvalidOperationException("ui/ gömülü kaynakları yok");
            return dir;
        }

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); }
            catch { try { msg = e.WebMessageAsJson; } catch { return; } }
            if (msg == null) return;
            switch (msg)
            {
                case "ready":
                    _pageReady = true;
                    PostVis();
                    if (_pipeThread == null) { _pipeThread = new Thread(PipeLoop) { IsBackground = true, Name = "pencere-boru" }; _pipeThread.Start(); }
                    else if (_lastConn != null) Post(_lastConn);
                    break;
                case "close": Close(); break;
                case "minimize": WindowState = FormWindowState.Minimized; break;
                case "maximize":
                    WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                    break;
                case "drag":
                    ReleaseCapture();
                    SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)2, IntPtr.Zero);
                    break;
                default:
                    if (msg.StartsWith("perf:", StringComparison.Ordinal)) Program.Log("pencere: " + msg.Substring(5));
                    else if (msg.StartsWith("{", StringComparison.Ordinal)) SendToService(msg);
                    break;
            }
        }

        void SendToService(string json)
        {
            bool sent = false;
            lock (_writeLock)
            {
                try { if (_writer != null) { _writer.Write(json.Replace("\n", " ") + "\n"); _writer.Flush(); sent = true; } }
                catch (Exception ex) { Program.Log("pencere: komut gönderilemedi: " + ex.Message); }
            }
            if (!sent)
                Post("{\"tip\":\"olay\",\"tur\":\"baglanti\",\"sonuc\":\"hata\",\"metin\":\"Servise bağlı değil; komut gönderilemedi.\"}");
        }

        void Conn(string state)
        {
            _lastConn = "{\"tip\":\"baglanti\",\"durum\":\"" + state + "\"}";
            Post(_lastConn);
        }

        void PipeLoop()
        {
            bool triedTask = false;
            while (!_closing)
            {
                try
                {
                    var pipe = new NamedPipeClientStream(".", Servis.BoruSunucu.Name, PipeDirection.InOut, PipeOptions.Asynchronous);
                    try { pipe.Connect(1500); }
                    catch (TimeoutException)
                    {
                        pipe.Dispose();
                        if (!triedTask)
                        {
                            triedTask = true;
                            if (StartTask(out var err)) { Program.Log("pencere: servis görevi başlatıldı"); Conn("baslatiliyor"); }
                            else
                            {
                                // Not installed yet (development, or before the morning install): run the service
                                // unelevated; the admin-only parts report themselves unavailable.
                                Program.Log("pencere: servis görevi yok (" + err + "), servis yetkisiz başlatılıyor");
                                try { System.Diagnostics.Process.Start(Application.ExecutablePath, "servis"); Conn("baslatiliyor"); }
                                catch (Exception ex2) { Program.Log("pencere: servis başlatılamadı: " + ex2.Message); Conn("yok"); }
                            }
                        }
                        else Conn(_lastConn != null && _lastConn.Contains("baslatiliyor") ? "baslatiliyor" : "yok");
                        Thread.Sleep(1000);
                        continue;
                    }
                    _pipe = pipe;
                    lock (_writeLock) _writer = new StreamWriter(pipe, new UTF8Encoding(false)) { NewLine = "\n" };
                    Conn("bagli");
                    using (var reader = new StreamReader(pipe, Encoding.UTF8))
                    {
                        string line;
                        while (!_closing && (line = reader.ReadLine()) != null)
                            if (line.Length > 0) Post(line);
                    }
                    lock (_writeLock) _writer = null;
                    Conn("yok");
                    triedTask = false;
                }
                catch (Exception ex)
                {
                    if (_closing) return;
                    Program.Log("pencere: boru hatası: " + ex.Message);
                    Conn("yok");
                    Thread.Sleep(1000);
                }
            }
        }

        void Post(string json)
        {
            if (_closing || !_pageReady) return;
            try
            {
                BeginInvoke((Action)(() =>
                {
                    try { _wv?.CoreWebView2?.PostWebMessageAsJson(json); }
                    catch { }
                }));
            }
            catch { }
        }

        void PostVis()
        {
            if (!_pageReady) return;
            bool visible = WindowState != FormWindowState.Minimized;
            bool focused = ContainsFocus || Form.ActiveForm == this;
            Post("{\"tip\":\"gorunur\",\"visible\":" + (visible ? "true" : "false") + ",\"focused\":" + (focused ? "true" : "false") + "}");
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _closing = true;
            try { _pipe?.Dispose(); } catch { }
            base.OnFormClosing(e);
        }
    }

    [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hmon, ref MONITORINFO mi);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
}
