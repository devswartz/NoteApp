using N = Notivelo.Native;

namespace Notivelo.Windows.Controls;

// What the ribbon's last editing buttons do through the engine: Clear formatting, Divider and Link to page (the slash menu's own picks).
internal sealed partial class BoxTextView
{
    /// <summary>Take the marks off the selection (or what is typed next): bold, italic, underline, strike, code, colour and highlight. Links and comments stay.</summary>
    public bool ClearFormatting()
    {
        if (!Interactive) return false;
        var any = false;
        try
        {
            if (_composing || _r?.View.Marked is not null) { _session.FinishComposition(); _composing = false; _ime.Clear(); }
            var marks = _r?.Active.Marks ?? Array.Empty<N.ViewMark>();
            foreach (var (kind, name) in new[] { (N.ViewMarkKind.Bold, "bold"), (N.ViewMarkKind.Italic, "italic"), (N.ViewMarkKind.Underline, "underline"), (N.ViewMarkKind.Strike, "strike"), (N.ViewMarkKind.Code, "code") })
                if (marks.Any(m => m.Kind == kind)) any |= _session.Command("toggleMark", "{\"mark\":\"" + name + "\"}");
            if (marks.Any(m => m.Kind == N.ViewMarkKind.TextColor)) any |= _session.Command("unsetColor", "{}");
            if (marks.Any(m => m.Kind == N.ViewMarkKind.Highlight)) any |= _session.Command("unsetHighlight", "{}");
            Render();
        }
        catch (Exception e) { Log("clear formatting", e); }
        return any;
    }

    /// <summary>The slash menu's "Divider" or "Link to page" from the ribbon: a "/" is typed and picked (taken back when the caret is not where the menu opens), "[[" opens the page picker.</summary>
    public bool RibbonInsert(string kind)
    {
        if (!Interactive) return false;
        try
        {
            if (_composing || _r?.View.Marked is not null) { _session.FinishComposition(); _composing = false; _ime.Clear(); }
            bool ok;
            if (kind == "page-link") { _session.InsertText("[["); ok = true; }
            else
            {
                var title = kind == "divider" ? "Divider" : kind;   // any other kind is a slash item's title (e.g. "Callout")
                _session.InsertText("/");
                ok = _session.Command("pickSlash", System.Text.Json.JsonSerializer.Serialize(new { title }));
                if (!ok) _session.Key("Backspace");
            }
            Render();
            return ok;
        }
        catch (Exception e) { Log("ribbon insert " + kind, e); return false; }
    }
}
