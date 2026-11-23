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
}
