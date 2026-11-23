using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;

namespace Notivelo.Windows.Controls;

/// <summary>The window-wide layer above the shell (LOOK 4.9 popovers, dialogs, the search palette, the task sheet, toasts). Everything is drawn
/// inside the window, so it is part of the UI tree (and the UI tests can find it) and takes the shell's theme.</summary>
internal sealed class OverlayHost : Grid
{
    internal sealed class Layer
    {
        public required Grid Root { get; init; }
        public Action? Closed { get; init; }
        public OverlayHost Host { get; init; } = null!;
        public void Close() => Host.Remove(this);
    }

    private readonly List<Layer> _layers = new();
    private readonly StackPanel _toasts = new() { VerticalAlignment = VerticalAlignment.Bottom, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 0, 0, 28), Spacing = 8, IsHitTestVisible = false };

    public OverlayHost()
    {
        Visibility = Visibility.Collapsed;
        Background = null;
        Children.Add(_toasts);
        Canvas.SetZIndex(_toasts, 100);
    }

    public bool IsOpen => _layers.Count > 0;

    /// <summary>Show content over the shell. <paramref name="dim"/> draws the backdrop (the --bg-overlay token, LOOK 2); a click outside the content closes it.</summary>
    public Layer Show(FrameworkElement content, HorizontalAlignment h, VerticalAlignment v, Thickness margin, bool dim = true, Action? closed = null, bool closeOnScrim = true)
    {
        var root = new Grid { Background = dim ? ThemeBrushes.Get("BgOverlay", this) : (Brush)new SolidColorBrush(Colors.Transparent), IsTabStop = false };
        var layer = new Layer { Root = root, Closed = closed, Host = this };
        if (closeOnScrim) root.PointerPressed += (s, e) => { if (ReferenceEquals(e.OriginalSource, root)) layer.Close(); };
        root.KeyDown += (_, e) => { if (e.Key == VirtualKey.Escape) { e.Handled = true; layer.Close(); } };
        content.HorizontalAlignment = h;
        content.VerticalAlignment = v;
        content.Margin = margin;
        root.Children.Add(content);
        _layers.Add(layer);
        Children.Insert(Children.Count - 1, root);
        Visibility = Visibility.Visible;
        return layer;
    }

    private void Remove(Layer l)
    {
        if (!_layers.Remove(l)) return;
        Children.Remove(l.Root);
        if (_layers.Count == 0 && _toasts.Children.Count == 0) Visibility = Visibility.Collapsed;
        l.Closed?.Invoke();
    }

    public void CloseAll() { foreach (var l in _layers.ToList()) Remove(l); }

    /// <summary>A short notice at the bottom (a result such as "Restored to Corpus", or an error).</summary>
    public void Toast(string text, Brush fg, Brush bg, Brush border)
    {
        var t = new Border
        {
            Background = bg, BorderBrush = border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(14, 9, 14, 9),
            Child = Ui.Text(text, 13, fg, 500), MaxWidth = 520,
        };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAutomationId(t, "toast");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(t, text);
        _toasts.Children.Add(t);
        Visibility = Visibility.Visible;
        _ = Task.Delay(3200).ContinueWith(_ => DispatcherQueue.TryEnqueue(() =>
        {
            _toasts.Children.Remove(t);
            if (_layers.Count == 0 && _toasts.Children.Count == 0) Visibility = Visibility.Collapsed;
        }));
    }
}
