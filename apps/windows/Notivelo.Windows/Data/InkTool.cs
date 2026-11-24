namespace Notivelo.Windows.Data;

internal enum InkKind { Select, Pen, Highlighter, Eraser, PartialEraser, Lasso }

/// <summary>The pen toolbar's state (Apple's InkTool): the active tool, the pen's and highlighter's colour and width (remembered per user),
/// whether the pen row is open. The tool itself is not remembered: a page opens ready to type.</summary>
internal sealed class InkTool
{

    public readonly record struct Swatch(string Name, uint Hex);

    public static readonly Swatch[] PenColors =
    {
        new("Black", 0x1F2328), new("Blue", 0x1D4ED8), new("Red", 0xDC2626), new("Green", 0x15803D), new("Purple", 0x7E22CE),
    };
    public static readonly Swatch[] HighlighterColors = { new("Yellow", 0xFACC15), new("Green", 0x4ADE80), new("Blue", 0x60A5FA), new("Pink", 0xF472B6) };
    /// <summary>Base widths in page points at pressure 0.5.</summary>
    public static readonly float[] PenWidths = { 1.5f, 2.5f, 4f };
    public static readonly float[] HighlighterWidths = { 12f, 18f, 26f };
    public static readonly string[] WidthNames = { "Fine", "Medium", "Thick" };
    public const float EraserRadius = 8f;
    public const double HighlighterAlpha = 0.35;

    /// <summary>Declared after the static tables: its field initialisers read them.</summary>
    public static readonly InkTool Shared = new();

    /// <summary>Raised on any change of tool, colour, width, bar or selection count.</summary>
    public event Action? Changed;

    public InkKind Kind { get; private set; } = InkKind.Select;
    public bool BarOpen { get; private set; }
    public uint PenColor { get; private set; } = AppSettings.PenColor ?? PenColors[0].Hex;
    public float PenWidth { get; private set; } = AppSettings.PenWidth ?? PenWidths[1];
    public uint HighlighterColor { get; private set; } = AppSettings.HighlighterColor ?? HighlighterColors[0].Hex;
    public float HighlighterWidth { get; private set; } = AppSettings.HighlighterWidth ?? HighlighterWidths[1];
    /// <summary>Strokes the lasso holds, and what deletes them (set by the page that shows them).</summary>
    public int SelectionCount { get; private set; }
    public Action? DeleteSelection { get; set; }

    /// <summary>A tool that takes the pointer (everything but select, with the bar open).</summary>
    public bool Inking => BarOpen && Kind != InkKind.Select;

    public void SetKind(InkKind k) { Kind = k; if (k != InkKind.Lasso) SelectionCount = 0; Changed?.Invoke(); }

    public void ToggleBar()
    {
        BarOpen = !BarOpen;
        if (BarOpen) { if (Kind == InkKind.Select) Kind = InkKind.Pen; }
        else { Kind = InkKind.Select; SelectionCount = 0; }
        Changed?.Invoke();
    }

    public void SetPenColor(uint c) { PenColor = c; AppSettings.PenColor = c; Changed?.Invoke(); }
    public void SetHighlighterColor(uint c) { HighlighterColor = c; AppSettings.HighlighterColor = c; Changed?.Invoke(); }
    public void SetPenWidth(float w) { PenWidth = w; AppSettings.PenWidth = w; Changed?.Invoke(); }
    public void SetHighlighterWidth(float w) { HighlighterWidth = w; AppSettings.HighlighterWidth = w; Changed?.Invoke(); }
    public void SetSelectionCount(int n) { if (SelectionCount != n) { SelectionCount = n; Changed?.Invoke(); } }

    /// <summary>The style a new stroke gets: tool number (0 pen, 1 highlighter), 0xRRGGBBAA, base width; null for tools that don't draw.</summary>
    public (byte Tool, uint Color, float Width)? StrokeStyle => Kind switch
    {
        InkKind.Pen => (0, Pack(PenColor, 1), PenWidth),
        InkKind.Highlighter => (1, Pack(HighlighterColor, HighlighterAlpha), HighlighterWidth),
        _ => null,
    };

    /// <summary>0xRRGGBB and an alpha to 0xRRGGBBAA.</summary>
    public static uint Pack(uint rgb, double alpha) => (rgb << 8) | (uint)Math.Round(Math.Clamp(alpha, 0, 1) * 255);
}
