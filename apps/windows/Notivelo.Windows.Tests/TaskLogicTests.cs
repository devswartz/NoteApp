using Notivelo.Windows.Data;
using Xunit;
using N = Notivelo.Native;

namespace Notivelo.Windows.Tests;

/// <summary>The words and rules behind the task sheet's pickers and the Calendar's filters (TaskLogic): repeat presets anchored on a day, reminder wording,
/// team order, due-date words, the week, and what the Calendar shows for each status.</summary>
public class TaskLogicTests
{
    [Fact]
    public void Repeat_presets_are_anchored_on_the_due_day()
    {
        // 2026-11-30 is a Monday, the 30th, the 5th Monday: no nth-weekday preset (only the first four)
        var p = TaskLogic.Presets("2026-11-30");
        Assert.Contains(p, x => x.Label == "Every week on Mon" && x.Rule.ByWeekday!.SequenceEqual(new uint[] { 1 }));
        Assert.Contains(p, x => x.Label == "Every month on the 30th" && x.Rule.ByMonthDay == 30);
        Assert.Contains(p, x => x.Label == "Every 2 weeks" && x.Rule.Interval == 2);
        Assert.DoesNotContain(p, x => x.Label.Contains("th Mon") || x.Label.Contains("last"));
        Assert.Equal("Every year", p[^1].Label);
        // the 2nd Thursday (2026-11-12) has its nth-weekday preset
        var q = TaskLogic.Presets("2026-11-12");
        Assert.Contains(q, x => x.Label == "Every month on the 2nd Thu" && x.Rule.ByNthWeekday is { N: 2, Weekday: 4 });
    }

    [Fact]
    public void Rule_keys_tell_rules_apart()
    {
        var a = new N.TaskRecurrence("week", 1, new uint[] { 1 });
        Assert.Equal(TaskLogic.Key(a), TaskLogic.Key(new N.TaskRecurrence("week", 1, new uint[] { 1 })));
        Assert.NotEqual(TaskLogic.Key(a), TaskLogic.Key(new N.TaskRecurrence("week", 2, new uint[] { 1 })));
        Assert.NotEqual(TaskLogic.Key(a), TaskLogic.Key(new N.TaskRecurrence("week", 1, new uint[] { 2 })));
    }

    [Theory]
    [InlineData(1, "st")]
    [InlineData(2, "nd")]
    [InlineData(3, "rd")]
    [InlineData(4, "th")]
    [InlineData(11, "th")]
    [InlineData(12, "th")]
    [InlineData(13, "th")]
    [InlineData(21, "st")]
    [InlineData(22, "nd")]
    public void Day_suffixes(int n, string want) => Assert.Equal(want, TaskLogic.Suffix(n));

    [Fact]
    public void Reminders_are_worded_like_the_apps()
    {
        Assert.Equal("At due time", TaskLogic.ReminderText(0, null));
        Assert.Equal("1 hour before", TaskLogic.ReminderText(60, null));
        Assert.Equal("1 week before", TaskLogic.ReminderText(10080, null));
        Assert.Equal("3 days before", TaskLogic.ReminderText(4320, null));
        Assert.Equal("5 hours before", TaskLogic.ReminderText(300, null));
        Assert.Equal("45 minutes before", TaskLogic.ReminderText(45, null));
        Assert.Equal("bad", TaskLogic.ReminderText(null, "bad"));
        Assert.Contains(":", TaskLogic.InstantText("2026-12-01T08:00:00.000Z"));
    }

    [Fact]
    public void A_reminder_that_will_not_fire_says_why()
    {
        Assert.Null(TaskLogic.ReminderNote(true, false, false, true, true));
        Assert.Equal("sent", TaskLogic.ReminderNote(false, true, false, true, true));
        Assert.Equal("done", TaskLogic.ReminderNote(false, false, true, true, true));
        Assert.Equal("no due date", TaskLogic.ReminderNote(false, false, false, true, false));
        Assert.Null(TaskLogic.ReminderNote(false, false, false, false, false));
    }

    [Fact]
    public void Teams_are_listed_parent_then_subteams_by_name()
    {
        TeamInfo T(string id, string name, string? parent = null) => new(id, name, name, "#000000", parent);
        var order = TaskLogic.Order(new[] { T("w", "Web", "e"), T("s", "Staff"), T("e", "Engineering"), T("d", "Design"), T("a", "Apps", "e"), T("o", "Orphan", "gone") });
        Assert.Equal(new[] { "Design", "Engineering", "Apps", "Web", "Orphan", "Staff" }, order.Select(t => t.Name).ToArray());
        Assert.Equal(new[] { 0, 0, 1, 1, 0, 0 }, order.Select(t => t.Depth).ToArray());
        Assert.Equal("Engineering › Web", TaskLogic.TeamLabel("Web", "Engineering"));
        Assert.Equal("Staff", TaskLogic.TeamLabel("Staff", null));
    }

    [Fact]
    public void Due_dates_in_words()
    {
        var today = new DateOnly(2026, 11, 23);
        Assert.Equal("Today", TaskLogic.DueWords("2026-11-23", null, today));
        Assert.Equal("Tomorrow 09:00", TaskLogic.DueWords("2026-11-24", "09:00", today));
        Assert.Equal("Yesterday", TaskLogic.DueWords("2026-11-22", null, today));
        Assert.Equal(new DateOnly(2026, 11, 26).ToString("dddd"), TaskLogic.DueWords("2026-11-26", null, today));
        Assert.Equal(new DateOnly(2026, 12, 10).ToString("d MMM"), TaskLogic.DueWords("2026-12-10", null, today));
        Assert.Equal(new DateOnly(2027, 1, 10).ToString("d MMM yyyy"), TaskLogic.DueWords("2027-01-10", null, today));
        Assert.Null(TaskLogic.DueWords(null, null, today));
        Assert.Null(TaskLogic.DueWords("soon", null, today));
    }

    [Fact]
    public void The_week_starts_on_Monday()
    {
        Assert.Equal(new DateOnly(2026, 11, 23), TaskLogic.WeekStart(new DateOnly(2026, 11, 23)));
        Assert.Equal(new DateOnly(2026, 11, 23), TaskLogic.WeekStart(new DateOnly(2026, 11, 29)));
        Assert.Equal(new DateOnly(2026, 11, 23), TaskLogic.WeekStart(new DateOnly(2026, 11, 25)));
        Assert.Equal(new DateOnly(2026, 11, 30), TaskLogic.WeekStart(new DateOnly(2026, 11, 30)));
    }

    [Theory]
    [InlineData(CalendarStatus.Open, false, true, true)]
    [InlineData(CalendarStatus.Open, true, true, false)]
    [InlineData(CalendarStatus.Completed, true, true, true)]
    [InlineData(CalendarStatus.Completed, false, true, false)]
    [InlineData(CalendarStatus.All, true, true, true)]
    [InlineData(CalendarStatus.All, false, true, true)]
    // the "No date" tray is always the open tasks, whatever the status
    [InlineData(CalendarStatus.Completed, false, false, true)]
    [InlineData(CalendarStatus.All, true, false, false)]
    public void The_calendar_status_filter(CalendarStatus status, bool done, bool dated, bool shown) =>
        Assert.Equal(shown, TaskLogic.CalendarShows(status, done, dated));
}
