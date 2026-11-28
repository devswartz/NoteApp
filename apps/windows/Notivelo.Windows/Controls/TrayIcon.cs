using System.Runtime.InteropServices;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Controls;

/// <summary>The notification-area icon (Tauri's tray.rs): Shell_NotifyIcon on the main window's handle. The tooltip says how many tasks are due today, a left click opens the app, a right click
/// shows the menu (<see cref="TrayRules.Menu"/>). The window procedure of the main window passes its messages to <see cref="HandleMessage"/>.</summary>
internal sealed class TrayIcon : IDisposable
{
    /// <summary>The message the shell sends us (WM_APP + 1).</summary>
    public const uint CallbackMessage = 0x8001;
    private const uint IconId = 1;
    private const uint WM_CONTEXTMENU = 0x007B, WM_LBUTTONUP = 0x0202, WM_RBUTTONUP = 0x0205, NIN_SELECT = 0x0400, NIN_KEYSELECT = 0x0401;

    private readonly IntPtr _hwnd;
    private readonly string _app;
    private readonly string _hotkey;
    private readonly uint _taskbarCreated = RegisterWindowMessage("TaskbarCreated");
    private IntPtr _icon;
    private string _tip;
    private bool _added, _v4;

    /// <summary>The icon is in the notification area.</summary>
    public bool Installed => _added;
    /// <summary>The left click (or the keyboard's select) on the icon.</summary>
    public event Action? Activated;
    /// <summary>A menu item was chosen.</summary>
    public event Action<TrayCommand>? Command;

    public TrayIcon(IntPtr hwnd, string app, string hotkey)
    {
        _hwnd = hwnd; _app = app; _hotkey = hotkey; _tip = app;
    }

    public bool Install()
    {
        _icon = MakeIcon();
        return _added = Notify(0);
    }

    /// <summary>The tooltip (tray.rs: "Notivelo: 3 tasks due today").</summary>
    public void SetTooltip(string tip)
    {
        if (tip == _tip) return;
        _tip = tip;
        if (_added) Notify(1);
    }

    private bool Notify(uint message)
    {
        var d = new NOTIFYICONDATA
        {
            cbSize = (uint)Marshal.SizeOf<NOTIFYICONDATA>(), hWnd = _hwnd, uID = IconId, uFlags = 0x1 | 0x2 | 0x4, uCallbackMessage = CallbackMessage,
            hIcon = _icon, szTip = _tip, szInfo = "", szInfoTitle = "",
        };
        try
        {
            if (!Shell_NotifyIcon(message, ref d)) return false;
            if (message == 0) { d.uTimeoutOrVersion = 4; _v4 = Shell_NotifyIcon(4, ref d); }   // NOTIFYICON_VERSION_4: WM_CONTEXTMENU and NIN_SELECT also come from the keyboard
            return true;
        }
        catch (Exception) { return false; }
    }

