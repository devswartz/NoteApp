using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Capturing;
using FlaUI.Core.Definitions;
using FlaUI.Core.Input;
using FlaUI.UIA3;
using Xunit;

[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace Notivelo.Windows.UiTests;

/// <summary>What the box exposes through UIA: the Value pattern is the view text, ItemStatus the rest
/// (<c>block=paragraph;sel=A,H;focus=1;menu=slash:2/18;undo=1;redo=0;marked=0</c>).</summary>
internal sealed record BoxState(string Text, int Anchor, int Head, string Block, bool Focus, string Menu, bool Undo, bool Redo, string Link = "", bool Editor = false)
{
    public static BoxState Parse(string text, string status)
    {
        var kv = status.Split(';').Select(p => p.Split('=', 2)).Where(p => p.Length == 2).ToDictionary(p => p[0], p => p[1]);
        var sel = kv.GetValueOrDefault("sel", "-1,-1")!.Split(',');
        return new BoxState(text, int.Parse(sel[0]), int.Parse(sel[1]), kv.GetValueOrDefault("block", "?")!, kv.GetValueOrDefault("focus") == "1",
            kv.GetValueOrDefault("menu", "?")!, kv.GetValueOrDefault("undo") == "1", kv.GetValueOrDefault("redo") == "1", kv.GetValueOrDefault("link", "")!, kv.GetValueOrDefault("editor") == "1");
    }
    public override string ToString() => $"text={Text.Replace("\n", "\\n")} sel={Anchor},{Head} block={Block} focus={Focus} menu={Menu} undo={Undo} redo={Redo}";
}

/// <summary>One box of the offline page ("a" is empty, "b" starts as "Second box").</summary>
internal sealed class Box
{
    private readonly AppHost _host;
    public string Id { get; }
    public Box(AppHost host, string id) { _host = host; Id = id; }

    private AutomationElement Element => AppHost.Wait(
        () => _host.Window.FindFirstDescendant(_host.Window.ConditionFactory.ByAutomationId("box-box-" + Id)), "box " + Id + " in the UIA tree");

    public System.Drawing.Rectangle Bounds => Element.BoundingRectangle;

    /// <summary>The raw ItemStatus (<c>...;images=loaded,loading;files=a.pdf|b.zip;sizes=200x100;node=image;upload=0</c>).</summary>
    public string Status => Element.Properties.ItemStatus.ValueOrDefault ?? "";

    /// <summary>One key of the ItemStatus (<c>images</c>, <c>files</c>, <c>sizes</c>, <c>node</c>, <c>upload</c>).</summary>
    public string Media(string key) =>
        Status.Split(';').Select(p => p.Split('=', 2)).Where(p => p.Length == 2 && p[0] == key).Select(p => p[1]).FirstOrDefault() ?? "";

    public void WaitMedia(string key, Func<string, bool> ok, string what, int ms = 15000)
    {
        var sw = Stopwatch.StartNew();
        string last = "";
        while (sw.ElapsedMilliseconds < ms)
        {
            try { last = Media(key); if (ok(last)) return; } catch (Exception) { }
            Thread.Sleep(100);
        }
        Assert.Fail($"waited for {what} in box {Id}; {key}=\"{last}\" status: {(TryStatus() ?? "?")}");
    }

    private string? TryStatus() { try { return Status; } catch { return null; } }

    public BoxState State
    {
        get
        {
            var e = Element;
            return BoxState.Parse(e.Patterns.Value.Pattern.Value.ValueOrDefault ?? "", e.Properties.ItemStatus.ValueOrDefault ?? "");
        }
    }

    /// <summary>Click near the right end of the box's first line (the caret goes to the end of a short line), and wait for the focus.</summary>
    public void Focus()
    {
        var r = Element.BoundingRectangle;
        Mouse.Click(new Point((int)r.Right - 12, (int)r.Top + 14));
        WaitFor(s => s.Focus, "focus");
    }

    public BoxState WaitFor(Func<BoxState, bool> ok, string what, int ms = 8000)
    {
        BoxState? last = null;
        var sw = Stopwatch.StartNew();
        while (true)
        {
            try { last = State; if (ok(last)) return last; } catch (Exception) when (sw.ElapsedMilliseconds < ms) { }
            if (sw.ElapsedMilliseconds >= ms) break;
            Thread.Sleep(50);
        }
        Assert.Fail("waited for " + what + " in box " + Id + "; last state: " + last);
        return last!;
    }

    public BoxState WaitText(string text) => WaitFor(s => s.Text == text, "text \"" + text.Replace("\n", "\\n") + "\"");
}

/// <summary>The app, started unpackaged in its offline mode, and the keys to drive it with.</summary>
internal sealed class AppHost : IDisposable
{
    private readonly Application _app;
    private readonly UIA3Automation _auto;
    public Window Window { get; }
    public string TaskLog { get; }
    public Box A { get; }
    public Box B { get; }

    private AppHost(Application app, UIA3Automation auto, Window w, string log)
    {
        _app = app; _auto = auto; Window = w; TaskLog = log; A = new Box(this, "a"); B = new Box(this, "b");
    }

    public static string ExePath()
    {
        if (Environment.GetEnvironmentVariable("NOTIVELO_EXE") is { Length: > 0 } e) return e;
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "out-ui", "Notivelo.exe"))) return Path.Combine(d.FullName, "out-ui", "Notivelo.exe");
        throw new FileNotFoundException("Set NOTIVELO_EXE to the unpackaged Notivelo.exe");
    }

    /// <summary>Start the app. <paramref name="env"/> adds environment variables (NOTIVELO_THEME...); a size gives a normal (not maximised) window of that size.</summary>
    public static AppHost Launch(IReadOnlyDictionary<string, string>? env = null, int? width = null, int? height = null)
    {
        var exe = ExePath();
        var log = Path.Combine(Path.GetTempPath(), "notivelo-tasks-" + Guid.NewGuid().ToString("N") + ".log");
        var psi = new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe)! };
        psi.Environment["NOTIVELO_SOURCE"] = "offline";
        psi.Environment["NOTIVELO_OFFLINE_LOG"] = log;
        psi.Environment["NOTIVELO_TRACE"] = "1";
        if (env is not null) foreach (var kv in env) psi.Environment[kv.Key] = kv.Value;
        var app = Application.Launch(psi);
        var auto = new UIA3Automation();
        Window w;
        try { w = app.GetMainWindow(auto, TimeSpan.FromSeconds(60)); }
        catch { try { app.Kill(); } catch { } throw; }
        var host = new AppHost(app, auto, w, log);
        if (width is { } ww && height is { } hh)
        {
            try { w.Patterns.Window.Pattern.SetWindowVisualState(WindowVisualState.Normal); } catch { }
            try { w.Patterns.Transform.Pattern.Move(0, 0); w.Patterns.Transform.Pattern.Resize(ww, hh); } catch { }
            Thread.Sleep(600);
        }
        else
        {
            try { w.Patterns.Window.Pattern.SetWindowVisualState(WindowVisualState.Maximized); } catch { }
        }
        try { w.SetForeground(); w.Focus(); } catch { }
        // the page and its boxes appear once the shell has laid out
        try { _ = host.A.State; _ = host.B.State; }
        catch { host.Shot("launch"); host.Dispose(); throw; }
        return host;
    }

    public static T Wait<T>(Func<T?> f, string what, int ms = 30000) where T : class
    {
        var sw = Stopwatch.StartNew();
        while (true)
        {
            try { if (f() is { } v) return v; } catch (Exception) when (sw.ElapsedMilliseconds < ms) { }
            if (sw.ElapsedMilliseconds >= ms) throw new TimeoutException("timed out waiting for " + what);
            Thread.Sleep(100);
        }
    }

    // ---- keys ----
    public void Type(string text) { Keyboard.Type(text); Thread.Sleep(150); }
    public void Press(FlaUI.Core.WindowsAPI.VirtualKeyShort k, int times = 1) { for (var i = 0; i < times; i++) { Keyboard.Type(k); Thread.Sleep(80); } }
    public void Chord(params FlaUI.Core.WindowsAPI.VirtualKeyShort[] keys) { Keyboard.TypeSimultaneously(keys); Thread.Sleep(150); }

    public static string ScreenshotDir => Environment.GetEnvironmentVariable("UITEST_SHOTS") is { Length: > 0 } d ? d : Path.Combine(Path.GetTempPath(), "uitest-shots");

    public void Shot(string name)
    {
        try { Directory.CreateDirectory(ScreenshotDir); Capture.Screen().ToFile(Path.Combine(ScreenshotDir, name + ".png")); } catch { }
    }

    public void Dispose()
    {
        try { _app.Kill(); } catch { }
        try { _auto.Dispose(); } catch { }
    }

    /// <summary>Run a test body against a fresh app; a failure leaves a screenshot of the desktop.</summary>
    public static void Run(string name, Action<AppHost> body)
    {
        using var host = Launch();
        try { body(host); }
        catch { host.Shot(name); throw; }
    }
}

