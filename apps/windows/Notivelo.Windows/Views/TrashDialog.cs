using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The workspace Trash (LOOK 6 "Trash"; Apple's Sheets.swift): deleted pages, sections and notebooks with Restore and Delete forever.
/// Delete forever asks twice: the trash button turns into a red "Delete forever" button, and so does "Empty Trash".</summary>
internal sealed class TrashDialog
{
    private readonly ShellHost _h;
    private readonly OverlayHost _o;
    private readonly Border _body = new();
    private List<TrashItem>? _items;
    private string? _error;
    private string? _confirming;           // an item id, or "*" for Empty Trash
    private OverlayHost.Layer? _layer;

    public static void Show(ShellHost host) => new TrashDialog(host).Open();

    private TrashDialog(ShellHost host) { _h = host; _o = host.Overlay; }

    private Brush B(string k) => ThemeBrushes.Get(k, _o);

    private async void Open()
    {
        var card = Dialogs.Card(_o, 540, _body);
        AutomationProperties.SetAutomationId(card, "trash-dialog");
        _layer = _o.Show(card, HorizontalAlignment.Center, VerticalAlignment.Top, new Thickness(0, 90, 0, 0));
        Draw();
        var list = await _h.Source.LoadTrash();
        _items = list.Items.ToList(); _error = list.Error;
        Draw();
    }

    private void Draw()
    {
        var panel = new StackPanel { Spacing = 6 };
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(Ui.Text("Trash", 16, B("Text"), 650));
        var close = Ui.IconButton("x", 15, 28, 28, "Close");
        AutomationProperties.SetAutomationId(close, "trash-close");
        close.Click += (_, _) => _layer?.Close();
        Grid.SetColumn(close, 1);
        head.Children.Add(close);
        panel.Children.Add(head);
        panel.Children.Add(Ui.Text("Deleted pages, sections and notebooks stay here for 60 days.", 12.5, B("TextMuted")).With(t => t.Margin = new Thickness(0, 0, 0, 6)));

        if (_error is not null)
            panel.Children.Add(Ui.Text(_error, 12.5, B("Danger")).With(t => { t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; }));
        if (_items is null) panel.Children.Add(Ui.Text("Loading…", 13.5, B("TextMuted")));
        else if (_items.Count == 0 && _error is null) panel.Children.Add(Ui.Text("The Trash is empty.", 13.5, B("TextMuted")).With(t => t.Margin = new Thickness(0, 10, 0, 10)));
        else
        {
            var list = new StackPanel();
            foreach (var e in _items) list.Children.Add(Row(e));
            panel.Children.Add(new ScrollViewer { MaxHeight = 380, Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
            var foot = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Spacing = 8, Margin = new Thickness(0, 8, 0, 0) };
            var empty = _confirming == "*"
                ? Dialogs.Btn(_o, "Empty Trash forever", false, true, "trash-empty-confirm")
                : Dialogs.Btn(_o, "Empty Trash", false, false, "trash-empty");
            empty.Click += async (_, _) =>
            {
                if (_confirming != "*") { _confirming = "*"; Draw(); return; }
                _confirming = null;
                var r = await _h.Source.EmptyTrash();
                if (r.Ok) _items = new List<TrashItem>(); else _error = r.Error;
                Draw();
            };
            foot.Children.Add(empty);
            panel.Children.Add(foot);
        }
        _body.Child = panel;
    }

    private UIElement Row(TrashItem e)
    {
        var g = new Grid { ColumnSpacing = 10, Padding = new Thickness(0, 6, 0, 6) };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.Children.Add(new Icon(e.Kind == TreeKind.Page ? "file-text" : e.Kind == TreeKind.Section ? "folder" : "book-open", 16, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Center });
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(Ui.Text(e.Name, 14, B("Text")));
        var detail = string.Join(" · ", new[] { e.Path, e.DeletedBy.Length > 0 ? "deleted by " + e.DeletedBy : "", e.DaysLeft + (e.DaysLeft == 1 ? " day left" : " days left") }.Where(x => x.Length > 0));
        text.Children.Add(Ui.Text(detail, 12, B("TextMuted")));
        Grid.SetColumn(text, 1);
        g.Children.Add(text);
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
        if (_confirming == e.Id)
        {
            var sure = Dialogs.Btn(_o, "Delete forever", false, true, "trash-forever-confirm-" + e.Id);
            sure.Click += async (_, _) =>
            {
                _confirming = null;
                var r = await _h.Source.DeleteForever(e);
                if (r.Ok) _items?.RemoveAll(x => x.Id == e.Id && x.Kind == e.Kind); else _error = r.Error;
                Draw();
            };
            actions.Children.Add(sure);
        }
        else
        {
            var restore = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 28, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6), Content = Ui.Text("Restore", 12.5, B("Accent"), 600) };
            AutomationProperties.SetAutomationId(restore, "trash-restore-" + e.Id);
            AutomationProperties.SetName(restore, "Restore " + e.Name);
            restore.Click += async (_, _) =>
            {
                var r = await _h.Source.Restore(e);
                if (r.Ok) { _items?.RemoveAll(x => x.Id == e.Id && x.Kind == e.Kind); if (r.Note is not null) _h.Toast(r.Note); } else _error = r.Error;
                Draw();
            };
            actions.Children.Add(restore);
            var del = Ui.IconButton("trash", 15, 28, 28, "Delete " + e.Name + " forever");
            AutomationProperties.SetAutomationId(del, "trash-delete-" + e.Id);
            del.Click += (_, _) => { _confirming = e.Id; Draw(); };
            actions.Children.Add(del);
        }
        Grid.SetColumn(actions, 2);
        g.Children.Add(actions);
        return new Border { Child = g, BorderBrush = B("Border"), BorderThickness = new Thickness(0, 0, 0, 1) };
    }
}
