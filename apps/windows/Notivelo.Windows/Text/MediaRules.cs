namespace Notivelo.Windows.Text;

/// <summary>The XAML-free rules of images and attachments (the web's <c>blocks.tsx</c> and the core contract): which upload becomes an image, how sizes
/// read, how an image is sized and resized, which icon a file card shows, and the type of a file by its name (the offline sample's uploads).</summary>
internal static class MediaRules
{
    /// <summary>The server's limit; the core refuses a bigger file before sending it.</summary>
    public const long MaxBytes = 25L * 1024 * 1024;
    /// <summary>The web's smallest image width.</summary>
    public const double MinImageWidth = 80;

    /// <summary>The web inserts an image node when the type starts with image/ and isn't HEIC (browsers can't draw it); SVG is stored as a download, never an image.</summary>
    public static bool IsImage(string? mime)
    {
        if (string.IsNullOrEmpty(mime)) return false;
        var m = mime.Trim().ToLowerInvariant();
        return m.StartsWith("image/") && m != "image/heic" && m != "image/heif" && !m.Contains("svg");
    }

    /// <summary>The web's <c>formatSize</c>: nothing for 0, "B", whole "KB", "MB" with one decimal.</summary>
    public static string SizeText(double bytes) =>
        bytes <= 0 ? "" : bytes < 1024 ? $"{bytes:0} B" : bytes < 1048576 ? $"{bytes / 1024:0} KB" : $"{bytes / 1048576:0.0} MB";

    /// <summary>The web's resize clamp: at least 80, whole units.</summary>
    public static double ClampWidth(double width) => Math.Max(MinImageWidth, Math.Round(width));

    /// <summary>Height for a width at the picture's own proportions (the web's resize keeps the aspect ratio); null when the size isn't known.</summary>
    public static double? HeightFor(double width, double naturalW, double naturalH) =>
        naturalW > 0 && naturalH > 0 ? Math.Round(ClampWidth(width) * naturalH / naturalW) : null;

    /// <summary>The size an image is drawn at: the stored width (and height, else the aspect of the picture, else a 5:3 placeholder), the picture's own
    /// width when nothing is stored, never wider than the box; the proportions are kept when it is shrunk to fit.</summary>
    public static (double W, double H) DisplaySize(double attrW, double attrH, double naturalW, double naturalH, double avail)
    {
        avail = Math.Max(MinImageWidth, avail);
        var known = naturalW > 0 && naturalH > 0;
        double w = attrW > 0 ? attrW : known ? naturalW : Math.Min(avail, 320);
        double h;
        if (attrW > 0 && attrH > 0) h = attrH;
        else if (known) h = w * naturalH / naturalW;
        else h = Math.Min(120, Math.Round(w * 0.6));
        if (w > avail) { h = h * avail / w; w = avail; }
        return (Math.Round(w), Math.Max(1, Math.Round(h)));
    }

    /// <summary>The icon of a file card (the web's <c>fileIcon</c>).</summary>
    public static string IconOf(string? mime, string? name)
    {
        var m = (mime ?? "").ToLowerInvariant();
        var ext = ExtOf(name).TrimStart('.');
        if (m.StartsWith("image/")) return "file-image";
        if (m.StartsWith("video/")) return "file-play";
        if (m.StartsWith("audio/")) return "file-headphone";
        if (m.Contains("zip") || m.Contains("tar") || m.Contains("gzip") || m.Contains("7z") || m.Contains("rar") || ext is "zip" or "gz" or "7z" or "rar" or "tar") return "file-archive";
        if (m.Contains("sheet") || m.Contains("excel") || m.Contains("csv") || ext is "xls" or "xlsx" or "csv" or "numbers") return "file-spreadsheet";
        if (m.StartsWith("text/") || m.Contains("pdf") || m.Contains("word") || m.Contains("document")) return "file-text";
        return "file";
    }

    public static string ExtOf(string? name)
    {
        if (string.IsNullOrEmpty(name)) return "";
        var i = name.LastIndexOf('.');
        return i <= 0 || i == name.Length - 1 || name.Length - i > 12 ? "" : name[i..].ToLowerInvariant();
    }

    private static readonly Dictionary<string, string> Types = new()
    {
        [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg", [".gif"] = "image/gif", [".webp"] = "image/webp", [".avif"] = "image/avif",
        [".heic"] = "image/heic", [".pdf"] = "application/pdf", [".txt"] = "text/plain", [".csv"] = "text/csv", [".json"] = "application/json", [".md"] = "text/markdown",
        [".doc"] = "application/msword", [".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        [".xls"] = "application/vnd.ms-excel", [".xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        [".ppt"] = "application/vnd.ms-powerpoint", [".pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        [".zip"] = "application/zip", [".gz"] = "application/gzip", [".mp3"] = "audio/mpeg", [".m4a"] = "audio/mp4", [".wav"] = "audio/wav",
        [".mp4"] = "video/mp4", [".mov"] = "video/quicktime", [".webm"] = "video/webm",
    };

    /// <summary>The type the server would report for a file name (its allow-list by extension; anything else, SVG included, is an octet-stream download).</summary>
    public static string MimeOf(string? name) => Types.TryGetValue(ExtOf(name), out var m) ? m : "application/octet-stream";

    /// <summary>A name to show for an upload that has none (the server's own fallback).</summary>
    public static string NameOrFile(string? name) => string.IsNullOrWhiteSpace(name) ? "file" : name.Trim();

    /// <summary>The ribbon's picture picker offers these (the web's image types; HEIC goes in as a file card).</summary>
    public static readonly string[] PictureExtensions = { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".heic" };

    /// <summary>One sentence for a failed upload (core: 413 file_too_large, 400 file_empty, 403 view-only, 404 page, network offline).</summary>
    public static string UploadError(int? status, string? code, string? message, string name, bool offline)
    {
        name = NameOrFile(name);
        if (offline) return "You're offline. Connect to the internet to add files.";
        if (status == 413 || code == "file_too_large") return $"“{name}” is larger than 25 MB.";
        if (status == 400 && code == "file_empty") return $"“{name}” is empty.";
        if (status == 403) return "You have view-only access to this page.";
        if (status == 404) return "This page can't be found. It may have been moved or deleted.";
        return string.IsNullOrWhiteSpace(message) ? $"Couldn't add “{name}”." : message;
    }

    /// <summary>A file name safe to write into a temp folder: no path parts, no characters Windows refuses.</summary>
    public static string SafeFileName(string? name)
    {
        var n = NameOrFile(name);
        foreach (var c in new[] { (char)92, '/', ':', '*', '?', '"', '<', '>', '|' }) n = n.Replace(c, '_');
        n = n.Trim().TrimEnd('.');
        return n.Length == 0 ? "file" : n.Length > 120 ? n[..120] : n;
    }
}
