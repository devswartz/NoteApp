using Notivelo.Native;

namespace Notivelo.Windows.Data;

/// <summary>Offline test mode: ink kept in memory per page (the core's stroke builder makes the outlines; hit tests are done on the outline points),
/// with a snapshot undo, so the UI tests can draw, lasso, delete and undo without a server. Apple's InkSession calls, answered locally.</summary>
public sealed partial class SampleNotesSource
{
    private readonly Dictionary<string, List<InkStroke>> _ink = new();
    private readonly Dictionary<string, (Stack<List<InkStroke>> Undo, Stack<List<InkStroke>> Redo)> _inkHistory = new();
    private int _inkSeq;

    private static InkStroke Measured(InkStroke s)
    {
        float x0 = float.MaxValue, y0 = float.MaxValue, x1 = float.MinValue, y1 = float.MinValue;
        foreach (var (x, y, r) in Points(s.Ops)) { x0 = Math.Min(x0, x - r); y0 = Math.Min(y0, y - r); x1 = Math.Max(x1, x + r); y1 = Math.Max(y1, y + r); }
        return x0 > x1 ? s : s with { MinX = x0, MinY = y0, MaxX = x1, MaxY = y1 };
    }

    /// <summary>The outline's points (a circle's centre with its radius).</summary>
    private static IEnumerable<(float X, float Y, float R)> Points(float[] ops)
    {
        for (var i = 0; i < ops.Length;)
            switch ((int)ops[i])
            {
                case 0 or 1 when i + 2 < ops.Length: yield return (ops[i + 1], ops[i + 2], 0); i += 3; break;
                case 2 when i + 3 < ops.Length: yield return (ops[i + 1], ops[i + 2], ops[i + 3]); i += 4; break;
                case 0 or 1 or 2: i = ops.Length; break;
                default: i++; break;
            }
    }

    private List<InkStroke> Strokes(string pageId) => _ink.TryGetValue(pageId, out var l) ? l : _ink[pageId] = DemoInk(pageId).ToList();

    public IReadOnlyList<InkStroke> InkOf(string pageId) => Offline ? Strokes(pageId).ToList() : DemoInk(pageId);

    public bool CanInk(string pageId) => Offline;

    /// <summary>Snapshot for undo before a change.</summary>
    private List<InkStroke> Edit(string pageId)
    {
        var cur = Strokes(pageId);
        if (!_inkHistory.TryGetValue(pageId, out var h)) _inkHistory[pageId] = h = (new(), new());
        h.Undo.Push(cur.ToList()); h.Redo.Clear();
        return cur;
    }

    public bool AddInkStroke(string pageId, InkStrokeBuilder builder, byte tool, uint color)
    {
        if (!Offline || builder.PointCount() == 0) return false;
        var list = Edit(pageId);
        list.Add(Measured(new InkStroke("n" + _inkSeq++, tool == 1, color, builder.Preview(Array.Empty<float>()), 0, 0)));
        return true;
    }

    public bool EraseInk(string pageId, float[] track, float radius, bool partial)
    {
        if (!Offline) return false;
        var hit = Strokes(pageId).Where(s => Touches(s, track, radius)).Select(s => s.Id).ToList();
        return hit.Count == 0 || DeleteInkStrokes(pageId, hit);
    }

    private static bool Touches(InkStroke s, float[] track, float radius)
    {
        for (var i = 0; i + 1 < track.Length; i += 2)
        {
            float x = track[i], y = track[i + 1];
            if (x < s.MinX - radius || x > s.MaxX + radius || y < s.MinY - radius || y > s.MaxY + radius) continue;
            if (Points(s.Ops).Any(p => Math.Abs(p.X - x) <= radius + 2 && Math.Abs(p.Y - y) <= radius + 2)) return true;
        }
        return false;
    }

    public IReadOnlyList<string> InkHitLasso(string pageId, float[] polygon)
    {
        if (!Offline) return Array.Empty<string>();
        var res = new List<string>();
        foreach (var s in Strokes(pageId))
        {
            var pts = Points(s.Ops).ToList();
            if (pts.Count > 0 && pts.Count(p => Inside(polygon, p.X, p.Y)) * 2 >= pts.Count) res.Add(s.Id);
        }
        return res;
    }

    private static bool Inside(float[] poly, float x, float y)
    {
        var inside = false;
        var n = poly.Length / 2;
        for (int i = 0, j = n - 1; i < n; j = i++)
        {
            float xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
            if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    public IReadOnlyList<string> InkHitPoint(string pageId, float x, float y, float radius) =>
        Offline ? Strokes(pageId).Where(s => Touches(s, new[] { x, y }, radius)).Select(s => s.Id).ToList() : Array.Empty<string>();

    public IReadOnlyList<(string OldId, string NewId)>? MoveInkStrokes(string pageId, IReadOnlyList<string> ids, float dx, float dy)
    {
        if (!Offline) return null;
        var list = Edit(pageId);
        var moved = new List<(string, string)>();
        for (var i = 0; i < list.Count; i++)
        {
            if (!ids.Contains(list[i].Id)) continue;
            var s = list[i];
            var ops = (float[])s.Ops.Clone();
            for (var k = 0; k < ops.Length;)
                switch ((int)ops[k])
                {
                    case 0 or 1 when k + 2 < ops.Length: ops[k + 1] += dx; ops[k + 2] += dy; k += 3; break;
                    case 2 when k + 3 < ops.Length: ops[k + 1] += dx; ops[k + 2] += dy; k += 4; break;
                    case 0 or 1 or 2: k = ops.Length; break;
                    default: k++; break;
                }
            var id = "n" + _inkSeq++;
            list[i] = s with { Id = id, Ops = ops, MinX = s.MinX + dx, MaxX = s.MaxX + dx, MinY = s.MinY + dy, MaxY = s.MaxY + dy };
            moved.Add((s.Id, id));
        }
        return moved;
    }

    public bool DeleteInkStrokes(string pageId, IReadOnlyList<string> ids)
    {
        if (!Offline) return false;
        Edit(pageId).RemoveAll(s => ids.Contains(s.Id));
        return true;
    }

    /// <summary>Ink steps only: null (the box's own undo) when this page has none in that direction.</summary>
    public bool? PageUndo(string pageId, bool undo)
    {
        if (!Offline || !_inkHistory.TryGetValue(pageId, out var h)) return null;
        var from = undo ? h.Undo : h.Redo; var to = undo ? h.Redo : h.Undo;
        if (from.Count == 0) return null;
        to.Push(Strokes(pageId).ToList());
        _ink[pageId] = from.Pop();
        return true;
    }

    public bool? CanPageUndo(string pageId, bool undo) =>
        Offline && _inkHistory.TryGetValue(pageId, out var h) && (undo ? h.Undo : h.Redo).Count > 0 ? true : null;
}
