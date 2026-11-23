using System.Globalization;
using System.Text;

namespace Notivelo.Windows.Text;

/// <summary>How a platform text update (<c>CoreTextEditContext.TextUpdating</c>) is told to the editor session (WINDOWS-TEXT-VIEW 2.2).</summary>
public enum UpdateKind
{
    /// <summary>Text typed at the selection: <c>InsertText</c> (input rules run).</summary>
    Insert,
    /// <summary>A range that is not the selection: <c>ReplaceViewRange</c> (autocorrect, dictation, reconversion).</summary>
    Replace,
    /// <summary>A line break at the selection: the key Enter.</summary>
    Enter,
    /// <summary>A tab at the selection: the key Tab.</summary>
    Tab,
    /// <summary>One code unit deleted before a caret: the key Backspace.</summary>
    Backspace,
}

/// <summary>A plain description of a selection, in view offsets.</summary>
public readonly record struct Span(int Start, int End)
{
    public int Length => End - Start;
    public bool IsEmpty => End == Start;
}

/// <summary>Offset mapping and key mapping for the box view, free of any UI type so it can be unit tested.</summary>
public static class InputMap
{
    /// <summary>The smallest edit turning <paramref name="a"/> into <paramref name="b"/>: the common prefix and suffix are kept
    /// (never splitting a surrogate pair). Returns the start, the end of the replaced stretch in <paramref name="a"/> and the length of what replaced it in <paramref name="b"/>.</summary>
    public static (int Start, int OldEnd, int NewLen) DiffRange(string a, string b)
    {
        var max = Math.Min(a.Length, b.Length);
        var p = 0;
        while (p < max && a[p] == b[p]) p++;
        if (p > 0 && p < max + 1 && p <= a.Length && p <= b.Length && IsSplit(a, p)) p--;
        var s = 0;
        while (s < max - p && a[a.Length - 1 - s] == b[b.Length - 1 - s]) s++;
        if (s > 0 && IsSplit(a, a.Length - s)) s--;
        return (p, a.Length - s, b.Length - s - p);
    }

    private static bool IsSplit(string t, int at) => at > 0 && at < t.Length && char.IsHighSurrogate(t[at - 1]) && char.IsLowSurrogate(t[at]);

    /// <summary>The text with [from, to) replaced.</summary>
    public static string Splice(string s, int from, int to, string insert)
    {
        from = Math.Clamp(from, 0, s.Length);
        to = Math.Clamp(to, from, s.Length);
        return string.Concat(s.AsSpan(0, from), insert, s.AsSpan(to));
    }

    /// <summary>Tells what a platform update (range, new text) means to the engine. <paramref name="selFrom"/>..<paramref name="selTo"/> is the selection.</summary>
    public static UpdateKind ClassifyUpdate(string viewText, int selFrom, int selTo, int rangeFrom, int rangeTo, string text)
    {
        var atSel = rangeFrom == selFrom && rangeTo == selTo;
        if (atSel && (text == "\r" || text == "\n" || text == "\r\n")) return UpdateKind.Enter;
        if (atSel && text == "\t") return UpdateKind.Tab;
        if (text.Length == 0 && selFrom == selTo && rangeTo == selFrom && rangeFrom == selFrom - 1 && selFrom >= 1 && selFrom <= viewText.Length
            && !char.IsLowSurrogate(viewText[selFrom - 1]) && viewText[selFrom - 1] != '\n' && viewText[selFrom - 1] != '￼')
            return UpdateKind.Backspace;
        return atSel ? UpdateKind.Insert : UpdateKind.Replace;
    }

    // ---- keys -----------------------------------------------------------------------------------------------------

    private static readonly HashSet<string> Editing = new() { "Enter", "Backspace", "Delete", "Tab", "Escape" };
    private static readonly HashSet<string> Moves = new() { "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown" };

    /// <summary>The chord the engine's <c>key()</c> gets for a key press, or null when the press is the view's (caret movement) or text
    /// (which arrives through the text services). AltGr (Ctrl+Alt) with a printable key is text. Mod is Ctrl.</summary>
    public static string? ChordOf(string key, bool ctrl, bool alt, bool shift, bool altGr = false, bool menuOpen = false)
    {
        if (altGr) { ctrl = false; alt = false; }
        var editing = Editing.Contains(key);
        var move = Moves.Contains(key);
        if (move)
        {
            // Alt+Shift+Arrow moves a block (the engine's); an open menu takes plain Up and Down; the rest is caret movement.
            var block = alt && shift && (key == "ArrowUp" || key == "ArrowDown");
            var menu = menuOpen && !ctrl && !alt && !shift && (key == "ArrowUp" || key == "ArrowDown");
            if (!block && !menu) return null;
        }
        else if (!ctrl && !alt && !editing) return null;
        if (key.Length == 1) key = key.ToLowerInvariant();
        return (ctrl ? "Mod+" : "") + (alt ? "Alt+" : "") + (shift ? "Shift+" : "") + key;
    }

