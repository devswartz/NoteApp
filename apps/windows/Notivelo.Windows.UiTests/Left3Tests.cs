using FlaUI.Core.AutomationElements;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>The left3 batch on the offline sample: merge and split table cells from the Table tools menu, the sample viewer's caret in a box (read from the box status), and the
/// workspace screens in Settings (rename the workspace, create and rename a team, rename a tag) and the Activity feed. Every feature has a menu or keyboard path; nothing depends on a
/// drag. Written, not run, on the dev PC: they run on the CI runner only.</summary>
public class Left3Tests
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

    private static void OpenWorkspaceSettings(AppHost h, string menuId = "menu-workspace-settings")
    {
        Press(h, "rail-workspace");
        Press(h, menuId);
    }

    // ---- tables ----

    [Fact]
    public void Cells_merge_and_split_from_the_Table_tools_menu() => AppHost.Run(nameof(Cells_merge_and_split_from_the_Table_tools_menu), h =>
    {
        h.B.Focus();
        Press(h, "ribbon-table");
        h.B.WaitMedia("tables", v => v == "3x3", "a 3x3 table");
        h.B.WaitMedia("merged", v => v == "0", "no merged cells yet");
        Press(h, "ribbon-table-tools");
        Press(h, "table-merge-cells");                       // the caret is in the first cell: it merges with the cell on its right
        h.B.WaitMedia("merged", v => v == "1", "one merged cell");
        h.B.WaitMedia("tstate", v => v.Contains('S'), "split offered on the merged cell");
        Press(h, "ribbon-table-tools");
        Press(h, "table-split-cell");
        h.B.WaitMedia("merged", v => v == "0", "the cell split again");
    });

    [Fact]
    public void A_cell_merges_with_the_cell_below() => AppHost.Run(nameof(A_cell_merges_with_the_cell_below), h =>
    {
        h.B.Focus();
        Press(h, "ribbon-table");
        h.B.WaitMedia("tables", v => v == "3x3", "a 3x3 table");
        Press(h, "ribbon-table-tools");
        Press(h, "table-merge-with-cell-below");
        h.B.WaitMedia("merged", v => v == "1", "one merged cell");
    });

    // ---- carets ----

    [Fact]
    public void The_sample_viewer_has_a_caret_in_the_second_box() => AppHost.Run(nameof(The_sample_viewer_has_a_caret_in_the_second_box), h =>
    {
        h.B.WaitMedia("remote", v => v.StartsWith("Sample Viewer@"), "the sample viewer's caret");
        Assert.Equal("", h.A.Media("remote"));               // box a has nobody in it
    });

    // ---- workspace settings ----

    [Fact]
    public void The_workspace_is_renamed_in_Settings() => AppHost.Run(nameof(The_workspace_is_renamed_in_Settings), h =>
    {
        OpenWorkspaceSettings(h);
        Retry(() => Find(h, "ws-name").AsTextBox().Text = "Choir office");
        Press(h, "ws-rename");
        AppHost.Wait(() => Find(h, "ws-name").AsTextBox().Text == "Choir office" && !Find(h, "ws-rename").IsEnabled ? "x" : null, "the new name saved");
        Assert.Contains("owner", Find(h, "ws-role").Properties.Name.ValueOrDefault ?? "");
    });

    [Fact]
    public void A_new_workspace_is_made_from_the_workspace_menu() => AppHost.Run(nameof(A_new_workspace_is_made_from_the_workspace_menu), h =>
    {
        Press(h, "rail-workspace");
        Press(h, "menu-new-workspace");
        Retry(() => Find(h, "prompt-input").AsTextBox().Text = "Youth group");
        Press(h, "prompt-ok");
        OpenWorkspaceSettings(h);
        AppHost.Wait(() => Find(h, "ws-name").AsTextBox().Text == "Youth group" ? "x" : null, "the new workspace open");
    });

    [Fact]
    public void A_team_is_created_and_renamed() => AppHost.Run(nameof(A_team_is_created_and_renamed), h =>
    {
        OpenWorkspaceSettings(h);
        Press(h, "settings-section-ws-teams");
        Find(h, "team-row-staff");
        Press(h, "team-new");
        Retry(() => Find(h, "prompt-input").AsTextBox().Text = "Choir");
        Press(h, "prompt-ok");
        Find(h, "team-row-choir");
        Press(h, "team-rename-choir");
        Retry(() => Find(h, "prompt-input").AsTextBox().Text = "Singers");
        Press(h, "prompt-ok");
        Find(h, "team-row-singers");
        Assert.True(Gone(h, "team-row-choir"));
    });

    [Fact]
    public void A_team_takes_a_member_from_its_Members_menu() => AppHost.Run(nameof(A_team_takes_a_member_from_its_Members_menu), h =>
    {
        OpenWorkspaceSettings(h);
        Press(h, "settings-section-ws-teams");
        Find(h, "team-row-design");
        Press(h, "team-members-design");
        Press(h, "team-member-design-priya-nair");
        AppHost.Wait(() => (Find(h, "team-row-design").Properties.Name.ValueOrDefault ?? "").Contains("Priya Nair") ? "x" : null, "Priya Nair in the team");
    });

    [Fact]
    public void A_tag_is_renamed_in_Settings() => AppHost.Run(nameof(A_tag_is_renamed_in_Settings), h =>
    {
        OpenWorkspaceSettings(h);
        Press(h, "settings-section-ws-tags");
        Find(h, "tag-row-launch");
        Press(h, "tag-rename-launch");
        Retry(() => Find(h, "prompt-input").AsTextBox().Text = "release");
        Press(h, "prompt-ok");
        Find(h, "tag-row-release");
        Assert.True(Gone(h, "tag-row-launch"));
    });

    [Fact]
    public void A_tag_changes_colour_and_is_deleted() => AppHost.Run(nameof(A_tag_changes_colour_and_is_deleted), h =>
    {
        OpenWorkspaceSettings(h);
        Press(h, "settings-section-ws-tags");
        Press(h, "tag-color-docs");
        Press(h, "tag-color-docs-22c55e");
        AppHost.Wait(() => (Find(h, "tag-row-docs").Properties.Name.ValueOrDefault ?? "").Contains("#22c55e") ? "x" : null, "the new colour");
        Press(h, "tag-delete-docs");
        Press(h, "confirm-ok");
        Assert.True(Gone(h, "tag-row-docs"));
    });

    // ---- activity ----

    [Fact]
    public void Activity_opens_from_the_workspace_menu() => AppHost.Run(nameof(Activity_opens_from_the_workspace_menu), h =>
    {
        OpenWorkspaceSettings(h, "menu-activity");
        AppHost.Wait(() => (Find(h, "activity-list").Properties.ItemStatus.ValueOrDefault ?? "").StartsWith("entries=3") ? "x" : null, "three activity lines");
        Find(h, "activity-12");
    });
}
