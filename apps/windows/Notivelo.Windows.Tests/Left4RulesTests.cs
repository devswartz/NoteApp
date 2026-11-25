using Notivelo.Native;
using Notivelo.Windows.Data;
using Notivelo.Windows.Text;
using Xunit;

namespace Notivelo.Windows.Tests;

/// <summary>left4: saved views (the web's query JSON), bulk selection, the outline and the block menu's edits (over the real engine).</summary>
public class Left4RulesTests
{
    private sealed class Tasks : TaskCallbacks
    {
        public string NewId() => Guid.NewGuid().ToString();
        public void Create(string id, string title, bool done) { }
        public void Delete(string id) { }
        public bool Restore(string id) => false;
        public string? Title(string id) => null;
        public void SetTitle(string id, string title) { }
    }

    private static EditorSession Open() => EditorSession.Open(new byte[] { 0, 0 }, "default", new Tasks());
    private static string Text(EditorSession s) => s.ViewState().Text.TrimEnd((char)10);

    /// <summary>A box of "Title" (heading 1), "Intro" (paragraph), "Item A", "Item B" (bullets), "Last" (paragraph).</summary>
    private static EditorSession Sample()
    {
        var s = Open();
        s.InsertText("Title");
        s.Command("setHeading", "{\"level\":1}");
        s.Key("Enter");
        s.InsertText("Intro");
        s.Key("Enter");
        s.Command("toggleBulletList", "{}");
        s.InsertText("Item A");
        s.Key("Enter");
        s.InsertText("Item B");
        s.Key("Enter");
        s.Key("Enter");   // leaves the list
        s.InsertText("Last");

        return s;
    }

    private static string Kinds(EditorSession s) => string.Join(",", s.ViewState().Lines.Select(l => l.Kind + (l.Marker is null ? "" : "*")));

    // ---- engine behaviour the block menu relies on ----

    [Fact]
    public void The_sample_box_has_the_lines_the_tests_expect()
    {
        var s = Sample();
        Assert.Equal(5, Text(s).Split((char)10).Length);
        Assert.Equal("heading,paragraph,paragraph*,paragraph*,paragraph,paragraph", Kinds(s));   // the engine keeps an empty paragraph after a list at the end
    }

    [Fact]
    public void Block_span_of_a_list_item_is_the_item_and_a_plain_line_is_itself()
    {
        var s = Sample();
        var lines = s.ViewState().Lines;
        var item = BlockOps.Of(lines, 2)!;
        Assert.Equal((2, 2), (item.FirstLine, item.LastLine));
        var plain = BlockOps.Of(lines, 1)!;
        Assert.Equal(("Intro".Length, 6, 11), (plain.To - plain.From, plain.From, plain.To));
    }

    [Fact]
    public void Move_down_swaps_a_block_with_the_next_and_up_swaps_back()
    {
        var s = Sample();
        Assert.True(BlockOps.Move(s, 1, up: false));       // Intro goes below the list
        Assert.Equal("Title\nItem A\nItem B\nIntro\nLast", Text(s));
        Assert.True(BlockOps.Move(s, 3, up: true));
        Assert.Equal("Title\nIntro\nItem A\nItem B\nLast", Text(s));
    }

    [Fact]
    public void Move_up_of_the_first_block_does_nothing()
    {
        var s = Sample();
        Assert.False(BlockOps.Move(s, 0, up: true));
        Assert.Equal("Title\nIntro\nItem A\nItem B\nLast", Text(s));
    }

    [Fact]
    public void Delete_removes_a_middle_block_the_first_and_the_last()
    {
        var s = Sample();
        Assert.True(BlockOps.Delete(s, 1));
        Assert.Equal("Title\nItem A\nItem B\nLast", Text(s));
        Assert.True(BlockOps.Delete(s, 0));
        Assert.Equal("Item A\nItem B\nLast", Text(s));
        Assert.True(BlockOps.Delete(s, 2));
        Assert.Equal("Item A\nItem B", Text(s));
        Assert.True(BlockOps.Delete(s, 0));
        Assert.Equal("Item B", Text(s));
    }

