using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;
using Windows.System;

namespace Notivelo.Windows.Views;

/// <summary>The comment threads of the open page (Apple's CommentsModel, the web's collabComments): the list the panel shows, the thread being started (its text is
/// already marked in the page) and the thread open in the panel. Starting a comment marks the selection with a fresh thread id through the editor, the panel asks for
/// the first comment, and only then does the source create the thread; cancelling, or deleting a thread, takes the mark off again.</summary>
internal sealed class CommentsModel
{
    private readonly INotesSource _src;
    public string PageId { get; }
    private readonly Action<string> _unmark;

    public IReadOnlyList<CommentThreadInfo> Threads { get; private set; } = Array.Empty<CommentThreadInfo>();
    public bool Loaded { get; private set; }
    public (string ThreadId, string Quote)? Pending { get; private set; }
    public string? ActiveId { get; private set; }
    public string? EditingId { get; set; }
    public bool ShowResolved { get; set; }
    public bool Busy { get; private set; }
    public string? Failure { get; private set; }
    /// <summary>Unsent text of the composer ("new"), of a reply ("reply:id") and of an edit ("edit:id"): kept across redraws.</summary>
    public Dictionary<string, string> Drafts { get; } = new();
    public event Action? Changed;

    public CommentsModel(INotesSource src, string pageId, Action<string> unmark) { _src = src; PageId = pageId; _unmark = unmark; }

    public IEnumerable<CommentThreadInfo> Open => Threads.Where(t => !t.Resolved);
    public IEnumerable<CommentThreadInfo> Resolved => Threads.Where(t => t.Resolved);
    private void Raise() => Changed?.Invoke();

    public async void Reload()
    {
        var r = await _src.LoadComments(PageId);
        Loaded = true;
        if (r.Ok) { Threads = r.Value!; Failure = null; } else Failure = r.Error;
        Raise();
    }

    /// <summary>The selection is marked with <paramref name="threadId"/>: ask for its first comment.</summary>
    public void Begin(string threadId, string quote)
    {
        Cancel(false);
        Pending = (threadId, quote.Length > 500 ? quote[..500] : quote);
        ActiveId = threadId; Failure = null;
        Drafts.Remove("new");
        Raise();
    }

    public void Cancel(bool raise = true)
    {
        if (Pending is not { } p) return;
        Pending = null;
        if (ActiveId == p.ThreadId) ActiveId = null;
        Drafts.Remove("new");
        _unmark(p.ThreadId);
        if (raise) Raise();
    }

    public async void Submit(string body)
    {
        var text = body.Trim();
        if (Pending is not { } p || text.Length == 0 || Busy) return;
        Busy = true; Failure = null; Raise();
        var r = await _src.AddCommentThread(PageId, p.ThreadId, p.Quote, text);
        Busy = false;
        if (r.Ok) { Pending = null; Drafts.Remove("new"); Upsert(r.Value!); ActiveId = r.Value!.Id; }
        else Failure = r.Error;
        Raise();
    }

    public void Focus(string id) { if (ActiveId == id) return; ActiveId = id; if (Threads.FirstOrDefault(t => t.Id == id)?.Resolved == true) ShowResolved = true; Raise(); }

    private void Upsert(CommentThreadInfo t)
    {
        var list = Threads.ToList();
        var i = list.FindIndex(x => x.Id == t.Id);
        if (i >= 0) list[i] = t; else list.Add(t);
        Threads = list;
    }

    private async void Run(Func<Task<PageToolResult<CommentThreadInfo>>> call, Action<CommentThreadInfo>? ok = null)
    {
        var r = await call();
        if (r.Ok) { Failure = null; Upsert(r.Value!); ok?.Invoke(r.Value!); } else Failure = r.Error;
        Raise();
    }

