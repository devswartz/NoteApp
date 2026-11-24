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

    [Fact]
    public void EditLink_links_the_selection_and_unsetLink_removes_it()
    {
        var (s, _) = Open();
        s.InsertText("see docs now");
        s.SetViewSelection(4, 8);
        Assert.True(s.Command("editLink", "{\"text\":\"docs\",\"href\":\"https://example.com\"}"));
        var run = s.ViewRender().View.Lines[0].Runs.First(r => r.Marks.Any(m => m.Kind == ViewMarkKind.Link));
        Assert.Equal((uint)4, run.From);
        Assert.Equal("https://example.com", run.Marks.First(m => m.Kind == ViewMarkKind.Link).Value);
        s.SetViewSelection(4, 8);
        Assert.True(s.Command("unsetLink", "{}"));
        Assert.DoesNotContain(s.ViewRender().View.Lines[0].Runs, r => r.Marks.Any(m => m.Kind == ViewMarkKind.Link));
    }

    [Fact]
    public void EditLink_with_a_new_text_inserts_a_link()
    {
        var (s, _) = Open();
        s.InsertText("go ");
        Assert.True(s.Command("editLink", "{\"text\":\"home\",\"href\":\"example.com/notes\"}"));
        Assert.Equal("go home", Text(s));
        Assert.Contains(s.ViewRender().View.Lines[0].Runs, r => r.Marks.Any(m => m.Kind == ViewMarkKind.Link));
    }

    [Fact]
    public void Ink_builder_gives_an_outline_of_path_commands()
    {
        using var b = new InkStrokeBuilder(0, 0x1D4ED8FF, 4f, false, false);
        var samples = new List<double>();
        for (var i = 0; i < 20; i++) samples.AddRange(new[] { 20.0 + i * 6, 100 + 20 * Math.Sin(i / 3.0), 0.5, 1.2, 0, i * 8.0 });
        b.PushMany(samples.ToArray());
        var ops = b.Preview(Array.Empty<float>());
        Assert.NotEmpty(ops);
        var at = 0;                 // path commands: 0 x y, 1 x y, 2 cx cy r, 3
        while (at < ops.Length) { var n = (int)ops[at] switch { 0 or 1 => 3, 2 => 4, 3 => 1, _ => -1 }; Assert.True(n > 0, "op " + ops[at]); at += n; }
        Assert.Equal(ops.Length, at);
        Assert.DoesNotContain(ops, float.IsNaN);
    }

    [Fact]
    public void Images_and_file_cards_insert_select_and_resize()
    {
        var (s, _) = Open();
        s.InsertText("before");
        Assert.True(s.Command("insertImage", "{\"src\":\"/uploads/abc.png\",\"alt\":\"cat.png\"}"));
        Assert.True(s.Command("insertFile", "{\"url\":\"/uploads/def.pdf\",\"name\":\"a.pdf\",\"size\":2048,\"mime\":\"application/pdf\"}"));
        var lines = s.ViewRender().View.Lines;
        var img = lines.Single(l => l.Kind == "image");
        var file = lines.Single(l => l.Kind == "fileAttachment");
        Assert.Contains("/uploads/abc.png", img.AttrsJson);
        Assert.Contains("a.pdf", file.AttrsJson);
        // an unsafe address is refused
        Assert.False(s.Command("insertImage", "{\"src\":\"javascript:alert(1)\",\"alt\":\"x\"}"));
        // a click on the picture selects it, and the resize command takes the selected node (width at least 80, height as given)
        s.SetViewSelection(img.Offset, img.Offset + 1);
        Assert.True(s.Command("setImageWidth", "{\"width\":240,\"height\":160}"));
        var after = s.ViewRender().View.Lines.Single(l => l.Kind == "image");
        Assert.Contains("240", after.AttrsJson);
        Assert.Contains("160", after.AttrsJson);
        Assert.True(s.Command("setImageWidth", "{\"width\":10}"));
        Assert.Contains("80", s.ViewRender().View.Lines.Single(l => l.Kind == "image").AttrsJson);
    }
}
