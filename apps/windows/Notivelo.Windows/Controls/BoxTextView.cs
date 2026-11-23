using System.Numerics;
using System.Text.Json;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Geometry;
using Microsoft.Graphics.Canvas.Text;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Data;
using Notivelo.Windows.Text;
using Windows.Foundation;
using Windows.UI;
using N = Notivelo.Native;

namespace Notivelo.Windows.Controls;

/// <summary>
/// One canvas box drawn from an editor session (docs/rewrite/WINDOWS-TEXT-VIEW.md): the session's line table becomes DirectWrite text
/// layouts (Win2D), with marks, lists, quotes, callouts, code, tables, toggles, atoms and the selection drawn under and over them.
/// Task rows are XAML laid over the canvas. This part only draws; input comes next.
/// </summary>
internal sealed partial class BoxTextView : UserControl
{
    private readonly N.EditorSession _session;
    private readonly INotesSource _source;
    private readonly CanvasControl _canvas = new();
    private readonly Canvas _chrome = new();
    private readonly Grid _root = new();

    /// <summary>The box chrome (LOOK 4.5.2: 1 pt border, radius 6, padding 6 10) holding this view; the page moves it between rebuilds.</summary>
    public Border Host => _host ??= new Border { Padding = new Thickness(10, 6, 10, 6), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(6), BorderBrush = new SolidColorBrush(Colors.Transparent), Child = this };
    private Border? _host;
    private N.ViewRender? _r;
    private ulong _textRev = ulong.MaxValue;
    private double _width = 0;
    private bool _dark;
    private bool _disposed;
    private List<LineBox> _boxes = new();
    private readonly List<Deco> _decos = new();
    private double _height;

    /// <summary>Draw the caret and the selection without focus (dev hook for screenshots).</summary>
    public bool ShowSelection { get; set; }

    public BoxTextView(N.EditorSession session, INotesSource source)
    {
        _session = session;
        _source = source;
        HorizontalAlignment = HorizontalAlignment.Left;
        IsTabStop = false;
        Padding = new Thickness(0);
        Content = _root;
        _canvas.Draw += OnDraw;
        _canvas.CreateResources += (_, _) => { };
        _chrome.IsHitTestVisible = true;
        _root.Children.Add(_canvas);
        _root.Children.Add(_chrome);
        ActualThemeChanged += (_, _) => { _textRev = ulong.MaxValue; Render(); };
        InitInput();
    }

    public double LaidOutHeight => _height;

    /// <summary>Lay the box out for a content width (the box minus padding and border).</summary>
    public void SetWidth(double w)
    {
        if (Math.Abs(w - _width) < 0.5) return;
        _width = w;
        Width = w;
        _textRev = ulong.MaxValue;
        Render();
    }

    /// <summary>The page changed (a remote edit, or a task title): read the session again and redraw if anything moved.</summary>
    public void OnPageChanged(bool force = false)
    {
        if (force) _textRev = ulong.MaxValue;
        Render();
    }

    /// <summary>Selection by view offsets, through the session (dev hook and tests).</summary>
    public void SetSelection(int anchor, int head)
    {
        _session.SetViewSelection((uint)anchor, (uint)head);
        Render();
    }


    /// <summary>Dev hook: drive the session from a script (NOTIVELO_SEED=file, loopback servers only) to fill a scratch page for screenshots.
    /// Lines: <c>text ...</c>, <c>key Enter</c>, <c>cmd name {json}</c>, <c>word w</c> (select the last w), <c>end</c>.</summary>
    public void RunScript(IEnumerable<string> script)
    {
        foreach (var raw in script)
        {
            var line = raw.TrimEnd((char)13);
            if (line.Length == 0 || line.StartsWith('#')) continue;
            var sp = line.IndexOf(' ');
            var op = sp < 0 ? line : line[..sp];
            var arg = sp < 0 ? "" : line[(sp + 1)..];
            try
            {
                switch (op)
                {
                    case "text": _session.InsertText(arg); break;
                    case "key": _session.Key(arg); break;
                    case "cmd":
                    {
                        var j = arg.IndexOf(' ');
                        _session.Command(j < 0 ? arg : arg[..j], j < 0 ? "{}" : arg[(j + 1)..]);
                        break;
                    }
                    case "word":
                    {
                        var t = _session.ViewRender().View.Text;
                        var at = t.LastIndexOf(arg, StringComparison.Ordinal);
                        if (at >= 0) _session.SetViewSelection((uint)at, (uint)(at + arg.Length));
                        break;
                    }
                    case "start": _session.SetViewSelection(0, 0); break;
                    case "end": { var n = (uint)_session.ViewRender().View.Text.Length; _session.SetViewSelection(n, n); break; }
                }
            }
            catch (Exception e) { Log("script " + line, e); }
        }
        Render();
    }

    public void Release()
    {
        if (_disposed) return;
        _disposed = true;
        Trace("dispose");
        _session.Dispose();
    }

    private void Render()
    {
        try { RenderCore(); } catch (Exception e) { Log("render", e); }
    }

    private void RenderCore()
    {
        Trace("render w=" + _width);
        if (_disposed || _width < 20) return;
        N.ViewRender r;
        try { r = _session.ViewRender(); }
        catch { return; }
        var prev = _r;
        _r = r;
        _dark = ActualTheme == ElementTheme.Dark;
        if (r.TextRevision != _textRev)
        {
            _textRev = r.TextRevision;
            try { Relayout(); } catch (Exception e) { Log("layout", e); }
        }
        else if (prev is not null && prev.Revision == r.Revision) return;
        Trace("invalidate");
        _canvas.Invalidate();
        Trace("invalidated");
        AfterRender(prev, r);
    }

    // ---- palette ------------------------------------------------------------------------------------------------