    [Fact]
    public void Deleting_a_heading_leaves_the_block_below_with_its_own_kind()
    {
        var s = Open();
        s.InsertText("one"); s.Key("Enter"); s.InsertText("head"); s.Command("setHeading", "{\"level\":1}"); s.Key("Enter"); s.InsertText("two");
        Assert.True(BlockOps.Delete(s, 1));
        Assert.Equal("one\ntwo", Text(s));
        Assert.StartsWith("paragraph,paragraph", Kinds(s));   // the engine may keep an empty paragraph after it
        s = Open();
        s.InsertText("head"); s.Command("setHeading", "{\"level\":1}"); s.Key("Enter"); s.InsertText("two");
        Assert.True(BlockOps.Delete(s, 0));
        Assert.Equal("two", Text(s));
        Assert.StartsWith("paragraph", Kinds(s));
    }

    [Fact]
    public void Delete_of_the_only_block_empties_it()
    {
        var s = Open();
        s.InsertText("alone");
        Assert.True(BlockOps.Delete(s, 0));
        Assert.Equal("", Text(s));
    }

    [Fact]
    public void Duplicate_copies_a_paragraph_a_heading_and_a_list_item_in_place()
    {
        var s = Sample();
        Assert.True(BlockOps.Duplicate(s, 1));
        Assert.Equal("Title\nIntro\nIntro\nItem A\nItem B\nLast", Text(s));
        s = Sample();
        Assert.True(BlockOps.Duplicate(s, 0));
        Assert.Equal("Title\nTitle\nIntro\nItem A\nItem B\nLast", Text(s));
        Assert.Equal("heading,heading", string.Join(",", s.ViewState().Lines.Take(2).Select(l => l.Kind)));
        s = Sample();
        Assert.True(BlockOps.Duplicate(s, 2));
        Assert.Equal("Title\nIntro\nItem A\nItem A\nItem B\nLast", Text(s));
        Assert.Equal("heading,paragraph,paragraph*,paragraph*,paragraph*,paragraph,paragraph", Kinds(s));   // the last one is the engine's empty paragraph after a list
    }

    [Fact]
    public void Block_edits_are_one_undo_step_each()
    {
        var s = Sample();
        BlockOps.Delete(s, 1);
        Assert.True(s.Undo());
        Assert.Equal("Title\nIntro\nItem A\nItem B\nLast", Text(s));
    }

    // ---- the outline ----

    [Fact]
    public void Outline_lists_the_headings_with_their_level_and_offset()
    {
        var s = Sample();
        s.SetViewSelection(6, 6);
        s.Command("setHeading", "{\"level\":2}");
        var v = s.ViewState();
        var items = OutlineRules.Of("box:a", v.Text, v.Lines);
        Assert.Equal(new[] { "Title", "Intro" }, items.Select(i => i.Text));
        Assert.Equal(new[] { 1, 2 }, items.Select(i => i.Level));
        Assert.Equal(new[] { 0, 6 }, items.Select(i => i.Offset));
    }

    [Fact]
    public void Outline_skips_empty_headings_and_reads_boxes_top_to_bottom()
    {
        var a = new[] { new OutlineEntry("b", 1, "Lower", 0) };
        var b = new[] { new OutlineEntry("a", 1, "Upper", 0), new OutlineEntry("a", 2, "Sub", 12) };
        var page = OutlineRules.Page(new (double, double, IReadOnlyList<OutlineEntry>)[] { (10, 300, a), (10, 40, b) });
        Assert.Equal(new[] { "Upper", "Sub", "Lower" }, page.Select(e => e.Text));
        Assert.Equal(1, OutlineRules.Active(page, "a", 20));
        Assert.Equal(-1, OutlineRules.Active(page, "z", 20));
        Assert.Equal(1, OutlineRules.Indent(page, page[1]));
        Assert.Equal(new[] { 0, 1, 2 }, OutlineRules.Bars(page, 8));
        var many = Enumerable.Range(0, 30).Select(i => new OutlineEntry("a", 1, "h" + i, i)).ToList();
        Assert.Equal(8, OutlineRules.Bars(many, 8).Count);
    }

    // ---- saved views ----

