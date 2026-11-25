using FlaUI.Core.AutomationElements;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>The left2 batch on the offline sample: the template strip and picker on a new page (Start blank takes a template back), saved templates (rename, delete, where each is
/// offered, a default per section), a table inserted and grown from the ribbon, the page bar's "who is here" avatars, and a notebook moved up from its menu. Every pointer feature
/// has a menu or keyboard path here; nothing depends on a drag. Written, not run, on the dev PC: they run on the CI runner only.</summary>
public class Left2Tests
{
    private static AutomationElement Find(AppHost h, string id, int ms = 20000) =>
        AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)), "element " + id, ms);

    private static bool Gone(AppHost h, string id, int ms = 3000)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms) { if (h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)) is null) return true; Thread.Sleep(150); }
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

    private static string Log(AppHost h) => File.Exists(h.TaskLog) ? File.ReadAllText(h.TaskLog) : "";
    private static void WaitLog(AppHost h, string part) => AppHost.Wait(() => Log(h).Contains(part) ? "x" : null, "the change log to say \"" + part + "\"; it says: " + Log(h));

    /// <summary>A new page in the Empty section, which opens with the template strip (a new sample page is blank).</summary>
    private static void NewBlankPage(AppHost h)
    {
        Press(h, "section-more-empty");
        Press(h, "menu-new-page");
        Find(h, "empty-template-more");
    }

    // ---- templates ----

    [Fact]
    public void A_new_page_offers_templates_and_Start_blank_dismisses_the_strip() => AppHost.Run(nameof(A_new_page_offers_templates_and_Start_blank_dismisses_the_strip), h =>
    {
        NewBlankPage(h);
        Find(h, "empty-template-meeting-notes");
        Find(h, "empty-template-project");
        Find(h, "empty-template-daily-journal");
        Press(h, "template-strip-blank");
        Assert.True(Gone(h, "empty-template-more"));
    });

    [Fact]
    public void A_template_goes_onto_a_new_page_and_Start_blank_takes_it_back() => AppHost.Run(nameof(A_template_goes_onto_a_new_page_and_Start_blank_takes_it_back), h =>
    {
        NewBlankPage(h);
        Press(h, "empty-template-project");
        WaitLog(h, "apply template builtin:project");
        Find(h, "page-start-blank");
        Assert.True(Gone(h, "empty-template-more"));
        Press(h, "page-start-blank");
        WaitLog(h, "start blank ");
        Find(h, "empty-template-more");                 // blank again: the strip offers the templates again
    });

    [Fact]
    public void The_ribbon_Templates_button_opens_the_picker_for_the_open_page() => AppHost.Run(nameof(The_ribbon_Templates_button_opens_the_picker_for_the_open_page), h =>
    {
        NewBlankPage(h);
        Press(h, "template-strip-blank");
        Press(h, "ribbon-templates");
        Find(h, "template-meeting-notes");
        Find(h, "template-weekly-review");
        Press(h, "template-weekly-review");
        WaitLog(h, "apply template t-weekly");
        Find(h, "page-start-blank");
    });

    [Fact]
    public void A_saved_template_can_be_renamed_and_deleted() => AppHost.Run(nameof(A_saved_template_can_be_renamed_and_deleted), h =>
    {
        Press(h, "section-more-empty");
        Press(h, "menu-manage-templates");
        Press(h, "template-rename-weekly-review");
        Retry(() => Find(h, "prompt-input").AsTextBox().Text = "Sprint review");
        Press(h, "prompt-ok");
        WaitLog(h, "rename template t-weekly Sprint review");
        Find(h, "template-rename-sprint-review");
        Press(h, "template-delete-sprint-review");
        Press(h, "confirm-ok");
        WaitLog(h, "delete template t-weekly");
        Assert.True(Gone(h, "template-rename-sprint-review"));
    });

    [Fact]
    public void A_template_can_be_tied_to_a_section() => AppHost.Run(nameof(A_template_can_be_tied_to_a_section), h =>
    {
        Press(h, "section-more-empty");
        Press(h, "menu-manage-templates");
        Press(h, "template-scope-weekly-review");           // everywhere -> only this section
        WaitLog(h, "scope template t-weekly empty");
        Press(h, "templates-done");
        // it is offered in Empty section but not in Corpus
        Press(h, "section-more-corpus");
        Press(h, "menu-new-from-template");
        Find(h, "template-meeting-notes");
        Assert.True(Gone(h, "template-weekly-review", 1500));
    });

    [Fact]
    public void A_section_default_template_starts_new_pages() => AppHost.Run(nameof(A_section_default_template_starts_new_pages), h =>
    {
        Press(h, "section-more-empty");
        Press(h, "menu-default-template");
        Press(h, "default-template-weekly-review");
        WaitLog(h, "default template empty template t-weekly");
        Press(h, "default-template-close");
        Press(h, "section-more-empty");
        Press(h, "menu-new-page");
        WaitLog(h, "page from default template t-weekly");
        Assert.True(Gone(h, "empty-template-more", 1500));      // the page started from the template: no strip asking for one
    });

    // ---- tables and blocks ----

    [Fact]
    public void A_table_is_inserted_and_grown_from_the_ribbon() => AppHost.Run(nameof(A_table_is_inserted_and_grown_from_the_ribbon), h =>
    {
        h.B.Focus();
        Press(h, "ribbon-table");
        h.B.WaitMedia("tables", v => v == "3x3", "a 3x3 table");
        Press(h, "ribbon-add-row");
        h.B.WaitMedia("tables", v => v == "4x3", "a fourth row");
        Press(h, "ribbon-add-column");
        h.B.WaitMedia("tables", v => v == "4x4", "a fourth column");
        Press(h, "ribbon-table-tools");
        Press(h, "table-delete-row");
        h.B.WaitMedia("tables", v => v == "3x4", "a row deleted");
        h.Press(DOWN);                                            // deleting the first row leaves the caret on the line above the table
        Press(h, "ribbon-table-tools");
        Press(h, "table-delete-table");
        h.B.WaitMedia("tables", v => v == "", "no table left");
    });

    [Fact]
    public void Callout_comes_from_the_text_style_menu() => AppHost.Run(nameof(Callout_comes_from_the_text_style_menu), h =>
    {
        h.B.Focus();
        h.Press(END);
        Press(h, "ribbon-block-type");
        Press(h, "block-callout");
        h.B.WaitMedia("in", v => v.Contains("callout"), "the line in a callout");
    });

    // ---- presence ----

    [Fact]
    public void The_page_bar_shows_who_else_is_on_the_page() => AppHost.Run(nameof(The_page_bar_shows_who_else_is_on_the_page), h =>
    {
        var stack = Find(h, "page-presence");
        Assert.Contains("Sample Viewer", stack.Properties.Name.ValueOrDefault ?? "");
        Press(h, "page-presence");
        Find(h, "menu-presence");
        Find(h, "presence-sample-viewer");
    });

    // ---- notebooks ----

    [Fact]
    public void A_notebook_moves_up_from_its_menu() => AppHost.Run(nameof(A_notebook_moves_up_from_its_menu), h =>
    {
        Press(h, "notebook-picker");
        Press(h, "new-notebook");
        Retry(() => Find(h, "prompt-input").AsTextBox().Text = "Second notebook");
        Press(h, "prompt-ok");
        Find(h, "notebook-more");
        Press(h, "notebook-more");                          // the new one is open and last: it can only go up
        Find(h, "menu-notebook");
        Assert.True(Gone(h, "menu-move-down", 1500));
        Press(h, "menu-move-up");
        WaitLog(h, "move notebook ");
        Press(h, "notebook-more");
        Find(h, "menu-move-down");                          // now first: it can only go down
        Assert.True(Gone(h, "menu-move-up", 1500));
    });
}
