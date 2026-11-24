using System.Text.Json;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Geometry;
using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Text;
using Windows.ApplicationModel.DataTransfer;
using Windows.Foundation;
using Windows.UI;

namespace Notivelo.Windows.Controls;

/// <summary>Images and attachments in a box: picking (ribbon, <c>/image</c>, <c>/file</c>), paste and drop, the upload with its visible state and errors, the
/// insert commands, opening and saving, and the selected image's resize handles. Drawing the picture and the file card is in <c>BoxTextView.cs</c>.</summary>
internal sealed partial class BoxTextView
{
    /// <summary>Something to tell the user about a picture or file (text, is it an error): the shell shows it as a toast.</summary>
    public static event Action<string, bool>? Notice;

    private static void Tell(string text, bool error = false) { try { Notice?.Invoke(text, error); } catch (Exception e) { Log("notice", e); } }

    private void InitMedia()
    {
        _root.AllowDrop = true;
        _root.DragOver += OnDragOver;
        _root.Drop += OnDrop;
        _mediaLoaded = () => _dq?.TryEnqueue(() => { if (_disposed) return; _textRev = ulong.MaxValue; Render(); });
    }

    private Action _mediaLoaded = () => { };

    // ---- the uploading state ------------------------------------------------------------------------------------------------

    private int _uploading;
    private string _uploadName = "";
    private Border? _uploadBar;
    private TextBlock? _uploadText;

