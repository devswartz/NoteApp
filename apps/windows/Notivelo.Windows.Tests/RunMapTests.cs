using Notivelo.Native;
using Notivelo.Windows.Text;
using Xunit;
using static Notivelo.Windows.Tests.Lines;

namespace Notivelo.Windows.Tests;

public class RunMapTests
{
    [Fact]
    public void Runs_are_line_relative_and_survive_a_surrogate_pair()
    {
        // an emoji is two UTF-16 units, so "bold" starts at 5
        var text = "\U0001F600 a bold word";
        var line = Ln(40, text, runs: new[] { R(0, 5), R(5, 4, M(ViewMarkKind.Bold)), R(9, 5) });
        var runs = RunMap.Resolve(line);
        Assert.Equal(3, runs.Count);
        Assert.Equal("bold", text.Substring(runs[1].Start, runs[1].Len));
        Assert.True(runs[1].Style.Bold);
        Assert.Equal(45, RunMap.ToView(line, runs[1].Start)); // absolute view offset
    }

    [Fact]
    public void Gaps_and_overlong_runs_are_filled_and_clamped()
    {
        var line = Ln(0, "abcdef", runs: new[] { R(1, 2, M(ViewMarkKind.Italic)), R(4, 99, M(ViewMarkKind.Strike)) });
        var runs = RunMap.Resolve(line);
        Assert.Collection(runs,
            a => { Assert.Equal((0, 1), (a.Start, a.Len)); Assert.Equal(RunStyle.Plain, a.Style); },
            b => { Assert.Equal((1, 2), (b.Start, b.Len)); Assert.True(b.Style.Italic); },
            c => { Assert.Equal((3, 1), (c.Start, c.Len)); Assert.Equal(RunStyle.Plain, c.Style); },
            d => { Assert.Equal((4, 2), (d.Start, d.Len)); Assert.True(d.Style.Strike); });
        Assert.Equal(6, runs.Sum(r => r.Len));
    }

    [Fact]
    public void A_line_without_runs_is_one_plain_range_and_an_empty_line_has_none()
    {
        Assert.Single(RunMap.Resolve(Ln(0, "plain")));
        Assert.Empty(RunMap.Resolve(Ln(0, "")));
    }

    [Fact]
    public void Marks_combine_on_one_run()
    {
        var line = Ln(0, "x", runs: new[]
        {
            R(0, 1, M(ViewMarkKind.Bold), M(ViewMarkKind.Link, "https://a.example"), M(ViewMarkKind.TextColor, "red"), M(ViewMarkKind.Highlight), M(ViewMarkKind.Code), M(ViewMarkKind.Comment, "t1")),
        });
        var s = RunMap.Resolve(line)[0].Style;
        Assert.True(s.Bold && s.Code && s.Comment && s.Highlighted);
        Assert.Equal("https://a.example", s.Href);
        Assert.Equal("red", s.Color);
        Assert.Null(s.Highlight); // no name: the default yellow
    }

    [Fact]
    public void LineAt_finds_the_line_holding_an_offset_including_its_line_feed()
    {
        // "ab", "cde", "", "f" joined by line feeds: starts at 0, 3, 7, 8
        var lines = new List<ViewLine> { Ln(0, "ab"), Ln(3, "cde"), Ln(7, ""), Ln(8, "f") };
        Assert.Equal(0, RunMap.LineAt(lines, 0));
        Assert.Equal(0, RunMap.LineAt(lines, 2));
        Assert.Equal(1, RunMap.LineAt(lines, 3));
        Assert.Equal(1, RunMap.LineAt(lines, 6));
        Assert.Equal(2, RunMap.LineAt(lines, 7));
        Assert.Equal(3, RunMap.LineAt(lines, 99));
        Assert.Equal(-1, RunMap.LineAt(new List<ViewLine>(), 0));
    }

    [Fact]
    public void ToLine_clamps_the_column()
    {
        var lines = new List<ViewLine> { Ln(0, "ab"), Ln(3, "cde") };
        Assert.Equal((1, 2), RunMap.ToLine(lines, 5));
        Assert.Equal((0, 2), RunMap.ToLine(lines, 2));
        Assert.Equal((1, 3), RunMap.ToLine(lines, 40));
    }

    [Fact]
    public void TextOf_slices_the_view_string_and_never_throws()
    {
        var view = "ab\ncde";
        Assert.Equal("cde", RunMap.TextOf(view, Ln(3, "cde")));
        Assert.Equal("", RunMap.TextOf(view, Ln(50, "zzz")));
        Assert.Equal("cde", RunMap.TextOf(view, new ViewLine(3, 99, 3, true, "paragraph", 0, Array.Empty<string>(), null, null, null, Array.Empty<ViewRun>(), Array.Empty<ViewAtom>(), null)));
    }

    [Fact]
    public void SelectionIn_clips_a_range_to_each_line()
    {
        var l0 = Ln(0, "ab");
        var l1 = Ln(3, "cde");
        // 1..5 starts inside the first line and ends inside the second
        Assert.Equal((1, 2), RunMap.SelectionIn(l0, 1, 5));
        Assert.Equal((0, 2), RunMap.SelectionIn(l1, 1, 5));
        // reversed anchor and head give the same ranges
        Assert.Equal((1, 2), RunMap.SelectionIn(l0, 5, 1));
        Assert.Equal((0, 3), RunMap.SelectionIn(l1, 0, 9));
    }

    [Fact]
    public void SelectionIn_is_null_outside_a_line()
    {
        var l1 = Ln(3, "cde");
        Assert.Null(RunMap.SelectionIn(l1, 0, 3));   // ends where the line starts
        Assert.Null(RunMap.SelectionIn(l1, 7, 9));   // begins after its end
        Assert.Equal((1, 3), RunMap.SelectionIn(l1, 4, 20));
    }

    [Fact]
    public void StyleAt_reads_the_range_holding_an_offset_or_the_one_before_the_end()
    {
        var line = Ln(0, "abcd", runs: new[] { R(0, 2), R(2, 2, M(ViewMarkKind.Bold)) });
        var runs = RunMap.Resolve(line);
        Assert.False(RunMap.StyleAt(runs, 1).Bold);
        Assert.True(RunMap.StyleAt(runs, 2).Bold);
        Assert.True(RunMap.StyleAt(runs, 4).Bold);
    }

    [Fact]
    public void Text_colours_and_highlights_follow_the_theme()
    {
        Assert.Equal("#c42b2b", TextColors.Text("red", false));
        Assert.Equal("#f47c7c", TextColors.Text("red", true));
        Assert.Null(TextColors.Text("nope", false));
        Assert.Equal("#fcf0b0", TextColors.Highlight(null, false));
        Assert.Equal("#1e3a5c", TextColors.Highlight("Blue", true));
    }
}
