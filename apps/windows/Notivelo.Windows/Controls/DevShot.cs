using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Windows.Graphics.Imaging;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Storage.Streams;

namespace Notivelo.Windows.Controls;

/// <summary>Dev hook (env NOTIVELO_SHOT=file.png[;seconds]): the window's pixels written to a PNG after a delay, then the app exits when NOTIVELO_SHOT_EXIT is set.
/// Only for screenshots of local runs; no input is synthesised.</summary>
internal static class DevShot
{
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr o);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, byte[] bits, ref BITMAPINFO bi, uint usage);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] private struct BITMAPINFO { public int Size, W, H; public short Planes, Bpp; public int Comp, ImgSize, X, Y, Used, Important; }

    private static DispatcherQueueTimer? _timer;

    public static void Arm(IntPtr hwnd)
    {
        var spec = Environment.GetEnvironmentVariable("NOTIVELO_SHOT");
        if (string.IsNullOrEmpty(spec) || !(Environment.GetEnvironmentVariable("NOTIVELO_SERVER") ?? "").Contains("127.0.0.1")) return;
        var parts = spec.Split(';');
        var secs = parts.Length > 1 && double.TryParse(parts[1], out var s) ? s : 20;
        var t = _timer = DispatcherQueue.GetForCurrentThread().CreateTimer();
        t.Interval = TimeSpan.FromSeconds(secs);
        t.IsRepeating = false;
        t.Tick += async (_, _) =>
        {
            try { await Capture(hwnd, parts[0]); } catch (Exception e) { BoxTextView.Log("shot", e); }
            if (Environment.GetEnvironmentVariable("NOTIVELO_SHOT_EXIT") is not null) Environment.Exit(0);
        };
        t.Start();
    }

    private static async Task Capture(IntPtr hwnd, string path)
    {
        BoxTextView.Trace("shot start");
        GetClientRect(hwnd, out var r);
        int w = r.R - r.L, h = r.B - r.T;
        var sdc = GetDC(hwnd);
        var dc = CreateCompatibleDC(sdc);
        var bmp = CreateCompatibleBitmap(sdc, w, h);
        var old = SelectObject(dc, bmp);
        PrintWindow(hwnd, dc, 3);   // client only + render full content
        var bi = new BITMAPINFO { Size = 40, W = w, H = -h, Planes = 1, Bpp = 32 };
        var bits = new byte[w * h * 4];
        GetDIBits(dc, bmp, 0, (uint)h, bits, ref bi, 0);
        SelectObject(dc, old); DeleteObject(bmp); DeleteDC(dc); ReleaseDC(hwnd, sdc);
        BoxTextView.Trace("shot grabbed");
        for (var i = 3; i < bits.Length; i += 4) bits[i] = 255;
        using var sb = SoftwareBitmap.CreateCopyFromBuffer(bits.AsBuffer(), BitmapPixelFormat.Bgra8, w, h, BitmapAlphaMode.Ignore);
        using var ms = new InMemoryRandomAccessStream();
        var enc = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, ms);
        enc.SetSoftwareBitmap(sb);
        await enc.FlushAsync();
        var data = new byte[ms.Size];
        ms.Seek(0);
        await ms.ReadAsync(data.AsBuffer(), (uint)ms.Size, InputStreamOptions.None);
        File.WriteAllBytes(path, data);
    }
}
