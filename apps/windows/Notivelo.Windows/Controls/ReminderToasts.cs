using Notivelo.Windows.Data;
using Notivelo.Windows.Text;
using Toast = global::Windows.UI.Notifications;

namespace Notivelo.Windows.Controls;

/// <summary>Local scheduled toasts for task reminders (the Windows counterpart of Apple's reminder notifications). The source lists the reminders that will fire
/// (<see cref="INotesSource.UpcomingReminders"/>); the next few are handed to Windows as scheduled toasts with a Snooze choice (10 minutes, 1 hour, tomorrow morning)
/// and an Open task button. A toast needs package identity, so an unpackaged run keeps the plan (shown in Settings > Notifications) and schedules nothing.
/// Push (WNS) is not part of this: it needs the app registered in Partner Center.</summary>
internal static class ReminderToasts
{
    private const string Group = "reminders";
    private static readonly List<ReminderEntry> _snoozed = new();
    private static bool _registered;

    /// <summary>The reminders planned (what the toasts are scheduled from), soonest first.</summary>
    public static IReadOnlyList<ReminderEntry> Planned { get; private set; } = Array.Empty<ReminderEntry>();
    /// <summary>What Windows said when the toasts were scheduled ("scheduled", or why not).</summary>
    public static string Os { get; private set; } = "";
    public static event Action? Changed;

    /// <summary>A toast was activated: its arguments (<c>action</c>, <c>task</c>, <c>ws</c>, <c>page</c>, <c>token</c>) and the Snooze choice. Raised on a background thread.</summary>
    public static event Action<Dictionary<string, string>, IDictionary<string, string>>? Activated;

    public static string StatusText
    {
        get
        {
            if (Planned.Count == 0) return "No reminders are scheduled on this PC.";
            var next = Planned[0].FireAtUtc.ToLocalTime();
            var text = $"{Planned.Count} reminder{(Planned.Count == 1 ? "" : "s")} scheduled on this PC. Next: {next:ddd d MMM, HH:mm}.";
            return Os.Length == 0 || Os == "scheduled" ? text : text + " Windows toasts are off here (" + Os + ").";
        }
    }

    /// <summary>Listen for taps on the toasts (needs package identity; an unpackaged run is quietly without).</summary>
    public static void RegisterActivation()
    {
        if (_registered) return;
        _registered = true;
        try
        {
            var mgr = Microsoft.Windows.AppNotifications.AppNotificationManager.Default;
            mgr.NotificationInvoked += (_, e) => Activated?.Invoke(ReminderRules.ParseArguments(e.Argument), e.UserInput);
            mgr.Register();
        }
        catch (Exception) { }
    }

    /// <summary>Read the reminders again and hand the next ones to Windows (the old schedule is replaced).</summary>
    private static DateTime _lastSync = DateTime.MinValue;

    public static async Task SyncAsync(INotesSource source, bool debounce = false)
    {
        if (!source.SchedulesReminders || (debounce && DateTime.UtcNow - _lastSync < TimeSpan.FromSeconds(60))) return;
        _lastSync = DateTime.UtcNow;
        IReadOnlyList<ReminderEntry> all;
        try { all = await source.UpcomingReminders(); } catch (Exception) { return; }
        Replan(all);
    }

    private static void Replan(IEnumerable<ReminderEntry> all)
    {
        var now = DateTime.UtcNow;
        _snoozed.RemoveAll(s => s.FireAtUtc <= now);
        Planned = ReminderRules.Plan(all.Concat(_snoozed), now);
        Schedule();
        Changed?.Invoke();
    }

    private static void Schedule()
    {
        try
        {
            var notifier = Toast.ToastNotificationManager.CreateToastNotifier();
            foreach (var old in notifier.GetScheduledToastNotifications().Where(n => n.Group == Group).ToList()) notifier.RemoveFromSchedule(old);
            foreach (var e in Planned)
            {
                var doc = new global::Windows.Data.Xml.Dom.XmlDocument();
                doc.LoadXml(ReminderRules.ToastXml(e));
                notifier.AddToSchedule(new Toast.ScheduledToastNotification(doc, new DateTimeOffset(e.FireAtUtc, TimeSpan.Zero)) { Tag = Tag(e), Group = Group });
            }
            Os = "scheduled";
        }
        catch (Exception ex) { Os = ex is InvalidOperationException or System.Runtime.InteropServices.COMException ? "needs the installed app" : ex.GetType().Name; }
    }

    private static string Tag(ReminderEntry e) => e.ReminderId.Length <= 64 ? e.ReminderId : e.ReminderId[..64];

    /// <summary>Snooze from a toast's Snooze button. A push carries a token the core snoozes on the server; a local toast has none, so it is shown again here at the
    /// snooze time (this PC only). Returns the sentence to show.</summary>
    public static async Task<string> SnoozeAsync(INotesSource source, IReadOnlyDictionary<string, string> args, string option)
    {
        var task = args.GetValueOrDefault("task", "");
        if (args.GetValueOrDefault("token", "") is { Length: > 0 } token)
        {
            var err = await source.SnoozeReminder(token, option);
            return err ?? "Snoozed";
        }
        var until = ReminderRules.SnoozeUntil(option, DateTime.Now);
        if (until is null || task.Length == 0) return "Couldn't snooze that reminder.";
        var t = source.FindTask(task);
        var entry = new ReminderEntry("snooze-" + task, task, t?.Title ?? "", until.Value.ToUniversalTime(), null, null, args.GetValueOrDefault("page", "") is { Length: > 0 } p ? p : null, args.GetValueOrDefault("ws", ""));
        _snoozed.RemoveAll(s => s.ReminderId == entry.ReminderId);
        _snoozed.Add(entry);
        Replan(Planned.Where(e => e.ReminderId != entry.ReminderId));
        return "Snoozed until " + until.Value.ToString("ddd HH:mm");
    }

    /// <summary>Forget the plan (sign-out): nothing of this person stays scheduled.</summary>
    public static void Clear()
    {
        _snoozed.Clear();
        Planned = Array.Empty<ReminderEntry>();
        try { var n = Toast.ToastNotificationManager.CreateToastNotifier(); foreach (var old in n.GetScheduledToastNotifications().Where(x => x.Group == Group).ToList()) n.RemoveFromSchedule(old); } catch (Exception) { }
        Changed?.Invoke();
    }
}
