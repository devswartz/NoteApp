using System.Globalization;
using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

/// <summary>The words and rules behind the task sheet's pickers (Apple's RuleLogic, ReminderLogic, orderedTeams, Due.words in TaskPickers.swift / TasksScreen.swift).
/// Pure functions, no UI: the unit tests cover them.</summary>
internal static class TaskLogic
{
    public sealed record RulePreset(string Label, N.TaskRecurrence Rule);
    public sealed record RelativeReminder(string Label, uint Minutes);

    public static readonly string[] WeekShort = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static DateOnly? ParseDay(string? day) =>
        day is not null && DateOnly.TryParseExact(day, "yyyy-MM-dd", Inv, DateTimeStyles.None, out var d) ? d : null;

    public static string Day(DateOnly d) => d.ToString("yyyy-MM-dd", Inv);

    /// <summary>0 Sunday ... 6 Saturday.</summary>
    public static int Weekday(string day) => ParseDay(day) is { } d ? (int)d.DayOfWeek : 0;

    public static int MonthDay(string day) => ParseDay(day)?.Day ?? 1;

    public static string Suffix(int n)
    {
        if (n % 100 is >= 11 and <= 13) return "th";
        return (n % 10) switch { 1 => "st", 2 => "nd", 3 => "rd", _ => "th" };
    }

    public static string Key(N.TaskRecurrence r) =>
        string.Join("|", r.Freq, r.Interval ?? 0, string.Join(",", r.ByWeekday ?? Array.Empty<uint>()), r.ByMonthDay ?? 0,
            r.ByNthWeekday is { } n ? n.N + "/" + n.Weekday : "", r.Until ?? "", r.Count ?? 0, r.Basis ?? "");

    /// <summary>The web's presets, anchored on the due date (or today).</summary>
    public static IReadOnlyList<RulePreset> Presets(string anchor)
    {
        var dow = Weekday(anchor);
        var dom = MonthDay(anchor);
        var nth = (dom + 6) / 7;
        var out_ = new List<RulePreset>
        {
            new("Every day", new N.TaskRecurrence("day", 1)),
            new("Every weekday (Mon–Fri)", new N.TaskRecurrence("weekday")),
            new("Every week on " + WeekShort[dow], new N.TaskRecurrence("week", 1, new[] { (uint)dow })),
            new("Every 2 weeks", new N.TaskRecurrence("week", 2, new[] { (uint)dow })),
            new($"Every month on the {dom}{Suffix(dom)}", new N.TaskRecurrence("month", 1, null, dom)),
        };
        if (nth <= 4)
        {
            var label = nth switch { 1 => "1st", 2 => "2nd", 3 => "3rd", _ => "4th" };
            out_.Add(new($"Every month on the {label} {WeekShort[dow]}", new N.TaskRecurrence("month", 1, null, null, new N.TaskNthWeekday((sbyte)nth, (byte)dow))));
        }
        out_.Add(new("Every year", new N.TaskRecurrence("year", 1, null, dom)));
        return out_;
    }

    /// <summary>A rule in words (the core's <c>describe_recurrence</c>); a plain fallback where the core library isn't loaded (a unit-test host).</summary>
    public static string Describe(N.TaskRecurrence rule, string? due)
    {
        try { return N.NvCore.DescribeRecurrence(rule, due); }
        catch (Exception) { return "Repeats every " + (rule.Interval is > 1 ? rule.Interval + " " : "") + rule.Freq + (rule.Interval is > 1 ? "s" : ""); }
    }

    public static readonly IReadOnlyList<RelativeReminder> Relative = new RelativeReminder[]
    {
        new("At due time", 0), new("10 minutes before", 10), new("30 minutes before", 30), new("1 hour before", 60),
        new("1 day before", 1440), new("2 days before", 2880), new("1 week before", 10080),
    };

