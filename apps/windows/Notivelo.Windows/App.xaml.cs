using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;

namespace Notivelo.Windows;

public partial class App : Application
{
    private Window? _window;
    private Mutex? _single;

    /// <summary>WM_APP + 2: a second launch asks the running app to come to the front (Tauri's single-instance plugin; the app lives on in the tray after its window is closed).</summary>
    public const uint ShowMessage = 0x8002;

    public App()
    {
        InitializeComponent();
        // Dev aid: write unhandled UI exceptions where they can be read (stowed exceptions give no message otherwise).
        UnhandledException += (_, e) =>
        {
            try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "notivelo-crash.log"), e.Exception.ToString()); } catch { }
        };
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        if (!IsFirstInstance()) { Environment.Exit(0); return; }
        _window = new MainWindow();
        _window.Activate();
    }

    /// <summary>Only the real app is single: the test and screenshot modes (NOTIVELO_SOURCE=offline|sample|signup) can run side by side. A second real launch finds the first one's window and asks it to show itself.</summary>
    private bool IsFirstInstance()
    {
        if (Environment.GetEnvironmentVariable("NOTIVELO_SOURCE") is { Length: > 0 }) return true;
        try
        {
            _single = new Mutex(true, @"Local\Notivelo.Main", out var created);
            if (created) return true;
            var hwnd = FindWindow(null, "Notivelo");
            if (hwnd != IntPtr.Zero) PostMessage(hwnd, ShowMessage, IntPtr.Zero, IntPtr.Zero);
            return false;
        }
        catch (Exception) { return true; }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string? cls, string title);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
}
