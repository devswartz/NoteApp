using Notivelo.Native;
using Notivelo.Windows.Data;
using Notivelo.Windows.Text;
using Xunit;
using static Notivelo.Windows.Tests.Lines;

namespace Notivelo.Windows.Tests;

public class Left3RulesTests
{
    private static readonly string[] Cell = { "table", "tableRow", "tableCell" };

    [Fact]
    public void A_merged_cell_reads_its_spans_and_colour_from_the_document()
    {
        const string json = """
        {"type":"doc","content":[{"type":"table","content":[
          {"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":2,"rowspan":1,"background":"#ef4444"},"content":[{"type":"paragraph"}]}]},
          {"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph"}]},{"type":"tableCell","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph"}]}]}
        ]}]}
        """;
        var d = DocInfo.Parse(json);
        var t = Assert.Single(d.TableSpans);
        Assert.Equal(new CellSpan(2, 1, "#ef4444"), t[0][0]);
        Assert.Equal(new CellSpan(1, 1, null), t[1][0]);
        Assert.Equal(1, TableTools.Merged(d.TableSpans));
    }

    [Fact]
    public void Cells_land_on_grid_slots_that_merged_cells_leave_free()
    {
        // row 0: a (rowspan 2, col 0), b (col 1); row 1: c must sit in col 1 because a covers col 0
        var lines = new List<ViewLine> { Ln(0, "a", containers: Cell), Ln(2, "b", containers: Cell), Ln(4, "c", containers: Cell) };
        var shapes = new List<List<List<int>>> { new() { new() { 1, 1 }, new() { 1 } } };
        var spans = new List<List<List<CellSpan>>> { new() { new() { new(1, 2), new(1, 1) }, new() { new(1, 1) } } };
        var t = Assert.Single(TableMap.Find(lines, shapes, spans));
        Assert.Equal((2, 2), (t.Rows, t.Cols));
        Assert.Equal((0, 0, 1, 2), (t.Cells[0].Row, t.Cells[0].Col, t.Cells[0].ColSpan, t.Cells[0].RowSpan));
        Assert.Equal((0, 1), (t.Cells[1].Row, t.Cells[1].Col));
        Assert.Equal((1, 1), (t.Cells[2].Row, t.Cells[2].Col));
    }

    [Fact]
    public void A_colspan_widens_the_grid_and_pushes_the_next_cell()
    {
        var lines = new List<ViewLine> { Ln(0, "a", containers: Cell), Ln(2, "b", containers: Cell) };
        var shapes = new List<List<List<int>>> { new() { new() { 1, 1 } } };
        var spans = new List<List<List<CellSpan>>> { new() { new() { new(2, 1), new(1, 1) } } };
        var t = Assert.Single(TableMap.Find(lines, shapes, spans));
        Assert.Equal(3, t.Cols);
        Assert.Equal(2, t.Cells[1].Col);
    }

    [Fact]
    public void The_table_menu_has_merge_and_split()
    {
        var cmds = TableTools.Menu.Select(m => m.Command).ToList();
        Assert.Contains("mergeRight", cmds);
        Assert.Contains("mergeDown", cmds);
        Assert.Contains("splitCell", cmds);
    }

    [Fact]
    public void Names_are_trimmed_and_limited()
    {
        Assert.Equal(("Staff", null), AdminRules.CheckName("  Staff ", AdminRules.TeamNameMax, "team"));
        Assert.NotNull(AdminRules.CheckName("   ", AdminRules.TeamNameMax, "team").Error);
        Assert.NotNull(AdminRules.CheckName(new string('x', 61), AdminRules.TeamNameMax, "team").Error);
    }

    [Fact]
    public void Subteams_follow_their_team()
    {
        var ts = new List<TeamDetail> { new("a", "A", "#000000", null, new string[0]), new("c", "C", "#000000", "b", new string[0]), new("b", "B", "#000000", null, new string[0]), new("d", "D", "#000000", "a", new string[0]) };
        var order = AdminRules.OrderTeams(ts).Select(x => x.Team.Id + x.Depth).ToArray();
        Assert.Equal(new[] { "a0", "d1", "b0", "c1" }, order);
    }

    [Fact]
    public void Activity_times_read_as_ago_and_dates()
    {
        var now = new DateTimeOffset(2026, 11, 24, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal("just now", AdminRules.When("2026-11-24T11:59:40Z", now));
        Assert.Equal("5 min ago", AdminRules.When("2026-11-24T11:55:00Z", now));
        Assert.Equal("3 h ago", AdminRules.When("2026-11-24T09:00:00Z", now));
        Assert.Equal("yesterday", AdminRules.When("2026-11-23T09:00:00Z", now));
        Assert.Equal("", AdminRules.When("nonsense", now));
        Assert.True(AdminRules.CanOpen("page"));
        Assert.False(AdminRules.CanOpen("member"));
    }

    [Fact]
    public void Carets_are_clamped_and_read_out()
    {
        var c = new RemoteCaret("u", "Sam", "#0ea5e9", "b", 4, 99);
        Assert.Equal((4, 10), AdminRules.Clamp(c, 10));
        Assert.Equal("Sam@4-10/Lee@3", AdminRules.Readout(new[] { c, new RemoteCaret("v", "Lee", "#f00000", "b", 3, 3) }, 10));
        Assert.True(AdminRules.Same(new[] { c }, new[] { c with { } }));
        Assert.False(AdminRules.Same(new[] { c }, new[] { c with { Head = 5 } }));
    }
}
