using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The page (LOOK 4.4 top bar, 4.5 surface): sticky 48 pt bar, scrolling article with title, sub-line and the canvas.
/// Boxes are static TextBlocks for now; the editor session's text view replaces them later.</summary>
internal sealed class PageView : ThemedControl
{
    private readonly INotesSource _source;
    public string? PageId { get; private set; }

    public PageView(INotesSource source) => _source = source;

    public void SetPage(string? id) { PageId = id; Rebuild(); }

    protected override UIElement Build()
    {
        var page = PageId is null ? null : _source.GetPage(PageId);
        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        if (page is null) { root.Children.Add(Empty()); return root; }

        root.Children.Add(TopBar(page));

        var article = new Grid { Padding = new Thickness(0, 32, 40, 0) };
        article.RowDefinitions.Add(new RowDefinition { Height = new GridLength(28) });
        article.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        article.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        article.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var title = Ui.Text(page.Title, 36, B("Text"), 700, lineHeight: 43.2, tracking: -0.025);
        title.Margin = new Thickness(51, 0, 0, 0);
        Grid.SetRow(title, 1);
        article.Children.Add(title);

        var sub = Ui.Text(page.EditedLine, 12.5, B("PageTextMuted"), lineHeight: 18.75);
        sub.Margin = new Thickness(51, 6, 0, 22);
        Grid.SetRow(sub, 2);
        article.Children.Add(sub);

        var surfaceH = Math.Max(320, page.Boxes.Max(b => b.Y) + 320);
        var canvas = new Canvas { Height = surfaceH, Margin = new Thickness(40, 10, 0, 0) };
        foreach (var box in page.Boxes) canvas.Children.Add(Box(box));
        Grid.SetRow(canvas, 3);
        article.Children.Add(canvas);

        var sv = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Content = article };
        Grid.SetRow(sv, 1);
        root.Children.Add(sv);

