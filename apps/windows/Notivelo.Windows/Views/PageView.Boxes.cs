using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Text;
using Windows.Foundation;

namespace Notivelo.Windows.Views;

// Selecting a canvas box as a whole and its clipboard (Apple's box selection: select, copy, cut, paste, duplicate, delete, and the box's context menu).
// A box is selected by pressing its move bar, by Escape inside it, or by pasting / duplicating (the new box); the keys then act on it.
internal sealed partial class PageView
{
    /// <summary>The field ("box:id") of the selected box, or null.</summary>
    private string? _selectedBox;
    private Point? _pasteAt;

    /// <summary>The selected box's field (a test and menu readout).</summary>
    public string? SelectedBox => _selectedBox;

    private string? SelectedId => _selectedBox is { } f && f.StartsWith("box:") ? f["box:".Length..] : null;

    /// <summary>Select a box (null: none). The page takes the keyboard so the clipboard keys reach it.</summary>
    private void Select(string? field)
    {
        if (field == _selectedBox) return;
        if (_selectedBox is { } old && _frames.TryGetValue(old, out var of)) of.SetSelected(false);
        _selectedBox = field is not null && _frames.ContainsKey(field) ? field : null;
        if (_selectedBox is { } now && _frames.TryGetValue(now, out var nf))
        {
            nf.SetSelected(true);
            if (_scroll is { } sv && BoxTextView.Focused is null) { sv.IsTabStop = true; sv.Focus(FocusState.Programmatic); }
        }
    }

    /// <summary>Escape inside a box: it is left, and now selected as a whole (an empty box goes away instead).</summary>
    private void OnBoxEscaped(BoxTextView view)
    {
        var field = _views.FirstOrDefault(kv => ReferenceEquals(kv.Value, view)).Key;
        if (field is null || !_frames.ContainsKey(field) || view.IsEmptyBox) return;
        DispatcherQueue.TryEnqueue(() => Select(field));
    }

    private static bool Down(global::Windows.System.VirtualKey key) =>
        Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(key).HasFlag(global::Windows.UI.Core.CoreVirtualKeyStates.Down);

