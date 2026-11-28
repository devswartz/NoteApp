using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Notivelo.Windows.Views;
using WinRT.Interop;

namespace Notivelo.Windows;

public sealed partial class MainWindow : Window
{
    // LOOK 3.3: the wide layout needs > 760 pt; the phone layout is not built, so the window never goes below it.
    private const double MinWidthDip = 800, MinHeightDip = 560;

    /// <summary>The window, so a tapped reminder toast can bring it forward.</summary>
    public static MainWindow? Instance { get; private set; }

    public MainWindow()
    {
        InitializeComponent();
        Title = "Notivelo";
        Instance = this;
        Activated += (_, e) => { if (e.WindowActivationState != WindowActivationState.Deactivated) WindowActivated?.Invoke(); };
        // NOTIVELO_SOURCE=sample: the fake data of the reference captures, no sign-in (offline screenshots). Default: the Rust core.
        // NOTIVELO_SOURCE=offline: the UI tests' mode: sample data plus a page of editable boxes over local documents, no server.
        var sourceMode = Environment.GetEnvironmentVariable("NOTIVELO_SOURCE");
        var offline = string.Equals(sourceMode, "offline", StringComparison.OrdinalIgnoreCase);
        if (offline || string.Equals(sourceMode, "sample", StringComparison.OrdinalIgnoreCase))
        {
            ShowShell(new SampleNotesSource(offline), null, null);
        }
        else if (string.Equals(sourceMode, "signup", StringComparison.OrdinalIgnoreCase))
        {
            // NOTIVELO_SOURCE=signup: the sign-in, sign-up and check-email screens with no server (UI tests, look screenshots); sign-up succeeds with nothing sent.
            _session = new AppSession(preview: true);
            _session.Changed += ShowPhase;
            ShowPhase();
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
            if (msg == App.ShowMessage) { ShowMain(); return IntPtr.Zero; }
            if (msg == 0x0016 && w != IntPtr.Zero) { _quitting = true; Cleanup(); }   // WM_ENDSESSION: the OS is shutting down or the user signs out; never hold that up in the tray
            if (msg == 0x0312 && _hotkeys?.Owns((int)w) == true) { ToggleQuickCapture(); return IntPtr.Zero; }   // WM_HOTKEY
            if (_tray?.HandleMessage(msg, w, l) == true) return IntPtr.Zero;
            if (msg == 0x0024) // WM_GETMINMAXINFO: ptMinTrackSize is at offset 24
            {
                var s = GetDpiForWindow(h) / 96.0;
                Marshal.WriteInt32(l, 24, (int)(MinWidthDip * s));
                Marshal.WriteInt32(l, 28, (int)(MinHeightDip * s));
            }
            return DefSubclassProc(h, msg, w, l);
        };
        SetWindowSubclass(hwnd, _subclass, 1, 0);
        StartTray(hwnd);
    }

    /// <summary>The window came to the front (the shell asks the server for new notifications).</summary>
    public static event Action? WindowActivated;

    private AppSession? _session;
    private SessionPhase? _shown;
    private bool _checkShown;
    private SignInView? _signIn;

