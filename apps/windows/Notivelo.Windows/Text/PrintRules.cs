namespace Notivelo.Windows.Text;

/// <summary>The XAML-free rules of printing a page as it is laid out: the page's picture is scaled down to the paper's width and cut into sheets.</summary>
internal static class PrintRules
{
    /// <summary>How a picture of <paramref name="contentW"/> x <paramref name="contentH"/> lays out on sheets of <paramref name="pageW"/> x <paramref name="pageH"/>
    /// (the printable area): the scale (never above 1) and how many sheets it takes.</summary>
    public static (double Scale, int Sheets) Layout(double contentW, double contentH, double pageW, double pageH)
    {
        if (contentW <= 0 || contentH <= 0 || pageW <= 0 || pageH <= 0) return (1, 1);
        var scale = Math.Min(1, pageW / contentW);
        var sheets = (int)Math.Ceiling(contentH * scale / pageH - 1e-6);
        return (scale, Math.Max(1, sheets));
    }

    /// <summary>The file name offered for the PDF: the page's title without characters Windows refuses.</summary>
    public static string JobName(string title)
    {
        var clean = new string((string.IsNullOrWhiteSpace(title) ? "Notivelo page" : title).Select(c => Path.GetInvalidFileNameChars().Contains(c) ? ' ' : c).ToArray()).Trim();
        return clean.Length == 0 ? "Notivelo page" : clean.Length > 80 ? clean[..80].Trim() : clean;
    }
}
