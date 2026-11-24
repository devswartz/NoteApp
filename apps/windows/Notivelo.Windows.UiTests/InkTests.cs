using System.Drawing;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Input;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>Ink editing on the offline page (strokes kept in memory by the sample source; the core's stroke builder makes the outlines): the Draw button opens
/// the pen row, the mouse draws, lassos and moves, Delete removes, Ctrl+Z undoes. The overlay's ItemStatus reads <c>strokes=N;selected=M;tool=pen;live=0</c>.</summary>
public class InkTests
{
    private static AutomationElement Find(AppHost h, string id, int ms = 20000) =>
        AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)), "element " + id, ms);

    private static void Click(AppHost h, string id) { Find(h, id).Click(); Thread.Sleep(250); }

    private static (int Strokes, int Selected) Status(AppHost h)
    {
        var s = Find(h, "ink-overlay").Properties.ItemStatus.ValueOrDefault ?? "";
        int Get(string k) => s.Split(';').Select(p => p.Split('=')).Where(p => p[0] == k).Select(p => int.Parse(p[1])).FirstOrDefault();
        return (Get("strokes"), Get("selected"));
    }

    private static void WaitStatus(AppHost h, Func<(int Strokes, int Selected), bool> ok, string what) =>
        AppHost.Wait(() => ok(Status(h)) ? "x" : null, what, 8000);

    /// <summary>Draw with the mouse through the given points (screen pixels).</summary>
    private static void Drag(IReadOnlyList<Point> pts)
    {
        pts = Densify(pts);
        Mouse.MoveTo(pts[0]);
        Mouse.Down(MouseButton.Left);
        Thread.Sleep(80);
        foreach (var p in pts.Skip(1)) { Mouse.MoveTo(p); Thread.Sleep(12); }
        Mouse.Up(MouseButton.Left);
        Thread.Sleep(300);
    }

    /// <summary>Points at most 6 px apart, so the app gets a pointer move for each (a lasso loop of four corners would otherwise be a few jumps).</summary>
    private static List<Point> Densify(IReadOnlyList<Point> pts)
    {
        var r = new List<Point> { pts[0] };
        for (var i = 1; i < pts.Count; i++)
        {
            var a = pts[i - 1]; var b = pts[i];
            var n = Math.Max(1, (int)Math.Ceiling(Math.Sqrt((b.X - a.X) * (b.X - a.X) + (b.Y - a.Y) * (b.Y - a.Y)) / 6));
            for (var k = 1; k <= n; k++) r.Add(new Point(a.X + (b.X - a.X) * k / n, a.Y + (b.Y - a.Y) * k / n));
        }
        return r;
    }

    /// <summary>An empty area of the canvas (right of box "a", below box "b").</summary>
    private static Point Origin(AppHost h)
    {
        var r = Find(h, "ink-overlay").BoundingRectangle;
        return new Point((int)r.Left + 250, (int)r.Top + 260);
    }

    private static List<Point> Wave(Point o) => Enumerable.Range(0, 20).Select(i => new Point(o.X + i * 8, o.Y + (int)(20 * Math.Sin(i / 3.0)))).ToList();

    private static List<Point> Loop(Point o, int l, int t, int r, int b) =>
        new() { new(o.X + l, o.Y + t), new(o.X + r, o.Y + t), new(o.X + r, o.Y + b), new(o.X + l, o.Y + b), new(o.X + l, o.Y + t + 2) };

    private static void OpenPen(AppHost h)
    {
        Click(h, "ribbon-draw");
        Find(h, "ink-tool-pen");
        Find(h, "ink-overlay");
        Thread.Sleep(300);
    }

    [Fact]
    public void Pen_draws_a_stroke() => AppHost.Run(nameof(Pen_draws_a_stroke), h =>
    {
        OpenPen(h);
        Assert.Equal((0, 0), Status(h));
        Drag(Wave(Origin(h)));
        WaitStatus(h, s => s.Strokes == 1, "one stroke");
        Drag(Wave(Origin(h) + new Size(0, 60)));
        WaitStatus(h, s => s.Strokes == 2, "two strokes");
    });

    [Fact]
    public void Lasso_selects_moves_and_deletes() => AppHost.Run(nameof(Lasso_selects_moves_and_deletes), h =>
    {
        OpenPen(h);
        var o = Origin(h);
        Drag(Wave(o));
        WaitStatus(h, s => s.Strokes == 1, "one stroke");
        Click(h, "ink-tool-lasso");
        Drag(Loop(o, -20, -40, 180, 40));
        WaitStatus(h, s => s.Selected == 1, "the stroke selected");
        Drag(new List<Point> { new(o.X + 60, o.Y), new(o.X + 90, o.Y + 40), new(o.X + 120, o.Y + 80) });   // drag the selection
        WaitStatus(h, s => s.Strokes == 1 && s.Selected == 1, "the stroke moved and still selected");
        h.Press(DELETE);
        WaitStatus(h, s => s.Strokes == 0 && s.Selected == 0, "the stroke deleted");
    });

    [Fact]
    public void Eraser_removes_a_stroke() => AppHost.Run(nameof(Eraser_removes_a_stroke), h =>
    {
        OpenPen(h);
        var o = Origin(h);
        Drag(Wave(o));
        WaitStatus(h, s => s.Strokes == 1, "one stroke");
        Click(h, "ink-tool-eraser");
        Drag(Enumerable.Range(0, 30).Select(i => new Point(o.X + i * 6, o.Y + (int)(20 * Math.Sin(i * 6 / 24.0)))).ToList());
        WaitStatus(h, s => s.Strokes == 0, "the stroke erased");
    });

    [Fact]
    public void Undo_takes_back_a_stroke() => AppHost.Run(nameof(Undo_takes_back_a_stroke), h =>
    {
        OpenPen(h);
        Drag(Wave(Origin(h)));
        WaitStatus(h, s => s.Strokes == 1, "one stroke");
        h.Chord(CONTROL, KEY_Z);
        WaitStatus(h, s => s.Strokes == 0, "the stroke undone");
        h.Chord(CONTROL, KEY_Y);
        WaitStatus(h, s => s.Strokes == 1, "the stroke redone");
    });
}
