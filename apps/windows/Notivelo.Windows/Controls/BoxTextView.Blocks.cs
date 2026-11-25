using Microsoft.UI.Xaml;
using Notivelo.Windows.Text;
using N = Notivelo.Native;

namespace Notivelo.Windows.Controls;

/// <summary>The block menu of a box (left4; Apple's block handle, the web's drag handle): which line a point or the caret is on, where a line sits, and the block edits
/// (<see cref="BlockOps"/>: move up or down through the engine's moveBlockUp / moveBlockDown, duplicate, delete, turn into). The page draws the handle and the menu.</summary>
internal sealed partial class BoxTextView
{
    /// <summary>Ctrl+Shift+M, or "Block options" in the right-click menu: the page opens the block menu for this box and line.</summary>
    public static event Action<BoxTextView, int>? BlockMenuRequested;

    public int LineCount => _r?.View.Lines.Length ?? 0;

    /// <summary>The line the caret is on (-1 when the box has no text view yet).</summary>
    public int CaretLineIndex => _r is { } r ? BlockOps.CaretLine(r.View) : -1;

    /// <summary>The line under a y in this view's own coordinates (the last line starting at or above it); -1 when there is none.</summary>
    public int LineAtY(double y)
    {
        var at = -1;
        for (var i = 0; i < _boxes.Count; i++) { if (_boxes[i].Hidden) continue; if (_boxes[i].Y <= y) at = i; else break; }
        return at;
    }

    /// <summary>Top and height of a line in this view's coordinates.</summary>
    public (double Top, double Height)? LineBand(int line) => line >= 0 && line < _boxes.Count ? (_boxes[line].Y, Math.Max(_boxes[line].H, 20)) : null;

    /// <summary>What the block menu offers for a line: up and down when the block has a neighbour on that side, duplicate for a text block that isn't a task.</summary>
    public (bool Up, bool Down, bool Duplicate, bool Any) BlockCan(int line)
    {
        if (_r is not { } r || BlockOps.Of(r.View.Lines, line) is not { } span) return (false, false, false, false);
        var l = r.View.Lines[line];
        return (span.FirstLine > 0, span.LastLine + 1 < r.View.Lines.Length, l.IsText && l.TaskId is null, true);
    }

    public void OpenBlockMenu(int line) => BlockMenuRequested?.Invoke(this, line);

    private bool BlockEdit(Func<N.EditorSession, bool> edit)
    {
        if (!Interactive) return false;
        try
        {
            if (_composing || _r?.View.Marked is not null) { _session.FinishComposition(); _composing = false; _ime.Clear(); }
            var ok = edit(_session);
            Render();
            return ok;
        }
        catch (Exception e) { Log("block", e); return false; }
    }

    public bool BlockMove(int line, bool up) => BlockEdit(s => BlockOps.Move(s, line, up));
    public bool BlockDelete(int line) => BlockEdit(s => BlockOps.Delete(s, line));
    public bool BlockDuplicate(int line) => BlockEdit(s => BlockOps.Duplicate(s, line));
    public bool BlockTurn(int line, string command, string args) => BlockEdit(s => BlockOps.Turn(s, line, command, args));
}