    // ---- text units -----------------------------------------------------------------------------------------------

    private enum Cls { Word, Space, Other, Break }

    private static Cls ClassOf(char c) =>
        c == '\n' ? Cls.Break : char.IsWhiteSpace(c) ? Cls.Space : char.IsLetterOrDigit(c) || c == '_' || char.IsSurrogate(c) || c == '\'' ? Cls.Word : c == '￼' ? Cls.Other : Cls.Other;

    /// <summary>The word around an offset (a double click): the run of letters and digits, else the run of spaces or of other marks. Never crosses a line feed.</summary>
    public static Span WordAt(string text, int offset)
    {
        if (text.Length == 0) return new Span(0, 0);
        offset = Math.Clamp(offset, 0, text.Length);
        var i = offset < text.Length && text[offset] != '\n' ? offset : offset - 1;
        if (i < 0 || text[i] == '\n') return new Span(offset, offset);
        // at the edge between a word and the space after it, the word wins
        if (i == offset && i > 0 && ClassOf(text[i]) == Cls.Space && ClassOf(text[i - 1]) == Cls.Word) i--;
        var cls = ClassOf(text[i]);
        if (text[i] == '￼') return new Span(i, i + 1);
        var a = i;
        while (a > 0 && ClassOf(text[a - 1]) == cls && text[a - 1] != '￼') a--;
        var b = i + 1;
        while (b < text.Length && ClassOf(text[b]) == cls && text[b] != '￼') b++;
        return new Span(a, b);
    }

    /// <summary>Ctrl+Left: the start of the word before the offset (skipping spaces); a line feed counts as one step.</summary>
    public static int WordLeft(string text, int offset)
    {
        var i = Math.Clamp(offset, 0, text.Length);
        if (i == 0) return 0;
        if (text[i - 1] == '\n') return i - 1;
        while (i > 0 && ClassOf(text[i - 1]) == Cls.Space) i--;
        if (i == 0 || text[i - 1] == '\n') return i;
        if (text[i - 1] == '￼') return i - 1;
        var cls = ClassOf(text[i - 1]);
        while (i > 0 && ClassOf(text[i - 1]) == cls && text[i - 1] != '￼') i--;
        return i;
    }

    /// <summary>Ctrl+Right: the start of the next word (Windows convention: past the word and the spaces after it).</summary>
    public static int WordRight(string text, int offset)
    {
        var i = Math.Clamp(offset, 0, text.Length);
        if (i >= text.Length) return text.Length;
        if (text[i] == '\n') return i + 1;
        if (text[i] == '￼') return i + 1;
        var cls = ClassOf(text[i]);
        if (cls != Cls.Space) while (i < text.Length && ClassOf(text[i]) == cls && text[i] != '￼') i++;
        while (i < text.Length && ClassOf(text[i]) == Cls.Space) i++;
        return i;
    }

    /// <summary>The previous caret position: one text element (grapheme cluster) back; a U+FFFC and a line feed are one step.</summary>
    public static int Prev(string text, int offset)
    {
        var i = Math.Clamp(offset, 0, text.Length);
        if (i == 0) return 0;
        if (text[i - 1] is '\n' or '￼') return i - 1;
        var starts = StringInfo.ParseCombiningCharacters(text.Substring(Math.Max(0, i - 64), Math.Min(64, i)));
        var baseAt = Math.Max(0, i - 64);
        var best = i - 1;
        foreach (var st in starts) { if (baseAt + st < i) best = baseAt + st; }
        // a run of marks never reaches past a line feed
        var nl = text.LastIndexOf('\n', i - 1, i - best);
        return nl >= best ? nl + 1 : best;
    }