    public void Reply(string threadId, string body) { var t = body.Trim(); if (t.Length > 0) Run(() => _src.ReplyToThread(threadId, t), _ => Drafts.Remove("reply:" + threadId)); }
    public void SetResolved(string threadId, bool resolved) => Run(() => _src.SetThreadResolved(threadId, resolved), _ => { if (resolved && ActiveId == threadId) ActiveId = null; });
    public void Edit(string commentId, string body) { var t = body.Trim(); if (t.Length > 0) Run(() => _src.EditComment(commentId, t), _ => { EditingId = null; Drafts.Remove("edit:" + commentId); }); }

    private void Removed(string threadId)
    {
        Threads = Threads.Where(t => t.Id != threadId).ToList();
        if (ActiveId == threadId) ActiveId = null;
        _unmark(threadId);
    }

    public async Task<string?> DeleteThread(string threadId)
    {
        var r = await _src.DeleteThread(threadId);
        if (r.Ok) { Removed(threadId); Raise(); } else { Failure = r.Error; Raise(); }
        return r.Error;
    }

    public async void DeleteComment(string threadId, string commentId)
    {
        var r = await _src.DeleteComment(commentId);
        if (!r.Ok) { Failure = r.Error; Raise(); return; }
        if (r.Value) { Removed(threadId); Raise(); } else Reload();
    }
}

/// <summary>The Comments tab of the page panel (collabCommentsPanel; LOOK 4.11): the thread being started, then the open threads, then the resolved ones behind
/// "Show n resolved". Redrawn when its model changes (not while typing, so the text boxes keep their focus).</summary>
internal sealed class CommentsBody : ThemedControl
{
    private readonly INotesSource _src;
    private readonly CommentsModel _m;
    internal ShellHost? Host { get; set; }

    public CommentsBody(INotesSource src, CommentsModel model)
    {
        _src = src; _m = model;
        Loaded += (_, _) => _m.Changed += OnChanged;
        Unloaded += (_, _) => _m.Changed -= OnChanged;
    }

    private void OnChanged() => Rebuild();

