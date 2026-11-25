using FlaUI.Core.AutomationElements;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>The left4 batch on the offline sample: saved task views (save, open, rename, delete), selecting tasks with the keyboard and completing them from the bulk bar (with Undo on
/// its toast), the outline of a page (ribbon list and the bars at the right edge), pages that link here, and the block menu (the handle, and Ctrl+Shift+M). Every feature has a
/// keyboard or menu path and nothing depends on a drag or a pixel. Written, not run, on the dev PC: they run on the CI runner only.</summary>
public class Left4Tests
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

    private static bool GoneName(AppHost h, string name, int ms = 5000)
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

    /// <summary>Invoke, or click where the element has no Invoke pattern (a toggle button, a tree row).</summary>
    private static void Press(AppHost h, string id) => Retry(() => { var e = Find(h, id); if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke(); else { e.Click(); Thread.Sleep(250); } });

    private static void PressName(AppHost h, string name) => Retry(() => { var e = FindName(h, name); if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke(); else { e.Click(); Thread.Sleep(250); } });

    private static string Status(AppHost h, string id) => Find(h, id).Properties.ItemStatus.ValueOrDefault ?? "";
    private static string NameOf(AppHost h, string id) => Find(h, id).Properties.Name.ValueOrDefault ?? "";
    private static int Count(AppHost h) => int.Parse(Status(h, "tasks-count").Replace("count=", ""));
    private static string Log(AppHost h) => File.Exists(h.TaskLog) ? File.ReadAllText(h.TaskLog) : "";
    private static void WaitLog(AppHost h, string part) => AppHost.Wait(() => Log(h).Contains(part) ? "x" : null, "the change log to say \"" + part + "\"; it says: " + Log(h));

    private static void OpenAllTasks(AppHost h)
    {
        Retry(() => Find(h, "rail-tasks").Click());
        Press(h, "ribbon-all-tasks");
        Find(h, "tasks-count");
    }

    // ---- saved views ----

    [Fact]
    public void A_view_is_saved_reopened_renamed_and_deleted() => AppHost.Run(nameof(A_view_is_saved_reopened_renamed_and_deleted), h =>
    {
        OpenAllTasks(h);
        Find(h, "sidebar-new-view");
        Press(h, "ribbon-priority");
        Press(h, "menu-priority-1");
        AppHost.Wait(() => Count(h) == 1 ? "x" : null, "one task left with priority 1");
        Press(h, "ribbon-save-view");
        Retry(() => Find(h, "prompt-input").AsTextBox().Text = "Only urgent");
        Press(h, "prompt-ok");
        WaitLog(h, "view create Only urgent");
        FindName(h, "Only urgent");                                      // a row in the Tasks panel
        AppHost.Wait(() => NameOf(h, "tasks-view-name") == "Saved view: Only urgent" ? "x" : null, "the list says which view it is");

        Press(h, "ribbon-clear-filters");
        AppHost.Wait(() => Count(h) > 1 ? "x" : null, "the whole list after Clear filters");
        Assert.True(Gone(h, "tasks-view-name"));

        PressName(h, "Only urgent");                                     // open it again from the sidebar
        AppHost.Wait(() => Count(h) == 1 ? "x" : null, "the view's filter applied again");
        Find(h, "task-row-t-launch");
        Assert.Contains("Priority", NameOf(h, "tasks-filter-summary"));

        PressName(h, "View options: Only urgent");
        Press(h, "menu-view-rename");
        Retry(() => Find(h, "prompt-input").AsTextBox().Text = "Urgent");
        Press(h, "prompt-ok");
        WaitLog(h, "view update Urgent");
        AppHost.Wait(() => NameOf(h, "tasks-view-name") == "Saved view: Urgent" ? "x" : null, "the renamed view");

        PressName(h, "View options: Urgent");
        Press(h, "menu-view-delete");
        Press(h, "confirm-ok");
        Assert.True(GoneName(h, "View options: Urgent"), "the view is gone from the sidebar");
    });

    [Fact]
    public void The_Saved_views_menu_lists_the_sample_views_and_opens_one() => AppHost.Run(nameof(The_Saved_views_menu_lists_the_sample_views_and_opens_one), h =>
    {
        OpenAllTasks(h);
        Press(h, "ribbon-saved-views");
        Find(h, "menu-saved-views");
        Press(h, "menu-view-view-urgent");                              // "Urgent this week": priority 1 and 2, due in the next 7 days, sorted by priority
        AppHost.Wait(() => NameOf(h, "tasks-view-name") == "Saved view: Urgent this week" ? "x" : null, "the sample view opened");
        Assert.Contains("Priority", NameOf(h, "tasks-filter-summary"));
        Press(h, "ribbon-saved-views");
        Press(h, "menu-views-new");                                     // New view: a clean All tasks
        Assert.True(Gone(h, "tasks-view-name"));
    });

    // ---- bulk select ----

    [Fact]
    public void Two_tasks_are_picked_with_the_keyboard_and_completed_from_the_bar_with_Undo() => AppHost.Run(nameof(Two_tasks_are_picked_with_the_keyboard_and_completed_from_the_bar_with_Undo), h =>
    {
        OpenAllTasks(h);
        Press(h, "tasks-select");                                       // the list now has the keyboard
        Find(h, "bulk-bar");
        h.Press(DOWN); h.Press(SPACE);                                  // the first row (Review the launch checklist)
        h.Press(DOWN); h.Press(SPACE);                                  // the second (Try checking off this task)
        AppHost.Wait(() => NameOf(h, "bulk-count") == "2 selected" ? "x" : null, "two tasks picked by the keyboard");
        Assert.Equal("selected=1", Status(h, "task-select-t-launch"));
        Assert.Equal("selected=1", Status(h, "task-select-t-welcome"));
        Press(h, "bulk-complete");
        AppHost.Wait(() => Status(h, "task-circle-t-launch") == "done=1" && Status(h, "task-circle-t-welcome") == "done=1" ? "x" : null, "both tasks done");
        Assert.Equal("done=0", Status(h, "task-circle-t-notes"));        // the third was not picked
        Assert.True(Gone(h, "bulk-bar"));                                // the selection ended
        Press(h, "toast-undo");
        AppHost.Wait(() => Status(h, "task-circle-t-launch") == "done=0" && Status(h, "task-circle-t-welcome") == "done=0" ? "x" : null, "Undo reopened both");
    });

    [Fact]
    public void Shift_picks_a_range_and_the_bar_sets_a_priority_and_deletes() => AppHost.Run(nameof(Shift_picks_a_range_and_the_bar_sets_a_priority_and_deletes), h =>
    {
        OpenAllTasks(h);
        Press(h, "tasks-select");
        Press(h, "task-select-t-notes");
        h.Press(DOWN);                                                  // the keyboard's row moves on from the one just picked
        h.Chord(SHIFT, DOWN);                                           // and Shift extends the pick down
        AppHost.Wait(() => Status(h, "bulk-bar").StartsWith("selected=") && int.Parse(Status(h, "bulk-bar")[9..]) >= 2 ? "x" : null, "a range picked");
        Press(h, "bulk-priority");
        Press(h, "bulk-priority-1");
        AppHost.Wait(() => Gone(h, "bulk-bar") ? "x" : null, "the bar closed after the change");
        Press(h, "tasks-select");
        Press(h, "task-select-t-nodate");
        Press(h, "bulk-delete");
        Press(h, "confirm-ok");
        Assert.True(Gone(h, "task-row-t-nodate", 8000), "the deleted task left the list");
    });

    // ---- outline ----

    private static void TypeHeadings(AppHost h)
    {
        h.A.Focus();
        Press(h, "ribbon-block-type"); Press(h, "block-heading-1");
        h.Type("Intro"); h.Press(ENTER);
        h.Type("body"); h.Press(ENTER);
        Press(h, "ribbon-block-type"); Press(h, "block-heading-2");
        h.Type("Details"); h.Press(ENTER);
        Press(h, "ribbon-block-type"); Press(h, "block-heading-3");
        h.Type("Third");
        h.A.WaitText("Intro\nbody\nDetails\nThird");
    }

    [Fact]
    public void The_outline_lists_the_headings_and_a_pick_puts_the_caret_in_the_heading() => AppHost.Run(nameof(The_outline_lists_the_headings_and_a_pick_puts_the_caret_in_the_heading), h =>
    {
        TypeHeadings(h);
        h.Chord(CONTROL, HOME);                                         // the caret to the very start
        h.A.WaitFor(s => s.Anchor == 0 && s.Head == 0, "the caret at the start");
        Press(h, "ribbon-outline");
        Find(h, "menu-outline");
        Find(h, "outline-item-0"); Find(h, "outline-item-2");
        Assert.Contains("Details", NameOf(h, "outline-item-1"));
        Press(h, "outline-item-1");
        h.A.WaitFor(s => s.Focus && s.Anchor == 11 && s.Head == 11, "the caret at the start of Details (offset 11)");

        // three headings: the bars at the right edge appear and open the same list
        var rail = Find(h, "page-outline-rail");
        Assert.Equal("headings=3", rail.Properties.ItemStatus.ValueOrDefault);
        Press(h, "page-outline-rail");
        Press(h, "outline-item-2");
        h.A.WaitFor(s => s.Focus && s.Anchor == 19 && s.Head == 19, "the caret at the start of Third (offset 19)");
    });

    // ---- backlinks ----

    [Fact]
    public void The_Linked_tab_lists_the_pages_that_link_to_this_page() => AppHost.Run(nameof(The_Linked_tab_lists_the_pages_that_link_to_this_page), h =>
    {
        Press(h, "page-links-button");                                  // the offline page is linked from "Canvas" in the sample
        Find(h, "page-links-panel");
        Find(h, "backlink-canvas");
        Assert.Equal("Linked from 1 page", NameOf(h, "backlinks-summary"));
        Assert.Equal("count=1", Status(h, "backlinks-summary"));
        Press(h, "page-tab-tasks");                                      // back to the page's tasks
        Find(h, "page-tasks-panel");
        Press(h, "page-tab-links");
        Press(h, "backlink-canvas");                                     // a row opens that page
        Find(h, "page-links-button");
    });

    // ---- block menu ----

    private static void ThreeLines(AppHost h)
    {
        h.A.Focus();
        h.Type("one"); h.Press(ENTER); h.Type("two"); h.Press(ENTER); h.Type("three");
        h.A.WaitText("one\ntwo\nthree");
    }

    [Fact]
    public void The_handle_opens_the_block_menu_which_moves_turns_and_deletes_a_block() => AppHost.Run(nameof(The_handle_opens_the_block_menu_which_moves_turns_and_deletes_a_block), h =>
    {
        ThreeLines(h);
        Press(h, "block-handle");                                       // the handle is at the caret's block ("three")
        Find(h, "menu-block");
        Press(h, "block-menu-up");
        h.A.WaitText("one\nthree\ntwo");
        Press(h, "block-handle");
        Press(h, "block-turn-heading-1");
        h.A.WaitFor(s => s.Block == "heading", "the moved block turned into a heading");
        Press(h, "block-handle");
        Press(h, "block-menu-duplicate");
        h.A.WaitText("one\nthree\nthree\ntwo");
        Press(h, "block-handle");
        Press(h, "block-menu-delete");
        h.A.WaitText("one\nthree\ntwo");
    });

    [Fact]
    public void Ctrl_Shift_M_opens_the_block_menu_from_the_keyboard() => AppHost.Run(nameof(Ctrl_Shift_M_opens_the_block_menu_from_the_keyboard), h =>
    {
        ThreeLines(h);
        h.Chord(CONTROL, SHIFT, KEY_M);
        Find(h, "menu-block");
        Press(h, "block-menu-up");
        h.A.WaitText("one\nthree\ntwo");
        h.Chord(ALT, SHIFT, DOWN);                                      // the engine's own key for the same move
        h.A.WaitText("one\ntwo\nthree");
    });
}