    /// <summary>The next caret position: one text element forward.</summary>
    public static int Next(string text, int offset)
    {
        var i = Math.Clamp(offset, 0, text.Length);
        if (i >= text.Length) return text.Length;
        if (text[i] is '\n' or '￼') return i + 1;
        var n = StringInfo.GetNextTextElementLength(text, i);
        var end = Math.Min(text.Length, i + Math.Max(1, n));
        var nl = text.IndexOf('\n', i, end - i);
        return nl >= 0 ? Math.Max(nl, i + 1) : end;
    }

    // ---- hit testing ----------------------------------------------------------------------------------------------

    /// <summary>The index of the rectangle a point is in, else the nearest one by vertical distance and then horizontal distance
    /// (-1 for none). Lines of one table row share a Y, so the containing rectangle wins before distance does.</summary>
    public static int NearestRect(IReadOnlyList<(double X, double Y, double W, double H, bool Skip)> rects, double x, double y)
    {
        var best = -1;
        var bestD = (double.MaxValue, double.MaxValue);
        for (var i = 0; i < rects.Count; i++)
        {
            var r = rects[i];
            if (r.Skip) continue;
            var dy = y < r.Y ? r.Y - y : y > r.Y + r.H ? y - (r.Y + r.H) : 0;
            var dx = x < r.X ? r.X - x : x > r.X + r.W ? x - (r.X + r.W) : 0;
            var d = (dy, dx);
            if (d.dy < bestD.Item1 || (d.dy == bestD.Item1 && d.dx < bestD.Item2)) { bestD = d; best = i; }
            if (dy == 0 && dx == 0) return i;
        }
        return best;
    }

    /// <summary>The offset of an object line (a rule, image, file or task): before its U+FFFC on the left half, after it on the right.</summary>
    public static int ObjectOffset(int lineOffset, double x, double left, double width) => lineOffset + (x > left + width / 2 ? 1 : 0);
}

/// <summary>The CF_HTML clipboard format: a header with byte offsets, then the HTML with the fragment between markers.</summary>
public static class CfHtml
{
    private const string StartMark = "<!--StartFragment-->";
    private const string EndMark = "<!--EndFragment-->";

    /// <summary>Wraps an HTML fragment in the CF_HTML envelope (version 1.0, offsets in UTF-8 bytes, ten digits each).</summary>
    public static string Create(string fragment)
    {
        const string head = "Version:1.0\r\nStartHTML:{0:D10}\r\nEndHTML:{1:D10}\r\nStartFragment:{2:D10}\r\nEndFragment:{3:D10}\r\n";
        var pre = "<html><body>\r\n" + StartMark;
        var post = EndMark + "\r\n</body></html>";
        var headLen = string.Format(CultureInfo.InvariantCulture, head, 0, 0, 0, 0).Length;
        var u8 = Encoding.UTF8;
        var startHtml = headLen;
        var startFrag = startHtml + u8.GetByteCount(pre);
        var endFrag = startFrag + u8.GetByteCount(fragment);
        var endHtml = endFrag + u8.GetByteCount(post);
        return string.Format(CultureInfo.InvariantCulture, head, startHtml, endHtml, startFrag, endFrag) + pre + fragment + post;
    }

    /// <summary>The HTML fragment of a CF_HTML string: by the header's byte offsets, else between the markers, else everything after the header.</summary>
    public static string Fragment(string cf)
    {
        if (string.IsNullOrEmpty(cf)) return "";
        if (cf.IndexOf("StartFragment:", StringComparison.Ordinal) is var i && i >= 0)
        {
            var bytes = Encoding.UTF8.GetBytes(cf);
            var s = Header(cf, "StartFragment:");
            var e = Header(cf, "EndFragment:");
            if (s >= 0 && e >= s && e <= bytes.Length) return Encoding.UTF8.GetString(bytes, s, e - s);
        }
        var a = cf.IndexOf(StartMark, StringComparison.Ordinal);
        var b = cf.IndexOf(EndMark, StringComparison.Ordinal);
        if (a >= 0 && b > a) return cf.Substring(a + StartMark.Length, b - a - StartMark.Length);
        var h = cf.IndexOf("<html", StringComparison.OrdinalIgnoreCase);
        return h >= 0 ? cf[h..] : cf;
    }

    private static int Header(string cf, string name)
    {
        var at = cf.IndexOf(name, StringComparison.Ordinal);
        if (at < 0) return -1;
        var from = at + name.Length;
        var to = from;
        while (to < cf.Length && char.IsDigit(cf[to])) to++;
        return int.TryParse(cf.AsSpan(from, to - from), NumberStyles.None, CultureInfo.InvariantCulture, out var v) ? v : -1;
    }
}
