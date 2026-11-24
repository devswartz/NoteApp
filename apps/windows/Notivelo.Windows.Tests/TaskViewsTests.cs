using Notivelo.Windows.Data;
using Xunit;

namespace Notivelo.Windows.Tests;

/// <summary>The task views' filters, sort, groups, Team numbers and the saved state (TaskViews.cs): pure logic over TaskFact lists.</summary>
public class TaskViewsTests
{
    private static readonly DateOnly Today = new(2026, 11, 24);
    private static readonly MemberInfo[] Members =
    {
        new("u1", "Demo User", "demo@example.com", "#6366f1", "owner"), new("u2", "Sam Rivera", "sam@example.com", "#14b8a6", "member"), new("u3", "Priya Nair", "priya@example.com", "#ec4899", "viewer"),
    };
    private static readonly TeamInfo[] Teams =
    {
        new("eng", "Engineering", "Engineering", "#22c55e", null), new("web", "Web", "Engineering › Web", "#16a34a", "eng"), new("design", "Design", "Design", "#a855f7", null),
    };
    private static readonly TaskContext Ctx = new("u1", Today, Members, Teams, id => id == "p1" ? "Roadmap" : id == "p2" ? "" : null);

    private static TaskFact T(string id, string title = "", string? due = null, string? who = "u1", int pri = 4, string? team = null, string[]? tags = null, string? page = null,
        bool done = false, string created = "2026-11-10T09:00:00Z", string? doneAt = null, string? time = null, string desc = "") =>
        new(new TaskItem(id, title.Length == 0 ? id : title, done, pri >= 4 ? 0 : pri, null, DueTone.None, false, null, null, null, Array.Empty<string>(), 0, 0), pri, due, time, who, team,
            tags ?? Array.Empty<string>(), page, created, doneAt, desc);

    private static readonly TaskFact[] All =
    {
        T("late", due: "2026-11-20", pri: 1, team: "web", tags: new[] { "launch" }, page: "p1"),
        T("today", due: "2026-11-24", pri: 2, team: "design", created: "2026-11-12T09:00:00Z"),
        T("soon", due: "2026-11-26", pri: 3, who: "u2", tags: new[] { "docs" }, page: "p1"),
        T("far", due: "2026-12-10", who: "u2"),
        T("none", who: null, page: "p2"),
        T("gone", due: "2026-11-01", done: true, doneAt: "2026-11-23T10:00:00Z", who: "u2"),
    };

    private static string[] Ids(IEnumerable<TaskFact> l) => l.Select(t => t.Item.Id).ToArray();

    [Fact]
    public void Views_start_from_their_own_open_lists()
    {
        Assert.Equal(new[] { "late", "today" }, Ids(TaskViewLogic.Base(TaskViewKind.Today, All, Ctx)));
        Assert.Equal(new[] { "late", "today" }, Ids(TaskViewLogic.Base(TaskViewKind.MyTasks, All, Ctx)));
        Assert.Empty(TaskViewLogic.Base(TaskViewKind.Upcoming, All, Ctx));                                     // mine: nothing due in the next 7 days
        Assert.Equal(new[] { "soon" }, Ids(TaskViewLogic.Base(TaskViewKind.Upcoming, All, Ctx, everyone: true)));
        Assert.Equal(5, TaskViewLogic.Base(TaskViewKind.All, All, Ctx).Count);                                 // open ones only
        Assert.Equal(5, TaskViewLogic.Base(TaskViewKind.Team, All, Ctx).Count);
    }

