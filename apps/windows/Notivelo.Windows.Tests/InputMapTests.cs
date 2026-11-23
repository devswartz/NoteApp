using System.Text;
using Notivelo.Windows.Text;
using Xunit;

namespace Notivelo.Windows.Tests;

public class InputMapTests
{
    [Theory]
    [InlineData("abc", "abXc", 2, 2, 1)]          // typed in the middle
    [InlineData("abc", "ab", 2, 3, 0)]            // deleted at the end
    [InlineData("hello world", "hello brave world", 6, 6, 6)]
    [InlineData("same", "same", 4, 4, 0)]
    [InlineData("aaa", "aaaa", 3, 3, 1)]
    [InlineData("abc", "xyz", 0, 3, 3)]
    public void Diff_keeps_the_common_prefix_and_suffix(string a, string b, int start, int oldEnd, int newLen)
    {
        var (s, e, n) = InputMap.DiffRange(a, b);
        Assert.Equal((start, oldEnd, newLen), (s, e, n));
        Assert.Equal(b, InputMap.Splice(a, s, e, b.Substring(s, n)));
    }

    [Fact]
    public void Diff_never_splits_a_surrogate_pair()
    {
        // U+1F600 (D83D DE00) and U+1F601 (D83D DE01) share their high unit
        var a = "x\U0001F600y";
        var b = "x\U0001F601y";
        var (s, e, n) = InputMap.DiffRange(a, b);
        Assert.Equal(1, s);
        Assert.Equal(3, e);
        Assert.Equal(2, n);
        Assert.Equal(b, InputMap.Splice(a, s, e, b.Substring(s, n)));
    }

    [Fact]
    public void Splice_clamps()
    {
        Assert.Equal("aXc", InputMap.Splice("abc", 1, 2, "X"));
        Assert.Equal("abcZ", InputMap.Splice("abc", 9, 12, "Z"));
    }

    [Theory]
    [InlineData("hello", 5, 5, 5, 5, "\r", UpdateKind.Enter)]
    [InlineData("hello", 5, 5, 5, 5, "\n", UpdateKind.Enter)]
    [InlineData("hello", 2, 2, 2, 2, "\t", UpdateKind.Tab)]
    [InlineData("hello", 5, 5, 4, 5, "", UpdateKind.Backspace)]
    [InlineData("hello", 5, 5, 5, 5, "!", UpdateKind.Insert)]
    [InlineData("hello", 1, 3, 1, 3, "J", UpdateKind.Insert)]        // typing over a selection
    [InlineData("hello", 5, 5, 0, 5, "Hello", UpdateKind.Replace)]    // autocorrect of the word before the caret
    [InlineData("hello", 5, 5, 3, 5, "", UpdateKind.Replace)]         // two units deleted
    [InlineData("hello", 2, 2, 4, 5, "", UpdateKind.Replace)]         // a delete away from the caret
    [InlineData("hi \U0001F600", 5, 5, 4, 5, "", UpdateKind.Replace)] // half a surrogate pair is not a Backspace
    [InlineData("a\nb", 2, 2, 1, 2, "", UpdateKind.Replace)]          // a line feed is not guessed
    public void Updates_are_told_to_the_engine_as_keys_or_text(string text, int s0, int s1, int r0, int r1, string t, UpdateKind want) =>
        Assert.Equal(want, InputMap.ClassifyUpdate(text, s0, s1, r0, r1, t));

    [Theory]
    [InlineData("b", true, false, false, false, false, "Mod+b")]
    [InlineData("B", true, false, true, false, false, "Mod+Shift+b")]
    [InlineData("Enter", true, false, false, false, false, "Mod+Enter")]
    [InlineData("Enter", false, false, false, false, false, "Enter")]
    [InlineData("Enter", false, false, true, false, false, "Shift+Enter")]
    [InlineData("Backspace", false, false, false, false, false, "Backspace")]
    [InlineData("Tab", false, false, true, false, false, "Shift+Tab")]
    [InlineData("1", true, true, false, false, false, "Mod+Alt+1")]
    [InlineData("8", true, false, true, false, false, "Mod+Shift+8")]
    [InlineData(".", true, false, false, false, false, "Mod+.")]
    [InlineData("ArrowUp", false, true, true, false, false, "Alt+Shift+ArrowUp")]
    [InlineData("Escape", false, false, false, false, false, "Escape")]
    public void Chords_follow_the_editors_names(string key, bool ctrl, bool alt, bool shift, bool altGr, bool menu, string want) =>
        Assert.Equal(want, InputMap.ChordOf(key, ctrl, alt, shift, altGr, menu));

    [Theory]
    [InlineData("a", false, false, false, false, false)]            // text goes through the text services
    [InlineData("a", false, false, true, false, false)]
    [InlineData("q", true, true, false, true, false)]               // AltGr + q is a character
    [InlineData("ArrowLeft", false, false, false, false, false)]    // caret movement is the view's
    [InlineData("ArrowRight", true, false, true, false, false)]
    [InlineData("Home", true, false, false, false, false)]
    [InlineData("ArrowUp", false, false, false, false, false)]
    [InlineData("ArrowDown", false, false, false, false, false)]
    public void Text_and_caret_keys_are_not_chords(string key, bool ctrl, bool alt, bool shift, bool altGr, bool menu) =>
        Assert.Null(InputMap.ChordOf(key, ctrl, alt, shift, altGr, menu));

    [Fact]
    public void An_open_menu_takes_plain_up_and_down()
    {
        Assert.Equal("ArrowDown", InputMap.ChordOf("ArrowDown", false, false, false, false, true));
        Assert.Null(InputMap.ChordOf("ArrowLeft", false, false, false, false, true));
    }

