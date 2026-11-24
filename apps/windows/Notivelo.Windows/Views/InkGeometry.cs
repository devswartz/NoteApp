using System.Numerics;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Geometry;

namespace Notivelo.Windows.Views;

/// <summary>Drawing parts of the page's ink (Apple's InkGeometry): the core's outline commands as a Win2D path (0 x y move, 1 x y line, 2 cx cy r a whole
/// circle, 3 close; winding fill) and the colour a stroke is drawn in (near-black ink is drawn near-white in the dark theme).</summary>
internal static class InkGeometry
{
    public static CanvasGeometry Build(ICanvasResourceCreator rc, float[] ops)
    {
        using var pb = new CanvasPathBuilder(rc);
        pb.SetFilledRegionDetermination(CanvasFilledRegionDetermination.Winding);
        var open = false; var i = 0;
        while (i < ops.Length)
        {
            switch ((int)ops[i])
            {
                case 0:
                    if (i + 2 >= ops.Length) { i = ops.Length; break; }
                    if (open) pb.EndFigure(CanvasFigureLoop.Closed);
                    pb.BeginFigure(ops[i + 1], ops[i + 2]); open = true; i += 3; break;
                case 1:
                    if (i + 2 >= ops.Length) { i = ops.Length; break; }
                    if (open) pb.AddLine(ops[i + 1], ops[i + 2]);
                    i += 3; break;
                case 2:
                {
                    if (i + 3 >= ops.Length) { i = ops.Length; break; }
                    if (open) { pb.EndFigure(CanvasFigureLoop.Closed); open = false; }
                    float cx = ops[i + 1], cy = ops[i + 2], r = ops[i + 3];
                    pb.BeginFigure(cx + r, cy);
                    pb.AddArc(new Vector2(cx - r, cy), r, r, 0, CanvasSweepDirection.Clockwise, CanvasArcSize.Small);
                    pb.AddArc(new Vector2(cx + r, cy), r, r, 0, CanvasSweepDirection.Clockwise, CanvasArcSize.Small);
                    pb.EndFigure(CanvasFigureLoop.Closed);
                    i += 4; break;
                }
                default:
                    if (open) { pb.EndFigure(CanvasFigureLoop.Closed); open = false; }
                    i += 1; break;
            }
        }
        if (open) pb.EndFigure(CanvasFigureLoop.Closed);
        return CanvasGeometry.CreatePath(pb);
    }

    /// <summary>0xRRGGBBAA as a colour, near-black drawn near-white in the dark theme (Apple's InkGeometry.color).</summary>
    public static global::Windows.UI.Color Color(uint c, bool dark, double alphaScale = 1)
    {
        var r = (byte)(c >> 24); var g = (byte)(c >> 16); var b = (byte)(c >> 8); var a = (byte)((c & 255) * alphaScale);
        if (dark && (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.25) { r = 0xE6; g = 0xE6; b = 0xE6; }
        return global::Windows.UI.Color.FromArgb(a, r, g, b);
    }
}