    [Fact]
    public void Filters_assignee_priority_tags_team_due_source_and_search()
    {
        var s = new TaskViewState();
        s.Assignee.Add("others");
        Assert.Equal(new[] { "soon", "far" }, Ids(TaskViewLogic.Filter(All.Where(t => !t.Done), s, Ctx)));
        s.ClearAll(); s.Assignee.Add("unassigned");
        Assert.Equal(new[] { "none" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        s.ClearAll(); s.Assignee.Add("u2"); s.Priority.Add(3);
        Assert.Equal(new[] { "soon" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        s.ClearAll(); s.Tags.Add("launch");
        Assert.Equal(new[] { "late" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        s.ClearAll(); s.Teams.Add("eng");                                                                      // with its subteam
        Assert.Equal(new[] { "late" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        s.IncludeSubteams = false;
        Assert.Empty(TaskViewLogic.Filter(All, s, Ctx));
        s.ClearAll(); s.Teams.Add("none");
        Assert.Equal(new[] { "soon", "far", "none", "gone" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        s.ClearAll(); s.Due = TaskDueFilter.Overdue;
        Assert.Equal(new[] { "late", "gone" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        s.Due = TaskDueFilter.Today;
        Assert.Equal(new[] { "late", "today", "gone" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        s.Due = TaskDueFilter.Week;
        Assert.Equal(new[] { "late", "today", "soon", "gone" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        s.Due = TaskDueFilter.None;
        Assert.Equal(new[] { "none" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        s.ClearAll(); s.Source.Add("notes");
        Assert.Equal(new[] { "late", "soon", "none" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        s.ClearAll(); s.Source.Add("standalone");
        Assert.Equal(new[] { "today", "far", "gone" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        s.ClearAll(); s.Q = "  SOO ";
        Assert.Equal(new[] { "soon" }, Ids(TaskViewLogic.Filter(All, s, Ctx)));
        Assert.Equal(6, TaskViewLogic.Filter(All, s, Ctx, includeSearch: false).Count);
    }

    [Fact]
    public void Search_reads_the_description_too()
    {
        var s = new TaskViewState { Q = "checklist" };
        var list = new[] { T("a", desc: "Review the checklist"), T("b") };
        Assert.Equal(new[] { "a" }, Ids(TaskViewLogic.Filter(list, s, Ctx)));
    }

    [Fact]
    public void Me_is_the_signed_in_user()
    {
        var s = new TaskViewState();
        s.Assignee.Add("me");
        Assert.Equal(new[] { "late", "today" }, Ids(TaskViewLogic.Filter(All.Where(t => !t.Done), s, Ctx)));
    }

    [Fact]
    public void Sorts_by_due_priority_newest_and_name_and_keeps_ties_in_order()
    {
        Assert.Equal(new[] { "gone", "late", "today", "soon", "far", "none" }, Ids(TaskViewLogic.Sorted(All, TaskSort.Due)));
        Assert.Equal(new[] { "late", "today", "soon", "gone", "far", "none" }, Ids(TaskViewLogic.Sorted(All, TaskSort.Priority)));
        Assert.Equal("today", Ids(TaskViewLogic.Sorted(All, TaskSort.Created))[0]);
        Assert.Equal(new[] { "far", "gone", "late", "none", "soon", "today" }, Ids(TaskViewLogic.Sorted(All, TaskSort.Title)));
        // the same day: time, then priority
        var two = new[] { T("b", due: "2026-11-24", time: "14:00"), T("a", due: "2026-11-24", time: "09:00") };
        Assert.Equal(new[] { "a", "b" }, Ids(TaskViewLogic.Sorted(two, TaskSort.Due)));
    }

    [Fact]
    public void Groups_by_due_in_the_lists_own_buckets_or_one_per_day()
    {
        var open = All.Where(t => !t.Done).ToList();
        var g = TaskViewLogic.Grouped(open, TaskGrouping.Due, TaskSort.Due, Ctx);
        Assert.Equal(new[] { "Overdue", "Today · Tue 24 Nov", "Later", "No date" }, g.Select(x => x.Title).ToArray());
        Assert.True(g[0].IsOverdue);
        Assert.Equal(new[] { 1, 1, 2, 1 }, g.Select(x => x.Count).ToArray());
        var days = TaskViewLogic.Grouped(open, TaskGrouping.Due, TaskSort.Due, Ctx, perDay: true);
        Assert.Equal(new[] { "Overdue", "Today · Tue 24 Nov", "Thursday", "Thu 10 Dec", "No date" }, days.Select(x => x.Title).ToArray());
    }

    [Fact]
    public void Groups_by_assignee_team_page_and_priority_with_the_empty_group_last()
    {
        var open = All.Where(t => !t.Done).ToList();
        var who = TaskViewLogic.Grouped(open, TaskGrouping.Assignee, TaskSort.Due, Ctx);
        Assert.Equal(new[] { "Demo User", "Sam Rivera", "Unassigned" }, who.Select(x => x.Title).ToArray());
        var team = TaskViewLogic.Grouped(open, TaskGrouping.Team, TaskSort.Due, Ctx);
        Assert.Equal(new[] { "Design", "Engineering › Web", "No team" }, team.Select(x => x.Title).ToArray());
        var page = TaskViewLogic.Grouped(open, TaskGrouping.Page, TaskSort.Due, Ctx);
        Assert.Equal(new[] { "Roadmap", "Untitled", "Not on a page" }, page.Select(x => x.Title).ToArray());
        var pri = TaskViewLogic.Grouped(open, TaskGrouping.Priority, TaskSort.Due, Ctx);
        Assert.Equal(new[] { "Priority 1", "Priority 2", "Priority 3", "No priority" }, pri.Select(x => x.Title).ToArray());
        var none = TaskViewLogic.Grouped(open, TaskGrouping.None, TaskSort.Due, Ctx);
        Assert.Single(none);
        Assert.Equal("", none[0].Title);
        Assert.Empty(TaskViewLogic.Grouped(Array.Empty<TaskFact>(), TaskGrouping.None, TaskSort.Due, Ctx));
    }

    [Fact]
    public void Day_titles_read_like_the_lists()
    {
        Assert.Equal("Today · Tue 24 Nov", TaskViewLogic.DayTitle("2026-11-24", Today));
        Assert.Equal("Tomorrow · Wed 25 Nov", TaskViewLogic.DayTitle("2026-11-25", Today));
        Assert.Equal("Saturday", TaskViewLogic.DayTitle("2026-11-28", Today));
        Assert.Equal("Wed 2 Dec", TaskViewLogic.DayTitle("2026-12-02", Today));
    }

    [Fact]
    public void Team_cards_count_open_overdue_and_done_this_week()
    {
        var (open, overdue, done) = TaskViewLogic.PersonStats(All.Where(t => t.AssigneeId == "u2"), Ctx);
        Assert.Equal((2, 0, 1), (open, overdue, done));
        var (o2, ov2, d2) = TaskViewLogic.PersonStats(All.Where(t => t.AssigneeId == "u1"), Ctx);
        Assert.Equal((2, 1, 0), (o2, ov2, d2));
    }

    [Fact]
    public void The_taskbar_badge_counts_my_open_tasks_due_today_or_earlier()
    {
        Assert.Equal(2, TaskViewLogic.DueTodayCount(All, Ctx));
        Assert.Equal(0, TaskViewLogic.DueTodayCount(All, Ctx with { Me = null }));
        Assert.Equal("<badge value=\"3\"/>", AuditRules.BadgeXml(3));
    }

    [Fact]
    public void The_state_round_trips_through_json_and_knows_when_it_is_default()
    {
        var s = new TaskViewState();
        Assert.True(s.IsDefault);
        s.Assignee.Add("me"); s.Priority.Add(1); s.Sort = TaskSort.Priority; s.Group = TaskGrouping.Team; s.Q = "x"; s.Due = TaskDueFilter.Week; s.TeamByTeam = true; s.TeamFocus = "u2";
        var back = TaskViewState.FromJson(s.ToJson());
        Assert.Equal(new[] { "assignee", "priority", "due" }, back.ActiveKinds.ToArray());
        Assert.Equal(TaskSort.Priority, back.Sort); Assert.Equal(TaskGrouping.Team, back.Group); Assert.Equal("x", back.Q); Assert.True(back.TeamByTeam); Assert.Equal("u2", back.TeamFocus);
        Assert.False(back.IsDefault);
        back.ClearAll();
        Assert.False(back.AnyFilter);
        Assert.True(TaskViewState.FromJson("not json").IsDefault);
        Assert.True(TaskViewState.FromJson(null).IsDefault);
    }

    [Fact]
    public void Toggling_a_value_adds_then_removes_it()
    {
        var set = new HashSet<string>();
        Assert.True(TaskViewState.Toggle(set, "a"));
        Assert.False(TaskViewState.Toggle(set, "a"));
        Assert.Empty(set);
    }

    [Fact]
    public void The_summary_names_the_conditions()
    {
        var s = new TaskViewState();
        s.Assignee.Add("me"); s.Assignee.Add("u2"); s.Teams.Add("none"); s.Teams.Add("web"); s.Priority.Add(4); s.Tags.Add("docs"); s.Source.Add("notes"); s.Due = TaskDueFilter.Overdue;
        var tags = new[] { new TagInfo("docs", "docs", "#3b82f6") };
        Assert.Equal("Assignee: Me, Sam Rivera", s.Summary("assignee", Ctx, tags));
        Assert.Equal("Team: Engineering › Web, No team", s.Summary("team", Ctx, tags));
        Assert.Equal("Priority: No priority", s.Summary("priority", Ctx, tags));
        Assert.Equal("Tags: docs", s.Summary("tags", Ctx, tags));
        Assert.Equal("Source: On pages", s.Summary("source", Ctx, tags));
        Assert.Equal("Due: Overdue", s.Summary("due", Ctx, tags));
    }
}
