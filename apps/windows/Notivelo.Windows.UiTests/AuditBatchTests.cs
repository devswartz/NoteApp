using FlaUI.Core.AutomationElements;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>The audit batch on the offline sample data: task filters, sort and groups from the Tasks ribbon, the ribbon's Divider and text colour, the notification bell,
/// the public share link and the delete-account dialog. Driven through UI Automation; the sample keeps everything in memory (no server, no real account).</summary>
public class AuditBatchTests
{
    private static AutomationElement Find(AppHost h, string id, int ms = 20000) =>
        AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)), "element " + id, ms);

    private static bool Gone(AppHost h, string id) => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)) is null;

    private static void Retry(Action a)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            try { a(); return; }
            catch (Exception) when (sw.ElapsedMilliseconds < 15000) { Thread.Sleep(200); }
        }
    }

    /// <summary>Invoke, or click where the element has no Invoke (a toggle button).</summary>
    private static void Press(AppHost h, string id) => Retry(() => { var e = Find(h, id); if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke(); else e.Click(); });

    private static string NameOf(AppHost h, string id) => Find(h, id).Properties.Name.ValueOrDefault ?? "";

    private static string Status(AppHost h, string id) => Find(h, id).Properties.ItemStatus.ValueOrDefault ?? "";

    private static void WaitStatus(AppHost h, string id, string status, string what) =>
        AppHost.Wait(() => Status(h, id) == status ? "x" : null, what);

    private static int Count(AppHost h) => int.Parse(Status(h, "tasks-count").Replace("count=", ""));

    private static void OpenAllTasks(AppHost h)
    {
        Retry(() => Find(h, "rail-tasks").Click());
        Press(h, "ribbon-all-tasks");
        Find(h, "tasks-count");
    }

    [Fact]
    public void Task_filters_change_the_list_and_clear() => AppHost.Run(nameof(Task_filters_change_the_list_and_clear), h =>
    {
        OpenAllTasks(h);
        Press(h, "ribbon-priority");
        Press(h, "menu-priority-1");
        AppHost.Wait(() => Count(h) == 1 ? "x" : null, "one task left with priority 1");
        Find(h, "task-row-t-launch");
        Assert.True(Gone(h, "task-row-t-welcome"));
        Assert.Contains("Priority", NameOf(h, "tasks-filter-summary"));
        Press(h, "ribbon-clear-filters");
        AppHost.Wait(() => Count(h) > 1 ? "x" : null, "the list back after Clear filters");
        Find(h, "task-row-t-welcome");
        Assert.True(Gone(h, "tasks-clear-filters"));
    });

    [Fact]
    public void Task_search_group_sort_and_status() => AppHost.Run(nameof(Task_search_group_sort_and_status), h =>
    {
        OpenAllTasks(h);
        Retry(() => Find(h, "tasks-search").AsTextBox().Text = "offsite");
        AppHost.Wait(() => Count(h) == 1 ? "x" : null, "the search matched one task");
        Find(h, "task-row-t-other");
        Retry(() => Find(h, "tasks-search").AsTextBox().Text = "");
        Press(h, "ribbon-group");
        Press(h, "menu-group-priority");
        AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByName("Group Priority 1")), "the Priority 1 group");
        Press(h, "ribbon-sort");
        Press(h, "menu-sort-title");
        Find(h, "ribbon-sort");
        Press(h, "ribbon-status");
        Press(h, "menu-status-done");
        Find(h, "task-row-t-slow");                              // the done sample task
        AppHost.Wait(() => Gone(h, "task-row-t-welcome") ? "x" : null, "open tasks hidden while the status is Completed");
        Press(h, "ribbon-clear-filters");
    });

    [Fact]
    public void Divider_and_text_colour_from_the_ribbon() => AppHost.Run(nameof(Divider_and_text_colour_from_the_ribbon), h =>
    {
        h.A.Focus();
        h.Type("Hello");
        var before = h.A.State;
        Press(h, "ribbon-divider");
        var after = h.A.WaitFor(s => s.Text != before.Text || s.Block != before.Block || s.Undo, "the divider added");
        Assert.DoesNotContain("/", after.Text);                  // the slash that picks it is gone again
        h.A.Focus();
        Press(h, "ribbon-text-colour");
        Press(h, "colour-text-red");
        Assert.Contains("Hello", h.A.State.Text);
        Press(h, "ribbon-clear-formatting");
        Assert.Contains("Hello", h.A.State.Text);
    });

    [Fact]
    public void The_bell_shows_unread_opens_the_inbox_and_marks_all_read() => AppHost.Run(nameof(The_bell_shows_unread_opens_the_inbox_and_marks_all_read), h =>
    {
        AppHost.Wait(() => NameOf(h, "rail-bell") == "Notifications, 3 unread" ? "x" : null, "the unread badge on the bell");
        Press(h, "rail-bell");
        Find(h, "inbox-popover");
        Find(h, "inbox-item-n1");
        Assert.Equal("unread", Status(h, "inbox-item-n1"));
        Press(h, "inbox-mark-all");
        AppHost.Wait(() => Gone(h, "inbox-mark-all") ? "x" : null, "Mark all read gone once nothing is unread");
        Assert.Equal("read", Status(h, "inbox-item-n1"));
        AppHost.Wait(() => NameOf(h, "rail-bell") == "Notifications" ? "x" : null, "the badge cleared");
    });

    [Fact]
    public void Share_link_create_and_turn_off() => AppHost.Run(nameof(Share_link_create_and_turn_off), h =>
    {
        Press(h, "page-share");
        Find(h, "share-dialog");
        WaitStatus(h, "share-link-block", "link=off", "the link off to begin with");
        Press(h, "share-link-create");
        WaitStatus(h, "share-link-block", "link=on", "the link made");
        Assert.StartsWith("https://", NameOf(h, "share-link-url"));
        Find(h, "share-link-copy");
        Find(h, "share-link-open");
        Press(h, "share-link-off");
        Press(h, "confirm-ok");
        WaitStatus(h, "share-link-block", "link=off", "the link turned off");
        Find(h, "share-link-create");
    });

    [Fact]
    public void Delete_account_shows_the_preview_and_checks_the_password() => AppHost.Run(nameof(Delete_account_shows_the_preview_and_checks_the_password), h =>
    {
        Press(h, "rail-account");
        Press(h, "menu-settings");
        Find(h, "settings-root");
        Press(h, "settings-delete-account");
        Find(h, "delete-account-dialog");
        AppHost.Wait(() => Status(h, "delete-account-preview") == "lines=4" ? "x" : null, "the preview's four lines");
        Assert.False(Find(h, "delete-account-confirm").IsEnabled);          // needs the password
        Find(h, "delete-account-password").Focus();
        h.Type("wrong");
        AppHost.Wait(() => Find(h, "delete-account-confirm").IsEnabled ? "x" : null, "Delete enabled once a password is typed");
        Press(h, "delete-account-confirm");
        AppHost.Wait(() => NameOf(h, "delete-account-error").Contains("not right") ? "x" : null, "the wrong-password message");
        Find(h, "delete-account-dialog");                                  // still open
        Press(h, "delete-account-cancel");
        AppHost.Wait(() => Gone(h, "delete-account-dialog") ? "x" : null, "the dialog closed");
    });
}
