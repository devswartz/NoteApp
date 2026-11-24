using Notivelo.Windows.Data;
using Xunit;

namespace Notivelo.Windows.Tests;

/// <summary>The pen row's state: colours pack as 0xRRGGBBAA (a highlighter is see-through), the style follows the tool, a page opens ready to type.</summary>
public class InkToolTests
{
    [Fact]
    public void Colours_pack_with_their_alpha()
    {
        Assert.Equal(0x1F2328FFu, InkTool.Pack(0x1F2328, 1));
        Assert.Equal(0xFACC1559u, InkTool.Pack(0xFACC15, InkTool.HighlighterAlpha));
    }

    [Fact]
    public void Stroke_style_follows_the_tool()
    {
        var t = InkTool.Shared;
        t.SetKind(InkKind.Select);
        Assert.Null(t.StrokeStyle);
        t.SetKind(InkKind.Highlighter);
        Assert.Equal((byte)1, t.StrokeStyle!.Value.Tool);
        t.SetKind(InkKind.Eraser);
        Assert.Null(t.StrokeStyle);
        t.SetKind(InkKind.Select);
    }
}
