using System.Text.Json;

namespace Notivelo.Windows.Text;

/// <summary>The XAML-free rules of the box clipboard (Apple's PasteboardBoxes; the web's <c>boxClipboard.ts</c>): the clip is the core's <c>BoxesJson</c> string,
/// kept on the Windows clipboard under a custom format next to its plain text, and in the app so it also survives a clipboard another program replaced.</summary>
internal static class BoxClipboardRules
{
    /// <summary>The clipboard format name of a box clip.</summary>
    public const string Format = "NotiveloBoxes";

    /// <summary>The plain text of a clip (its <c>text</c> field), or "" when it isn't one.</summary>
    public static string PlainText(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return "";
        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? "" : "";
        }
        catch (JsonException) { return ""; }
    }

    /// <summary>A clip is an object with a non-empty <c>boxes</c> array (or such an array itself).</summary>
    public static bool IsClip(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return false;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            if (r.ValueKind == JsonValueKind.Array) return r.GetArrayLength() > 0;
            return r.ValueKind == JsonValueKind.Object && r.TryGetProperty("boxes", out var b) && b.ValueKind == JsonValueKind.Array && b.GetArrayLength() > 0;
        }
        catch (JsonException) { return false; }
    }

    /// <summary>The clip to paste: the clipboard's own box format when it is there; else the app's last clip while the clipboard's text is still that clip's text
    /// (nothing was copied elsewhere since); else none.</summary>
    public static string? Choose(string? systemClip, string? systemText, string? appClip)
    {
        if (IsClip(systemClip)) return systemClip;
        if (IsClip(appClip) && (systemText ?? "") == PlainText(appClip)) return appClip;
        return null;
    }

    /// <summary>Where a pasted group lands without a pointer: its own place nudged down and right in 24 pt steps until no box sits exactly there (the web's placeBoxes).</summary>
    public static (double X, double Y) Nudge(double x, double y, IEnumerable<(double X, double Y)> existing)
    {
        var taken = existing.Select(e => (Math.Round(e.X), Math.Round(e.Y))).ToHashSet();
        var px = Math.Round(x); var py = Math.Round(y);
        for (var i = 0; i < 200 && taken.Contains((px, py)); i++) { px += 24; py += 24; }
        return (px, py);
    }

    /// <summary>The selected box ids in page order.</summary>
    public static IReadOnlyList<string> InOrder(IEnumerable<string> selected, IEnumerable<string> pageOrder)
    {
        var set = new HashSet<string>(selected);
        return pageOrder.Where(set.Contains).ToList();
    }

    /// <summary>What the key does to a selected box: Ctrl+C copy, Ctrl+X cut, Ctrl+D duplicate, Ctrl+V paste, Delete / Backspace delete, Escape deselect; else none.
    /// <paramref name="key"/> is the virtual key's name ("C", "Delete", "Back", "Escape").</summary>
    public static string? KeyAction(string key, bool ctrl, bool shift) => (key.ToUpperInvariant(), ctrl, shift) switch
    {
        ("C", true, false) => "copy",
        ("X", true, false) => "cut",
        ("D", true, false) => "duplicate",
        ("V", true, false) => "paste",
        ("DELETE", false, _) or ("BACK", false, _) => "delete",
        ("ESCAPE", false, _) => "deselect",
        _ => null,
    };
}