    private Brush C2(string key) => ThemeBrushes.Get(key, ActualTheme);
    private Color C(string key) => ((SolidColorBrush)ThemeBrushes.Get(key, ActualTheme)).Color;
    private Color Hex(string hex) => Ui.ColorOf(hex);
    private static Color Alpha(Color c, double a) => Color.FromArgb((byte)Math.Round(a * 255), c.R, c.G, c.B);

    // ---- layout -------------------------------------------------------------------------------------------------

    private enum DecoKind { Callout, Quote, CodeBlock, Rule, Table, TableCell, Image, FileCard, ToggleArrow, Checkbox, Bullet, Marker, TaskGuide }

    private sealed record Deco(DecoKind Kind, Rect Rect, string? Text = null, int Flag = 0, int Line = -1);

    private sealed class Back
    {
        public Rect Rect;
        public int Kind; // 0 code, 1 highlight, 2 comment, 3 mention, 4 mention me, 5 page link
        public string? Name;
        public bool Missing;
    }

    private sealed class LineBox
    {
        public N.ViewLine Line = null!;
        public int Index;
        public double X, Y, W, H;
        public CanvasTextLayout? Text;
        public LineMetrics M;
        public bool Hidden;
        public List<Back> Backs = new();
        public List<AtomDraw> Atoms = new();
        public bool CheckedLine;
        public bool Muted;
    }

    private sealed class AtomDraw
    {
        public Rect Rect;
        public string Kind = "";
        public string Label = "";
        public bool Me, Missing;
        public string? Emoji;
    }

    private static string? _mono;
    private static string MonoFamily => _mono ??= PickMono();

    private static string PickMono()
    {
        try
        {
            var fams = CanvasTextFormat.GetSystemFontFamilies();
            if (fams.Contains("Cascadia Mono")) return "Cascadia Mono";
        }
        catch { }
        return "Consolas";
    }

    private double Baseline(double pitch, double size, bool mono)
    {
        var a = mono ? 1.0 : 1.079; var d = mono ? 0.3 : 0.251;
        return (pitch - (a + d) * size) / 2 + a * size;
    }

    private CanvasTextFormat Format(LineMetrics m, double width) => new()
    {
        FontFamily = m.Mono ? MonoFamily : "Segoe UI",
        FontSize = (float)m.Size,
        FontWeight = new FontWeight((ushort)m.Weight),
        WordWrapping = CanvasWordWrapping.Wrap,
        LineSpacingMode = CanvasLineSpacingMode.Uniform,
        LineSpacing = (float)m.Pitch,
        LineSpacingBaseline = (float)Baseline(m.Pitch, m.Size, m.Mono),
        HorizontalAlignment = CanvasHorizontalAlignment.Left,
        VerticalAlignment = CanvasVerticalAlignment.Top,
        TrimmingGranularity = CanvasTextTrimmingGranularity.None,
    };

    private double TextWidth(string text, double size, int weight, string family = "Segoe UI")
    {
        using var l = new CanvasTextLayout(CanvasDevice.GetSharedDevice(), text, new CanvasTextFormat { FontFamily = family, FontSize = (float)size, FontWeight = new FontWeight((ushort)weight), WordWrapping = CanvasWordWrapping.NoWrap }, 10000, 100);
        return l.LayoutBounds.Width;
    }