    [Fact]
    public void A_view_query_round_trips_through_the_webs_json()
    {
        var s = new TaskViewState { Group = TaskGrouping.Page, Sort = TaskSort.Priority, Due = TaskDueFilter.Week, Status = TaskStatusFilter.Any, Q = " launch " };
        s.Priority.Add(1); s.Priority.Add(2); s.Assignee.Add("me"); s.Tags.Add("tag-a"); s.Teams.Add("team-1"); s.Source.Add("notes"); s.IncludeSubteams = false;
        var json = SavedViewRules.ToQueryJson(s);
        Assert.Contains("\"group\":\"note\"", json);
        Assert.Contains("\"sort\":\"priority\"", json);
        Assert.Contains("\"q\":\"launch\"", json);
        var back = SavedViewRules.FromQueryJson(json);
        Assert.Equal(s.Group, back.Group); Assert.Equal(s.Sort, back.Sort); Assert.Equal(s.Due, back.Due); Assert.Equal(s.Status, back.Status);
        Assert.Equal("launch", back.Q);
        Assert.Equal(new[] { 1, 2 }, back.Priority.OrderBy(x => x));
        Assert.Equal(new[] { "me" }, back.Assignee); Assert.Equal(new[] { "tag-a" }, back.Tags); Assert.Equal(new[] { "team-1" }, back.Teams);
        Assert.Equal(new[] { "notes" }, back.Source); Assert.False(back.IncludeSubteams);
        Assert.Equal(json, SavedViewRules.ToQueryJson(back));
    }

    [Fact]
    public void A_view_made_on_the_web_is_read_leniently()
    {
        var web = "{\"filters\":{\"assignee\":\"me\",\"priority\":{\"values\":[\"1\",\"9\"],\"not\":false},\"due\":\"overdue\",\"sectionId\":{\"values\":[\"s1\"],\"not\":true},\"q\":\"\"},\"sort\":\"created\",\"group\":\"assignee\"}";
        var s = SavedViewRules.FromQueryJson(web);
        Assert.Equal(new[] { "me" }, s.Assignee);
        Assert.Equal(new[] { 1 }, s.Priority);
        Assert.Equal(TaskDueFilter.Overdue, s.Due);
        Assert.Equal(TaskSort.Created, s.Sort);
        Assert.Equal(TaskGrouping.Assignee, s.Group);
        Assert.Equal(TaskStatusFilter.Open, s.Status);
        var junk = SavedViewRules.FromQueryJson("not json");
        Assert.False(junk.AnyFilter);
        Assert.Equal(TaskGrouping.None, junk.Group);
        Assert.False(SavedViewRules.FromQueryJson("[1,2]").AnyFilter);
    }

    [Fact]
    public void Matching_finds_the_saved_view_the_state_is_and_never_the_plain_list()
    {
        var urgent = new TaskViewState { Group = TaskGrouping.None }; urgent.Priority.Add(1);
        var views = new[]
        {
            new SavedView("v1", "Urgent", SavedViewRules.ToQueryJson(urgent), false, "u1", 1),
            new SavedView("v2", "Plain", SavedViewRules.ToQueryJson(new TaskViewState { Group = TaskGrouping.None }), false, "u1", 2),
        };
        Assert.Equal("v1", SavedViewRules.Matching(views, urgent)?.Id);
        Assert.Null(SavedViewRules.Matching(views, new TaskViewState { Group = TaskGrouping.None }));
        var other = new TaskViewState { Group = TaskGrouping.None }; other.Priority.Add(2);
        Assert.Null(SavedViewRules.Matching(views, other));
        Assert.True(SavedViewRules.Same(urgent, views[0].QueryJson));
    }

    [Fact]
    public void Apply_copies_the_conditions_and_clears_the_upcoming_flags()
    {
        var from = SavedViewRules.FromQueryJson("{\"filters\":{\"priority\":{\"values\":[\"2\"],\"not\":false}},\"sort\":\"title\",\"group\":\"priority\"}");
        var to = new TaskViewState { UpcomingEveryone = true, TeamFocus = "x" };
        to.Tags.Add("t");
        SavedViewRules.Apply(from, to);
        Assert.Equal(new[] { 2 }, to.Priority); Assert.Empty(to.Tags);
        Assert.Equal(TaskSort.Title, to.Sort); Assert.Equal(TaskGrouping.Priority, to.Group);
        Assert.False(to.UpcomingEveryone); Assert.Null(to.TeamFocus);
    }