    private void OnPageKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Handled || PageId is null || BoxTextView.Focused is not null || e.OriginalSource is Microsoft.UI.Xaml.Controls.TextBox) return;
        var ctrl = Down(global::Windows.System.VirtualKey.Control);
        var shift = Down(global::Windows.System.VirtualKey.Shift);
        // the context-menu key or Shift+F10 opens the selected box's menu at its frame's top left
        if (_selectedBox is { } sb && (e.Key == global::Windows.System.VirtualKey.Application || (shift && e.Key == global::Windows.System.VirtualKey.F10))
            && _frames.TryGetValue(sb, out var fr))
        {
            e.Handled = true;
            Point at;
            try { at = fr.Bar.TransformToVisual(null).TransformPoint(new Point(0, fr.Bar.ActualHeight)); } catch { at = new Point(200, 200); }
            ShowBoxMenu(at);
            return;
        }
        var action = BoxClipboardRules.KeyAction(e.Key.ToString(), ctrl, shift);
        if (action is null) return;
        if (action == "paste") { e.Handled = true; _pasteAt = null; _ = PasteAsync(null); return; }
        if (_selectedBox is null) return;
        e.Handled = true;
        RunBoxAction(action);
    }

    private void RunBoxAction(string action)
    {
        switch (action)
        {
            case "copy": CopySelected(false); break;
            case "cut": CopySelected(true); break;
            case "duplicate": DuplicateSelected(); break;
            case "delete": DeleteSelected(); break;
            case "deselect": Select(null); break;
        }
    }

    private void Fail(string? error) { if (error is not null) Host?.Toast(error, true); }

    private IReadOnlyList<string> SelectedIds() => SelectedId is { } id ? new[] { id } : Array.Empty<string>();

    private void CopySelected(bool cut)
    {
        if (PageId is null || SelectedIds() is not { Count: > 0 } ids) return;
        var clip = _source.BoxClip(PageId, ids);
        if (!clip.Ok) { Fail(clip.Error); return; }
        BoxClipboard.Set(clip.Value!);
        if (!cut) { Host?.Toast("Box copied"); return; }
        var gone = _source.DeleteBoxesWithContent(PageId, ids);
        if (!gone.Ok) { Fail(gone.Error); return; }
        Select(null);
        Host?.Toast("Box cut");
    }

    private void DuplicateSelected()
    {
        if (PageId is null || SelectedIds() is not { Count: > 0 } ids) return;
        var r = _source.DuplicateBoxes(PageId, ids);
        if (!r.Ok) { Fail(r.Error); return; }
        SelectNew(r.Value);
    }

    private void DeleteSelected()
    {
        if (PageId is null || SelectedIds() is not { Count: > 0 } ids) return;
        var r = _source.DeleteBoxesWithContent(PageId, ids);
        if (!r.Ok) { Fail(r.Error); return; }
        Select(null);
        UndoStateChanged?.Invoke();
    }

    /// <summary>Paste the clipboard's boxes (at a point of the canvas, or nudged from where they were) and select the first new one.</summary>
    private async Task PasteAsync(Point? at)
    {
        if (PageId is null || !_source.CanEditBoxes(PageId)) return;
        var clip = await BoxClipboard.GetAsync();
        if (clip is null) { if (at is not null) Host?.Toast("There are no boxes to paste"); return; }
        var r = _source.PasteBoxes(PageId, clip, at?.X, at?.Y);
        if (!r.Ok) { Fail(r.Error); return; }
        SelectNew(r.Value);
        UndoStateChanged?.Invoke();
    }

    private void SelectNew(IReadOnlyList<string>? ids)
    {
        if (ids is not { Count: > 0 }) return;
        Select("box:" + ids[0]);
    }

    /// <summary>The box's context menu (Cut, Copy, Paste, Duplicate, Delete) at a point in window coordinates.</summary>
    private void ShowBoxMenu(Point at)
    {
        if (Host is null || _selectedBox is null) return;
        var items = new List<MenuEntry>
        {
            new("Cut", "scissors", () => RunBoxAction("cut"), Hint: "Ctrl+X", Id: "menu-box-cut"),
            new("Copy", "copy", () => RunBoxAction("copy"), Hint: "Ctrl+C", Id: "menu-box-copy"),
            new("Paste", "clipboard-paste", () => { _pasteAt = null; _ = PasteAsync(null); }, Hint: "Ctrl+V", Id: "menu-box-paste"),
            new("Duplicate", "copy-plus", () => RunBoxAction("duplicate"), Hint: "Ctrl+D", Id: "menu-box-duplicate"),
            MenuEntry.Sep(),
            new("Delete", "trash", () => RunBoxAction("delete"), Danger: true, Hint: "Del", Id: "menu-box-delete"),
        };
        PopupMenu.Show(Host.Overlay, items, null, at: at, id: "menu-box");
    }

    /// <summary>A right-click on empty canvas: Paste at the pointer.</summary>
    private void OnSurfaceRightTapped(object sender, RightTappedRoutedEventArgs e)
    {
        if (!ReferenceEquals(e.OriginalSource, sender) || PageId is null || Host is null || !_source.CanEditBoxes(PageId)) return;
        e.Handled = true;
        Select(null);
        var onCanvas = e.GetPosition((UIElement)sender);
        var items = new List<MenuEntry>
        {
            new("Paste", "clipboard-paste", () => _ = PasteAsync(new Point(Math.Max(onCanvas.X, 0), Math.Max(onCanvas.Y, 0))), Hint: "Ctrl+V", Id: "menu-canvas-paste"),
        };
        PopupMenu.Show(Host.Overlay, items, null, at: e.GetPosition(null), id: "menu-canvas");
    }
}

// ---- print ----
internal sealed partial class PageView
{
    /// <summary>Print the page as laid out (Windows' print dialog; it also saves a PDF).</summary>
    public async void Print()
    {
        if (PageId is null || Host is null || _scroll?.Content is not FrameworkElement content) return;
        BoxTextView.Focused?.Unfocus();
        await PagePrint.ShowAsync(Host, content, _source.GetPage(PageId)?.Title ?? "", B("Bg"));
    }
}
