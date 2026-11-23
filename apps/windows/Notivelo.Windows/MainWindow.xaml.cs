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
        var theme = Environment.GetEnvironmentVariable("NOTIVELO_THEME");
        var shell = new ShellView(new SampleNotesSource());
        if (Enum.TryParse<ThemeMode>(theme, true, out var mode)) shell.SetTheme(mode);
        if (Enum.TryParse<AppRoute>(Environment.GetEnvironmentVariable("NOTIVELO_ROUTE"), true, out var route)) shell.Navigate(route);
        Host.Children.Add(shell);

        var hwnd = WindowNative.GetWindowHandle(this);
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

    private readonly SubclassProc _subclass;
    private delegate IntPtr SubclassProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, nuint id, nuint data);
    [DllImport("comctl32.dll")] private static extern bool SetWindowSubclass(IntPtr hWnd, SubclassProc proc, nuint id, nuint data);
    [DllImport("comctl32.dll")] private static extern IntPtr DefSubclassProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hWnd);
}
