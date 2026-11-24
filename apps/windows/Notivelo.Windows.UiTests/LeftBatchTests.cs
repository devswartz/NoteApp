using FlaUI.Core.AutomationElements;
using FlaUI.Core.Input;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>The left batch on the offline sample: the box clipboard (select a box with Escape or its move bar, then Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+D / Delete and the box's
/// context menu), a new page from a template, Save as template, and the reminder toasts' readout in Settings > Notifications (the toasts themselves are not in the app's UI
/// tree, and an unpackaged run can't schedule them: the plan is read back from the Settings line). Written, not run, on the dev PC: they run on the CI runner only.</summary>
public class LeftBatchTests
{
    private static AutomationElement Find(AppHost h, string id, int ms = 20000) =>
        AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)), "element " + id, ms);

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

    private static string Log(AppHost h) => File.Exists(h.TaskLog) ? File.ReadAllText(h.TaskLog) : "";
    private static void WaitLog(AppHost h, string part) => AppHost.Wait(() => Log(h).Contains(part) ? "x" : null, "the change log to say \"" + part + "\"; it says: " + Log(h));

    private static List<string> BoxIds(AppHost h) =>
        h.Window.FindAllDescendants().Select(e => e.Properties.AutomationId.ValueOrDefault ?? "").Where(i => i.StartsWith("box-box-")).Select(i => i["box-box-".Length..]).OrderBy(i => i).ToList();

    private static string WaitBoxCount(AppHost h, int n) => AppHost.Wait(() => BoxIds(h).Count == n ? "x" : null, n + " boxes; there are " + string.Join(",", BoxIds(h)));
    private static string NewBox(AppHost h) => AppHost.Wait(() => BoxIds(h).FirstOrDefault(i => i != "a" && i != "b"), "a box besides a and b");

    private static bool Selected(Box b) { try { return b.Media("boxsel") == "1"; } catch (Exception) { return false; } }
    private static void WaitSelected(Box b) => AppHost.Wait(() => Selected(b) ? "x" : null, "box " + b.Id + " selected; status: " + b.Status);

    /// <summary>Select box "b" with Escape from inside it (the way OneNote does).</summary>
    private static void SelectB(AppHost h)
    {
        h.B.Focus();
        h.Press(ESCAPE);
        WaitSelected(h.B);
    }

    [Fact]
    public void Escape_inside_a_box_selects_it_and_Escape_again_lets_go() => AppHost.Run(nameof(Escape_inside_a_box_selects_it_and_Escape_again_lets_go), h =>
    {
        SelectB(h);
        Assert.False(Selected(h.A));
        h.Press(ESCAPE);
        AppHost.Wait(() => !Selected(h.B) ? "x" : null, "box b no longer selected");
    });

    [Fact]
    public void Ctrl_C_then_Ctrl_V_pastes_a_copy_of_the_selected_box() => AppHost.Run(nameof(Ctrl_C_then_Ctrl_V_pastes_a_copy_of_the_selected_box), h =>
    {
        SelectB(h);
        h.Chord(CONTROL, KEY_C);
        h.Chord(CONTROL, KEY_V);
        WaitBoxCount(h, 3);
        var made = new Box(h, NewBox(h));
        made.WaitText("Second box");
        WaitSelected(made);                       // the pasted box is the selected one
        Assert.False(Selected(h.B));
        WaitLog(h, "box paste " + made.Id);
        Assert.Equal("Second box", h.B.State.Text);   // the original is untouched
    });

    [Fact]
    public void Ctrl_D_duplicates_the_selected_box() => AppHost.Run(nameof(Ctrl_D_duplicates_the_selected_box), h =>
    {
        SelectB(h);
        h.Chord(CONTROL, KEY_D);
        WaitBoxCount(h, 3);
        var made = new Box(h, NewBox(h));
        made.WaitText("Second box");
        WaitSelected(made);
        // it sits down and to the right of the original, not on top of it
        Assert.True(made.Bounds.Left > h.B.Bounds.Left && made.Bounds.Top > h.B.Bounds.Top, $"copy at {made.Bounds}, original at {h.B.Bounds}");
    });

    [Fact]
    public void Delete_removes_the_selected_box_with_its_text() => AppHost.Run(nameof(Delete_removes_the_selected_box_with_its_text), h =>
    {
        SelectB(h);
        h.Press(DELETE);
        AppHost.Wait(() => BoxIds(h).SequenceEqual(new[] { "a" }) ? "x" : null, "only box a left; there are " + string.Join(",", BoxIds(h)));
        WaitLog(h, "box delete-with-content b");
    });

    [Fact]
    public void Ctrl_X_cuts_and_Ctrl_V_brings_it_back() => AppHost.Run(nameof(Ctrl_X_cuts_and_Ctrl_V_brings_it_back), h =>
    {
        SelectB(h);
        h.Chord(CONTROL, KEY_X);
        AppHost.Wait(() => BoxIds(h).SequenceEqual(new[] { "a" }) ? "x" : null, "box b cut");
        h.Chord(CONTROL, KEY_V);
        WaitBoxCount(h, 2);
        var back = BoxIds(h).First(i => i != "a");
        Assert.NotEqual("b", back);               // a new box (the core gives pasted boxes new ids)
        new Box(h, back).WaitText("Second box");
    });

    [Fact]
    public void The_box_context_menu_duplicates_and_deletes() => AppHost.Run(nameof(The_box_context_menu_duplicates_and_deletes), h =>
    {
        SelectB(h);
        var r = h.B.Bounds;
        Mouse.RightClick(new System.Drawing.Point(r.Left + 120, r.Top - 4));   // the move bar sits just above the box
        Find(h, "menu-box");
        Press(h, "menu-box-duplicate");
        WaitBoxCount(h, 3);
        var made = new Box(h, NewBox(h));
        WaitSelected(made);
        var m = made.Bounds;
        Mouse.RightClick(new System.Drawing.Point(m.Left + 120, m.Top - 4));
        Find(h, "menu-box");
        Press(h, "menu-box-delete");
        WaitBoxCount(h, 2);
    });

    [Fact]
    public void A_new_page_can_start_from_a_template() => AppHost.Run(nameof(A_new_page_can_start_from_a_template), h =>
    {
        Press(h, "section-more-empty");
        Press(h, "menu-new-from-template");
        Find(h, "template-meeting-notes");
        Find(h, "template-project");
        Find(h, "template-daily-journal");
        Find(h, "template-weekly-review");        // a saved template of the sample workspace
        Press(h, "template-meeting-notes");
        WaitLog(h, "page from template builtin:meeting");
        Assert.NotNull(AppHost.Wait(() => h.Window.FindAllDescendants().FirstOrDefault(e => (e.Properties.AutomationId.ValueOrDefault ?? "").StartsWith("page-row-page-n")), "the new page in the tree"));
    });

    [Fact]
    public void The_open_page_can_be_saved_as_a_template() => AppHost.Run(nameof(The_open_page_can_be_saved_as_a_template), h =>
    {
        Press(h, "page-options");
        Press(h, "menu-save-template");
        Retry(() => Find(h, "prompt-input").AsTextBox().Text = "Standup");
        Press(h, "prompt-ok");
        WaitLog(h, "save as template Standup");
        // it is offered next time
        Press(h, "section-more-empty");
        Press(h, "menu-new-from-template");
        Find(h, "template-standup");
    });

    [Fact]
    public void Reminder_toasts_are_planned_and_shown_in_Settings() => AppHost.Run(nameof(Reminder_toasts_are_planned_and_shown_in_Settings), h =>
    {
        Press(h, "rail-account");
        Press(h, "menu-settings");
        Find(h, "settings-root");
        Press(h, "settings-section-notifications");
        var status = AppHost.Wait(() =>
        {
            var name = Find(h, "settings-reminders-status", 3000).Properties.Name.ValueOrDefault ?? "";
            return name.Contains("scheduled on this PC") && name.StartsWith("2 reminders") ? name : null;
        }, "the two sample reminders planned");
        Assert.Contains("Next:", status);
    });

    [Fact]
    public void The_Print_button_is_on_the_Home_ribbon() => AppHost.Run(nameof(The_Print_button_is_on_the_Home_ribbon), h =>
    {
        Find(h, "ribbon-print");                  // opening the print dialog is not driven here (it is a system window)
    });
}