        // outline rail: 16x2 bars, 12 apart, current in accent (LOOK 4.5.4)
        var outline = new StackPanel { Spacing = 10, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 72, 20, 0), IsHitTestVisible = false };
        for (var i = 0; i < 3; i++)
            outline.Children.Add(new Border { Width = 16, Height = 2, Background = i == 0 ? B("Accent") : B("BorderStrong"), HorizontalAlignment = HorizontalAlignment.Right });
        Grid.SetRow(outline, 1);
        root.Children.Add(outline);
        return root;
    }

    private UIElement Empty()
    {
        var sp = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Spacing = 6 };
        sp.Children.Add(Ui.Text("Pick a page", 15, B("Text"), 700));
        sp.Children.Add(Ui.Text("Choose a page in the sidebar to open it.", 13, B("TextMuted")));
        Grid.SetRowSpan(sp, 2);
        return sp;
    }

    // ---- top bar ----------------------------------------------------------------------------------------------

    private UIElement TopBar(NotePage page)
    {
        var bar = new Grid { Height = 48, Padding = new Thickness(20, 0, 16, 0), ColumnSpacing = 12 };
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var crumbs = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, VerticalAlignment = VerticalAlignment.Center };
        crumbs.Children.Add(new Border { Width = 8, Height = 8, CornerRadius = new CornerRadius(4), Background = Ui.Hex(page.NotebookColorHex), VerticalAlignment = VerticalAlignment.Center });
        crumbs.Children.Add(Ui.Text(page.NotebookName, 13, B("Text2"), lineHeight: 19.5));
        foreach (var s in page.SectionPath)
        {
            crumbs.Children.Add(new Icon("chevron-right", 14, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
            crumbs.Children.Add(Ui.Text(s, 13, B("Text2"), lineHeight: 19.5));
        }
        bar.Children.Add(crumbs);

        var right = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, VerticalAlignment = VerticalAlignment.Center };
        var saved = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, Margin = new Thickness(0, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center };
        saved.Children.Add(new Icon("check", 14, B("Text2")));
        saved.Children.Add(Ui.Text("Saved", 12, B("Text2")));
        right.Children.Add(saved);
        right.Children.Add(WithBadge(Ui.IconButton("list-todo", 18, 32, 32, "Tasks on this page", 8), page.OpenTasks));
        right.Children.Add(Ui.IconButton("message-square", 18, 32, 32, "Comments", 8));

        var share = new Button
        {
            Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(8),
            Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), Foreground = B("Text"),
        };
        var ss = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        ss.Children.Add(new Icon("user-plus", 14));
        ss.Children.Add(new TextBlock { Text = "Share", FontSize = 13, FontWeight = new FontWeight(500), VerticalAlignment = VerticalAlignment.Center, FontFamily = Ui.Font });
        share.Content = ss;
        right.Children.Add(share);
        right.Children.Add(Ui.IconButton("ellipsis", 18, 32, 32, "Page options", 8));
        Grid.SetColumn(right, 1);
        bar.Children.Add(right);
        return bar;
    }

    private UIElement WithBadge(Button b, int count)
    {
        var g = new Grid();
        g.Children.Add(b);
        if (count > 0)
        {
            g.Children.Add(new Border
            {
                Height = 16, MinWidth = 16, Padding = new Thickness(4, 0, 4, 0), CornerRadius = new CornerRadius(8), Background = B("AccentSolid"),
                HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, -2, -4, 0), IsHitTestVisible = false,
                Child = Ui.Text(count.ToString(), 10, B("TextOnAccent"), 600).With(t => t.HorizontalAlignment = HorizontalAlignment.Center),
            });
        }
        return g;
    }

    // ---- canvas boxes -----------------------------------------------------------------------------------------

    private UIElement Box(CanvasBox box)
    {
        var sp = new StackPanel();
        var first = true;
        foreach (var blk in box.Blocks)
        {
            sp.Children.Add(Block(blk, first));
            first = false;
        }
        var b = new Border
        {
            Width = box.Wide ? 819 : box.Width, Padding = new Thickness(10, 6, 10, 6), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(6),
            BorderBrush = new SolidColorBrush(Colors.Transparent), Child = sp,
        };
        Canvas.SetLeft(b, box.X);
        Canvas.SetTop(b, box.Y);
        return b;
    }

    private UIElement Block(BoxBlock blk, bool first)
    {
        // 0.4 em block gap (6.4 at 16); headings carry their own margins (LOOK 2.3).
        switch (blk.Kind)
        {
            case BlockKind.Heading1:
                return Ui.Text(blk.Text, 28, B("Text"), 700, lineHeight: 36.4, tracking: -0.02).With(t => { t.TextWrapping = TextWrapping.Wrap; t.Margin = new Thickness(0, first ? 0 : 33.6, 0, 8.4); });
            case BlockKind.Heading2:
                return Ui.Text(blk.Text, 21.6, B("Text"), 700, lineHeight: 29.16, tracking: -0.01).With(t => { t.TextWrapping = TextWrapping.Wrap; t.Margin = new Thickness(0, first ? 0 : 23.76, 0, 5.4); });
            case BlockKind.Task:
                return TaskLine(blk.Task!);
            default:
                return Ui.Text(blk.Text, 16, B("Text"), lineHeight: 27.2).With(t => { t.TextWrapping = TextWrapping.Wrap; t.Margin = new Thickness(0, first ? 0 : 6.4, 0, 0); });
        }
    }

    /// <summary>A task line inside a box (LOOK 2.4): circle, empty-state chips, avatar, "Add checklist", open.</summary>
    private UIElement TaskLine(TaskItem t)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Padding = new Thickness(4, 3, 6, 3), MinHeight = 36, Margin = new Thickness(0) };
        var circle = TaskParts.Circle(B, t.Priority, t.Done);
        ((FrameworkElement)circle).VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(circle);
        UIElement Chip(string icon) => new Border
        {
            Height = 22, Width = 26, CornerRadius = new CornerRadius(6), Background = B("BgHover"), VerticalAlignment = VerticalAlignment.Center,
            Child = new Icon(icon, 13, B("TextMuted")) { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center },
        };
        var meta = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 2, 0, 0) };
        meta.Children.Add(Chip("flag"));
        meta.Children.Add(Chip("calendar-days"));
        meta.Children.Add(Ui.Avatar(t.Assignee ?? "DU", 20));
        var add = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(4, 0, 0, 0) };
        add.Children.Add(new Icon("list-plus", 13, B("Text2")));
        add.Children.Add(Ui.Text("Add checklist", 11.5, B("Text2"), 600));
        meta.Children.Add(add);
        meta.Children.Add(new Icon("maximize-2", 13, B("Text2")) { Margin = new Thickness(6, 0, 0, 0) });
        row.Children.Add(meta);
        return row;
    }
}