    private void Relayout()
    {
        Trace("relayout");
        var r = _r!;
        var dev = CanvasDevice.GetSharedDevice();
        var lines = r.View.Lines;
        var text = r.View.Text;
        var doc = DocInfo.Parse(SafeDoc());
        var tables = TableMap.Find(lines, doc.Tables);
        var cellOf = new Dictionary<int, TableCell>();
        foreach (var t in tables) foreach (var c in t.Cells) cellOf[c.Line] = c;
        var tableAt = tables.ToDictionary(t => t.FirstLine);

        foreach (var b in _boxes) b.Text?.Dispose();
        _boxes = lines.Select((l, k) => new LineBox { Line = l, Index = k }).ToList();
        _decos.Clear();
        _chrome.Children.Clear();

        double y = 0;
        N.ViewLine? prev = null;
        var callouts = -1; var codes = -1; var detailsIdx = -1;
        var guideTop = -1.0; var guideBottom = 0.0; var guideX = 0.0;
        var detailsOpen = true;
        var inCallout = false; var calloutTop = 0.0; var calloutEmoji = ""; var calloutLeft = 0;
        var quoteTop = -1.0; double quoteX = 0;
        var bulletOrdinal = 0;

        void CloseCallout(double bottom)
        {
            if (!inCallout) return;
            _decos.Add(new Deco(DecoKind.Callout, new Rect(0, calloutTop, _width, bottom - calloutTop), calloutEmoji));
            inCallout = false;
        }
        void CloseQuote(double bottom)
        {
            if (quoteTop < 0) return;
            _decos.Add(new Deco(DecoKind.Quote, new Rect(quoteX, quoteTop, 3, bottom - quoteTop)));
            quoteTop = -1;
        }

        void CloseGuide()
        {
            if (guideTop < 0) return;
            _decos.Add(new Deco(DecoKind.TaskGuide, new Rect(guideX, guideTop, 2, guideBottom - guideTop)));
            guideTop = -1;
        }

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            if (guideTop >= 0 && (line.Kind == "taskRef" || !line.Containers.Contains("taskRef"))) CloseGuide();
            Trace($"line {i} {line.Kind} {string.Join('/', line.Containers)}");
            var box = _boxes[i];

            // toggles: the summary opens or closes everything after it (until the next non-content line)
            if (Metrics.InSummary(line)) { detailsIdx++; detailsOpen = detailsIdx < doc.DetailsOpen.Count && doc.DetailsOpen[detailsIdx]; }
            if (Metrics.InDetailsContent(line) && !detailsOpen) { box.Hidden = true; continue; }

            // tables lay out as a unit from their first line
            if (tableAt.TryGetValue(i, out var tbl))
            {
                CloseCallout(y); CloseQuote(y);
                y += Metrics.GapAbove(prev, line) == 0 && prev is null ? 0 : Math.Max(Metrics.BlockGap, 12.8);
                y = LayoutTable(tbl, y, text);
                prev = lines[Math.Min(lines.Length - 1, tbl.FirstLine + tbl.LineCount - 1)];
                i = tbl.FirstLine + tbl.LineCount - 1;
                continue;
            }

            var gap = Metrics.GapAbove(prev, line);
            var endsCallout = inCallout && (!Metrics.InCallout(line) || calloutLeft <= 0);
            if (endsCallout) { y += 12; CloseCallout(y); gap = Math.Max(Metrics.BlockGap, 9.6); }
            var startsCallout = Metrics.InCallout(line) && !inCallout;
            var inQuote = Metrics.InQuote(line);
            if (quoteTop >= 0 && !inQuote) CloseQuote(y);
            y += gap;
            if (startsCallout)
            {
                callouts++;
                calloutTop = y; calloutEmoji = callouts < doc.CalloutEmoji.Count ? doc.CalloutEmoji[callouts] : "\U0001F4A1";
                inCallout = true; y += 12;
                calloutLeft = callouts < doc.CalloutLines.Count ? doc.CalloutLines[callouts] : int.MaxValue;
            }
            if (inCallout) calloutLeft--;
            if (inQuote && quoteTop < 0)
            {
                quoteTop = y;
                quoteX = Metrics.Indent(line).TextX - Metrics.QuoteIndent;
            }

            var ind = Metrics.Indent(line);
            var m = Metrics.Of(line);
            var x = ind.TextX;
            var w = Math.Max(40, _width - x - ind.RightInset);
            box.X = x; box.W = w; box.M = m;
            var isNote = line.Kind != "taskRef" && line.Containers.Contains("taskRef");

            if (!line.IsText)
            {
                y = LayoutObject(box, y, text);
                prev = line;
                if (isNote) { if (guideTop < 0) { guideTop = box.Y; guideX = Metrics.IndentBefore(line, "taskRef") + 26; } guideBottom = box.Y + box.H; }
                continue;
            }

            if (line.Kind == "codeBlock")
            {
                codes++;
                var top = y;
                y += ind.TopPad;
                BuildText(box, text, dev, w, doc);
                box.Y = y;
                y += box.H + ind.BottomPad;
                var lang = codes < doc.CodeLanguage.Count ? doc.CodeLanguage[codes] : null;
                _decos.Add(new Deco(DecoKind.CodeBlock, new Rect(0, top, _width, y - top), lang));
                prev = line;
                continue;
            }

            BuildText(box, text, dev, w, doc);
            box.Y = y;
            y += box.H;

            // markers and checkboxes sit in the gutter of the first line of the item
            if (line.Marker is not null)
            {
                var depth = line.Containers.Count(c => c is "bulletList");
                var isBullet = line.Marker == "•";
                _decos.Add(new Deco(DecoKind.Marker, new Rect(x - 6, box.Y, 0, m.Pitch), line.Marker, isBullet ? 100 + Math.Max(0, depth - 1) : 0, i));
            }
            else if (line.Checked is { } chk)
            {
                _decos.Add(new Deco(DecoKind.Checkbox, new Rect(x - Metrics.CheckIndent + 3.2, box.Y + 6.1, 15, 15), null, chk ? 1 : 0, i));
                box.Muted = chk;
            }
            if (Metrics.InSummary(line))
            {
                _decos.Add(new Deco(DecoKind.ToggleArrow, new Rect(0, box.Y, 24, 27), null, detailsOpen ? 1 : 0, i));
            }
            prev = line;
            if (isNote) { if (guideTop < 0) { guideTop = box.Y; guideX = Metrics.IndentBefore(line, "taskRef") + 26; } guideBottom = box.Y + box.H; }
        }
        CloseGuide();
        if (inCallout) { y += 12; CloseCallout(y); }
        CloseQuote(y);

