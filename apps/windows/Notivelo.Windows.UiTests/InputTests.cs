using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>The manual input checklist of docs/rewrite/status/windows.md, driven with real keys on the real app (offline mode):
/// box "a" starts empty, box "b" holds "Second box".</summary>
public class InputTests
{
    [Fact]
    public void Typing_text() => AppHost.Run(nameof(Typing_text), h =>
    {
        h.A.Focus();
        h.Type("hello world");
        var s = h.A.WaitText("hello world");
        Assert.Equal((11, 11), (s.Anchor, s.Head));
        Assert.Equal("Second box", h.B.State.Text);
    });

    [Fact]
    public void Enter_and_Backspace() => AppHost.Run(nameof(Enter_and_Backspace), h =>
    {
        h.A.Focus();
        h.Type("ab");
        h.Press(ENTER);
        h.Type("cd");
        h.A.WaitText("ab\ncd");
        h.Press(BACK);
        h.A.WaitText("ab\nc");
        h.Press(BACK, 2);
        h.A.WaitText("ab");
    });

    [Fact]
    public void Shift_arrows_select_and_typing_replaces() => AppHost.Run(nameof(Shift_arrows_select_and_typing_replaces), h =>
    {
        h.A.Focus();
        h.Type("hello world");
        h.A.WaitText("hello world");
        for (var i = 0; i < 5; i++) h.Chord(SHIFT, LEFT);
        var s = h.A.WaitFor(x => x.Anchor != x.Head, "a range");
        Assert.Equal((11, 6), (s.Anchor, s.Head));
        h.Type("there");
        h.A.WaitText("hello there");
    });

    [Fact]
    public void Select_all_and_ctrl_arrows() => AppHost.Run(nameof(Select_all_and_ctrl_arrows), h =>
    {
        h.A.Focus();
        h.Type("one two three");
        h.A.WaitText("one two three");
        h.Chord(CONTROL, LEFT);
        h.A.WaitFor(x => x.Head == 8 && x.Anchor == 8, "caret before the last word");
        h.Chord(CONTROL, SHIFT, LEFT);
        h.A.WaitFor(x => x.Anchor == 8 && x.Head == 4, "a word selected backwards");
        h.Chord(CONTROL, KEY_A);
        h.A.WaitFor(x => Math.Abs(x.Head - x.Anchor) == 13, "everything selected");
        h.Type("x");
        h.A.WaitText("x");
    });

    [Fact]
    public void Slash_menu_applies_a_heading() => AppHost.Run(nameof(Slash_menu_applies_a_heading), h =>
    {
        h.A.Focus();
        h.Type("/");
        var s = h.A.WaitFor(x => x.Menu.StartsWith("slash:"), "the slash menu");
        Assert.StartsWith("slash:0/", s.Menu);
        h.Press(DOWN, 2);
        h.A.WaitFor(x => x.Menu.StartsWith("slash:2/"), "the third item highlighted");
        h.Press(ENTER);
        var after = h.A.WaitFor(x => x.Menu == "none", "the menu closed");
        Assert.Equal("", after.Text.TrimEnd((char)10));      // the heading, then the box's trailing paragraph
        Assert.StartsWith("heading", after.Block);
        h.Type("Title");
        h.A.WaitText("Title");
    });

    [Fact]
    public void Slash_menu_filters_and_makes_a_list() => AppHost.Run(nameof(Slash_menu_filters_and_makes_a_list), h =>
    {
        h.A.Focus();
        h.Type("/bullet");
        h.A.WaitFor(x => x.Menu.StartsWith("slash:"), "the slash menu with a query");
        h.Press(ENTER);
        var s = h.A.WaitFor(x => x.Menu == "none", "the menu closed");
        Assert.Equal("paragraph/•", s.Block);        // a bulleted list item
        h.Type("item");
        h.A.WaitText("item");
    });

    [Fact]
    public void Copy_and_paste_within_and_across_boxes() => AppHost.Run(nameof(Copy_and_paste_within_and_across_boxes), h =>
    {
        h.A.Focus();
        h.Type("hello");
        h.A.WaitText("hello");
        h.Chord(SHIFT, HOME);
        h.A.WaitFor(x => x.Anchor == 5 && x.Head == 0, "the line selected");
        h.Chord(CONTROL, KEY_C);
        h.Press(RIGHT);                        // collapse to the end
        h.A.WaitFor(x => x.Anchor == x.Head, "a caret");
        h.Chord(CONTROL, KEY_V);
        h.A.WaitText("hellohello");            // within the box
        h.B.Focus();
        h.Chord(CONTROL, KEY_V);
        h.B.WaitText("Second boxhello");       // across boxes
        Assert.Equal("hellohello", h.A.State.Text);
    });

    [Fact]
    public void System_clipboard_round_trip() => AppHost.Run(nameof(System_clipboard_round_trip), h =>
    {
        Clip.Set("from the system");
        h.A.Focus();
        h.Chord(CONTROL, KEY_V);
        h.A.WaitText("from the system");
        Clip.Set("replaced");                  // so that a stale paste cannot pass for the copy
        h.Chord(SHIFT, HOME);
        h.A.WaitFor(x => x.Anchor == 15 && x.Head == 0, "the line selected");
        h.Chord(CONTROL, KEY_C);
        AppHost.Wait(() => Clip.Get() == "from the system" ? "ok" : null, "the copy on the system clipboard", 8000);
        h.Chord(CONTROL, KEY_X);               // cut empties the box and fills the clipboard
        h.A.WaitText("");
        AppHost.Wait(() => Clip.Get() == "from the system" ? "ok" : null, "the cut on the system clipboard", 8000);
    });

    [Fact]
    public void System_clipboard_multiple_lines() => AppHost.Run(nameof(System_clipboard_multiple_lines), h =>
    {
        Clip.Set("one\r\ntwo");
        h.A.Focus();
        h.Chord(CONTROL, KEY_V);
        h.A.WaitText("one\ntwo");
    });

    [Fact]
    public void Undo_and_redo() => AppHost.Run(nameof(Undo_and_redo), h =>
    {
        h.A.Focus();
        h.Type("hello");
        h.A.WaitText("hello");
        h.Chord(CONTROL, KEY_Z);
        h.A.WaitText("");
        h.Chord(CONTROL, KEY_Y);
        h.A.WaitText("hello");
        h.Chord(CONTROL, KEY_Z);
        h.A.WaitText("");
        h.Chord(CONTROL, SHIFT, KEY_Z);
        h.A.WaitText("hello");
    });

    [Fact]
    public void Ctrl_Enter_makes_a_task() => AppHost.Run(nameof(Ctrl_Enter_makes_a_task), h =>
    {
        h.A.Focus();
        h.Type("buy milk");
        h.A.WaitText("buy milk");
        h.Chord(CONTROL, ENTER);
        AppHost.Wait(() => File.Exists(h.TaskLog) && File.ReadAllText(h.TaskLog).Contains("buy milk") ? "ok" : null, "the task created through the callbacks");
        Assert.Contains("create ", File.ReadAllText(h.TaskLog));
    });
}
