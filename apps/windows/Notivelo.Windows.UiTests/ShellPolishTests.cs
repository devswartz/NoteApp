using FlaUI.Core.AutomationElements;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>PARITY batch 4 (tree and shell polish) on the offline sample: section and notebook colours, Move up / Move down, notebook sharing, the System theme, accent
/// colours, the keyboard-shortcut sheet, renaming a page by its title and the offline pill. The tree changes are read back from the sample's change log
/// (NOTIVELO_OFFLINE_LOG); the rest through UI Automation names. Drag and drop in the tree is not driven here (it needs real pointer drags). Run on the CI runner only.</summary>
public class ShellPolishTests
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

    private static void Invoke(AppHost h, string id) => Retry(() => { var e = Find(h, id); if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke(); else { e.Click(); Thread.Sleep(250); } });
    private static void SetText(AppHost h, string id, string text) => Retry(() => Find(h, id).AsTextBox().Text = text);
    private static string NameOf(AppHost h, string id) => Find(h, id).Properties.Name.ValueOrDefault ?? "";
    private static string Status(AppHost h, string id) => Find(h, id).Properties.ItemStatus.ValueOrDefault ?? "";
    private static string Log(AppHost h) => File.Exists(h.TaskLog) ? File.ReadAllText(h.TaskLog) : "";

    private static void WaitLog(AppHost h, string part) =>
        AppHost.Wait(() => Log(h).Contains(part) ? "x" : null, "the change log to say \"" + part + "\"; it says: " + Log(h));

    private static void WaitName(AppHost h, string id, string name) =>
        AppHost.Wait(() => { try { return NameOf(h, id) == name ? "x" : null; } catch (Exception) { return null; } }, $"{id} to be named \"{name}\"");

    private static void With(IReadOnlyDictionary<string, string> env, string name, Action<AppHost> body)
    {
        using var h = AppHost.Launch(env);
        try { body(h); }
        catch { h.Shot(name); throw; }
    }

    private static void OpenSettings(AppHost h, string section)
    {
        Invoke(h, "rail-account");
        Invoke(h, "menu-settings");
        Find(h, "settings-root");
        Invoke(h, "settings-section-" + section);
    }

    // ---- colours ----

    [Fact]
    public void Section_colour_comes_from_the_section_menu() => AppHost.Run(nameof(Section_colour_comes_from_the_section_menu), h =>
    {
        Invoke(h, "section-more-corpus");
        Find(h, "menu-section");
        Assert.Equal("Pink (selected)", NameOf(h, "colour-ec4899"));   // the sample section is pink
        Assert.Equal("Red", NameOf(h, "colour-ef4444"));
        Invoke(h, "colour-ef4444");
        WaitLog(h, "color section corpus #ef4444");
        AppHost.Wait(() => Gone(h, "menu-section") ? "x" : null, "the menu closed");
        Invoke(h, "section-more-corpus");
        WaitName(h, "colour-ef4444", "Red (selected)");
        Assert.Equal("Pink", NameOf(h, "colour-ec4899"));
    });

    [Fact]
    public void Notebook_colour_comes_from_the_notebook_menu() => AppHost.Run(nameof(Notebook_colour_comes_from_the_notebook_menu), h =>
    {
        Invoke(h, "notebook-more");
        Find(h, "menu-notebook");
        Invoke(h, "colour-0ea5e9");
        WaitLog(h, "color notebook look #0ea5e9");
        Invoke(h, "notebook-more");
        WaitName(h, "colour-0ea5e9", "Sky (selected)");
    });

    // ---- reordering ----

    [Fact]
    public void Move_a_page_and_a_section_from_the_menu() => AppHost.Run(nameof(Move_a_page_and_a_section_from_the_menu), h =>
    {
        Invoke(h, "page-more-canvas");                      // the first page of Corpus: it can only go down
        Find(h, "menu-page");
        Assert.True(Gone(h, "menu-move-up"));
        Invoke(h, "menu-move-down");
        WaitLog(h, "move page canvas to corpus at 1");
        Invoke(h, "page-more-canvas");
        Find(h, "menu-move-up");                            // now second: both ways
        Find(h, "menu-move-down");
        Invoke(h, "menu-move-up");
        WaitLog(h, "move page canvas to corpus at 0");

        Invoke(h, "section-more-corpus");                   // Corpus is the first of two sections
        Find(h, "menu-section");
        Assert.True(Gone(h, "menu-move-up"));
        Invoke(h, "menu-move-down");
        WaitLog(h, "move section corpus to look at 1");
        Invoke(h, "section-more-corpus");
        Find(h, "menu-move-up");
        Assert.True(Gone(h, "menu-move-down"));
    });

    [Fact]
    public void Move_to_still_moves_a_page_into_another_section() => AppHost.Run(nameof(Move_to_still_moves_a_page_into_another_section), h =>
    {
        Invoke(h, "page-more-lists");
        Invoke(h, "menu-move-to");
        Invoke(h, "dest-empty-section");
        AppHost.Wait(() => Gone(h, "dest-empty-section") ? "x" : null, "the picker closed");
        Find(h, "page-row-lists");
    });

    // ---- sharing a notebook ----

    [Fact]
    public void Share_a_notebook_with_people() => AppHost.Run(nameof(Share_a_notebook_with_people), h =>
    {
        Invoke(h, "notebook-more");
        Invoke(h, "menu-notebook-share");
        Find(h, "notebook-share-dialog");
        AppHost.Wait(() => Status(h, "notebook-share-dialog").Contains("visibility=shared") ? "x" : null, "the dialog to load");
        Assert.True(Gone(h, "nbshare-member-u2"));          // the list shows once the notebook is private
        Invoke(h, "nbshare-private");
        AppHost.Wait(() => Status(h, "notebook-share-dialog").Contains("visibility=private") ? "x" : null, "the notebook private");
        WaitLog(h, "notebook private look");
        Assert.Equal("Sam Rivera", NameOf(h, "nbshare-member-u2"));
        Invoke(h, "nbshare-member-u2");
        WaitName(h, "nbshare-member-u2", "Sam Rivera (shared)");
        WaitLog(h, "notebook shares look u2");
        Invoke(h, "nbshare-done");
        AppHost.Wait(() => Gone(h, "notebook-share-dialog") ? "x" : null, "the dialog closed");
        Invoke(h, "notebook-more");                          // the menu now offers the way back
        Assert.Equal("Share with workspace", NameOf(h, "menu-notebook-visibility"));
    });

    // ---- appearance ----

    [Fact]
    public void System_theme_is_selectable_in_the_account_menu_and_in_settings() =>
        With(new Dictionary<string, string> { ["NOTIVELO_SYSTEM_THEME"] = "dark" }, nameof(System_theme_is_selectable_in_the_account_menu_and_in_settings), h =>
        {
            Invoke(h, "rail-account");
            Find(h, "theme-system");
            Invoke(h, "theme-system");
            Invoke(h, "rail-account");
            WaitName(h, "theme-system", "System (selected)");
            Assert.Equal("Hybrid", NameOf(h, "theme-hybrid"));
            Invoke(h, "theme-light");
            OpenSettings(h, "appearance");
            Assert.Equal("System", NameOf(h, "settings-theme-system"));
            Invoke(h, "settings-theme-system");
            WaitName(h, "settings-theme-system", "System (selected)");
            Assert.Equal("Light", NameOf(h, "settings-theme-light"));
        });

    [Fact]
    public void Accent_colour_is_chosen_in_settings() => AppHost.Run(nameof(Accent_colour_is_chosen_in_settings), h =>
    {
        OpenSettings(h, "appearance");
        Find(h, "settings-accents");
        Assert.Equal("Blue (selected)", NameOf(h, "settings-accent-blue"));
        Assert.Equal(8, h.Window.FindAllDescendants().Count(e => e.Properties.AutomationId.ValueOrDefault?.StartsWith("settings-accent-") == true));
        Invoke(h, "settings-accent-purple");
        WaitName(h, "settings-accent-purple", "Purple (selected)");
        Assert.Equal("Blue", NameOf(h, "settings-accent-blue"));
    });

    // ---- the keyboard-shortcut sheet ----

    [Fact]
    public void Shortcut_sheet_opens_from_the_account_menu_and_closes_with_Esc() => AppHost.Run(nameof(Shortcut_sheet_opens_from_the_account_menu_and_closes_with_Esc), h =>
    {
        Invoke(h, "rail-account");
        Invoke(h, "menu-shortcuts");
        Find(h, "shortcuts-sheet");
        Assert.Equal("Search: Ctrl K", NameOf(h, "shortcut-search"));
        h.Press(ESCAPE);
        AppHost.Wait(() => Gone(h, "shortcuts-sheet") ? "x" : null, "the sheet closed with Esc");
    });

    [Fact]
    public void Shortcut_sheet_opens_with_Ctrl_slash() => AppHost.Run(nameof(Shortcut_sheet_opens_with_Ctrl_slash), h =>
    {
        Retry(() => Find(h, "rail-notes").Focus());
        h.Chord(CONTROL, OEM_2);
        Find(h, "shortcuts-sheet", 8000);
        h.Press(ESCAPE);
        AppHost.Wait(() => Gone(h, "shortcuts-sheet") ? "x" : null, "the sheet closed with Esc");
    });

    // ---- the page title ----

    [Fact]
    public void Rename_a_page_by_clicking_its_title() => AppHost.Run(nameof(Rename_a_page_by_clicking_its_title), h =>
    {
        Retry(() => Find(h, "page-row-blocks").Click());
        WaitName(h, "page-title", "Blocks");
        Retry(() => Find(h, "page-title").Click());
        Find(h, "page-title-edit");
        SetText(h, "page-title-edit", "Renamed by title");
        h.Press(ENTER);
        AppHost.Wait(() => Gone(h, "page-title-edit") ? "x" : null, "the title box closed");
        WaitName(h, "page-title", "Renamed by title");
        WaitName(h, "page-row-blocks", "Renamed by title");
    });

    [Fact]
    public void Esc_keeps_the_old_title() => AppHost.Run(nameof(Esc_keeps_the_old_title), h =>
    {
        Retry(() => Find(h, "page-row-lists").Click());
        WaitName(h, "page-title", "Lists");
        Retry(() => Find(h, "page-title").Click());
        SetText(h, "page-title-edit", "Never saved");
        h.Press(ESCAPE);
        AppHost.Wait(() => Gone(h, "page-title-edit") ? "x" : null, "the title box closed");
        WaitName(h, "page-title", "Lists");
        Assert.Equal("Lists", NameOf(h, "page-row-lists"));
    });

    // ---- the offline pill ----

    [Fact]
    public void Offline_pill_shows_when_the_connection_is_lost_and_can_be_dismissed() =>
        With(new Dictionary<string, string> { ["NOTIVELO_FORCE_OFFLINE"] = "1" }, nameof(Offline_pill_shows_when_the_connection_is_lost_and_can_be_dismissed), h =>
        {
            Find(h, "offline-pill");
            Assert.Contains("Offline", NameOf(h, "offline-pill"));
            Assert.Equal("Offline", NameOf(h, "page-status"));   // the page's top bar
            Invoke(h, "offline-pill-x");
            AppHost.Wait(() => Gone(h, "offline-pill") ? "x" : null, "the pill dismissed");
        });
}
