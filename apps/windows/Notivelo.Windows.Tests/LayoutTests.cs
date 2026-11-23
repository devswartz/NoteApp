using Notivelo.Native;
using Notivelo.Windows.Text;
using Xunit;
using static Notivelo.Windows.Tests.Lines;

namespace Notivelo.Windows.Tests;

public class MetricsTests
{
    private static readonly string[] Bullet = { "bulletList", "listItem" };

    [Fact]
    public void Type_scale_matches_the_look_spec()
    {
        Assert.Equal(new LineMetrics(16, 27.2, 400, 0, false), Metrics.Of(Ln(0, "x")));
        Assert.Equal(new LineMetrics(28, 36.4, 700, -0.02, false), Metrics.Of(Ln(0, "x", "heading", level: 1)));
        Assert.Equal(new LineMetrics(21.6, 29.16, 700, -0.01, false), Metrics.Of(Ln(0, "x", "heading", level: 2)));
        Assert.Equal(27.2, Metrics.Of(Ln(0, "x", "heading", level: 3)).Pitch);
        Assert.True(Metrics.Of(Ln(0, "x", "codeBlock")).Mono);
        Assert.Equal(600, Metrics.Of(Ln(0, "x", containers: new[] { "table", "tableRow", "tableHeader" })).Weight);
    }

    [Fact]
    public void Indentation_follows_the_containers()
    {
        Assert.Equal(0, Metrics.Indent(Ln(0, "x")).TextX);
        Assert.Equal(25.6, Metrics.Indent(Ln(0, "x", containers: Bullet, marker: "-")).TextX, 3);
        Assert.Equal(51.2, Metrics.Indent(Ln(0, "x", containers: new[] { "orderedList", "listItem", "bulletList", "listItem" })).TextX, 3);
        Assert.Equal(19, Metrics.Indent(Ln(0, "x", containers: new[] { "blockquote" })).TextX);
        var callout = Metrics.Indent(Ln(0, "x", containers: new[] { "callout" }));
        Assert.Equal(50, callout.TextX);
        Assert.Equal(14, callout.RightInset);
        Assert.Equal(26.2, Metrics.Indent(Ln(0, "x", containers: new[] { "taskList", "taskItem" }, check: false)).TextX, 3);
        var code = Metrics.Indent(Ln(0, "x", "codeBlock"));
        Assert.Equal((14, 34, 12), (code.TextX, code.TopPad, code.BottomPad));
        Assert.Equal(24, Metrics.Indent(Ln(0, "x", "detailsSummary", new[] { "details" })).TextX);
    }

    [Fact]
    public void The_first_block_keeps_its_own_margin()
    {
        Assert.Equal(0, Metrics.GapAbove(null, Ln(0, "x")));
        Assert.Equal(33.6, Metrics.GapAbove(null, Ln(0, "x", "heading", level: 1)), 3);
        Assert.Equal(4.8, Metrics.GapAbove(null, Ln(0, "x", containers: Bullet, marker: "-")), 3);
        Assert.Equal(9.6, Metrics.GapAbove(null, Ln(0, "x", containers: new[] { "callout" })), 3);
    }

    [Fact]
    public void Plain_blocks_are_a_point_four_em_apart_and_headings_win_with_their_margins()
    {
        var p = Ln(0, "a");
        Assert.Equal(6.4, Metrics.GapAbove(p, Ln(2, "b")), 3);
        Assert.Equal(33.6, Metrics.GapAbove(p, Ln(2, "b", "heading", level: 1)), 3);
        Assert.Equal(8.4, Metrics.GapAbove(Ln(0, "h", "heading", level: 1), Ln(2, "b")), 3);
        Assert.Equal(23.76, Metrics.GapAbove(p, Ln(2, "b", "heading", level: 2)), 3);
    }