internal static class Clip
{
    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
    [DllImport("user32.dll")] private static extern bool EmptyClipboard();
    [DllImport("user32.dll")] private static extern IntPtr SetClipboardData(uint fmt, IntPtr mem);
    [DllImport("user32.dll")] private static extern IntPtr GetClipboardData(uint fmt);
    [DllImport("user32.dll")] private static extern bool IsClipboardFormatAvailable(uint fmt);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalLock(IntPtr h);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr h);
    private const uint CfUnicode = 13, GmemMoveable = 2;

    private static void WithClipboard(Action a)
    {
        for (var i = 0; i < 40; i++)
        {
            if (OpenClipboard(IntPtr.Zero))
            {
                try { a(); } finally { CloseClipboard(); }
                return;
            }
            Thread.Sleep(50);
        }
        throw new InvalidOperationException("clipboard stays locked");
    }

    public static void Set(string text) => WithClipboard(() =>
    {
        EmptyClipboard();
        var bytes = (text.Length + 1) * 2;
        var h = GlobalAlloc(GmemMoveable, (UIntPtr)bytes);
        var p = GlobalLock(h);
        var buf = new byte[bytes];
        System.Text.Encoding.Unicode.GetBytes(text).CopyTo(buf, 0);
        Marshal.Copy(buf, 0, p, bytes);
        GlobalUnlock(h);
        SetClipboardData(CfUnicode, h);
    });

    public static string? Get()
    {
        string? r = null;
        WithClipboard(() =>
        {
            if (!IsClipboardFormatAvailable(CfUnicode)) return;
            var h = GetClipboardData(CfUnicode);
            var p = GlobalLock(h);
            r = Marshal.PtrToStringUni(p);
            GlobalUnlock(h);
        });
        return r;
    }
}
