using FlaUI.Core.AutomationElements;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>Parity B on the offline sample data: tree actions (menu, name prompt, Trash), the search palette and task writes, driven through
/// UI Automation (Invoke / Value patterns on elements the app names with AutomationIds) and a few real keys.</summary>
public class ParityTests
{
    private static AutomationElement Find(AppHost h, string id, int ms = 20000) =>
        AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)), "element " + id, ms);

    private static bool Gone(AppHost h, string id) => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)) is null;

    /// <summary>Retried: the app redraws lists (the sidebar, search results) as data arrives, which can leave a found element stale.</summary>
    private static void Retry(Action a)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            try { a(); return; }
            catch (Exception) when (sw.ElapsedMilliseconds < 15000) { Thread.Sleep(200); }
        }
    }

    private static void Invoke(AppHost h, string id) => Retry(() => Find(h, id).Patterns.Invoke.Pattern.Invoke());

    private static void SetText(AppHost h, string id, string text) => Retry(() => Find(h, id).AsTextBox().Text = text);

    private static string NameOf(AppHost h, string id) => Find(h, id).Properties.Name.ValueOrDefault ?? "";

    private static string Status(AppHost h, string id) => Find(h, id).Properties.ItemStatus.ValueOrDefault ?? "";

    private static void OpenTasks(AppHost h) => Retry(() => Find(h, "rail-tasks").Click());   // a toggle button: a real click raises its Click

    [Fact]
    public void Rename_a_page_in_the_tree() => AppHost.Run(nameof(Rename_a_page_in_the_tree), h =>
    {
        Assert.Equal("Page options: Blocks", NameOf(h, "page-more-blocks"));
        Invoke(h, "page-more-blocks");
        Invoke(h, "menu-rename");
        SetText(h, "prompt-input", "Renamed page");
        Invoke(h, "prompt-ok");
        AppHost.Wait(() => NameOf(h, "page-more-blocks") == "Page options: Renamed page" ? "x" : null, "the page renamed in the tree");
        Assert.True(Gone(h, "prompt-input"));
    });

    [Fact]
    public void Delete_a_page_then_restore_it_from_the_Trash() => AppHost.Run(nameof(Delete_a_page_then_restore_it_from_the_Trash), h =>
    {
        Invoke(h, "page-more-lists");
        Invoke(h, "menu-delete-page");
        Invoke(h, "confirm-ok");
        AppHost.Wait(() => Gone(h, "page-more-lists") ? "x" : null, "the page gone from the tree");
        Invoke(h, "rail-workspace");
        Invoke(h, "menu-trash");
        Invoke(h, "trash-restore-lists");
        Invoke(h, "trash-close");
        Find(h, "page-more-lists");
    });

    [Fact]
    public void New_section_from_the_notebook_menu() => AppHost.Run(nameof(New_section_from_the_notebook_menu), h =>
    {
        Invoke(h, "notebook-more");
        Invoke(h, "menu-new-section");
        SetText(h, "prompt-input", "Fresh section");
        Invoke(h, "prompt-ok");
        AppHost.Wait(() => h.Window.FindAllDescendants().Any(e => e.Properties.AutomationId.ValueOrDefault?.StartsWith("section-more-") == true && e.Properties.Name.ValueOrDefault == "Section options: Fresh section") ? "x" : null, "the new section");
    });

    [Fact]
    public void Search_finds_pages_and_opens_them() => AppHost.Run(nameof(Search_finds_pages_and_opens_them), h =>
    {
        Invoke(h, "rail-search");
        Find(h, "search-input");
        h.Type("sandb");
        Find(h, "search-result-page-sandbox");
        h.Press(ENTER);                                          // the first result opens
        AppHost.Wait(() => Gone(h, "search-input") ? "x" : null, "the palette closed");
    });

    [Fact]
    public void Search_finds_tasks_and_the_sheet_edits_them() => AppHost.Run(nameof(Search_finds_tasks_and_the_sheet_edits_them), h =>
    {
        Invoke(h, "rail-search");
        Find(h, "search-input");
        h.Type("launch");
        Thread.Sleep(600);                                       // the core answer replaces the title matches
        Invoke(h, "search-result-task-t-launch");
        Find(h, "task-sheet-title");
        Invoke(h, "task-sheet-priority");
        Invoke(h, "menu-priority-3-medium");
        AppHost.Wait(() => Status(h, "task-sheet-priority") == "priority=3" ? "x" : null, "priority 3");
        SetText(h, "task-sheet-title", "Review the launch plan");
        Invoke(h, "task-sheet-close");                           // closing writes the title
        OpenTasks(h);
        AppHost.Wait(() => NameOf(h, "task-circle-t-launch") == "Mark done: Review the launch plan" ? "x" : null, "the new title in the Tasks view");
    });

    [Fact]
    public void Ticking_a_task_in_the_Tasks_view() => AppHost.Run(nameof(Ticking_a_task_in_the_Tasks_view), h =>
    {
        OpenTasks(h);
        Assert.Equal("done=0", Status(h, "task-circle-t-launch"));
        Invoke(h, "task-circle-t-launch");
        AppHost.Wait(() => Status(h, "task-circle-t-launch") == "done=1" ? "x" : null, "the task ticked");
    });

    [Fact]
    public void Notebook_picker_opens_on_the_overlay_and_lists_the_notebooks() => AppHost.Run(nameof(Notebook_picker_opens_on_the_overlay_and_lists_the_notebooks), h =>
    {
        Invoke(h, "notebook-picker");
        Find(h, "menu-notebook-picker");
        Assert.Equal("Look reference", NameOf(h, "notebook-look-reference"));
        Invoke(h, "notebook-look-reference");               // picking the open notebook closes the menu
        AppHost.Wait(() => Gone(h, "menu-notebook-picker") ? "x" : null, "the picker closed");
    });

    [Fact]
    public void Account_menu_shows_the_theme_switch() => AppHost.Run(nameof(Account_menu_shows_the_theme_switch), h =>
    {
        Invoke(h, "rail-account");
        Find(h, "menu-account");
        Assert.Contains("Hybrid", NameOf(h, "theme-hybrid"));
        Assert.EndsWith("(selected)", NameOf(h, "theme-hybrid"));
        Find(h, "theme-light");
        Invoke(h, "theme-dark");
        AppHost.Wait(() => Gone(h, "menu-account") ? "x" : null, "the account menu closed");
        Invoke(h, "rail-account");                           // reopened: the choice is marked
        AppHost.Wait(() => NameOf(h, "theme-dark").EndsWith("(selected)") ? "x" : null, "Dark marked");
    });

    [Fact]
    public void Floating_toolbar_follows_a_text_selection() => AppHost.Run(nameof(Floating_toolbar_follows_a_text_selection), h =>
    {
        h.A.Focus();
        h.Type("hello");
        h.A.WaitText("hello");
        Assert.True(Gone(h, "floating-toolbar"));            // a caret has no bar
        h.Chord(CONTROL, KEY_A);
        Find(h, "floating-toolbar");
        Invoke(h, "float-bold");
        Find(h, "floating-toolbar");                         // the box keeps the selection and the keyboard
        h.A.WaitFor(s => s.Focus, "the box still focused");
        h.Press(RIGHT);
        AppHost.Wait(() => Gone(h, "floating-toolbar") ? "x" : null, "the bar gone with the selection");
    });

    [Fact]
    public void Quick_add_makes_a_task_that_shows_in_the_list() => AppHost.Run(nameof(Quick_add_makes_a_task_that_shows_in_the_list), h =>
    {
        OpenTasks(h);
        Retry(() => Find(h, "sidebar-add-task").Click());
        Find(h, "quickadd-card");
        SetText(h, "quickadd-input", "Buy oat milk p1");
        AppHost.Wait(() => NameOf(h, "quickadd-priority") == "P1" ? "x" : null, "the P1 chip from the line (the core's parse)");
        Invoke(h, "quickadd-due");
        Invoke(h, "quickadd-due-today");
        AppHost.Wait(() => NameOf(h, "quickadd-due") == "Today" ? "x" : null, "the due chip set to Today");
        Invoke(h, "quickadd-ok");
        AppHost.Wait(() => Gone(h, "quickadd-card") ? "x" : null, "the dialog closed");
        AppHost.Wait(() => h.Window.FindAllDescendants().Any(e => e.Properties.AutomationId.ValueOrDefault?.StartsWith("task-row-") == true
            && e.Properties.Name.ValueOrDefault == "Buy oat milk") ? "x" : null, "the new task in the Today list");
    });

    [Fact]
    public void Calendar_shows_a_month_and_navigates() => AppHost.Run(nameof(Calendar_shows_a_month_and_navigates), h =>
    {
        Retry(() => Find(h, "rail-calendar").Click());
        Find(h, "calendar-grid");
        var now = DateTime.Now;
        var month = now.ToString("MMMM yyyy");
        AppHost.Wait(() => NameOf(h, "calendar-title") == month ? "x" : null, "the title of this month");
        Find(h, "cal-daynum-" + now.ToString("yyyy-MM-dd") + "-today");          // today is marked
        Find(h, "cal-task-t-welcome");                                           // a sample task due today
        Invoke(h, "ribbon-next");
        var next = new DateTime(now.Year, now.Month, 1).AddMonths(1).ToString("MMMM yyyy");
        AppHost.Wait(() => NameOf(h, "calendar-title") == next ? "x" : null, "next month");
        Invoke(h, "ribbon-today");
        AppHost.Wait(() => NameOf(h, "calendar-title") == month ? "x" : null, "back to this month");
    });


    // ---- task detail, quick add pickers, "Tasks on this page", Calendar week / Everyone / Status (the offline sample data) ----

    /// <summary>A button or toggle: Invoke where the control has it, else a real click.</summary>
    private static void Press(AppHost h, string id) => Retry(() => { var e = Find(h, id); if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke(); else e.Click(); });

    private static void OpenSheetOfLaunch(AppHost h)
    {
        Invoke(h, "rail-search");
        Find(h, "search-input");
        h.Type("launch");
        Thread.Sleep(600);
        Invoke(h, "search-result-task-t-launch");
        Find(h, "task-sheet-title");
    }

    [Fact]
    public void Task_sheet_sets_team_tags_due_repeat_and_reminders() => AppHost.Run(nameof(Task_sheet_sets_team_tags_due_repeat_and_reminders), h =>
    {
        OpenSheetOfLaunch(h);
        AppHost.Wait(() => Status(h, "task-sheet-team") == "team=team-staff" ? "x" : null, "the sample task's team (Staff)");
        Invoke(h, "task-sheet-team");
        Invoke(h, "pick-team-team-design");
        AppHost.Wait(() => Status(h, "task-sheet-team") == "team=team-design" ? "x" : null, "the team changed to Design");

        Invoke(h, "task-sheet-tags");                            // make a tag by name, then pick an existing one
        SetText(h, "pick-tag-input", "ship");
        Invoke(h, "pick-tag-create");
        AppHost.Wait(() => Status(h, "task-sheet-tags").Contains("ship") ? "x" : null, "the new tag on the task");
        SetText(h, "pick-tag-input", "");
        Invoke(h, "pick-tag-launch");
        AppHost.Wait(() => Status(h, "task-sheet-tags") is var t && t.Contains("ship") && t.Contains("launch") ? "x" : null, "both tags on the task");
        Retry(() => Find(h, "pick-tag-input").Focus());          // Escape goes to the focused menu (SetText through UIA leaves focus elsewhere)
        h.Press(ESCAPE);                                         // closes the tags menu, not the sheet
        AppHost.Wait(() => Gone(h, "pick-tag-input") ? "x" : null, "the tags menu closed");
        Find(h, "task-sheet-title");

        Invoke(h, "task-sheet-due");
        Invoke(h, "pick-due-tomorrow");
        var tomorrow = DateTime.Now.AddDays(1).ToString("yyyy-MM-dd");
        AppHost.Wait(() => Status(h, "task-sheet-due") == "due=" + tomorrow ? "x" : null, "the due date set to tomorrow");

        Invoke(h, "task-sheet-repeat");
        Invoke(h, "pick-repeat-0");                              // Every day
        AppHost.Wait(() => Status(h, "task-sheet-repeat").StartsWith("repeat=Every") ? "x" : null, "a repeat rule, in words");

        Invoke(h, "task-sheet-add-reminder");                    // a due date makes "before it is due" available
        Invoke(h, "pick-reminder-60");
        AppHost.Wait(() => NameOf(h, "task-sheet-reminder-0") == "1 hour before" ? "x" : null, "the reminder listed");
        Assert.Equal("reminders=1", Status(h, "task-sheet-reminders"));
        Invoke(h, "task-sheet-reminder-del-0");
        AppHost.Wait(() => Status(h, "task-sheet-reminders") == "reminders=0" ? "x" : null, "the reminder removed");
    });

    [Fact]
    public void Task_sheet_adds_and_ticks_subtasks() => AppHost.Run(nameof(Task_sheet_adds_and_ticks_subtasks), h =>
    {
        OpenSheetOfLaunch(h);
        Assert.Equal("subtasks=0/0", Status(h, "task-sheet-subtasks"));
        Retry(() => { SetText(h, "task-sheet-subtask-input", "Draft the FAQ"); Find(h, "task-sheet-subtask-input").Focus(); });
        h.Press(ENTER);
        AppHost.Wait(() => Status(h, "task-sheet-subtasks") == "subtasks=0/1" ? "x" : null, "the subtask listed under the task");
        string? tick = null;
        AppHost.Wait(() =>
        {
            tick = h.Window.FindAllDescendants().Select(e => e.Properties.AutomationId.ValueOrDefault).FirstOrDefault(i => i?.StartsWith("task-sheet-sub-tick-") == true);
            return tick;
        }, "the subtask tick");
        Invoke(h, tick!);
        AppHost.Wait(() => Status(h, "task-sheet-subtasks") == "subtasks=1/1" ? "x" : null, "the subtask done: 1/1");
    });

    [Fact]
    public void Quick_add_pickers_set_team_tags_and_assignee() => AppHost.Run(nameof(Quick_add_pickers_set_team_tags_and_assignee), h =>
    {
        OpenTasks(h);
        Retry(() => Find(h, "sidebar-add-task").Click());
        Find(h, "quickadd-card");
        SetText(h, "quickadd-input", "Plan the offsite");
        Invoke(h, "quickadd-team");
        Invoke(h, "pick-team-team-design");
        AppHost.Wait(() => NameOf(h, "quickadd-team") == "Design" ? "x" : null, "the team chip set by its picker");
        Invoke(h, "quickadd-tags");
        Invoke(h, "pick-tag-docs");
        Retry(() => Find(h, "pick-tag-input").Focus());
        h.Press(ESCAPE);                                         // closes the tags menu, quick add stays
        AppHost.Wait(() => Gone(h, "pick-tag-input") ? "x" : null, "the tags menu closed");
        AppHost.Wait(() => NameOf(h, "quickadd-tags") == "#docs" ? "x" : null, "the tags chip set by its picker");
        Invoke(h, "quickadd-assignee");
        Invoke(h, "pick-assignee-u2");
        AppHost.Wait(() => NameOf(h, "quickadd-assignee") == "Sam Rivera" ? "x" : null, "the assignee chip set by its picker");
        Invoke(h, "quickadd-due");
        Invoke(h, "quickadd-due-today");
        Invoke(h, "quickadd-ok");
        AppHost.Wait(() => Gone(h, "quickadd-card") ? "x" : null, "the dialog closed");
        AppHost.Wait(() => h.Window.FindAllDescendants().Any(e => e.Properties.AutomationId.ValueOrDefault?.StartsWith("task-row-") == true
            && e.Properties.Name.ValueOrDefault == "Plan the offsite") ? "x" : null, "the new task in the Today list");
        Invoke(h, "rail-search");                                // open its sheet from search (a mouse click on the row is unreliable under UIA)
        Find(h, "search-input");
        h.Type("offsite");
        Thread.Sleep(600);
        string? hit = null;
        AppHost.Wait(() => hit = h.Window.FindAllDescendants().Select(e => e.Properties.AutomationId.ValueOrDefault).FirstOrDefault(i => i?.StartsWith("search-result-task-") == true), "the new task in the search results");
        Invoke(h, hit!);                                         // its sheet shows what the pickers set
        AppHost.Wait(() => Status(h, "task-sheet-team") == "team=team-design" ? "x" : null, "the team on the new task");
        Assert.Contains("docs", Status(h, "task-sheet-tags"));
    });

    [Fact]
    public void Page_tasks_panel_lists_the_pages_tasks_and_ticks_them() => AppHost.Run(nameof(Page_tasks_panel_lists_the_pages_tasks_and_ticks_them), h =>
    {
        Press(h, "page-row-tasks");
        Press(h, "page-tasks-button");
        Find(h, "page-tasks-panel");
        AppHost.Wait(() => Status(h, "page-tasks-panel") == "tasks=3 open=2 done=1" ? "x" : null, "the page's three tasks, two open");
        Assert.Equal("1/3 done", NameOf(h, "page-tasks-progress"));
        Invoke(h, "page-task-circle-t-welcome");
        AppHost.Wait(() => Status(h, "page-tasks-panel") == "tasks=3 open=1 done=2" ? "x" : null, "a task ticked in the panel");
        Assert.Equal("2/3 done", NameOf(h, "page-tasks-progress"));
        Press(h, "page-tasks-add");                              // quick add for this page
        Find(h, "quickadd-card");
        Find(h, "quickadd-page");
        h.Press(ESCAPE);
        Invoke(h, "page-tasks-close");
        AppHost.Wait(() => Gone(h, "page-tasks-panel") ? "x" : null, "the panel closed");
    });

    [Fact]
    public void Calendar_week_everyone_and_status_filter() => AppHost.Run(nameof(Calendar_week_everyone_and_status_filter), h =>
    {
        Retry(() => Find(h, "rail-calendar").Click());
        Find(h, "calendar-grid");
        Find(h, "cal-task-t-welcome");                           // mine, open
        Assert.True(Gone(h, "cal-task-t-other"));                // Sam's task is not in Mine
        Press(h, "ribbon-everyone");
        Find(h, "cal-task-t-other");
        Press(h, "ribbon-week");
        AppHost.Wait(() => NameOf(h, "calendar-title").Contains("–") ? "x" : null, "the week's title (a range of days)");
        Find(h, "cal-task-t-welcome");
        Find(h, "cal-task-t-other");
        Assert.True(Gone(h, "cal-task-t-slow"));                 // done: hidden while the status is Open
        Invoke(h, "calendar-status");
        Invoke(h, "calendar-status-completed");
        Find(h, "cal-task-t-slow");
        AppHost.Wait(() => Gone(h, "cal-task-t-welcome") ? "x" : null, "open tasks hidden while the status is Completed");
        Assert.Equal("status=completed", Status(h, "calendar-status"));
        Invoke(h, "ribbon-next");                                // a week later
        AppHost.Wait(() => Gone(h, "cal-task-t-slow") ? "x" : null, "next week has no tasks");
    });

    [Fact]
    public void Settings_opens_from_the_account_menu() => AppHost.Run(nameof(Settings_opens_from_the_account_menu), h =>
    {
        Invoke(h, "rail-account");
        Invoke(h, "menu-settings");
        Find(h, "settings-root");
        Find(h, "settings-name");
        Invoke(h, "settings-section-appearance");
        Invoke(h, "settings-theme-light");
        AppHost.Wait(() => NameOf(h, "settings-theme-light").EndsWith("(selected)") ? "x" : null, "Light selected");
        Invoke(h, "settings-section-about");
        Find(h, "settings-version");
        Invoke(h, "ribbon-back");
        AppHost.Wait(() => Gone(h, "settings-root") ? "x" : null, "Settings closed by the back arrow");
    });
}