    [Fact]
    public void Names_are_trimmed_cut_to_60_and_made_free()
    {
        Assert.Null(SavedViewRules.CleanName("   "));
        Assert.Equal("My view", SavedViewRules.CleanName("  My view "));
        Assert.Equal(60, SavedViewRules.CleanName(new string('x', 80))!.Length);
        var views = new[] { new SavedView("a", "Urgent", "{}", false, "u", 1), new SavedView("b", "urgent 2", "{}", false, "u", 2) };
        Assert.Equal("Urgent 3", SavedViewRules.FreeName(views, "Urgent"));
        Assert.Equal("Other", SavedViewRules.FreeName(views, "Other"));
    }

    [Fact]
    public void Views_list_the_persons_own_first_then_shared_ones_by_position()
    {
        var v = new[]
        {
            new SavedView("a", "B shared", "{}", true, "other", 1), new SavedView("b", "Z mine", "{}", false, "me", 2), new SavedView("c", "A mine", "{}", false, "me", 2),
        };
        Assert.Equal(new[] { "c", "b", "a" }, SavedViewRules.Ordered(v, "me").Select(x => x.Id));
    }

    [Fact]
    public void Describe_says_the_filters_group_and_sort()
    {
        Assert.Equal("All tasks", SavedViewRules.Describe(new TaskViewState { Group = TaskGrouping.None }));
        var s = new TaskViewState { Group = TaskGrouping.Page, Sort = TaskSort.Priority }; s.Priority.Add(1); s.Assignee.Add("me");
        Assert.Equal("2 filters · by Page · sorted by priority", SavedViewRules.Describe(s));
    }

    // ---- bulk selection ----

    [Fact]
    public void Selection_toggles_extends_by_range_and_prunes()
    {
        var order = new[] { "a", "b", "c", "d", "e" };
        var sel = new TaskSelection();
        sel.Toggle("b");
        Assert.True(sel.Active);
        sel.ExtendTo("d", order);
        Assert.Equal(new[] { "b", "c", "d" }, sel.Ids.OrderBy(x => x));
        sel.Toggle("c");
        Assert.Equal(new[] { "b", "d" }, sel.Ids.OrderBy(x => x));
        sel.Prune(new[] { "a", "b", "e" });
        Assert.Equal(new[] { "b" }, sel.Ids);
        sel.Clear();
        Assert.False(sel.Active); Assert.Equal(0, sel.Count);
    }

    [Fact]
    public void Selection_keyboard_steps_move_the_cursor_and_extend_with_shift()
    {
        var order = new[] { "a", "b", "c", "d" };
        var sel = new TaskSelection();
        Assert.Equal("a", sel.Step(order, 1, false));
        sel.Toggle("a");
        Assert.Equal("b", sel.Step(order, 1, false));
        Assert.Equal("c", sel.Step(order, 1, true));
        Assert.Equal(new[] { "a", "b", "c" }, sel.Ids.OrderBy(x => x));
        Assert.Equal("a", sel.Step(order, -10, false));
        sel.SelectAll(order);
        Assert.Equal(4, sel.Count);
        Assert.Null(new TaskSelection().Step(Array.Empty<string>(), 1, false));
    }

    [Fact]
    public void Bulk_days_and_words()
    {
        Assert.Equal("2026-12-01", BulkRules.Day(new DateOnly(2026, 11, 24), 7));
        Assert.Equal("Completed · 1 task", BulkRules.Said("Completed", 1));
        Assert.Equal("Deleted · 3 tasks", BulkRules.Said("Deleted", 3));
        var t = new TaskItem("a", "A", true, 0, null, DueTone.None, false, null, null, null, Array.Empty<string>(), 0, 0);
        Assert.True(BulkRules.AllDone(new[] { t }));
        Assert.False(BulkRules.AllDone(new[] { t, t with { Done = false } }));
        Assert.False(BulkRules.AllDone(Array.Empty<TaskItem>()));
    }
}