    private void SetUploading(int delta, string name)
    {
        _uploading = Math.Max(0, _uploading + delta);
        if (delta > 0) _uploadName = name;
        if (_uploadBar is null)
        {
            _uploadText = new TextBlock { FontSize = 12, FontFamily = Ui.Font, Foreground = C2("Text2"), VerticalAlignment = VerticalAlignment.Center };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(_uploadText, "upload-status");
            var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            sp.Children.Add(new ProgressRing { Width = 14, Height = 14, IsActive = true, VerticalAlignment = VerticalAlignment.Center });
            sp.Children.Add(_uploadText);
            _uploadBar = new Border
            {
                Padding = new Thickness(10, 5, 12, 5), CornerRadius = new CornerRadius(14), Background = C2("BgElevated"), BorderBrush = C2("Border"), BorderThickness = new Thickness(1),
                HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 0, 2), IsHitTestVisible = false,
                Visibility = Visibility.Collapsed, Child = sp,
            };
            _root.Children.Add(_uploadBar);
        }
        _uploadBar.Visibility = _uploading > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (_uploading > 0) _uploadText!.Text = _uploading == 1 ? $"Uploading {_uploadName}…" : $"Uploading {_uploading} files…";
    }

    // ---- adding files ---------------------------------------------------------------------------------------------------------

    /// <summary>Open the file dialog (pictures only for the Picture button and <c>/image</c>) and add what is chosen at the caret.</summary>
    public async Task PickMediaAsync(bool picture)
    {
        if (!CanAddFiles()) return;
        try
        {
            var files = await MediaPicker.PickAsync(picture);
            if (_disposed) return;
            Focus(FocusState.Programmatic);
            if (files.Count > 0) await AddFilesAsync(files);
        }
        catch (Exception e) { Log("pick", e); Tell("Couldn't open the file dialog.", true); }
    }

    private bool CanAddFiles()
    {
        if (!Interactive) return false;
        if (PageId is null || !_source.CanUpload(PageId))
        {
            Tell("Pictures and files can be added once the page has connected.", true);
            return false;
        }
        return true;
    }

    /// <summary>Upload each file, then insert it at the caret (an image block for a picture, a file card for anything else), one after the other.</summary>
    public async Task AddFilesAsync(IReadOnlyList<PickedFile> files)
    {
        foreach (var f in files)
        {
            if (!CanAddFiles()) return;
            var name = MediaRules.NameOrFile(f.Name);
            if (f.Size > MediaRules.MaxBytes) { Tell(MediaRules.UploadError(413, "file_too_large", null, name, false), true); continue; }
            byte[] bytes;
            try { bytes = await f.Read(); }
            catch (Exception e) { Log("read " + name, e); Tell($"Couldn't read “{name}”.", true); continue; }
            await UploadAndInsertAsync(name, bytes);
        }
    }

    private async Task UploadAndInsertAsync(string name, byte[] bytes)
    {
        if (PageId is not { } page) return;
        SetUploading(1, name);
        Data.MediaResult<Data.UploadedMedia> r;
        try { r = await _source.UploadFile(page, name, bytes); }
        catch (Exception e) { Log("upload", e); r = Data.MediaResult<Data.UploadedMedia>.Fail($"Couldn't add “{name}”."); }
        finally { SetUploading(-1, name); }
        if (!r.Ok) { Tell(r.Error ?? $"Couldn't add “{name}”.", true); return; }
        if (!Interactive) { Tell($"“{name}” was uploaded, but the box was closed before it could be added.", true); return; }
        var up = r.Value!;
        // never a signed link: the stored path is what the document keeps
        var ok = MediaRules.IsImage(up.Mime)
            ? RunCommand("insertImage", JsonSerializer.Serialize(new { src = up.Url, alt = up.Name }))
            : RunCommand("insertFile", JsonSerializer.Serialize(new { url = up.Url, name = up.Name, size = up.Size, mime = up.Mime }));
        if (!ok) Tell($"Couldn't put “{up.Name}” on the page here. Click where it should go and try again.", true);
    }

    // ---- paste and drop ------------------------------------------------------------------------------------------------------------

    /// <summary>A clipboard with files, or only a bitmap, adds them instead of pasting text. True when it did (or tried to).</summary>
    private async Task<bool> PasteMediaAsync(DataPackageView v)
    {
        if (!v.Contains(StandardDataFormats.StorageItems) && !v.Contains(StandardDataFormats.Bitmap)) return false;
        List<PickedFile> files;
        try { files = await MediaPicker.FromDataView(v, bitmapOnly: true); }
        catch (Exception e) { Log("paste media", e); return false; }
        if (files.Count == 0) return false;
        await AddFilesAsync(files);
        return true;
    }

    private void OnDragOver(object sender, DragEventArgs e)
    {
        var v = e.DataView;
        if (!Interactive || !(v.Contains(StandardDataFormats.StorageItems) || (v.Contains(StandardDataFormats.Bitmap) && !v.Contains(StandardDataFormats.Html)))) return;
        e.AcceptedOperation = DataPackageOperation.Copy;
        e.DragUIOverride.Caption = "Add to page";
        e.DragUIOverride.IsGlyphVisible = true;
        e.Handled = true;
    }

    private async void OnDrop(object sender, DragEventArgs e)
    {
        if (!Interactive) return;
        var def = e.GetDeferral();
        List<PickedFile> files;
        try
        {
            files = await MediaPicker.FromDataView(e.DataView, bitmapOnly: true);
            e.Handled = files.Count > 0;
            // the caret goes where it was dropped
            if (files.Count > 0 && _r is not null)
            {
                var off = HitOffset(e.GetPosition(_root));
                _session.SetViewSelection((uint)off, (uint)off);
                Render();
            }
        }
        catch (Exception ex) { Log("drop", ex); files = new(); }
        finally { def.Complete(); }
        if (files.Count > 0) await AddFilesAsync(files);
    }

    // ---- what is on the page --------------------------------------------------------------------------------------------------------

    private static bool IsMediaKind(string kind) => kind is "image" or "fileAttachment";

    private Deco? MediaAt(Point p)
    {
        foreach (var d in _decos)
            if (d.Kind is DecoKind.Image or DecoKind.FileCard && d.Rect.Contains(p)) return d;
        return null;
    }

    /// <summary>The image or file card the selection is on (exactly that node), or null.</summary>
    private Deco? SelectedMedia()
    {
        if (_r is not { } r) return null;
        var sel = r.View.Selection;
        var from = Math.Min(sel.Anchor, sel.Head); var to = Math.Max(sel.Anchor, sel.Head);
        foreach (var d in _decos)
        {
            if (d.Kind is not (DecoKind.Image or DecoKind.FileCard) || d.Line < 0 || d.Line >= r.View.Lines.Length) continue;
            var l = r.View.Lines[d.Line];
            if (l.Offset == from && to == from + 1) return d;
        }
        return null;
    }

    private bool IsSelectedNode(int lineIndex)
    {
        if (_r is not { } r || lineIndex < 0 || lineIndex >= r.View.Lines.Length) return false;
        var sel = r.View.Selection;
        var l = r.View.Lines[lineIndex];
        return Math.Min(sel.Anchor, sel.Head) == l.Offset && Math.Max(sel.Anchor, sel.Head) == l.Offset + 1;
    }

    private (string Url, string Name, bool Image)? MediaAttrs(int lineIndex)
    {
        if (_r is not { } r || lineIndex < 0 || lineIndex >= r.View.Lines.Length) return null;
        var l = r.View.Lines[lineIndex];
        if (!IsMediaKind(l.Kind)) return null;
        try
        {
            using var j = JsonDocument.Parse(string.IsNullOrEmpty(l.AttrsJson) ? "{}" : l.AttrsJson);
            var root = j.RootElement;
            if (l.Kind == "image")
            {
                var src = Str(root, "src") ?? "";
                var alt = Str(root, "alt");
                return (src, string.IsNullOrWhiteSpace(alt) ? "image" + MediaRules.ExtOf(src) : alt!, true);
            }
            return (Str(root, "url") ?? "", Str(root, "name") ?? "file", false);
        }
        catch (JsonException) { return null; }
    }

    /// <summary>The state of the box's pictures and cards for the UI tests' readout: <c>images=loaded,loading;files=a.pdf|b.zip;node=image</c>.</summary>
    internal string MediaState()
    {
        if (_r is not { } r) return "images=;files=;node=none";
        var images = new List<string>(); var files = new List<string>();
        for (var i = 0; i < r.View.Lines.Length; i++)
        {
            var l = r.View.Lines[i];
            if (l.Kind == "image")
            {
                var src = MediaAttrs(i)?.Url ?? "";
                images.Add(MediaCache.Peek(src)?.State ?? "none");
            }
            else if (l.Kind == "fileAttachment") files.Add((MediaAttrs(i)?.Name ?? "file").Replace(";", "%3B").Replace("|", "%7C").Replace(",", "%2C"));
        }
        var node = SelectedMedia() is { } m ? (m.Kind == DecoKind.Image ? "image" : "file") : "none";
        var sizes = _decos.Where(d => d.Kind == DecoKind.Image).Select(d => $"{Math.Round(d.Rect.Width)}x{Math.Round(d.Rect.Height)}");
        // the selected picture's bottom-right corner relative to this control's top left, in DIPs (for the resize test)
        var corner = "";
        if (SelectedMedia() is { Kind: DecoKind.Image } sel)
        {
            try
            {
                var o = _root.TransformToVisual(this).TransformPoint(new Point(sel.Rect.Right, sel.Rect.Bottom));
                corner = $"{Math.Round(o.X)},{Math.Round(o.Y)}";
            }
            catch { }
        }
        return $"images={string.Join(",", images)};files={string.Join("|", files)};sizes={string.Join(",", sizes)};corner={corner};node={node};upload={_uploading}";
    }

    // ---- open and save ---------------------------------------------------------------------------------------------------------------

    /// <summary>Download the file (or picture) to a temp folder and open it with its default app. A picture from the web opens in the browser.</summary>
    public async Task OpenMediaAsync(int lineIndex)
    {
        if (MediaAttrs(lineIndex) is not { } m || m.Url.Length == 0) return;
        try
        {
            if (m.Url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || m.Url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                if (Openable(m.Url) is { } u) await global::Windows.System.Launcher.LaunchUriAsync(u);
                return;
            }
            var r = await _source.DownloadFile(m.Url);
            if (!r.Ok) { Tell(r.Error ?? $"Couldn't open “{m.Name}”.", true); return; }
            var name = MediaRules.ExtOf(m.Name).Length == 0 ? m.Name + MediaRules.ExtOf(m.Url) : m.Name;
            var path = await MediaPicker.OpenAsync(name, r.Value!.Bytes);
            Trace("opened " + path);
        }
        catch (Exception e) { Log("open media", e); Tell($"Couldn't open “{m.Name}”.", true); }
    }

    /// <summary>"Save as…": the save dialog, then the downloaded bytes.</summary>
    public async Task SaveMediaAsync(int lineIndex)
    {
        if (MediaAttrs(lineIndex) is not { } m || m.Url.Length == 0) return;
        try
        {
            if (m.Url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) { Tell("This picture lives on the web: open it to save it.", false); return; }
            var r = await _source.DownloadFile(m.Url);
            if (!r.Ok) { Tell(r.Error ?? $"Couldn't save “{m.Name}”.", true); return; }
            var name = MediaRules.ExtOf(m.Name).Length == 0 ? m.Name + MediaRules.ExtOf(m.Url) : m.Name;
            if (await MediaPicker.SaveAsync(name, r.Value!.Bytes)) Tell($"Saved “{m.Name}”");
        }
        catch (Exception e) { Log("save media", e); Tell($"Couldn't save “{m.Name}”.", true); }
    }

    // ---- resizing the selected image ---------------------------------------------------------------------------------------------------

    private sealed class Resize
    {
        public int Line, Corner;
        public Point Start;
        public Rect Orig;
        public double Aspect;       // height per width
        public double MaxW;
        public Rect Now;
    }

    private Resize? _rz;
    private InputSystemCursorShape _cursorShape = InputSystemCursorShape.IBeam;

    private static Rect[] Handles(Rect r)
    {
        const double s = 9;
        return new[]
        {
            new Rect(r.X - s / 2, r.Y - s / 2, s, s), new Rect(r.Right - s / 2, r.Y - s / 2, s, s),
            new Rect(r.X - s / 2, r.Bottom - s / 2, s, s), new Rect(r.Right - s / 2, r.Bottom - s / 2, s, s),
        };
    }

    private (Deco D, int Corner)? HandleAt(Point p)
    {
        if (SelectedMedia() is not { Kind: DecoKind.Image } d) return null;
        var hs = Handles(d.Rect);
        for (var i = 0; i < hs.Length; i++)
        {
            var h = hs[i];
            if (new Rect(h.X - 3, h.Y - 3, h.Width + 6, h.Height + 6).Contains(p)) return (d, i);
        }
        return null;
    }

    private void UpdateCursor(Point p)
    {
        var want = HandleAt(p) is { } h ? (h.Corner is 0 or 3 ? InputSystemCursorShape.SizeNorthwestSoutheast : InputSystemCursorShape.SizeNortheastSouthwest) : InputSystemCursorShape.IBeam;
        if (want == _cursorShape) return;
        _cursorShape = want;
        try { ProtectedCursor = InputSystemCursor.Create(want); } catch { }
    }

    private bool BeginResize(Point p, PointerRoutedEventArgs e)
    {
        if (HandleAt(p) is not { } h || _r is null) return false;
        var nat = h.D.Line >= 0 && MediaAttrs(h.D.Line) is { } m && MediaCache.Peek(m.Url) is { Bitmap: not null } ent && ent.W > 0 ? ent.H / ent.W : h.D.Rect.Height / Math.Max(1, h.D.Rect.Width);
        var box = _boxes[h.D.Line];
        _rz = new Resize { Line = h.D.Line, Corner = h.Corner, Start = p, Orig = h.D.Rect, Aspect = nat, MaxW = Math.Max(MediaRules.MinImageWidth, _width - box.X), Now = h.D.Rect };
        _root.CapturePointer(e.Pointer);
        return true;
    }

    private void MoveResize(Point p)
    {
        if (_rz is not { } rz) return;
        var dx = p.X - rz.Start.X;
        var w = rz.Corner is 0 or 2 ? rz.Orig.Width - dx : rz.Orig.Width + dx;
        w = Math.Min(Math.Max(w, MediaRules.MinImageWidth), rz.MaxW);
        var h = w * rz.Aspect;
        var x = rz.Corner is 0 or 2 ? rz.Orig.Right - w : rz.Orig.X;
        // the picture stays left-aligned in the box (as on the web): a left handle only changes the width
        rz.Now = new Rect(rz.Orig.X, rz.Orig.Y, w, h);
        _ = x;
        _canvas.Invalidate();
    }

    private void EndResize(PointerRoutedEventArgs e)
    {
        if (_rz is not { } rz) return;
        MoveResize(e.GetCurrentPoint(_root).Position);   // the release point counts even if the moves before it were coalesced
        _rz = null;
        try { _root.ReleasePointerCapture(e.Pointer); } catch { }
        var w = MediaRules.ClampWidth(rz.Now.Width);
        if (Math.Abs(w - rz.Orig.Width) < 1) { _canvas.Invalidate(); return; }
        try
        {
            // the node stays selected through the drag; say so again, then resize with the picture's own proportions
            if (_r is { } r && rz.Line < r.View.Lines.Length && !IsSelectedNode(rz.Line)) _session.SetViewSelection(r.View.Lines[rz.Line].Offset, r.View.Lines[rz.Line].Offset + 1);
            var h = Math.Max(1, Math.Round(w * rz.Aspect));
            RunCommand("setImageWidth", JsonSerializer.Serialize(new { width = w, height = h }));
        }
        catch (Exception ex) { Log("resize", ex); }
        _textRev = ulong.MaxValue; Render();
    }
}