    public static string InstantText(string iso) =>
        DateTimeOffset.TryParse(iso, Inv, DateTimeStyles.None, out var t) ? t.ToLocalTime().ToString("ddd, d MMM, HH:mm", CultureInfo.CurrentCulture) : iso;

    /// <summary>"At due time", "2 hours before", or the instant of a fixed reminder.</summary>
    public static string ReminderText(uint? beforeMinutes, string? at)
    {
        if (beforeMinutes is not { } m) return at is null ? "" : InstantText(at);
        if (Relative.FirstOrDefault(r => r.Minutes == m) is { } preset) return preset.Label;
        if (m % 1440 == 0) return (m / 1440) + " days before";
        if (m % 60 == 0) return (m / 60) + " hours before";
        return m + " minutes before";
    }

    /// <summary>Why a reminder will not fire (Apple's reminderNote): sent, the task is done, or it has no due date.</summary>
    public static string? ReminderNote(bool hasNextFire, bool fired, bool taskDone, bool before, bool hasDue)
    {
        if (hasNextFire) return null;
        if (fired) return "sent";
        if (taskDone) return "done";
        if (before && !hasDue) return "no due date";
        return null;
    }

    /// <summary>Teams and their subteams, each parent followed by its children, names in order (Apple's orderedTeams).</summary>
    public static IReadOnlyList<TeamInfo> Order(IEnumerable<TeamInfo> teams)
    {
        var all = teams.ToList();
        int Cmp(TeamInfo a, TeamInfo b) => string.Compare(a.Name, b.Name, StringComparison.CurrentCultureIgnoreCase);
        var top = all.Where(t => t.ParentId is null || all.All(x => x.Id != t.ParentId)).ToList();
        top.Sort(Cmp);
        var res = new List<TeamInfo>();
        foreach (var t in top)
        {
            res.Add(t with { Depth = 0 });
            var kids = all.Where(c => c.ParentId == t.Id).ToList();
            kids.Sort(Cmp);
            res.AddRange(kids.Select(c => c with { Depth = 1 }));
        }
        return res;
    }

    /// <summary>A team's name; a subteam is "Parent › Child".</summary>
    public static string TeamLabel(string name, string? parentName) => parentName is null ? name : parentName + " › " + name;

    /// <summary>The words of a due date (Apple's Due.words): Today, Tomorrow, Yesterday, the weekday within the week, else "d MMM" (with the year when it isn't this one).</summary>
    public static string? DueWords(string? day, string? time, DateOnly today)
    {
        if (ParseDay(day) is not { } d) return null;
        var n = d.DayNumber - today.DayNumber;
        var w = n switch
        {
            0 => "Today", 1 => "Tomorrow", -1 => "Yesterday",
            >= 2 and <= 6 => d.ToString("dddd", CultureInfo.CurrentCulture),
            _ => d.Year == today.Year ? d.ToString("d MMM", CultureInfo.CurrentCulture) : d.ToString("d MMM yyyy", CultureInfo.CurrentCulture),
        };
        return time is { Length: > 0 } ? w + " " + time : w;
    }

    /// <summary>The first day a rule falls on, on or after <paramref name="from"/> (the core's <c>first_occurrence</c>); <paramref name="from"/> where the core library is not loaded.</summary>
    public static string FirstOccurrence(N.TaskRecurrence rule, string from) { try { return N.NvCore.FirstOccurrence(rule, from); } catch (Exception) { return from; } }

    /// <summary>Monday on or before the day.</summary>
    public static DateOnly WeekStart(DateOnly d) => d.AddDays(-(((int)d.DayOfWeek + 6) % 7));

    /// <summary>What the Calendar shows of a task (Apple's inScope and status): whose, and the status on dated tasks.</summary>
    public static bool CalendarShows(CalendarStatus status, bool done, bool dated) => !dated ? !done : status switch
    {
        CalendarStatus.Open => !done, CalendarStatus.Completed => done, _ => true,
    };
}
