using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.Graphics.Canvas;
using Notivelo.Windows.Data;
using Windows.Storage.Streams;

namespace Notivelo.Windows.Controls;

/// <summary>The pictures the box views draw: a stored path is turned into a link with the source's <c>FileUrl</c> (signed, valid for hours, so it is asked for again
/// rather than kept) or, for the offline sample, read from the source's bytes; the pixels are decoded once into a Win2D bitmap and kept for the page's lifetime
/// (<see cref="Clear"/> when the page changes). A failed load is tried again after a short while. All of it runs on the UI thread.</summary>
internal static class MediaCache
{
    internal sealed class Entry
    {
        public CanvasBitmap? Bitmap;
        public bool Loading, Failed;
        public DateTime FailedAt;
        public double W, H;
        public readonly List<Action> Waiting = new();
        public string State => Bitmap is not null ? "loaded" : Failed ? "failed" : "loading";
    }

    private static readonly Dictionary<string, Entry> Map = new();
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };
    private static readonly TimeSpan RetryAfter = TimeSpan.FromSeconds(20);
    private const long MaxImageBytes = 60L * 1024 * 1024;

    public static Entry? Peek(string src) => Map.TryGetValue(src, out var e) ? e : null;

    /// <summary>The entry for a picture, starting its load when it has none (or its last try failed a while ago). <paramref name="done"/> is called once, on the UI thread, when the load ends.</summary>
    public static Entry Request(INotesSource source, string src, Action done)
    {
        if (!Map.TryGetValue(src, out var e)) Map[src] = e = new Entry();
        if (e.Bitmap is not null) return e;
        if (e.Loading) { if (!e.Waiting.Contains(done)) e.Waiting.Add(done); return e; }
        if (e.Failed && DateTime.UtcNow - e.FailedAt < RetryAfter) return e;
        e.Loading = true; e.Failed = false; e.Waiting.Add(done);
        _ = Load(source, src, e);
        return e;
    }

    private static async Task Load(INotesSource source, string src, Entry e)
    {
        try
        {
            byte[]? bytes = null;
            var url = await source.FileUrl(src);
            if (url is null) throw new InvalidOperationException("no link");
            if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                bytes = await Http.GetByteArrayAsync(url);
            else
            {
                var r = await source.DownloadFile(src);
                if (!r.Ok) throw new InvalidOperationException(r.Error);
                bytes = r.Value!.Bytes;
            }
            if (bytes.LongLength > MaxImageBytes) throw new InvalidOperationException("too big");
            using var ms = new InMemoryRandomAccessStream();
            await ms.WriteAsync(bytes.AsBuffer());
            ms.Seek(0);
            var bmp = await CanvasBitmap.LoadAsync(CanvasDevice.GetSharedDevice(), ms);
            e.Bitmap = bmp; e.W = bmp.Size.Width; e.H = bmp.Size.Height;
        }
        catch (Exception ex)
        {
            e.Failed = true; e.FailedAt = DateTime.UtcNow;
            BoxTextView.Log("image " + src, ex);
        }
        finally
        {
            e.Loading = false;
            var waiting = e.Waiting.ToList(); e.Waiting.Clear();
            foreach (var w in waiting) { try { w(); } catch { } }
        }
    }

    /// <summary>The page changed: pictures are loaded again for the next one (bitmaps are left to the finalizer; a view may still be drawing one).</summary>
    public static void Clear() => Map.Clear();
}
