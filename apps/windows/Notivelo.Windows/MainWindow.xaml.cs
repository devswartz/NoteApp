using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Notivelo.Windows.Data;
using Notivelo.Windows.Views;
using WinRT.Interop;

namespace Notivelo.Windows;

public sealed partial class MainWindow : Window
{
    // LOOK 3.3: the wide layout needs > 760 pt; the phone layout is not built, so the window never goes below it.
    private const double MinWidthDip = 800, MinHeightDip = 560;

    public MainWindow()
    {
        InitializeComponent();
        Title = "Notivelo";
        // NOTIVELO_SOURCE=sample: the fake data of the reference captures, no sign-in (offline screenshots). Default: the Rust core.
        // NOTIVELO_SOURCE=offline: the UI tests' mode: sample data plus a page of editable boxes over local documents, no server.
        var sourceMode = Environment.GetEnvironmentVariable("NOTIVELO_SOURCE");
        var offline = string.Equals(sourceMode, "offline", StringComparison.OrdinalIgnoreCase);
        if (offline || string.Equals(sourceMode, "sample", StringComparison.OrdinalIgnoreCase))
        {
            ShowShell(new SampleNotesSource(offline), null, null);
        }
        else
        {
            _session = new AppSession();
            _session.Changed += ShowPhase;
            ShowPhase();
            _session.Restore();
        }

        var hwnd = WindowNative.GetWindowHandle(this);
        Controls.BoxTextView.WindowHandle = hwnd;
        Controls.DevShot.Arm(hwnd);
        var scale = GetDpiForWindow(hwnd) / 96.0;
        AppWindow.ResizeClient(new global::Windows.Graphics.SizeInt32((int)(1180 * scale), (int)(820 * scale)));
        if (AppWindowTitleBar.IsCustomizationSupported())
        {
            var tb = AppWindow.TitleBar;
            var bg = global::Windows.UI.Color.FromArgb(255, 0x14, 0x14, 0x16);
            var fg = global::Windows.UI.Color.FromArgb(255, 0xEC, 0xEC, 0xEF);
            tb.BackgroundColor = bg; tb.InactiveBackgroundColor = bg; tb.ForegroundColor = fg; tb.InactiveForegroundColor = global::Windows.UI.Color.FromArgb(255, 0x9D, 0x9D, 0xA6);
            tb.ButtonBackgroundColor = bg; tb.ButtonInactiveBackgroundColor = bg; tb.ButtonForegroundColor = fg;
            tb.ButtonHoverBackgroundColor = global::Windows.UI.Color.FromArgb(255, 0x2C, 0x2C, 0x32); tb.ButtonHoverForegroundColor = fg;
            tb.ButtonPressedBackgroundColor = global::Windows.UI.Color.FromArgb(255, 0x3A, 0x3A, 0x42);
        }
        _subclass = (h, msg, w, l, id, data) =>
        {
            if (msg == 0x0024) // WM_GETMINMAXINFO: ptMinTrackSize is at offset 24
            {
                var s = GetDpiForWindow(h) / 96.0;
                Marshal.WriteInt32(l, 24, (int)(MinWidthDip * s));
                Marshal.WriteInt32(l, 28, (int)(MinHeightDip * s));
            }
            return DefSubclassProc(h, msg, w, l);
        };
        SetWindowSubclass(hwnd, _subclass, 1, 0);
    }

    private AppSession? _session;
    private SessionPhase? _shown;
    private SignInView? _signIn;

    /// <summary>Sign-in screen while signed out or restoring, the shell once signed in (a new shell per sign-in).</summary>
    private void ShowPhase()
    {
        var s = _session!;
        var signedIn = s.Phase == SessionPhase.SignedIn && s.Source is not null;
        if (signedIn)
        {
            if (_shown == SessionPhase.SignedIn) return;
            _shown = SessionPhase.SignedIn;
            ShowShell(s.Source!, s.SignOut, s.Host);
        }
        else
        {
            if (_shown == SessionPhase.SignedOut) return; // the sign-in view follows the session by itself
            _shown = SessionPhase.SignedOut;
            _signIn = new SignInView(s);
            Host.Children.Clear();
            Host.Children.Add(_signIn);
            ApplyTheme(ThemeMode.Hybrid);
        }
    }

    private void ShowShell(INotesSource source, Action? signOut, string? server)
    {
        var shell = new ShellView(source, signOut, server);
        if (Enum.TryParse<ThemeMode>(Environment.GetEnvironmentVariable("NOTIVELO_THEME"), true, out var mode)) shell.SetTheme(mode);
        if (Enum.TryParse<AppRoute>(Environment.GetEnvironmentVariable("NOTIVELO_ROUTE"), true, out var route)) shell.Navigate(route);
        Host.Children.Clear();
        Host.Children.Add(shell);
    }

    /// <summary>The sign-in screen follows the theme: Hybrid and Dark use the dark palette (as the reference does), Light the light one.</summary>
    private void ApplyTheme(ThemeMode mode) =>
        Host.RequestedTheme = mode == ThemeMode.Light ? ElementTheme.Light : ElementTheme.Dark;

    private readonly SubclassProc _subclass;
    private delegate IntPtr SubclassProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, nuint id, nuint data);
    [DllImport("comctl32.dll")] private static extern bool SetWindowSubclass(IntPtr hWnd, SubclassProc proc, nuint id, nuint data);
    [DllImport("comctl32.dll")] private static extern IntPtr DefSubclassProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hWnd);
}
