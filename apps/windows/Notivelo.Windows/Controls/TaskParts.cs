using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Controls;

/// <summary>Task visuals shared by the Tasks view rows and the task lines on a page (LOOK 2.4, 4.10).</summary>
internal static class TaskParts
{
    /// <summary>The check circle: 1.6 ring, priority colour + 10 % fill; done = filled with a white check.</summary>
    public static UIElement Circle(Func<string, Brush> b, int priority, bool done, double size = 18)
    {
        var ring = priority switch { 1 => b("P1"), 2 => b("P2"), 3 => b("P3"), _ => b("TextMuted") };
        var soft = priority switch { 1 => b("P1Soft"), 2 => b("P2Soft"), 3 => b("P3Soft"), _ => null };
        var c = new Border
        {
            Width = size, Height = size, CornerRadius = new CornerRadius(size / 2), BorderBrush = ring, BorderThickness = new Thickness(1.6),
            Background = done ? ring : soft ?? new SolidColorBrush(Colors.Transparent),
        };
        if (done) c.Child = new Icon("check", size * 0.62, new SolidColorBrush(Colors.White)) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, StrokeUnits = 3 };
        return c;
    }

    public static Brush ToneBrush(Func<string, Brush> b, DueTone tone) => tone switch
    {
        DueTone.Overdue => b("Danger"),
        DueTone.Today => b("Success"),
        DueTone.Soon => b("Warn"),
        _ => b("Text2"),
    };

    public static Brush PriorityBrush(Func<string, Brush> b, int p) => p switch { 1 => b("P1"), 2 => b("P2"), 3 => b("P3"), _ => b("TextMuted") };

    /// <summary>Icon + text pair used in meta lines (due date, page link, team).</summary>
    public static StackPanel IconText(string icon, double iconSize, string text, double textSize, Brush iconBrush, Brush textBrush, int weight = 400)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
        sp.Children.Add(new Icon(icon, iconSize, iconBrush) { VerticalAlignment = VerticalAlignment.Center });
        sp.Children.Add(Ui.Text(text, textSize, textBrush, weight));
        return sp;
    }
}