    [Fact]
    public void List_items_touch_nested_lists_are_a_third_of_an_em_off_and_lists_beside_paragraphs_use_their_margin()
    {
        var one = Ln(0, "a", containers: Bullet, marker: "-");
        var two = Ln(2, "b", containers: Bullet, marker: "-");
        var nested = Ln(4, "c", containers: new[] { "bulletList", "listItem", "bulletList", "listItem" }, marker: "-");
        Assert.Equal(0, Metrics.GapAbove(one, two));
        Assert.Equal(4.8, Metrics.GapAbove(one, nested), 3);
        Assert.Equal(4.8, Metrics.GapAbove(nested, two), 3);
        Assert.Equal(4.8, Metrics.GapAbove(Ln(0, "para"), one), 3);
        Assert.Equal(4.8, Metrics.GapAbove(one, Ln(6, "para")), 3);
    }

    [Fact]
    public void A_second_paragraph_in_a_list_item_continues_it()
    {
        var item = Ln(0, "a", containers: new[] { "orderedList", "listItem" }, marker: "1.");
        var more = Ln(2, "b", containers: new[] { "orderedList", "listItem" });
        Assert.Equal(0, Metrics.GapAbove(item, more));
    }

    [Theory]
    [InlineData("5.", "6.", false)]
    [InlineData("5.", "7)", true)]   // the marker style changes: another list
    [InlineData("2.", "5.", true)]   // the number skips
    [InlineData("b.", "c.", false)]
    [InlineData("I.", "II.", false)]
    public void Adjacent_numbered_items_are_one_list_only_when_the_numbering_carries_on(string a, string b, bool newList)
    {
        var c = new[] { "orderedList", "listItem" };
        var prev = Ln(0, "x", containers: c, marker: a);
        var cur = Ln(2, "y", containers: c, marker: b);
        Assert.Equal(newList, Metrics.StartsNewList(prev, cur));
        Assert.Equal(newList ? 4.8 : 0, Metrics.GapAbove(prev, cur), 3);
    }

    [Fact]
    public void Checklist_items_are_a_fifth_of_an_em_apart()
    {
        var c = new[] { "taskList", "taskItem" };
        Assert.Equal(3.2, Metrics.GapAbove(Ln(0, "a", containers: c, check: true), Ln(2, "b", containers: c, check: false)), 3);
    }

    [Fact]
    public void Task_rows_sit_close_to_their_neighbours_and_a_tasks_notes_hug_it()
    {
        var para = Ln(0, "before");
        var task = Obj(8, "taskRef", taskId: "t1");
        var note = Ln(10, "note", containers: new[] { "taskRef" });
        Assert.Equal(4, Metrics.GapAbove(para, task));
        Assert.Equal(4, Metrics.GapAbove(task, note));
        Assert.Equal(38, Metrics.Indent(note).TextX);
        Assert.Equal(38 + 25.6, Metrics.Indent(Ln(0, "x", containers: new[] { "taskRef", "bulletList", "listItem" })).TextX, 3);
        Assert.Equal(0, Metrics.IndentBefore(Ln(0, "x", containers: new[] { "taskRef", "bulletList" }), "taskRef"));
        Assert.Equal(25.6, Metrics.IndentBefore(Ln(0, "x", containers: new[] { "bulletList", "taskRef" }), "taskRef"), 3);
    }

    [Fact]
    public void Callouts_and_quotes_pull_their_neighbours_apart_by_six_tenths_of_an_em()
    {
        var para = Ln(0, "a");
        Assert.Equal(9.6, Metrics.GapAbove(para, Ln(2, "b", containers: new[] { "callout" })), 3);
        Assert.Equal(9.6, Metrics.GapAbove(Ln(2, "b", containers: new[] { "blockquote" }), para), 3);
        Assert.Equal(22.4, Metrics.GapAbove(para, Obj(2, "horizontalRule")), 3);
    }

    [Fact]
    public void Summary_and_content_lines_of_a_toggle_are_recognised()
    {
        var summary = Ln(0, "Title", "detailsSummary", new[] { "details" });
        var body = Ln(6, "Body", containers: new[] { "details", "detailsContent" });
        Assert.True(Metrics.InSummary(summary));
        Assert.False(Metrics.InSummary(body));
        Assert.True(Metrics.InDetailsContent(body));
        Assert.Equal(500, Metrics.Of(summary).Weight);
        Assert.Equal(0, Metrics.GapAbove(summary, body));
    }
}

