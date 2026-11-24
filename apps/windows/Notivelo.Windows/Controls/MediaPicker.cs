using System.Runtime.InteropServices.WindowsRuntime;
using Notivelo.Windows.Text;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Storage.Pickers;
using Windows.Storage.Streams;
using WinRT.Interop;

namespace Notivelo.Windows.Controls;

/// <summary>A file chosen, dropped or pasted: its name, size (when known) and a way to read it (read only when it is uploaded).</summary>
internal sealed record PickedFile(string Name, long Size, Func<Task<byte[]>> Read);

/// <summary>The file dialogs and the clipboard / drag-and-drop sources of pictures and files, and opening a downloaded file.
/// Test hooks (offline test mode only, since the system dialogs can't be driven): <c>NOTIVELO_TEST_PICK</c> = paths separated by <c>|</c> that the open picker returns,
/// <c>NOTIVELO_TEST_SAVE</c> = the path "Save as" writes to.</summary>
internal static class MediaPicker
{
    private static bool TestMode =>
        Environment.GetEnvironmentVariable("NOTIVELO_SOURCE") is { } s && s.Equals("offline", StringComparison.OrdinalIgnoreCase);

    public static PickedFile FromPath(string path) =>
        new(Path.GetFileName(path), new FileInfo(path).Length, () => File.ReadAllBytesAsync(path));

    public static async Task<PickedFile> FromStorageFile(StorageFile f)
    {
        long size = -1;
        try { size = (long)(await f.GetBasicPropertiesAsync()).Size; } catch { }
        return new PickedFile(f.Name, size, async () =>
        {
            var buf = await FileIO.ReadBufferAsync(f);
            return buf.ToArray();
        });
    }

    /// <summary>The open dialog (pictures only, or any file); several can be chosen. Empty when cancelled.</summary>
    public static async Task<List<PickedFile>> PickAsync(bool picture)
    {
        var res = new List<PickedFile>();
        if (TestMode && Environment.GetEnvironmentVariable("NOTIVELO_TEST_PICK") is { Length: > 0 } hook)
        {
            foreach (var p in hook.Split('|', StringSplitOptions.RemoveEmptyEntries)) if (File.Exists(p)) res.Add(FromPath(p));
            return res;
        }
        var picker = new FileOpenPicker { SuggestedStartLocation = picture ? PickerLocationId.PicturesLibrary : PickerLocationId.DocumentsLibrary };
        if (picture) foreach (var e in MediaRules.PictureExtensions) picker.FileTypeFilter.Add(e); else picker.FileTypeFilter.Add("*");
        InitializeWithWindow.Initialize(picker, BoxTextView.WindowHandle);
        var files = await picker.PickMultipleFilesAsync();
        foreach (var f in files) res.Add(await FromStorageFile(f));
        return res;
    }

    /// <summary>The files (or a bitmap, as image.png) in a clipboard or drag payload. A bitmap counts only when <paramref name="bitmapOnly"/> says the payload has no
    /// text or HTML of its own (a picture copied from a web page also carries its HTML, which the editor pastes itself).</summary>
    public static async Task<List<PickedFile>> FromDataView(DataPackageView v, bool bitmapOnly)
    {
        var res = new List<PickedFile>();
        if (v.Contains(StandardDataFormats.StorageItems))
        {
            var items = await v.GetStorageItemsAsync();
            foreach (var it in items) if (it is StorageFile f) res.Add(await FromStorageFile(f));
            if (res.Count > 0) return res;
        }
        if (v.Contains(StandardDataFormats.Bitmap) && (!bitmapOnly || (!v.Contains(StandardDataFormats.Html) && !v.Contains(StandardDataFormats.Text))))
        {
            var rs = await v.GetBitmapAsync();
            using var s = await rs.OpenReadAsync();
            var dec = await BitmapDecoder.CreateAsync(s);
            using var sb = await dec.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
            var ms = new InMemoryRandomAccessStream();
            var enc = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, ms);
            enc.SetSoftwareBitmap(sb);
            await enc.FlushAsync();
            var bytes = new byte[ms.Size];
            ms.Seek(0);
            await ms.ReadAsync(bytes.AsBuffer(), (uint)ms.Size, InputStreamOptions.None);
            ms.Dispose();
            res.Add(new PickedFile("image.png", bytes.LongLength, () => Task.FromResult(bytes)));
        }
        return res;
    }

    /// <summary>"Save as…": the save dialog, then the bytes. Returns false when cancelled.</summary>
    public static async Task<bool> SaveAsync(string name, byte[] bytes)
    {
        name = MediaRules.SafeFileName(name);
        if (TestMode && Environment.GetEnvironmentVariable("NOTIVELO_TEST_SAVE") is { Length: > 0 } path)
        {
            await File.WriteAllBytesAsync(path, bytes);
            return true;
        }
        var picker = new FileSavePicker { SuggestedFileName = Path.GetFileNameWithoutExtension(name), SuggestedStartLocation = PickerLocationId.Downloads };
        var ext = MediaRules.ExtOf(name);
        picker.FileTypeChoices.Add(ext.Length > 0 ? ext.TrimStart('.').ToUpperInvariant() + " file" : "File", new List<string> { ext.Length > 0 ? ext : "." });
        InitializeWithWindow.Initialize(picker, BoxTextView.WindowHandle);
        var f = await picker.PickSaveFileAsync();
        if (f is null) return false;
        await FileIO.WriteBytesAsync(f, bytes);
        return true;
    }

    /// <summary>Write the file to a fresh temp folder and open it with its default app (flagged untrusted, so Windows warns before it runs a program).
    /// Returns the path written; in the offline test mode with <c>NOTIVELO_TEST_NOLAUNCH</c> set the file is written but not launched.</summary>
    public static async Task<string> OpenAsync(string name, byte[] bytes)
    {
        var dir = Path.Combine(Path.GetTempPath(), "Notivelo", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, MediaRules.SafeFileName(name));
        await File.WriteAllBytesAsync(path, bytes);
        if (TestMode && Environment.GetEnvironmentVariable("NOTIVELO_TEST_NOLAUNCH") is not null) return path;
        var f = await StorageFile.GetFileFromPathAsync(path);
        await global::Windows.System.Launcher.LaunchFileAsync(f, new global::Windows.System.LauncherOptions { TreatAsUntrusted = true });
        return path;
    }
}
