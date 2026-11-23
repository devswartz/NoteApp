using System.Drawing;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Input;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>Canvas boxes, links and the [[ menu on the offline page (boxes "a" and "b"): the parity checks of docs/rewrite/status/windows.md.</summary>
public class BoxTests
{
    private static List<string> BoxIds(AppHost h) =>
        h.Window.FindAllDescendants().Select(e => e.Properties.AutomationId.ValueOrDefault ?? "").Where(i => i.StartsWith("box-box-")).Select(i => i["box-box-".Length..]).OrderBy(i => i).ToList();

    /// <summary>An empty spot of the canvas: right of box "a", below box "b".</summary>
    private static Point EmptySpot(AppHost h)
    {
        var r = h.A.Bounds;
        return new Point((int)r.Left + 200, (int)r.Top + 300);
    }

    [Fact]
    public void Click_on_empty_canvas_makes_a_box() => AppHost.Run(nameof(Click_on_empty_canvas_makes_a_box), h =>
    {
        Assert.Equal(new[] { "a", "b" }, BoxIds(h));
        Mouse.Click(EmptySpot(h));
        var made = AppHost.Wait(() => BoxIds(h).Count == 3 ? BoxIds(h).First(i => i != "a" && i != "b") : null, "a third box");
        var box = new Box(h, made);
        box.WaitFor(s => s.Focus, "the new box focused");   // it opens for typing
        h.Type("fresh");
        box.WaitText("fresh");
    });

    [Fact]
    public void A_box_left_empty_is_removed() => AppHost.Run(nameof(A_box_left_empty_is_removed), h =>
    {
        Mouse.Click(EmptySpot(h));
        AppHost.Wait(() => BoxIds(h).Count == 3 ? "x" : null, "a third box");
        h.Press(ESCAPE);                                     // leave it without typing
        AppHost.Wait(() => BoxIds(h).Count == 2 ? "x" : null, "the empty box gone");
        Assert.Equal(new[] { "a", "b" }, BoxIds(h));
    });

    [Fact]
    public void A_box_with_text_stays() => AppHost.Run(nameof(A_box_with_text_stays), h =>
    {
        Mouse.Click(EmptySpot(h));
        var made = AppHost.Wait(() => BoxIds(h).Count == 3 ? BoxIds(h).First(i => i != "a" && i != "b") : null, "a third box");
        new Box(h, made).WaitFor(s => s.Focus, "focus");
        h.Type("keep me");
        h.Press(ESCAPE);
        Thread.Sleep(500);
        Assert.Equal(3, BoxIds(h).Count);
        Assert.Equal("keep me", new Box(h, made).State.Text);
    });

    [Fact]
    public void CtrlK_links_the_selection() => AppHost.Run(nameof(CtrlK_links_the_selection), h =>
    {
        h.A.Focus();
        h.Type("read docs");
        h.A.WaitText("read docs");
        h.Chord(CONTROL, KEY_A);
        h.A.WaitFor(x => x.Anchor != x.Head, "everything selected");
        h.Chord(CONTROL, KEY_K);
        h.A.WaitFor(x => x.Editor, "the link editor open");   // the address field has the keyboard (text is selected)
        Thread.Sleep(300);
        h.Type("https://example.com/docs");
        h.Press(ENTER);
        h.A.WaitFor(x => !x.Editor, "the link editor closed");
        h.Press(RIGHT);                                      // caret at the end of the linked text
        var s = h.A.WaitFor(x => x.Link.Length > 0, "a link at the caret");
        Assert.Equal("https://example.com/docs", s.Link);
        Assert.Equal("read docs", s.Text);
    });

    [Fact]
    public void Double_bracket_opens_the_page_menu() => AppHost.Run(nameof(Double_bracket_opens_the_page_menu), h =>
    {
        h.A.Focus();
        h.Type("see [[");
        h.A.WaitFor(x => x.Menu.StartsWith("pagelink"), "the page link menu");
        h.Press(ESCAPE);
    });
}
