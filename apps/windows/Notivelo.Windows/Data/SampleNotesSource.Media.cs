using Notivelo.Windows.Text;

namespace Notivelo.Windows.Data;

/// <summary>Images and attachments in the offline sample: uploads stay in memory under fake <c>/uploads/&lt;id&gt;&lt;ext&gt;</c> paths and are served back to the view,
/// so the whole flow (pick, upload, insert, draw, open) works without a server and in the UI tests. The same limits and errors as the core's.</summary>
public sealed partial class SampleNotesSource
{
    private readonly Dictionary<string, (byte[] Bytes, string Mime)> _uploads = new();

    public bool CanUpload(string pageId) => Offline;

    public async System.Threading.Tasks.Task<MediaResult<UploadedMedia>> UploadFile(string pageId, string name, byte[] data)
    {
        name = MediaRules.NameOrFile(name);
        await System.Threading.Tasks.Task.Delay(Environment.GetEnvironmentVariable("NOTIVELO_UPLOAD_DELAY_MS") is { } d && int.TryParse(d, out var ms) ? ms : 120);
        if (data.Length == 0) return MediaResult<UploadedMedia>.Fail(MediaRules.UploadError(400, "file_empty", null, name, false));
        if (data.LongLength > MediaRules.MaxBytes) return MediaResult<UploadedMedia>.Fail(MediaRules.UploadError(413, "file_too_large", null, name, false));
        var mime = MediaRules.MimeOf(name);
        var ext = mime == "application/octet-stream" ? "" : MediaRules.ExtOf(name);
        var url = "/uploads/" + Guid.NewGuid().ToString("N") + ext;
        lock (_uploads) _uploads[url] = (data, mime);
        Log($"upload {name} {data.Length} {mime}");
        return new MediaResult<UploadedMedia>(new UploadedMedia(url, name, mime, data.LongLength));
    }

    public System.Threading.Tasks.Task<string?> FileUrl(string stored) => System.Threading.Tasks.Task.FromResult<string?>(stored.StartsWith("/uploads/") ? "sample:" + stored : stored);

    public System.Threading.Tasks.Task<MediaResult<MediaBytes>> DownloadFile(string stored)
    {
        lock (_uploads)
            return System.Threading.Tasks.Task.FromResult(_uploads.TryGetValue(stored, out var f)
                ? new MediaResult<MediaBytes>(new MediaBytes(f.Bytes, f.Mime))
                : MediaResult<MediaBytes>.Fail("This file isn't available."));
    }
}