        _height = Math.Ceiling(Math.Max(y, LineMetrics.BasePitch));
        _canvas.Width = _width; _canvas.Height = _height;
        _chrome.Width = _width; _chrome.Height = _height;
        Height = _height;
        Trace("relayout done h=" + _height);
        _ = bulletOrdinal;
    }

    private string SafeDoc()
    {
        try { return _session.State().DocJson; } catch { return "{}"; }
    }

    /// <summary>The line's text layout: type scale, marks as ranges, atoms as spacing, and the backgrounds the marks ask for.</summary>
    private void BuildText(LineBox box, string text, CanvasDevice dev, double w, DocInfo doc)
    {
        var line = box.Line;
        var m = box.M;
        var s = RunMap.TextOf(text, line);
        var fmt = Format(m, w);
        var tl = new CanvasTextLayout(dev, s, fmt, (float)w, float.MaxValue);
        box.Text = tl;
        var len = s.Length;
        if (len > 0 && m.Tracking != 0) tl.SetCharacterSpacing(0, len, 0, (float)(m.Tracking * m.Size), 0);
        var runs = RunMap.Resolve(line);
        var atomsByOffset = line.Atoms.ToDictionary(a => (int)a.Offset);
        foreach (var run in runs)
        {
            var st = run.Style;
            if (run.Len == 0) continue;
            if (st.Bold && m.Weight < 700) tl.SetFontWeight(run.Start, run.Len, new FontWeight(700));
            if (st.Italic) tl.SetFontStyle(run.Start, run.Len, global::Windows.UI.Text.FontStyle.Italic);
            if (st.Underline || st.Href is not null) tl.SetUnderline(run.Start, run.Len, true);
            if (st.Strike) tl.SetStrikethrough(run.Start, run.Len, true);
            if (st.Href is not null) tl.SetColor(run.Start, run.Len, C("Accent"));
            if (TextColors.Text(st.Color, _dark) is { } hex) tl.SetColor(run.Start, run.Len, Hex(hex));
            if (st.Code)
            {
                tl.SetFontFamily(run.Start, run.Len, MonoFamily);
                tl.SetFontSize(run.Start, run.Len, (float)(m.Size * 0.88));
                tl.SetCharacterSpacing(run.Start, 1, 5, 0, 0);
                tl.SetCharacterSpacing(run.Start + run.Len - 1, 1, run.Len == 1 ? 5 : 0, 5, 0);
            }
            else if (st.Highlighted)
            {
                tl.SetCharacterSpacing(run.Start, 1, 1, 0, 0);
                tl.SetCharacterSpacing(run.Start + run.Len - 1, 1, run.Len == 1 ? 1 : 0, 1, 0);
            }
        }
        if (box.Muted || line.Checked == true) { tl.SetColor(0, len, C("TextMuted")); if (len > 0) tl.SetStrikethrough(0, len, true); }

        // atoms: reserve the chip's width on the U+FFFC and draw the chip over it
        foreach (var a in line.Atoms)
        {
            var at = (int)a.Offset;
            if (at < 0 || at >= len) continue;
            var d = new AtomDraw { Kind = a.Kind, Label = a.Label };
            double cw;
            try
            {
                using var j = JsonDocument.Parse(string.IsNullOrEmpty(a.AttrsJson) ? "{}" : a.AttrsJson);
                var root = j.RootElement;
                string? Get(string n) => root.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                if (a.Kind == "mention")
                {
                    d.Me = _source.UserId is { } me && Get("id") == me;
                    d.Label = "@" + (Get("label") ?? a.Label);
                    cw = TextWidth(d.Label, m.Size, 500) + 6;
                }
                else if (a.Kind == "pageLink")
                {
                    var pid = Get("pageId") ?? a.Label;
                    var title = _source.PageTitleOf(pid);
                    d.Missing = title is null;
                    d.Label = title is { Length: > 0 } ? title : d.Missing ? "Missing page" : "Untitled";
                    d.Emoji = Get("emoji");
                    cw = TextWidth(d.Label, m.Size, d.Missing ? 400 : 500) + 6 + (d.Emoji is { Length: > 0 } ? TextWidth(d.Emoji, m.Size * 0.95, 400) + 3 : 0);
                }
                else
                {
                    d.Label = string.IsNullOrEmpty(a.Label) ? a.Kind : a.Label;
                    cw = 120;
                }
            }
            catch (JsonException) { cw = 40; }
            tl.SetCharacterSpacing(at, 1, 0, 0, (float)cw);
            tl.SetColor(at, 1, Color.FromArgb(0, 0, 0, 0));
            box.Atoms.Add(d);
        }

        // backgrounds from the marks (rounded, one per line fragment)
        foreach (var run in runs)
        {
            var st = run.Style;
            if (run.Len == 0) continue;
            void Add(int kind, string? name)
            {
                foreach (var reg in tl.GetCharacterRegions(run.Start, run.Len))
                    box.Backs.Add(new Back { Rect = reg.LayoutBounds, Kind = kind, Name = name });
            }
            if (st.Code) Add(0, null);
            if (st.Highlighted) Add(1, st.Highlight);
            if (st.Comment) Add(2, null);
        }
        for (var k = 0; k < box.Atoms.Count; k++)
        {
            var d = box.Atoms[k];
            var reg = tl.GetCharacterRegions((int)line.Atoms[k].Offset, 1);
            if (reg.Length > 0) d.Rect = reg[0].LayoutBounds;
        }
        box.H = Math.Max(m.Pitch, tl.LayoutBounds.Height);
        // a trailing empty line still takes a line (layout of "" reports one line)
        if (len == 0) box.H = m.Pitch;
    }

    private static double Num(JsonElement root, string name, double fallback) =>
        root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : fallback;

    private static string? Str(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>Object lines: rule, image, file card, task row. Returns the new y.</summary>
    private double LayoutObject(LineBox box, double y, string text)
    {
        var line = box.Line;
        var avail = _width - box.X;
        JsonElement attrs = default;
        JsonDocument? jd = null;
        try
        {
            if (!string.IsNullOrEmpty(line.AttrsJson)) { jd = JsonDocument.Parse(line.AttrsJson); attrs = jd.RootElement.Clone(); }
        }
        catch (JsonException) { }
        jd?.Dispose();
        var hasAttrs = attrs.ValueKind == JsonValueKind.Object;
        switch (line.Kind)
        {
            case "horizontalRule":
                box.Y = y; box.H = 1;
                _decos.Add(new Deco(DecoKind.Rule, new Rect(box.X, y, avail, 1)));
                return y + 1;
            case "image":
            {
                var iw = hasAttrs ? Num(attrs, "width", 0) : 0;
                var ih = hasAttrs ? Num(attrs, "height", 0) : 0;
                if (iw <= 0) iw = Math.Min(avail, 320);
                if (ih <= 0) ih = Math.Min(120, Math.Round(iw * 0.6));
                if (iw > avail) { ih = ih * avail / iw; iw = avail; }
                box.Y = y; box.H = ih;
                var alt = hasAttrs ? Str(attrs, "alt") : null;
                _decos.Add(new Deco(DecoKind.Image, new Rect(box.X, y, iw, ih), string.IsNullOrEmpty(alt) ? "Image" : alt, 0, box.Index));
                return y + ih;
            }
            case "fileAttachment":
            {
                var name = hasAttrs ? Str(attrs, "name") ?? "file" : "file";
                var size = hasAttrs ? Num(attrs, "size", 0) : 0;
                var cw = Math.Min(520, avail);
                box.Y = y; box.H = 52;
                _decos.Add(new Deco(DecoKind.FileCard, new Rect(box.X, y, cw, 52), name + "\n" + SizeText(size), 0, box.Index));
                var ficon = new Icon("file-text", 18, C2("Accent")) { Width = 34, Height = 34 };
                Canvas.SetLeft(ficon, box.X + 10); Canvas.SetTop(ficon, y + 9);
                _chrome.Children.Add(ficon);
                var dl = new Icon("download", 16, C2("Text2")) { Width = 28, Height = 28 };
                Canvas.SetLeft(dl, box.X + cw - 10 - 28); Canvas.SetTop(dl, y + 12);
                _chrome.Children.Add(dl);
                return y + 52;
            }
            case "taskRef":
            {
                var rowW = Math.Max(120, avail + 4);
                var row = TaskRow(line.TaskId, box.X - 4, rowW);
                row.Measure(new Size(rowW, double.PositiveInfinity));
                var h = Math.Max(36, row.DesiredSize.Height);
                Canvas.SetLeft(row, box.X - 4);
                Canvas.SetTop(row, y);
                _chrome.Children.Add(row);
                box.Y = y; box.H = h;
                return y + h;
            }
            default:
                box.Y = y; box.H = LineMetrics.BasePitch;
                return y + LineMetrics.BasePitch;
        }
    }

    private static string SizeText(double bytes) =>
        bytes <= 0 ? "" : bytes < 1024 ? $"{bytes:0} B" : bytes < 1048576 ? $"{bytes / 1024:0.#} KB" : $"{bytes / 1048576:0.#} MB";

    private UIElement TaskRow(string? id, double x, double w)
    {
        var t = id is null ? null : _source.FindTask(id);
        Brush B(string k) => ThemeBrushes.Get(k, ActualTheme);
        var g = new Grid { Width = w, MinHeight = 36, Padding = new Thickness(4, 3, 6, 3), ColumnSpacing = 8, CornerRadius = new CornerRadius(8) };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        if (t is null)
        {
            var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center };
            sp.Children.Add(new Icon("file-x-corner", 15, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
            var gone = Ui.Text("This task was deleted or is not visible to you.", 12.5, B("TextMuted"));
            gone.VerticalAlignment = VerticalAlignment.Center;
            sp.Children.Add(gone);
            var rm = new Button { Content = "Remove from page", Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(10, 0, 10, 0), FontSize = 12.5, FontWeight = new FontWeight(600), Foreground = B("Text2") };
            sp.Children.Add(rm);
            Grid.SetColumnSpan(sp, 3);
            g.Children.Add(sp);
            return g;
        }
        var circle = TaskParts.Circle(B, t.Priority, t.Done);
        ((FrameworkElement)circle).VerticalAlignment = VerticalAlignment.Top;
        ((FrameworkElement)circle).Margin = new Thickness(0, 5, 0, 0);
        g.Children.Add(circle);
        var title = Ui.Text(t.Title.Length == 0 ? "Untitled task" : t.Title, 16, t.Done ? B("TextMuted") : B("Text"), lineHeight: 24);
        title.TextWrapping = TextWrapping.Wrap;
        title.Padding = new Thickness(0, 2, 0, 2);
        if (t.Done) title.TextDecorations = TextDecorations.Strikethrough;
        Grid.SetColumn(title, 1);
        g.Children.Add(title);
        var meta = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 5, 0, 0) };
        Border Chip(UIElement content) => new()
        {
            Height = 22, Padding = new Thickness(7, 0, 7, 0), CornerRadius = new CornerRadius(6), Background = B("BgHover"), Child = content,
            VerticalAlignment = VerticalAlignment.Center,
        };
        if (t.ChecklistTotal > 0)
            meta.Children.Add(Chip(TaskParts.IconText("square-check", 12, $"{t.ChecklistDone}/{t.ChecklistTotal}", 11.5, B("Text2"), t.ChecklistDone == t.ChecklistTotal ? B("Success") : B("Text2"), 400)));
        if (t.Priority is >= 1 and <= 3)
            meta.Children.Add(Chip(new Icon("flag", 13, TaskParts.PriorityBrush(B, t.Priority))));
        if (t.DueLabel is { } due)
            meta.Children.Add(Chip(TaskParts.IconText("calendar-days", 13, due, 11.5, TaskParts.ToneBrush(B, t.Tone), TaskParts.ToneBrush(B, t.Tone), 400)));
        if (t.Assignee is { } who) meta.Children.Add(Ui.Avatar(who, 20));
        meta.Children.Add(new Icon("list-plus", 13, B("Text2")) { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(4, 0, 0, 0) });
        meta.Children.Add(new Icon("maximize-2", 13, B("Text2")) { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(4, 0, 0, 0) });
        Grid.SetColumn(meta, 2);
        g.Children.Add(meta);
        return g;
    }

    /// <summary>A table as a unit: equal columns, a row as tall as its tallest cell, header row shaded.</summary>
    private double LayoutTable(TableLayoutInfo tbl, double y, string text)
    {
        var dev = CanvasDevice.GetSharedDevice();
        var lines = _r!.View.Lines;
        var cols = tbl.Cols;
        var colW = Math.Max(60, (_width - 1) / cols);
        var rowH = new double[tbl.Rows];
        var cellH = new Dictionary<(int, int), double>();
        var perCell = new Dictionary<(int, int), List<LineBox>>();
        foreach (var c in tbl.Cells)
        {
            var line = lines[c.Line];
            var lb = _boxes[c.Line];
            var m = Metrics.Of(line);
            lb.M = m;
            var cw = colW - 2 * Metrics.CellPadX;
            lb.X = c.Col * colW + Metrics.CellPadX; lb.W = cw;
            if (line.IsText) BuildText(lb, text, dev, cw, new DocInfo()); else { lb.H = LineMetrics.BasePitch; }
            var key = (c.Row, c.Col);
            if (!perCell.TryGetValue(key, out var lst)) perCell[key] = lst = new List<LineBox>();
            lst.Add(lb);
        }
        foreach (var (key, lst) in perCell)
        {
            var h = lst.Sum(b => b.H) + 2 * Metrics.CellPadY;
            cellH[key] = h;
            rowH[key.Item1] = Math.Max(rowH[key.Item1], h);
        }
        var top = y;
        var rowY = new double[tbl.Rows];
        var acc = y;
        for (var r = 0; r < tbl.Rows; r++) { rowY[r] = acc; acc += rowH[r] == 0 ? LineMetrics.BasePitch + 12 : rowH[r]; }
        foreach (var c in tbl.Cells.GroupBy(c => (c.Row, c.Col)).Select(g => g.First()))
        {
            var header = tbl.Cells.Any(k => k.Row == c.Row && k.Col == c.Col && k.Header);
            _decos.Add(new Deco(DecoKind.TableCell, new Rect(c.Col * colW, rowY[c.Row], colW, rowH[c.Row] == 0 ? LineMetrics.BasePitch + 12 : rowH[c.Row]), null, header ? 1 : 0));
        }
        foreach (var ((row, col), lst) in perCell)
        {
            var cy = rowY[row] + Metrics.CellPadY;
            foreach (var b in lst) { b.Y = cy; cy += b.H; }
        }
        return acc;
    }

    // ---- drawing ------------------------------------------------------------------------------------------------

    internal static void Trace(string m)
    {
        if (Environment.GetEnvironmentVariable("NOTIVELO_TRACE") is null) return;
        try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "notivelo-text.log"), $"{DateTime.Now:HH:mm:ss.fff} {m}{Environment.NewLine}"); } catch { }
    }

    internal static void Log(string where, Exception e)
    {
        try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "notivelo-text.log"), $"{DateTime.Now:HH:mm:ss} {where}: {e}{Environment.NewLine}"); } catch { }
    }

    private void OnDraw(CanvasControl sender, CanvasDrawEventArgs args)
    {
        try { Draw(args.DrawingSession); } catch (Exception e) { Log("draw", e); }
    }

    private void Draw(CanvasDrawingSession ds)
    {
        Trace("draw");
        var r = _r;
        if (r is null) return;
        var border = C("Border");
        var text = C("Text");

        // block decorations first
        foreach (var d in _decos)
        {
            switch (d.Kind)
            {
                case DecoKind.Callout:
                {
                    ds.FillRoundedRectangle(d.Rect, 8, 8, C("BgSubtle"));
                    ds.DrawRoundedRectangle(Inset(d.Rect, 0.5), 8, 8, border, 1);
                    DrawEmoji(ds, d.Text ?? "", new Rect(d.Rect.X + 12, d.Rect.Y + 12, 28, 28));
                    break;
                }
                case DecoKind.Quote: ds.FillRectangle(d.Rect, C("BorderStrong")); break;
                case DecoKind.TaskGuide: ds.FillRectangle(d.Rect, border); break;
                case DecoKind.CodeBlock:
                {
                    ds.FillRoundedRectangle(d.Rect, 8, 8, C("BgSubtle"));
                    ds.DrawRoundedRectangle(Inset(d.Rect, 0.5), 8, 8, border, 1);
                    DrawSmall(ds, string.IsNullOrEmpty(d.Text) ? "Plain text" : d.Text!, d.Rect.X + 14, d.Rect.Y + 6, 12, C("Text2"), CanvasHorizontalAlignment.Left);
                    DrawSmall(ds, "Copy", d.Rect.Right - 14 - 40, d.Rect.Y + 6, 12, C("TextMuted"), CanvasHorizontalAlignment.Right, 40);
                    break;
                }
                case DecoKind.Rule: ds.FillRectangle(d.Rect, border); break;
                case DecoKind.TableCell:
                {
                    if (d.Flag == 1) ds.FillRectangle(d.Rect, C("BgSubtle"));
                    ds.DrawRectangle(Inset(new Rect(d.Rect.X, d.Rect.Y, d.Rect.Width + 1, d.Rect.Height + 1), 0.5), border, 1);
                    break;
                }
                case DecoKind.Image:
                {
                    ds.FillRoundedRectangle(d.Rect, 8, 8, C("BgSubtle"));
                    ds.DrawRoundedRectangle(Inset(d.Rect, 0.5), 8, 8, border, 1);
                    DrawSmall(ds, d.Text ?? "Image", d.Rect.X, d.Rect.Y + d.Rect.Height / 2 - 10, 13, C("TextMuted"), CanvasHorizontalAlignment.Center, d.Rect.Width);
                    break;
                }
                case DecoKind.FileCard:
                {
                    ds.FillRoundedRectangle(d.Rect, 8, 8, C("Bg"));
                    ds.DrawRoundedRectangle(Inset(d.Rect, 0.5), 8, 8, border, 1);
                    var tile = new Rect(d.Rect.X + 10, d.Rect.Y + 9, 34, 34);
                    ds.FillRoundedRectangle(tile, 7, 7, C("AccentSoft"));
                    var parts = (d.Text ?? "").Split((char)10);
                    DrawSmall(ds, parts[0], d.Rect.X + 54, d.Rect.Y + 16, 15, text, CanvasHorizontalAlignment.Left, d.Rect.Width - 54 - 110, 500);
                    if (parts.Length > 1 && parts[1].Length > 0) DrawSmall(ds, parts[1], d.Rect.Right - 10 - 28 - 8 - 70, d.Rect.Y + 17, 12, C("TextMuted"), CanvasHorizontalAlignment.Right, 70);
                    break;
                }
            }
        }

        // backgrounds under text, then the selection
        foreach (var b in _boxes)
        {
            if (b.Hidden || b.Text is null) continue;
            foreach (var back in b.Backs) DrawBack(ds, b, back);
        }
        if (ShowSelection || _focused) DrawSelection(ds, r);

        foreach (var b in _boxes)
        {
            if (b.Hidden || b.Text is null) continue;
            ds.DrawTextLayout(b.Text, (float)b.X, (float)b.Y, text);
            foreach (var a in b.Atoms) DrawAtom(ds, b, a);
        }

        foreach (var d in _decos)
        {
            switch (d.Kind)
            {
                case DecoKind.Marker: DrawMarker(ds, d); break;
                case DecoKind.Checkbox:
                {
                    var rc = d.Rect;
                    if (d.Flag == 1)
                    {
                        ds.FillRoundedRectangle(rc, 3.5f, 3.5f, C("AccentSolid"));
                        using var pb = new CanvasPathBuilder(ds);
                        pb.BeginFigure((float)(rc.X + 3.6), (float)(rc.Y + 7.8));
                        pb.AddLine((float)(rc.X + 6.4), (float)(rc.Y + 10.6));
                        pb.AddLine((float)(rc.X + 11.4), (float)(rc.Y + 4.8));
                        pb.EndFigure(CanvasFigureLoop.Open);
                        using var g = CanvasGeometry.CreatePath(pb);
                        ds.DrawGeometry(g, Colors.White, 1.8f, new CanvasStrokeStyle { StartCap = CanvasCapStyle.Round, EndCap = CanvasCapStyle.Round, LineJoin = CanvasLineJoin.Round });
                    }
                    else ds.DrawRoundedRectangle(Inset(rc, 0.75), 3.5f, 3.5f, C("TextMuted"), 1.5f);
                    break;
                }
                case DecoKind.ToggleArrow:
                {
                    // 6 x 9 triangle, pointing right (down when open), centred in the 24 x 27 button
                    var cx = d.Rect.X + 12; var cy = d.Rect.Y + 13.5;
                    using var pb = new CanvasPathBuilder(ds);
                    if (d.Flag == 1) { pb.BeginFigure((float)(cx - 4.5), (float)(cy - 3)); pb.AddLine((float)(cx + 4.5), (float)(cy - 3)); pb.AddLine((float)cx, (float)(cy + 3)); }
                    else { pb.BeginFigure((float)(cx - 3), (float)(cy - 4.5)); pb.AddLine((float)(cx - 3), (float)(cy + 4.5)); pb.AddLine((float)(cx + 3), (float)cy); }
                    pb.EndFigure(CanvasFigureLoop.Closed);
                    using var g = CanvasGeometry.CreatePath(pb);
                    ds.FillGeometry(g, C("TextMuted"));
                    break;
                }
            }
        }

        DrawIme(ds, r);
        if (ShowSelection || (_focused && _caretOn)) DrawCaret(ds, r);
    }

    private static Rect Inset(Rect r, double d) => new(r.X + d, r.Y + d, Math.Max(0, r.Width - 2 * d), Math.Max(0, r.Height - 2 * d));

    private void DrawSmall(CanvasDrawingSession ds, string s, double x, double y, double size, Color c, CanvasHorizontalAlignment align, double width = 400, int weight = 400)
    {
        using var f = new CanvasTextFormat
        {
            FontFamily = "Segoe UI", FontSize = (float)size, FontWeight = new FontWeight((ushort)weight), HorizontalAlignment = align,
            WordWrapping = CanvasWordWrapping.NoWrap, TrimmingGranularity = CanvasTextTrimmingGranularity.Character,
        };
        using var l = new CanvasTextLayout(ds, s, f, (float)width, (float)(size * 1.5));
        ds.DrawTextLayout(l, (float)x, (float)y, c);
    }

    private void DrawEmoji(CanvasDrawingSession ds, string emoji, Rect box)
    {
        using var f = new CanvasTextFormat { FontFamily = "Segoe UI Emoji", FontSize = 19, HorizontalAlignment = CanvasHorizontalAlignment.Center, VerticalAlignment = CanvasVerticalAlignment.Center, Options = CanvasDrawTextOptions.EnableColorFont };
        ds.DrawText(emoji, box, C("Text"), f);
    }

    private void DrawBack(CanvasDrawingSession ds, LineBox b, Back back)
    {
        var rc = new Rect(b.X + back.Rect.X, b.Y + back.Rect.Y, back.Rect.Width, back.Rect.Height);
        switch (back.Kind)
        {
            case 0:
                // inline code: --bg-hover pill, 1 pt up/down, radius 4
                ds.FillRoundedRectangle(new Rect(rc.X, rc.Y + 4, rc.Width, rc.Height - 8), 4, 4, C("BgHover"));
                break;
            case 1:
                ds.FillRoundedRectangle(new Rect(rc.X, rc.Y + 3, rc.Width, rc.Height - 6), 3, 3, Hex(TextColors.Highlight(back.Name, _dark)));
                break;
            case 2:
                ds.FillRectangle(new Rect(rc.X, rc.Y + 3, rc.Width, rc.Height - 6), Color.FromArgb(0x47, 250, 204, 21));
                ds.FillRectangle(new Rect(rc.X, rc.Bottom - 5, rc.Width, 2), Color.FromArgb(0xCC, 234, 179, 8));
                break;
        }
    }

    private void DrawAtom(CanvasDrawingSession ds, LineBox b, AtomDraw a)
    {
        var rc = new Rect(b.X + a.Rect.X, b.Y + a.Rect.Y + 3, a.Rect.Width, a.Rect.Height - 6);
        if (rc.Width < 2) return;
        var size = b.M.Size;
        using var fmt = new CanvasTextFormat
        {
            FontFamily = "Segoe UI", FontSize = (float)size, FontWeight = new FontWeight((ushort)(a.Missing ? 400 : 500)),
            WordWrapping = CanvasWordWrapping.NoWrap, LineSpacingMode = CanvasLineSpacingMode.Uniform, LineSpacing = (float)b.M.Pitch,
            LineSpacingBaseline = (float)Baseline(b.M.Pitch, size, false),
        };
        switch (a.Kind)
        {
            case "mention":
                ds.FillRoundedRectangle(rc, 4, 4, a.Me ? Color.FromArgb(0x59, 250, 204, 21) : C("AccentSoft"));
                using (var l = new CanvasTextLayout(ds, a.Label, fmt, 1000, 100)) ds.DrawTextLayout(l, (float)(rc.X + 3), (float)b.Y + (float)a.Rect.Y, a.Me ? C("Text") : C("Accent"));
                break;
            case "pageLink":
            {
                var x = rc.X + 3;
                if (a.Emoji is { Length: > 0 })
                {
                    using var ef = new CanvasTextFormat { FontFamily = "Segoe UI Emoji", FontSize = (float)(size * 0.95), WordWrapping = CanvasWordWrapping.NoWrap, LineSpacingMode = CanvasLineSpacingMode.Uniform, LineSpacing = (float)b.M.Pitch, LineSpacingBaseline = (float)Baseline(b.M.Pitch, size, false), Options = CanvasDrawTextOptions.EnableColorFont };
                    using var el = new CanvasTextLayout(ds, a.Emoji, ef, 100, 100);
                    ds.DrawTextLayout(el, (float)x, (float)b.Y + (float)a.Rect.Y, C("TextMuted"));
                    x += el.LayoutBounds.Width + 3;
                }
                using (var l = new CanvasTextLayout(ds, a.Label, fmt, 1000, 100)) ds.DrawTextLayout(l, (float)x, (float)b.Y + (float)a.Rect.Y, a.Missing ? C("TextMuted") : C("Text"));
                ds.FillRectangle(new Rect(rc.X, b.Y + a.Rect.Y + a.Rect.Height - 5, rc.Width, 1), C("BorderStrong"));
                break;
            }
            default:
                ds.FillRoundedRectangle(rc, 4, 4, C("BgSubtle"));
                ds.DrawRoundedRectangle(Inset(rc, 0.5), 4, 4, C("Border"), 1);
                break;
        }
    }

    private void DrawMarker(CanvasDrawingSession ds, Deco d)
    {
        var b = _boxes[d.Line];
        var m = b.M;
        var right = b.X - 5.5;
        if (d.Flag >= 100)
        {
            var depth = d.Flag - 100;
            var cx = b.X - 12.5; var cy = b.Y + m.Pitch * 0.5 + 0.2;
            var col = C("Text");
            switch (depth % 3)
            {
                case 0: ds.FillCircle((float)cx, (float)cy, 2.9f, col); break;
                case 1: ds.DrawCircle((float)cx, (float)cy, 2.5f, col, 1.1f); break;
                default: ds.FillRectangle(new Rect(cx - 2.6, cy - 2.6, 5.2, 5.2), col); break;
            }
            return;
        }
        using var fmt = new CanvasTextFormat
        {
            FontFamily = "Segoe UI", FontSize = (float)m.Size, HorizontalAlignment = CanvasHorizontalAlignment.Right, WordWrapping = CanvasWordWrapping.NoWrap,
            LineSpacingMode = CanvasLineSpacingMode.Uniform, LineSpacing = (float)m.Pitch, LineSpacingBaseline = (float)Baseline(m.Pitch, m.Size, false),
        };
        using var l = new CanvasTextLayout(ds, d.Text ?? "", fmt, 60, (float)m.Pitch);
        ds.DrawTextLayout(l, (float)(right - 60), (float)b.Y, C("Text"));
    }

    // ---- selection and caret ------------------------------------------------------------------------------------

    private void DrawSelection(CanvasDrawingSession ds, N.ViewRender r)
    {
        var sel = r.View.Selection;
        if (sel.Anchor == sel.Head) return;
        int a = (int)Math.Min(sel.Anchor, sel.Head), e = (int)Math.Max(sel.Anchor, sel.Head);
        var fill = C("AccentSoft");   // LOOK 4.4: ::selection is --accent-soft (accent at 10 %, 15 % dark), text colour unchanged
        foreach (var b in _boxes)
        {
            if (b.Hidden) continue;
            var line = b.Line;
            var part = RunMap.SelectionIn(line, a, e);
            if (part is null) continue;
            if (!line.IsText || b.Text is null)
            {
                var rc = new Rect(b.X, b.Y, Math.Max(20, _width - b.X), Math.Max(1, b.H));
                ds.FillRoundedRectangle(rc, 2, 2, fill);
                continue;
            }
            var (from, to) = part.Value;
            if (to > from)
                foreach (var reg in b.Text.GetCharacterRegions(from, to - from))
                    ds.FillRoundedRectangle(new Rect(b.X + reg.LayoutBounds.X, b.Y + reg.LayoutBounds.Y, reg.LayoutBounds.Width, reg.LayoutBounds.Height), 2, 2, fill);
            if (e > line.Offset + line.Len) // the selection runs past the line's end: show the line feed as a stub
            {
                var last = b.Text.GetCaretPosition((int)line.Len, false);
                ds.FillRectangle(new Rect(b.X + last.X, b.Y + last.Y, 5, b.M.Pitch), fill);
            }
        }
    }

    private void DrawCaret(CanvasDrawingSession ds, N.ViewRender r)
    {
        var sel = r.View.Selection;
        if (sel.Anchor != sel.Head) return;
        var (li, col) = RunMap.ToLine(r.View.Lines, (int)sel.Head);
        if (li < 0 || li >= _boxes.Count) return;
        var b = _boxes[li];
        if (b.Hidden) return;
        double x, y, h;
        if (b.Text is null) { x = b.X; y = b.Y; h = Math.Max(1, b.H); }
        else
        {
            var cp = b.Text.GetCaretPosition(col, false);
            x = b.X + cp.X; y = b.Y + cp.Y; h = b.M.Pitch;
        }
        ds.FillRectangle(new Rect(x - 0.75, y + 2, 1.5, Math.Max(h - 4, 10)), C("Text"));
    }
}