    /// <summary>Handle a window message of the main window; true when it was ours (the icon's clicks, or the taskbar coming back after Explorer restarted).</summary>
    public bool HandleMessage(uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == _taskbarCreated && _added) { Notify(0); return true; }
        if (msg != CallbackMessage) return false;
        // version 4 sends both the mouse message and NIN_SELECT / WM_CONTEXTMENU for one click: act on the second kind only, or the menu would open twice
        switch ((uint)(lParam.ToInt64() & 0xFFFF))
        {
            case NIN_SELECT or NIN_KEYSELECT: Activated?.Invoke(); break;
            case WM_LBUTTONUP when !_v4: Activated?.Invoke(); break;
            case WM_CONTEXTMENU: ShowMenu(); break;
            case WM_RBUTTONUP when !_v4: ShowMenu(); break;
        }
        return true;
    }

    private void ShowMenu()
    {
        var items = TrayRules.Menu(_app, _hotkey);
        var menu = CreatePopupMenu();
        try
        {
            for (var i = 0; i < items.Count; i++)
            {
                if (items[i].IsSeparator) AppendMenu(menu, 0x800, UIntPtr.Zero, null);
                else AppendMenu(menu, 0, (UIntPtr)(uint)items[i].Command, TrayRules.Text(items[i]));
            }
            GetCursorPos(out var p);
            SetForegroundWindow(_hwnd);   // so the menu closes when the user clicks elsewhere
            var cmd = TrackPopupMenuEx(menu, 0x100 | 0x2 | 0x20, p.X, p.Y, _hwnd, IntPtr.Zero);   // RETURNCMD | RIGHTBUTTON | BOTTOMALIGN
            PostMessage(_hwnd, 0, IntPtr.Zero, IntPtr.Zero);
            if (cmd > 0) Command?.Invoke((TrayCommand)cmd);
        }
        finally { DestroyMenu(menu); }
    }

    public void Dispose()
    {
        if (_added) { var d = new NOTIFYICONDATA { cbSize = (uint)Marshal.SizeOf<NOTIFYICONDATA>(), hWnd = _hwnd, uID = IconId, szTip = "", szInfo = "", szInfoTitle = "" }; try { Shell_NotifyIcon(2, ref d); } catch (Exception) { } _added = false; }
        if (_icon != IntPtr.Zero) { DestroyIcon(_icon); _icon = IntPtr.Zero; }
    }

    // ---- the icon: today's tray.png (a black check on transparent: a template image), drawn white on a dark taskbar ----

    private static IntPtr MakeIcon()
    {
        try
        {
            var size = Math.Max(16, GetSystemMetrics(49));   // SM_CXSMICON
            var path = Path.Combine(AppContext.BaseDirectory, "Assets", "Tray.png");
            var pixels = System.Threading.Tasks.Task.Run(() => Decode(path, (uint)size)).GetAwaiter().GetResult();
            if (pixels is not null)
            {
                if (TaskbarIsDark()) for (var i = 0; i < pixels.Length; i += 4) { pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; }
                var made = FromBgra(pixels, size);
                if (made != IntPtr.Zero) return made;
            }
        }
        catch (Exception) { }
        return LoadIcon(IntPtr.Zero, (IntPtr)32512);   // IDI_APPLICATION
    }

    private static async System.Threading.Tasks.Task<byte[]?> Decode(string path, uint size)
    {
        if (!File.Exists(path)) return null;
        var file = await global::Windows.Storage.StorageFile.GetFileFromPathAsync(path);
        using var stream = await file.OpenReadAsync();
        var decoder = await global::Windows.Graphics.Imaging.BitmapDecoder.CreateAsync(stream);
        var transform = new global::Windows.Graphics.Imaging.BitmapTransform { ScaledWidth = size, ScaledHeight = size, InterpolationMode = global::Windows.Graphics.Imaging.BitmapInterpolationMode.Fant };
        var data = await decoder.GetPixelDataAsync(global::Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8, global::Windows.Graphics.Imaging.BitmapAlphaMode.Straight, transform,
            global::Windows.Graphics.Imaging.ExifOrientationMode.IgnoreExifOrientation, global::Windows.Graphics.Imaging.ColorManagementMode.DoNotColorManage);
        return data.DetachPixelData();
    }

    private static bool TaskbarIsDark()
    {
        try
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return k?.GetValue("SystemUsesLightTheme") is int v ? v == 0 : true;
        }
        catch (Exception) { return true; }
    }

    private static IntPtr FromBgra(byte[] bgra, int size)
    {
        // straight alpha in, premultiplied for the colour bitmap; the mask bitmap is unused (all opaque bits) because the colour bitmap has alpha
        var bi = new BITMAPINFOHEADER { biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(), biWidth = size, biHeight = -size, biPlanes = 1, biBitCount = 32 };
        var dc = GetDC(IntPtr.Zero);
        var color = CreateDIBSection(dc, ref bi, 0, out var bits, IntPtr.Zero, 0);
        var mask = CreateBitmap(size, size, 1, 1, null);
        ReleaseDC(IntPtr.Zero, dc);
        if (color == IntPtr.Zero) { if (mask != IntPtr.Zero) DeleteObject(mask); return IntPtr.Zero; }
        var pre = new byte[bgra.Length];
        for (var i = 0; i < bgra.Length; i += 4)
        {
            var a = bgra[i + 3];
            pre[i] = (byte)(bgra[i] * a / 255); pre[i + 1] = (byte)(bgra[i + 1] * a / 255); pre[i + 2] = (byte)(bgra[i + 2] * a / 255); pre[i + 3] = a;
        }
        Marshal.Copy(pre, 0, bits, pre.Length);
        var info = new ICONINFO { fIcon = true, hbmMask = mask, hbmColor = color };
        var icon = CreateIconIndirect(ref info);
        DeleteObject(color); DeleteObject(mask);
        return icon;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NOTIFYICONDATA
    {
        public uint cbSize; public IntPtr hWnd; public uint uID, uFlags, uCallbackMessage; public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
        public uint dwState, dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
        public uint uTimeoutOrVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
        public uint dwInfoFlags; public Guid guidItem; public IntPtr hBalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct ICONINFO { public bool fIcon; public uint xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount; public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter; public uint biClrUsed, biClrImportant;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "Shell_NotifyIconW")] private static extern bool Shell_NotifyIcon(uint message, ref NOTIFYICONDATA data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessage(string name);
    [DllImport("user32.dll")] private static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] private static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "AppendMenuW")] private static extern bool AppendMenu(IntPtr menu, uint flags, UIntPtr id, string? text);
    [DllImport("user32.dll")] private static extern uint TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr hwnd, IntPtr tpm);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern IntPtr LoadIcon(IntPtr instance, IntPtr name);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll")] private static extern IntPtr CreateIconIndirect(ref ICONINFO info);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateBitmap(int w, int h, uint planes, uint bits, byte[]? data);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr o);
}

/// <summary>RegisterHotKey on the main window: WM_HOTKEY comes to its window procedure.</summary>
internal sealed class Win32Hotkeys : IHotkeyApi
{
    private readonly IntPtr _hwnd;
    public Win32Hotkeys(IntPtr hwnd) => _hwnd = hwnd;

    public bool Register(int id, Hotkey key, out int error)
    {
        var ok = RegisterHotKey(_hwnd, id, key.Modifiers, key.Vk);
        error = ok ? 0 : Marshal.GetLastWin32Error();
        return ok;
    }

    public void Unregister(int id) => UnregisterHotKey(_hwnd, id);

    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnregisterHotKey(IntPtr hwnd, int id);
}