    [Theory]
    [InlineData("hello big world", 7, 6, 9)]
    [InlineData("hello big world", 5, 0, 5)]       // at a word's end: the word before
    [InlineData("hello big world", 0, 0, 5)]
    [InlineData("hello  world", 6, 5, 7)]          // spaces are their own run
    [InlineData("a, b", 1, 1, 2)]
    [InlineData("hello", 5, 0, 5)]
    [InlineData("it's", 1, 0, 4)]
    public void Double_click_selects_a_word(string text, int at, int from, int to) =>
        Assert.Equal(new Span(from, to), InputMap.WordAt(text, at));

    [Fact]
    public void A_word_never_crosses_a_line_feed_and_an_atom_is_alone()
    {
        Assert.Equal(new Span(0, 3), InputMap.WordAt("abc\ndef", 3));
        Assert.Equal(new Span(4, 7), InputMap.WordAt("abc\ndef", 4));
        Assert.Equal(new Span(1, 2), InputMap.WordAt("a￼b", 1));
        Assert.Equal(new Span(0, 0), InputMap.WordAt("", 0));
    }

    [Fact]
    public void Word_moves_follow_the_windows_convention()
    {
        var t = "one two  three\nfour";
        Assert.Equal(4, InputMap.WordRight(t, 0));
        Assert.Equal(9, InputMap.WordRight(t, 4));
        Assert.Equal(15, InputMap.WordRight(t, 14));      // over the line feed
        Assert.Equal(19, InputMap.WordRight(t, 19));
        Assert.Equal(9, InputMap.WordLeft(t, 14));
        Assert.Equal(4, InputMap.WordLeft(t, 9));
        Assert.Equal(0, InputMap.WordLeft(t, 3));
        Assert.Equal(14, InputMap.WordLeft(t, 15));       // back over the line feed
    }

    [Fact]
    public void Caret_steps_are_text_elements()
    {
        var t = "a\U0001F600b́c";                     // emoji pair; b + combining acute
        Assert.Equal(1, InputMap.Next(t, 0));
        Assert.Equal(3, InputMap.Next(t, 1));
        Assert.Equal(5, InputMap.Next(t, 3));
        Assert.Equal(6, InputMap.Next(t, 5));
        Assert.Equal(6, InputMap.Next(t, 6));
        Assert.Equal(5, InputMap.Prev(t, 6));
        Assert.Equal(3, InputMap.Prev(t, 5));
        Assert.Equal(1, InputMap.Prev(t, 3));
        Assert.Equal(0, InputMap.Prev(t, 1));
        Assert.Equal(0, InputMap.Prev(t, 0));
        Assert.Equal(2, InputMap.Next("a\n￼", 1));
        Assert.Equal(1, InputMap.Prev("a\n￼", 2));
    }

    [Fact]
    public void Hit_testing_takes_the_containing_rectangle_then_the_nearest()
    {
        var rects = new List<(double X, double Y, double W, double H, bool Skip)>
        {
            (0, 0, 100, 27, false),      // 0
            (0, 33, 50, 27, false),      // 1: a table row, left cell
            (50, 33, 50, 27, false),     // 2: right cell
            (0, 70, 100, 27, true),      // 3: hidden
            (0, 100, 100, 27, false),    // 4
        };
        Assert.Equal(0, InputMap.NearestRect(rects, 10, 5));
        Assert.Equal(2, InputMap.NearestRect(rects, 70, 40));
        Assert.Equal(1, InputMap.NearestRect(rects, 10, 40));
        Assert.Equal(0, InputMap.NearestRect(rects, 10, -50));         // above the first line
        Assert.Equal(4, InputMap.NearestRect(rects, 10, 500));         // below the last
        Assert.Equal(4, InputMap.NearestRect(rects, 10, 90));          // nearest, skipping the hidden one
        Assert.Equal(2, InputMap.NearestRect(rects, 400, 40));         // to the right of the row: the nearest cell
        Assert.Equal(-1, InputMap.NearestRect(new List<(double X, double Y, double W, double H, bool Skip)>(), 0, 0));
        Assert.Equal(11, InputMap.ObjectOffset(10, 90, 0, 100));
        Assert.Equal(10, InputMap.ObjectOffset(10, 20, 0, 100));
    }

    [Fact]
    public void Cf_html_round_trips_with_utf8_offsets()
    {
        var frag = "<p>café 日本語 <b>bold</b></p>";
        var cf = CfHtml.Create(frag);
        Assert.StartsWith("Version:1.0\r\nStartHTML:", cf);
        Assert.Equal(frag, CfHtml.Fragment(cf));
        // the header's byte offsets point at the fragment
        var bytes = Encoding.UTF8.GetBytes(cf);
        int Off(string n) { var i = cf.IndexOf(n + ":", StringComparison.Ordinal) + n.Length + 1; return int.Parse(cf.Substring(i, 10)); }
        Assert.Equal(frag, Encoding.UTF8.GetString(bytes, Off("StartFragment"), Off("EndFragment") - Off("StartFragment")));
        Assert.Equal(bytes.Length, Off("EndHTML"));
    }

    [Fact]
    public void Cf_html_from_other_apps_reads_by_markers_or_header()
    {
        Assert.Equal("<p>Hi</p>", CfHtml.Fragment("<html><body><!--StartFragment--><p>Hi</p><!--EndFragment--></body></html>"));
        Assert.Equal("<i>x</i>", CfHtml.Fragment("<i>x</i>"));
        Assert.Equal("", CfHtml.Fragment(""));
    }
}
