using System.Globalization;
using System.Security;

namespace Notivelo.Windows.Text;

/// <summary>One reminder that will fire: the task, when, and what the task says (for the toast's body).</summary>
public sealed record ReminderEntry(string ReminderId, string TaskId, string Title, DateTime FireAtUtc, string? DueDate, string? DueTime, string? PageId, string? WorkspaceId, bool Locked = false);

/// <summary>The XAML-free rules of the reminder toasts (the server's push payload, as Apple's notification actions read it): which reminders are scheduled, the words,
/// the snooze times (10m, 1h, tomorrow) and the toast XML.</summary>
internal static class ReminderRules
{
    /// <summary>Only the next few reminders of this person are worth planning.</summary>
    public const int MaxScheduled = 50;

    public static readonly (string Id, string Label)[] SnoozeOptions = { ("10m", "Snooze 10 minutes"), ("1h", "Snooze 1 hour"), ("tomorrow", "Tomorrow morning") };

    /// <summary>The toast title: the task's title, "Task reminder" when it has none, and a generic one for a locked page (no task text on screen).</summary>
    public static string TitleOf(ReminderEntry e) => e.Locked || string.IsNullOrWhiteSpace(e.Title) ? "Task reminder" : e.Title.Trim();

    /// <summary>"Reminder" without a due date, else "Due 2026-11-25" plus " at 09:00" when it has a time.</summary>
    public static string BodyOf(ReminderEntry e) => e.DueDate is null ? "Reminder" : "Due " + e.DueDate + (e.DueTime is { Length: > 0 } t ? " at " + t : "");

    /// <summary>The reminders to schedule: ones still ahead (not within the next 5 seconds), soonest first, at most <see cref="MaxScheduled"/>, one per reminder id.</summary>
    public static IReadOnlyList<ReminderEntry> Plan(IEnumerable<ReminderEntry> all, DateTime nowUtc) =>
        all.Where(e => e.FireAtUtc > nowUtc.AddSeconds(5)).GroupBy(e => e.ReminderId).Select(g => g.First()).OrderBy(e => e.FireAtUtc).Take(MaxScheduled).ToList();

    /// <summary>When a snooze option ends: 10 minutes, 1 hour, or tomorrow at the user's default reminder time (09:00 unless told); null for another option.</summary>
    public static DateTime? SnoozeUntil(string option, DateTime nowLocal, TimeSpan? tomorrowAt = null) => option switch
    {
        "10m" => nowLocal.AddMinutes(10),
        "1h" => nowLocal.AddHours(1),
        "tomorrow" => nowLocal.Date.AddDays(1) + (tomorrowAt ?? TimeSpan.FromHours(9)),
        _ => null,
    };

    /// <summary>The ISO instant of the core's <c>next_fire_at</c> as a UTC time (null when it can't be read).</summary>
    public static DateTime? ParseInstant(string? iso) =>
        DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d) ? d : null;

    private static string Q(string s) => Uri.EscapeDataString(s);

    /// <summary>The argument string a toast carries (<c>action=open&amp;task=..&amp;page=..</c>).</summary>
    public static string Arguments(string action, ReminderEntry e, string? snoozeToken = null) =>
        $"action={action}&task={Q(e.TaskId)}&ws={Q(e.WorkspaceId ?? "")}&page={Q(e.PageId ?? "")}" + (snoozeToken is null ? "" : "&token=" + Q(snoozeToken));

    /// <summary>The toast's XML: title, body, a Snooze choice with the three options and an Open task button; a tap on the toast opens the task.</summary>
    public static string ToastXml(ReminderEntry e, string? snoozeToken = null)
    {
        string X(string s) => SecurityElement.Escape(s) ?? "";
        var options = string.Concat(SnoozeOptions.Select(o => $"<selection id=\"{o.Id}\" content=\"{X(o.Label)}\"/>"));
        return $"<toast launch=\"{X(Arguments("open", e, snoozeToken))}\"><visual><binding template=\"ToastGeneric\"><text>{X(TitleOf(e))}</text><text>{X(BodyOf(e))}</text></binding></visual>"
             + $"<actions><input id=\"snooze\" type=\"selection\" defaultInput=\"10m\">{options}</input>"
             + $"<action content=\"Snooze\" arguments=\"{X(Arguments("snooze", e, snoozeToken))}\"/>"
             + $"<action content=\"Open task\" arguments=\"{X(Arguments("open", e, snoozeToken))}\"/></actions></toast>";
    }

    /// <summary>Read a toast's argument string into its pairs.</summary>
    public static Dictionary<string, string> ParseArguments(string? args)
    {
        var d = new Dictionary<string, string>();
        foreach (var part in (args ?? "").Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var i = part.IndexOf('=');
            if (i > 0) d[Uri.UnescapeDataString(part[..i])] = Uri.UnescapeDataString(part[(i + 1)..]);
        }
        return d;
    }
}
