using Xunit;
using Notivelo.Native;

namespace Notivelo.Windows.Tests;

/// <summary>The offline test mode opens a box on the empty Yjs update [0, 0] with the "default" field: this runs the real core on that
/// document and pins the engine behaviour the UI tests rely on.</summary>
public class OfflineSessionTests
{
    private sealed class Tasks : TaskCallbacks
    {
        public readonly List<string> Made = new();
        public string NewId() => Guid.NewGuid().ToString();
        public void Create(string id, string title, bool done) => Made.Add(title);
        public void Delete(string id) { }
        public bool Restore(string id) => false;
        public string? Title(string id) => null;
        public void SetTitle(string id, string title) { }
    }

    private static (EditorSession S, Tasks T) Open()
    {
        var t = new Tasks();
        return (EditorSession.Open(new byte[] { 0, 0 }, "default", t), t);
    }

    private static string Text(EditorSession s) => s.ViewRender().View.Text;

    [Fact]
    public void Types_and_splits_lines()
    {
        var (s, _) = Open();
        s.InsertText("hello");
        Assert.Equal("hello", Text(s));
        Assert.True(s.Key("Enter"));
        s.InsertText("world");
        Assert.Equal("hello\nworld", Text(s));
        Assert.True(s.Key("Backspace"));
        Assert.Equal("hello\nworl", Text(s));
    }

    [Fact]
    public void Typing_over_a_selection_replaces_it()
    {
        var (s, _) = Open();
        s.InsertText("abcdef");
        s.SetViewSelection(1, 4);
        s.InsertText("X");
        Assert.Equal("aXef", Text(s));
    }

    [Fact]
    public void Undo_and_redo()
    {
        var (s, _) = Open();
        s.InsertText("hello");
        Assert.True(s.ViewRender().CanUndo);
        s.Undo();
        Assert.Equal("", Text(s));
        s.Redo();
        Assert.Equal("hello", Text(s));
    }

    [Fact]
    public void Slash_menu_opens_and_picks()
    {
        var (s, _) = Open();
        s.InsertText("/");
        var r = s.ViewRender();
        Assert.NotNull(r.Suggestion);
        Assert.Equal(SuggestionTrigger.Slash, r.Suggestion!.Trigger);
        Assert.True(r.Suggestion.Items.Length > 1);
        Assert.True(s.Key("ArrowDown"));
        Assert.True(s.Key("ArrowDown"));
        Assert.Equal(2u, s.ViewRender().Suggestion!.Highlighted);   // Task, Text, Heading 1
        Assert.True(s.Key("Enter"));
        var after = s.ViewRender();
        Assert.Null(after.Suggestion);
        Assert.DoesNotContain("/", after.View.Text);
        Assert.True(after.View.Lines[0].Kind != "paragraph" || after.View.Lines[0].Marker is not null, string.Join("|", r.Suggestion.Items.Select(i => i.Id)) + " kind=" + after.View.Lines[0].Kind);
    }

    [Fact]
    public void Convert_to_task_calls_the_callbacks()
    {
        var (s, t) = Open();
        s.InsertText("buy milk");
        Assert.True(s.Key("Mod+Enter"));
        Assert.Single(t.Made);
        Assert.Equal("buy milk", t.Made[0]);
    }
}
