using FlaUI.Core.AutomationElements;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>The left5 batch on the offline sample: the highlight colour menu, the task keys A, R / F2 and S, inline rename (Enter saves, Esc cancels), the toast with Undo on a row's check circle, and the
/// app-menu shortcuts (Ctrl+N, Ctrl+Shift+T, Ctrl+1 to 8, Ctrl+,). Keyboard and menu paths only; nothing depends on a drag or a pixel. Written, not run, on the dev PC: they run on the CI runner only.
/// Opening offline from a cold start needs a stored sign-in and a server that cannot be reached: it is covered by unit tests (OfflineStart), not here.</summary>
public class Left5Tests
{
    private static AutomationElement Find(AppHost h, string id, int ms = 20000) =>
        AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)), "element " + id, ms);

    private static AutomationElement FindName(AppHost h, string name, int ms = 20000) =>
        AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByName(name)), "element named " + name, ms);

    private static bool Gone(AppHost h, string id, int ms = 3000)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms) { if (h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)) is null) return true; Thread.Sleep(150); }
        return false;
    }

    private static bool GoneName(AppHost h, string name, int ms = 3000)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms) { if (h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByName(name)) is null) return true; Thread.Sleep(150); }
        return false;
    }

    private static void Retry(Action a)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            try { a(); return; }
            catch (Exception) when (sw.ElapsedMilliseconds < 15000) { Thread.Sleep(200); }
        }
    }

    /// <summary>Invoke, or click where the element has no Invoke pattern.</summary>
    private static void Press(AppHost h, string id) => Retry(() => { var e = Find(h, id); if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke(); else { e.Click(); Thread.Sleep(250); } });

    private static string Status(AppHost h, string id) => Find(h, id).Properties.ItemStatus.ValueOrDefault ?? "";
    private static string NameOf(AppHost h, string id) => Find(h, id).Properties.Name.ValueOrDefault ?? "";
    private static string Log(AppHost h) => File.Exists(h.TaskLog) ? File.ReadAllText(h.TaskLog) : "";
    private static void WaitLog(AppHost h, string part) => AppHost.Wait(() => Log(h).Contains(part) ? "x" : null, "the change log to say \"" + part + "\"; it says: " + Log(h));

    private static void OpenAllTasks(AppHost h)
    {
        Retry(() => Find(h, "rail-tasks").Click());
        Press(h, "ribbon-all-tasks");
        Find(h, "tasks-count");
    }

    private static void WaitTitle(AppHost h, string title) =>
        AppHost.Wait(() => NameOf(h, "tasks-title") == title ? "x" : null, "the Tasks title to read " + title);

    // ---- highlight ----

    [Fact]
    public void Highlight_has_a_colour_menu_with_the_webs_eight_names_and_a_default() => AppHost.Run(nameof(Highlight_has_a_colour_menu_with_the_webs_eight_names_and_a_default), h =>
    {
        h.A.Focus();
        h.Type("Hello");
        h.Chord(CONTROL, KEY_A);
        Press(h, "ribbon-highlight");
        foreach (var n in new[] { "default", "gray", "red", "orange", "yellow", "green", "blue", "purple", "pink" }) Find(h, "colour-highlight-" + n);
        Press(h, "colour-highlight-green");
        h.A.WaitFor(s => s.Focus, "the box has the keyboard back after the pick");
        Assert.Equal("Hello", h.A.State.Text.TrimEnd('\n'));
        Press(h, "ribbon-highlight");
        Press(h, "colour-highlight-default");
        h.A.WaitFor(s => s.Focus, "the box has the keyboard back after Default");
        Assert.Equal("Hello", h.A.State.Text.TrimEnd('\n'));
    });

    // ---- task keys and inline rename ----

    [Fact]
    public void R_renames_the_row_in_place_Enter_saves_and_Esc_cancels() => AppHost.Run(nameof(R_renames_the_row_in_place_Enter_saves_and_Esc_cancels), h =>
    {
        OpenAllTasks(h);
        Press(h, "tasks-select");                                       // the list has the keyboard
        h.Press(DOWN);                                                  // the keyboard's row: the first
        h.Press(KEY_R);
        var box = Find(h, "task-rename-input").AsTextBox();
        Retry(() => { box.Focus(); });
        h.Type("Launch checklist, renamed");                           // the title is selected: typing replaces it
        h.Press(ENTER);
        AppHost.Wait(() => Gone(h, "task-rename-input") ? "x" : null, "the rename box gone after Enter");
        FindName(h, "Launch checklist, renamed");
        WaitLog(h, "task t-launch edit");

        h.Press(DOWN);                                                  // the second row, then F2
        h.Press(F2);
        Retry(() => { Find(h, "task-rename-input").Focus(); });
        h.Type("Should not stay");
        h.Press(ESCAPE);
        AppHost.Wait(() => Gone(h, "task-rename-input") ? "x" : null, "the rename box gone after Esc");
        Assert.True(GoneName(h, "Should not stay"), "Esc kept the old title");
    });

    [Fact]
    public void S_picks_the_row_and_A_opens_the_assign_menu() => AppHost.Run(nameof(S_picks_the_row_and_A_opens_the_assign_menu), h =>
    {
        OpenAllTasks(h);
        Press(h, "tasks-select");
        h.Press(DOWN);
        h.Press(KEY_S);
        AppHost.Wait(() => NameOf(h, "bulk-count") == "1 selected" ? "x" : null, "S picked the row");
        h.Press(KEY_S);
        AppHost.Wait(() => NameOf(h, "bulk-count") == "Select tasks" ? "x" : null, "S again unpicked it");
        var before = Log(h).Length;
        h.Press(KEY_A);                                                 // the keyboard's row gets picked and the menu opens
        Find(h, "bulk-assign-menu");
        Press(h, "bulk-assign-none");
        AppHost.Wait(() => Log(h).Length > before ? "x" : null, "the assignment written; the log says: " + Log(h));
    });

    [Fact]
    public void Completing_from_the_check_circle_says_so_and_Undo_reopens() => AppHost.Run(nameof(Completing_from_the_check_circle_says_so_and_Undo_reopens), h =>
    {
        OpenAllTasks(h);
        Assert.Equal("done=0", Status(h, "task-circle-t-notes"));
        Press(h, "task-circle-t-notes");
        AppHost.Wait(() => Status(h, "task-circle-t-notes") == "done=1" ? "x" : null, "the task done");
        FindName(h, "Task completed");
        Press(h, "toast-undo");
        AppHost.Wait(() => Status(h, "task-circle-t-notes") == "done=0" ? "x" : null, "Undo reopened it");
    });

    // ---- app-menu shortcuts ----

    [Fact]
    public void Ctrl_1_to_8_switch_views_and_Ctrl_comma_opens_settings() => AppHost.Run(nameof(Ctrl_1_to_8_switch_views_and_Ctrl_comma_opens_settings), h =>
    {
        Retry(() => Find(h, "rail-tasks").Click());                     // the shell has the keyboard
        WaitTitle(h, "Today");
        h.Chord(CONTROL, KEY_2); WaitTitle(h, "Upcoming");
        h.Chord(CONTROL, KEY_3); WaitTitle(h, "My Tasks");
        h.Chord(CONTROL, KEY_4); WaitTitle(h, "Team");
        h.Chord(CONTROL, KEY_5); WaitTitle(h, "All tasks");
        h.Chord(CONTROL, KEY_1); WaitTitle(h, "Today");
        h.Chord(CONTROL, KEY_6); Find(h, "ribbon-week");                // the Calendar's ribbon
        h.Chord(CONTROL, KEY_8); Find(h, "ribbon-bold");                // Notes: the editing ribbon
        h.Chord(CONTROL, OEM_COMMA); Find(h, "settings-root");
    });

    [Fact]
    public void Ctrl_Shift_T_opens_quick_add_and_Ctrl_N_makes_a_page() => AppHost.Run(nameof(Ctrl_Shift_T_opens_quick_add_and_Ctrl_N_makes_a_page), h =>
    {
        Retry(() => Find(h, "rail-tasks").Click());
        h.Chord(CONTROL, SHIFT, KEY_T);
        Find(h, "quickadd-card");
        h.Press(ESCAPE);
        AppHost.Wait(() => Gone(h, "quickadd-card") ? "x" : null, "quick add closed by Esc");
        h.Chord(CONTROL, KEY_N);                                        // a new page opens, blank, with the template strip
        Find(h, "empty-template-more");
    });
}