public class TableTests
{
    private static readonly string[] Cell = { "table", "tableRow", "tableCell" };
    private static readonly string[] Head = { "table", "tableRow", "tableHeader" };

    [Fact]
    public void Doc_json_gives_callouts_toggles_code_and_table_shapes_in_document_order()
    {
        const string json = """
        {"type":"doc","content":[
          {"type":"callout","attrs":{"emoji":"X"},"content":[{"type":"heading","content":[]},{"type":"paragraph"}]},
          {"type":"callout","content":[{"type":"paragraph"}]},
          {"type":"details","attrs":{"open":true},"content":[{"type":"detailsSummary"},{"type":"detailsContent","content":[{"type":"paragraph"}]}]},
          {"type":"codeBlock","attrs":{"language":"rust"}},
          {"type":"table","content":[
            {"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph"}]},{"type":"tableHeader","content":[{"type":"paragraph"}]}]},
            {"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph"},{"type":"paragraph"}]},{"type":"tableCell","content":[{"type":"paragraph"}]}]}
          ]}
        ]}
        """;
        var d = DocInfo.Parse(json);
        Assert.Equal(new[] { "X", "\U0001F4A1" }, d.CalloutEmoji);
        Assert.Equal(new[] { 2, 1 }, d.CalloutLines);
        Assert.Equal(new[] { true }, d.DetailsOpen);
        Assert.Equal(new string?[] { "rust" }, d.CodeLanguage);
        var t = Assert.Single(d.Tables);
        Assert.Equal(new[] { 1, 1 }, t[0]);
        Assert.Equal(new[] { 2, 1 }, t[1]);
    }

    [Fact]
    public void Bad_json_is_harmless()
    {
        Assert.Empty(DocInfo.Parse("not json").Tables);
    }

    [Fact]
    public void Table_lines_are_dealt_out_cell_by_cell()
    {
        // header row: 2 cells of 1 line; body row: first cell 2 lines, second 1 line; then a paragraph
        var lines = new List<ViewLine>
        {
            Ln(0, "Name", containers: Head), Ln(5, "Value", containers: Head),
            Ln(11, "a", containers: Cell), Ln(13, "a2", containers: Cell), Ln(16, "1", containers: Cell),
            Ln(18, "after"),
        };
        var shapes = new List<List<List<int>>> { new() { new() { 1, 1 }, new() { 2, 1 } } };
        var tables = TableMap.Find(lines, shapes);
        var t = Assert.Single(tables);
        Assert.Equal((0, 5, 2, 2), (t.FirstLine, t.LineCount, t.Rows, t.Cols));
        Assert.Equal((0, 0, true), (t.Cells[0].Row, t.Cells[0].Col, t.Cells[0].Header));
        Assert.Equal((0, 1), (t.Cells[1].Row, t.Cells[1].Col));
        Assert.Equal((1, 0), (t.Cells[2].Row, t.Cells[2].Col));
        Assert.Equal((1, 0), (t.Cells[3].Row, t.Cells[3].Col)); // a second line of the same cell
        Assert.Equal((1, 1), (t.Cells[4].Row, t.Cells[4].Col));
    }

    [Fact]
    public void Two_tables_in_a_row_are_told_apart_by_their_shapes()
    {
        var lines = new List<ViewLine>
        {
            Ln(0, "a", containers: Cell), Ln(2, "b", containers: Cell),
            Ln(4, "c", containers: Cell),
        };
        var shapes = new List<List<List<int>>> { new() { new() { 1, 1 } }, new() { new() { 1 } } };
        var tables = TableMap.Find(lines, shapes);
        Assert.Equal(2, tables.Count);
        Assert.Equal((0, 2), (tables[0].FirstLine, tables[0].LineCount));
        Assert.Equal((2, 1), (tables[1].FirstLine, tables[1].LineCount));
    }

    [Fact]
    public void Without_a_known_shape_each_line_is_a_cell_of_one_row()
    {
        var lines = new List<ViewLine> { Ln(0, "a", containers: Cell), Ln(2, "b", containers: Cell) };
        var t = Assert.Single(TableMap.Find(lines, new List<List<List<int>>>()));
        Assert.Equal((1, 2), (t.Rows, t.Cols));
    }
}