    protected override UIElement Build()
    {
        var canComment = _src.CanComment(_m.PageId);
        var list = new StackPanel { Spacing = 10, Padding = new Thickness(12) };
        if (_m.Pending is { } p) list.Children.Add(Composer(p.Quote));
        if (_m.Loaded && _m.Threads.Count == 0 && _m.Pending is null)
        {
            var empty = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Margin = new Thickness(4, 0, 4, 0) };
            empty.Children.Add(new Icon("message-square", 14, B("TextMuted")) { VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 2, 0, 0) });
            var t = Ui.Text("No comments yet." + (canComment ? " Select text and choose Comment to start a thread." : ""), 12.5, B("TextMuted"), lineHeight: 18);
            t.TextWrapping = TextWrapping.Wrap; t.TextTrimming = TextTrimming.None; t.MaxWidth = 250;
            empty.Children.Add(t);
            AutomationProperties.SetAutomationId(empty, "comments-empty");
            AutomationProperties.SetName(empty, "No comments yet.");
            list.Children.Add(empty);
        }
        foreach (var t in _m.Open) list.Children.Add(Card(t, canComment));
        var resolved = _m.Resolved.ToList();
        if (resolved.Count > 0)
        {
            var more = new Button { Style = Ui.Style("GhostButtonStyle"), Height = 30, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6), HorizontalAlignment = HorizontalAlignment.Left };
            var label = $"{(_m.ShowResolved ? "Hide" : "Show")} {resolved.Count} resolved";
            more.Content = Ui.Text(label, 13, B("Text2"), 500);
            AutomationProperties.SetAutomationId(more, "comments-show-resolved"); AutomationProperties.SetName(more, label);
            more.Click += (_, _) => { _m.ShowResolved = !_m.ShowResolved; Rebuild(); };
            list.Children.Add(more);
            if (_m.ShowResolved) foreach (var t in resolved) list.Children.Add(Card(t, canComment));
        }
        if (_m.Failure is { } f)
        {
            var e = Ui.Text(f, 12.5, B("Danger"), lineHeight: 18);
            e.TextWrapping = TextWrapping.Wrap; e.TextTrimming = TextTrimming.None; e.Margin = new Thickness(4, 0, 4, 0);
            AutomationProperties.SetAutomationId(e, "comments-error"); AutomationProperties.SetName(e, f);
            list.Children.Add(e);
        }
        AutomationProperties.SetAutomationId(list, "comments-panel");
        AutomationProperties.SetName(list, "Comments");
        AutomationProperties.SetItemStatus(list, $"threads={_m.Threads.Count} open={_m.Open.Count()} resolved={resolved.Count} pending={(_m.Pending is null ? 0 : 1)}");
        return new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    // ---- pieces ----

    private UIElement Quote(string text)
    {
        var g = new Grid { ColumnSpacing = 8, HorizontalAlignment = HorizontalAlignment.Stretch };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.Children.Add(new Border { Width = 3, Background = new SolidColorBrush(Microsoft.UI.ColorHelper.FromArgb(204, 234, 179, 8)), CornerRadius = new CornerRadius(1.5) });
        var t = Ui.Text(text.Length == 0 ? "(text removed)" : text, 12, B("TextMuted"));
        Grid.SetColumn(t, 1);
        g.Children.Add(t);
        return g;
    }

    private Border CardBox(UIElement content, bool accent, bool dim = false) => new()
    {
        Padding = new Thickness(10), CornerRadius = new CornerRadius(10), Background = B("Bg"), BorderBrush = accent ? B("Accent") : B("Border"),
        BorderThickness = new Thickness(accent ? 2 : 1), Child = content, Opacity = dim ? 0.7 : 1,
    };

    private Button Solid(string text, string id, bool primary, Action click)
    {
        var b = Dialogs.Btn(Host?.Overlay ?? throw new InvalidOperationException(), text, primary, id: id);
        b.Height = 30; b.Padding = new Thickness(12, 0, 12, 0);
        b.Click += (_, _) => click();
        return b;
    }

    /// <summary>A multi-line field with "@" completion over the workspace's members (picking one writes <c>@[Name](id) </c>).</summary>
    private StackPanel MentionBox(string draftKey, string placeholder, string id, bool focus, Action<string>? onChange = null)
    {
        var col = new StackPanel { Spacing = 4 };
        var tb = new TextBox
        {
            PlaceholderText = placeholder, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 56, MaxHeight = 160, FontSize = 14, CornerRadius = new CornerRadius(8),
            Padding = new Thickness(8), Text = _m.Drafts.GetValueOrDefault(draftKey, ""),
        };
        AutomationProperties.SetAutomationId(tb, id); AutomationProperties.SetName(tb, placeholder.Length == 0 ? "Comment" : placeholder);
        var sugg = new StackPanel { Padding = new Thickness(4), Visibility = Visibility.Collapsed };
        var box = new Border { Background = B("BgElevated"), BorderBrush = B("Border"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Child = sugg, Visibility = Visibility.Collapsed };
        tb.TextChanged += (_, _) =>
        {
            _m.Drafts[draftKey] = tb.Text;
            onChange?.Invoke(tb.Text);
            sugg.Children.Clear();
            if (PageToolRules.MentionQuery(tb.Text) is { } q)
            {
                foreach (var m in _src.Members().Where(m => q.Length == 0 || m.Name.Contains(q, StringComparison.OrdinalIgnoreCase) || m.Email.StartsWith(q, StringComparison.OrdinalIgnoreCase)).Take(6))
                {
                    var member = m;
                    var g = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                    g.Children.Add(new Border { Width = 8, Height = 8, CornerRadius = new CornerRadius(4), Background = Ui.Hex(m.Color.Length == 7 ? m.Color : "#6366f1"), VerticalAlignment = VerticalAlignment.Center });
                    g.Children.Add(Ui.Text(m.Name, 13.5, B("Text")));
                    g.Children.Add(Ui.Text(m.Email, 12, B("TextMuted")));
                    var b = new Button { Style = Ui.Style("GhostButtonStyle"), MinHeight = 34, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(6), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Left, Content = g };
                    AutomationProperties.SetAutomationId(b, "mention-" + m.Id); AutomationProperties.SetName(b, m.Name);
                    b.Click += (_, _) => { tb.Text = PageToolRules.InsertMention(tb.Text, member.Name, member.Id); tb.SelectionStart = tb.Text.Length; tb.Focus(FocusState.Programmatic); };
                    sugg.Children.Add(b);
                }
            }
            box.Visibility = sugg.Children.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            sugg.Visibility = box.Visibility;
        };
        col.Children.Add(tb);
        col.Children.Add(box);
        if (focus) tb.Loaded += (_, _) => { tb.Focus(FocusState.Programmatic); tb.SelectionStart = tb.Text.Length; };
        col.Tag = tb;
        return col;
    }

    private static TextBox TextOf(StackPanel mentionBox) => (TextBox)mentionBox.Tag;

    private UIElement Composer(string quote)
    {
        var col = new StackPanel { Spacing = 8 };
        col.Children.Add(Quote(quote));
        var box = MentionBox("new", "Add a comment… (@ to mention)", "comment-input", true);
        col.Children.Add(box);
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
        var cancel = Solid("Cancel", "comment-cancel", false, () => _m.Cancel());
        var send = Solid("Comment", "comment-submit", true, () => _m.Submit(TextOf(box).Text));
        send.IsEnabled = _m.Drafts.GetValueOrDefault("new", "").Trim().Length > 0 && !_m.Busy;
        TextOf(box).TextChanged += (_, _) => send.IsEnabled = TextOf(box).Text.Trim().Length > 0 && !_m.Busy;
        row.Children.Add(cancel); row.Children.Add(send);
        col.Children.Add(row);
        AutomationProperties.SetAutomationId(col, "comment-composer"); AutomationProperties.SetName(col, "New comment");
        return CardBox(col, true);
    }

    private UIElement Card(CommentThreadInfo t, bool canComment)
    {
        var active = _m.ActiveId == t.Id;
        var col = new StackPanel { Spacing = 8 };
        var head = new Grid { ColumnSpacing = 4 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(Quote(t.Quote));
        if (canComment)
        {
            var rs = Ui.IconButton(t.Resolved ? "rotate-ccw" : "check", 15, 32, 32, t.Resolved ? "Reopen thread" : "Resolve thread", 8);
            AutomationProperties.SetAutomationId(rs, "thread-resolve-" + t.Id); AutomationProperties.SetName(rs, t.Resolved ? "Reopen thread" : "Resolve thread");
            rs.Tapped += (_, e) => e.Handled = true;
            rs.Click += (_, _) => _m.SetResolved(t.Id, !t.Resolved);
            Grid.SetColumn(rs, 1); head.Children.Add(rs);
            if (t.CanDelete)
            {
                var del = Ui.IconButton("trash", 15, 32, 32, "Delete thread", 8);
                AutomationProperties.SetAutomationId(del, "thread-delete-" + t.Id); AutomationProperties.SetName(del, "Delete thread");
                del.Tapped += (_, e) => e.Handled = true;
                del.Click += (_, _) => { if (Host is { } h) Dialogs.Confirm(h.Overlay, "Delete this whole thread?", "The comment and all its replies are removed.", "Delete thread", true, () => _m.DeleteThread(t.Id)); };
                Grid.SetColumn(del, 2); head.Children.Add(del);
            }
        }
        col.Children.Add(head);
        if (t.ResolvedLine is { } rl) col.Children.Add(Ui.Text(rl, 12.5, B("TextMuted")));
        foreach (var c in t.Comments) col.Children.Add(Comment(t, c, canComment));
        if (canComment && active) col.Children.Add(ReplyBox(t));
        AutomationProperties.SetAutomationId(col, "thread-" + t.Id);
        AutomationProperties.SetName(col, t.Quote);
        AutomationProperties.SetItemStatus(col, $"comments={t.Comments.Count};resolved={(t.Resolved ? 1 : 0)};active={(active ? 1 : 0)}");
        var card = CardBox(col, active, t.Resolved);
        card.Tapped += (_, _) => _m.Focus(t.Id);
        return card;
    }

    private UIElement ReplyBox(CommentThreadInfo t)
    {
        var col = new StackPanel { Spacing = 6 };
        var box = MentionBox("reply:" + t.Id, t.Resolved ? "Reply to reopen…" : "Reply… (@ to mention)", "thread-reply-input-" + t.Id, false);
        col.Children.Add(box);
        var send = Solid("Reply", "thread-reply-send-" + t.Id, true, () => _m.Reply(t.Id, TextOf(box).Text));
        send.HorizontalAlignment = HorizontalAlignment.Right;
        send.Visibility = TextOf(box).Text.Trim().Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        TextOf(box).TextChanged += (_, _) => send.Visibility = TextOf(box).Text.Trim().Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        col.Children.Add(send);
        return col;
    }

    private UIElement Comment(CommentThreadInfo t, CommentInfo c, bool canComment)
    {
        var col = new StackPanel { Spacing = 4 };
        var head = new Grid { ColumnSpacing = 8 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(Ui.Avatar(AccountRules.Initials(c.Author, ""), 20, c.AuthorColor is { Length: 7 } ac ? ac : "#999999"));
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center };
        line.Children.Add(Ui.Text(c.Author, 13, B("Text"), 600));
        line.Children.Add(Ui.Text(c.When + (c.Edited ? " · edited" : ""), 12, B("TextMuted")));
        Grid.SetColumn(line, 1); head.Children.Add(line);
        if (canComment && c.CanChange)
        {
            var more = Ui.IconButton("ellipsis", 14, 28, 28, "Comment actions", 6);
            AutomationProperties.SetAutomationId(more, "comment-actions-" + c.Id); AutomationProperties.SetName(more, "Comment actions");
            more.Tapped += (_, e) => e.Handled = true;
            more.Click += (_, _) =>
            {
                var items = new List<MenuEntry>();
                if (c.Mine) items.Add(new MenuEntry("Edit", "pencil", () => { _m.EditingId = c.Id; _m.Drafts["edit:" + c.Id] = c.Body; Rebuild(); }, Id: "comment-edit-" + c.Id));
                items.Add(new MenuEntry("Delete", "trash", () => _m.DeleteComment(t.Id, c.Id), Danger: true, Id: "comment-delete-" + c.Id));
                if (Host is { } h) PopupMenu.Show(h.Overlay, items, more, endAlign: true, width: 160);
            };
            Grid.SetColumn(more, 2); head.Children.Add(more);
        }
        col.Children.Add(head);
        if (_m.EditingId == c.Id)
        {
            var box = MentionBox("edit:" + c.Id, "", "comment-edit-input-" + c.Id, true);
            col.Children.Add(box);
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            row.Children.Add(Solid("Cancel", "comment-edit-cancel-" + c.Id, false, () => { _m.EditingId = null; Rebuild(); }));
            row.Children.Add(Solid("Save", "comment-edit-save-" + c.Id, true, () => _m.Edit(c.Id, TextOf(box).Text)));
            col.Children.Add(row);
        }
        else
        {
            var tb = new TextBlock { FontSize = 14, FontFamily = Ui.Font, Foreground = B("Text"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(28, 0, 0, 0), LineHeight = 20 };
            foreach (var piece in PageToolRules.Pieces(c.Body))
            {
                var run = new Run { Text = piece.Text };
                if (piece.MentionId is { } id)
                {
                    run.Foreground = B("Accent");
                    if (id == _src.UserId) run.FontWeight = new FontWeight(600);
                }
                tb.Inlines.Add(run);
            }
            AutomationProperties.SetAutomationId(tb, "comment-body-" + c.Id); AutomationProperties.SetName(tb, c.Body);
            col.Children.Add(tb);
        }
        AutomationProperties.SetAutomationId(col, "comment-" + c.Id);
        AutomationProperties.SetName(col, $"{c.Author}: {c.Body}");
        return col;
    }
}