    /// <summary>Sign-in screen while signed out or restoring, the check-email screen when the new account's address is not confirmed, the shell once signed in (a new shell per sign-in).</summary>
    private void ShowPhase()
    {
        var s = _session!;
        var signedIn = s.Phase == SessionPhase.SignedIn && s.Source is not null;
        if (s.NeedsEmailCheck)
        {
            if (_checkShown) return;
            _checkShown = true; _shown = SessionPhase.SignedIn;
            _shell = null; _shellSource = null;
            Host.Children.Clear();
            Host.Children.Add(new CheckEmailView(s));
            ApplyTheme(ThemeMode.Hybrid);
        }
        else if (signedIn)
        {
            if (_shown == SessionPhase.SignedIn && !_checkShown) return;
            _shown = SessionPhase.SignedIn; _checkShown = false;
            ShowShell(s.Source!, s.SignOut, s.Host);
        }
        else
        {
            if (_shown == SessionPhase.SignedOut) return; // the sign-in view follows the session by itself
            _checkShown = false;
            _shell = null; _shellSource = null;
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
        _shell = shell; _shellSource = source;
        if (Enum.TryParse<ThemeMode>(Environment.GetEnvironmentVariable("NOTIVELO_THEME"), true, out var mode)) shell.SetTheme(mode, false);
        if (Enum.TryParse<AppRoute>(Environment.GetEnvironmentVariable("NOTIVELO_ROUTE"), true, out var route)) shell.Navigate(route);
        Host.Children.Clear();
        Host.Children.Add(shell);
    }

    /// <summary>The sign-in screen follows the theme: Hybrid and Dark use the dark palette (as the reference does), Light the light one.</summary>
    private void ApplyTheme(ThemeMode mode) =>
        Host.RequestedTheme = mode == ThemeMode.Light ? ElementTheme.Light : ElementTheme.Dark;

    // ---- tray icon, close to tray and global quick capture (Tauri's tray.rs, quick.rs, lib.rs) ----

    private ShellView? _shell;
    private INotesSource? _shellSource;
    private TrayIcon? _tray;
    private HotkeyService? _hotkeys;
    private QuickCaptureWindow? _quick;
    private bool _quitting;

    /// <summary>Why the quick-capture shortcut is off (another app has it), or null; the shell says so once.</summary>
    public static string? HotkeyProblem { get; private set; }

    /// <summary>What the tray shows, for the shell to repeat in its test readout and to set the tooltip from: the count of tasks due today.</summary>
    public static void SetTodayCount(int count) => Instance?._tray?.SetTooltip(TrayRules.Tooltip(TrayRules.AppName, count));

    private void StartTray(IntPtr hwnd)
    {
        try
        {
            _quick = new QuickCaptureWindow(() => _shellSource, ShowMain, id => { ShowMain(); _shell?.OpenPageById(id); });
            _hotkeys = new HotkeyService(new Win32Hotkeys(hwnd));
            _hotkeys.Register();
            HotkeyProblem = _hotkeys.Problem;   // another app may own the shortcut: the tray item and the in-app Ctrl+Alt+N still work
            _tray = new TrayIcon(hwnd, TrayRules.AppName, HotkeyService.QuickCapture);
            _tray.Activated += ShowMain;
            _tray.Command += RunTrayCommand;
            _tray.Install();
        }
        catch (Exception e)
        {
            try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "notivelo-tray.log"), e + "\n"); } catch { }
        }
        // closing hides the window while the tray icon is there to bring it back (lib.rs); Quit from the tray menu really quits
        AppWindow.Closing += (_, e) =>
        {
            if (TrayRules.HideOnClose(_quitting, _tray?.Installed == true)) { e.Cancel = true; AppWindow.Hide(); return; }
            Cleanup();
            _quick?.Quit();   // its hidden window would keep the process alive
        };
    }

    /// <summary>Bring the main window back (tray click, tray menu, a second launch): restored if it was minimised, shown if it was hidden, in front.</summary>
    public void ShowMain()
    {
        var hwnd = WindowNative.GetWindowHandle(this);
        if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } p) p.Restore();
        AppWindow.Show();
        Activate();
        SetForegroundWindow(hwnd);
    }

    /// <summary>Ctrl+Alt+N (global, or inside the app) and the tray's Quick Capture.</summary>
    public void ToggleQuickCapture() => _quick?.Toggle();

    private void RunTrayCommand(TrayCommand c)
    {
        switch (c)
        {
            case TrayCommand.QuickCapture: ToggleQuickCapture(); return;
            case TrayCommand.Quit: Quit(); return;
        }
        if (TrayRules.ShowsMain(c)) ShowMain();
        if (TrayRules.KeyOf(c) is var k and not ShellKey.None) _shell?.RunShellKeyPublic(k);
    }

    /// <summary>Quit for real (tray menu): remove the icon, free the shortcut, close the windows and exit.</summary>
    public void Quit()
    {
        _quitting = true;
        Cleanup();
        _quick?.Quit();
        try { Close(); } catch (Exception) { }
        Application.Current.Exit();
    }

    private void Cleanup()
    {
        try { _hotkeys?.Unregister(); } catch (Exception) { }
        try { _tray?.Dispose(); } catch (Exception) { }
    }

    private readonly SubclassProc _subclass;
    private delegate IntPtr SubclassProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, nuint id, nuint data);
    [DllImport("comctl32.dll")] private static extern bool SetWindowSubclass(IntPtr hWnd, SubclassProc proc, nuint id, nuint data);
    [DllImport("comctl32.dll")] private static extern IntPtr DefSubclassProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
}
