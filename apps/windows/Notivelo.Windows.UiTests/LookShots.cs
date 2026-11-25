using FlaUI.Core.AutomationElements;
using FlaUI.Core.Capturing;
using System.Drawing;
using System.Runtime.InteropServices;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>Screenshots of every screen for the look comparison (artifact windows-look-screenshots): the offline sample data, the app window (client 1180x820 under the title bar), once per theme.
/// Files are <c>screen-theme.png</c> in LOOK_SHOTS. Never fails: a screen that can't be opened is logged to look-log.txt and skipped.</summary>
public class LookShots
{
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out Rect rect, int size);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }

    private static string Dir => Environment.GetEnvironmentVariable("LOOK_SHOTS") is { Length: > 0 } d ? d : Path.Combine(Path.GetTempPath(), "look-shots");

    private static void Log(string line)
    {
        try { Directory.CreateDirectory(Dir); File.AppendAllText(Path.Combine(Dir, "look-log.txt"), line + Environment.NewLine); } catch { }
    }

    [Fact] public void Light() => Run("light");
    [Fact] public void Hybrid() => Run("hybrid");

    /// <summary>The signed-out screens (no server: NOTIVELO_SOURCE=signup): sign in, create account (empty form, then a problem shown), check your email.</summary>
    [Fact]
    public void Auth()
    {
        AppHost host;
        try { host = AppHost.Launch(new Dictionary<string, string> { ["NOTIVELO_SOURCE"] = "signup" }, 1196, 859); }
        catch (Exception e) { Log($"[auth] launch failed: {e.Message}"); return; }
        using var h = host;
        var w = h.Window;
        AutomationElement? Find(string id, int ms = 8000)
        {
            try { return AppHost.Wait(() => w.FindFirstDescendant(w.ConditionFactory.ByAutomationId(id)), id, ms); } catch (TimeoutException) { return null; }
        }
        void Invoke(string id) { var e = Find(id) ?? throw new InvalidOperationException("no element " + id); if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke(); else e.Click(); }
        void Snap(string name)
        {
            Thread.Sleep(600);
            try
            {
                Directory.CreateDirectory(Dir);
                var file = Path.Combine(Dir, $"{name}-dark.png");
                if (DwmGetWindowAttribute(w.Properties.NativeWindowHandle.Value, 9, out var fr, Marshal.SizeOf<Rect>()) == 0 && fr.Right > fr.Left)
                    Capture.Rectangle(new Rectangle(fr.Left, fr.Top, fr.Right - fr.Left, fr.Bottom - fr.Top)).ToFile(file);
                else Capture.Element(w).ToFile(file);
            }
            catch (Exception e) { Log($"[auth] {name}: capture failed: {e.Message}"); }
        }
        try
        {
            Find("signin"); Snap("sign-in");
            Invoke("signin-toggle-mode"); Find("signup"); Snap("sign-up");
            Invoke("signin-submit"); Find("signin-error"); Snap("sign-up-problem");
            Find("signup-name")!.AsTextBox().Text = "Demo User"; Find("signin-email")!.AsTextBox().Text = "demo@example.com"; Find("signin-password")!.Focus(); h.Type("correct horse");
            Invoke("signin-submit"); Find("check-email"); Snap("check-email");
        }
        catch (Exception e) { Log($"[auth] {e.GetType().Name}: {e.Message}"); }
    }

    /// <summary>The offline pill: the sample reports a lost connection from the start (NOTIVELO_FORCE_OFFLINE), so the page's top bar says Offline and the pill shows at the bottom.</summary>
    [Fact]
    public void OfflinePill()
    {
        AppHost host;
        try { host = AppHost.Launch(new Dictionary<string, string> { ["NOTIVELO_FORCE_OFFLINE"] = "1", ["NOTIVELO_THEME"] = "hybrid" }, 1196, 859); }
        catch (Exception e) { Log($"[offline] launch failed: {e.Message}"); return; }
        using var h = host;
        var w = h.Window;
        try
        {
            AppHost.Wait(() => w.FindFirstDescendant(w.ConditionFactory.ByAutomationId("offline-pill")), "offline-pill", 8000);
            Thread.Sleep(600);
            Directory.CreateDirectory(Dir);
            var file = Path.Combine(Dir, "offline-pill-hybrid.png");
            if (DwmGetWindowAttribute(w.Properties.NativeWindowHandle.Value, 9, out var fr, Marshal.SizeOf<Rect>()) == 0 && fr.Right > fr.Left)
                Capture.Rectangle(new Rectangle(fr.Left, fr.Top, fr.Right - fr.Left, fr.Bottom - fr.Top)).ToFile(file);
            else Capture.Element(w).ToFile(file);
        }
        catch (Exception e) { Log($"[offline] {e.GetType().Name}: {e.Message}"); }
    }

    private static void Run(string theme)
    {
        AppHost host;
        // the open dialog is replaced by these files in the offline test mode: a picture and a document (the media step picks both)
        var pick = new Dictionary<string, string> { ["NOTIVELO_THEME"] = theme };
        try { foreach (var kv in TestMedia.Pick(TestMedia.WritePng("Team offsite.png", 320, 180), TestMedia.WriteFile("Quarterly report.pdf", 1_258_291))) pick[kv.Key] = kv.Value; } catch { }
        try { host = AppHost.Launch(pick, 1196, 859); }   // outer size: the visible frame is then 1180 wide and 851 high (31 of it the title bar, so the client is 1180x820)
        catch (Exception e) { Log($"[{theme}] launch failed: {e.Message}"); return; }
        using var h = host;
        var w = h.Window;

        AutomationElement? Find(string id, int ms = 6000)
        {
            try { return AppHost.Wait(() => w.FindFirstDescendant(w.ConditionFactory.ByAutomationId(id)), id, ms); } catch (TimeoutException) { return null; }
        }
        bool Exists(string id) => w.FindFirstDescendant(w.ConditionFactory.ByAutomationId(id)) is not null;
        void Invoke(string id)
        {
            var e = Find(id) ?? throw new InvalidOperationException("no element " + id);
            if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke(); else e.Click();
        }
        void Settle(int ms = 500) => Thread.Sleep(ms);
        void Snap(string name)
        {
            Settle();
            try
            {
                Directory.CreateDirectory(Dir);
                // the visible frame only (DWM extended bounds), not the invisible resize border that GetWindowRect adds
                var file = Path.Combine(Dir, $"{name}-{theme}.png");
                if (DwmGetWindowAttribute(w.Properties.NativeWindowHandle.Value, 9, out var fr, Marshal.SizeOf<Rect>()) == 0 && fr.Right > fr.Left)
                    Capture.Rectangle(new Rectangle(fr.Left, fr.Top, fr.Right - fr.Left, fr.Bottom - fr.Top)).ToFile(file);
                else Capture.Element(w).ToFile(file);
            }
            catch (Exception e) { Log($"[{theme}] {name}: capture failed: {e.Message}"); }
        }
        // back to the Notes view with nothing open on top
        void Reset()
        {
            for (var i = 0; i < 2; i++)
            {
                try { h.Press(ESCAPE); } catch { }
                Settle(200);
            }
            try
            {
                var r = w.BoundingRectangle;       // a click on the scrim at the window's bottom right closes what Escape didn't
                if (Exists("menu-account") || Exists("menu-workspace") || Exists("menu-section") || Exists("menu-notebook-picker") || Exists("prompt-input")
                    || Exists("search-input") || Exists("quickadd-card") || Exists("task-sheet") || Exists("trash-dialog") || Exists("confirm-ok")
                    || Exists("version-dialog") || Exists("members-dialog") || Exists("join-dialog") || Exists("share-dialog") || Exists("icon-picker") || Exists("lock-dialog") || Exists("menu-page") || Exists("shortcuts-sheet") || Exists("notebook-share-dialog") || Exists("menu-notebook") || Exists("inbox-popover") || Exists("delete-account-dialog") || Exists("menu-priority") || Exists("menu-saved-views") || Exists("menu-view") || Exists("menu-block") || Exists("menu-outline") || Exists("bulk-date-menu"))
                    FlaUI.Core.Input.Mouse.Click(new System.Drawing.Point((int)r.Right - 12, (int)r.Bottom - 12));
            }
            catch { }
            try { Find("rail-notes", 3000)?.Click(); } catch { }
            Settle(300);
        }
        void Step(string name, Action body)
        {
            try { body(); }
            catch (Exception e) { Log($"[{theme}] {name}: {e.GetType().Name}: {e.Message}"); }
            try { Reset(); } catch (Exception e) { Log($"[{theme}] {name}: reset: {e.Message}"); }
        }
        void OpenSettings(string? section)
        {
            Invoke("rail-account"); Find("menu-account"); Invoke("menu-settings");
            Find("settings-root");
            if (section is not null) { Invoke("settings-section-" + section); Settle(900); }
        }

        Step("canvas-unfocused", () => { _ = h.A.State; Snap("canvas-unfocused"); });
        Step("canvas-focused", () => { h.A.Focus(); h.Type("Meeting notes"); Snap("canvas-focused"); });
        Step("page-media", () =>   // a picture and a file card in the second box (the picker hook returns both), the picture selected with its handles
        {
            h.B.Focus(); Invoke("ribbon-picture"); h.B.WaitMedia("images", v => v == "loaded", "the picture drawn"); h.B.WaitMedia("files", v => v.Length > 0, "the file card"); Settle(600);
            var r = h.B.Bounds; FlaUI.Core.Input.Mouse.Click(new System.Drawing.Point(r.Left + 80, r.Top + 80)); Settle(500);
            Snap("page-media");
        });
        Step("outline", () =>   // headings in box a, the list open under the ribbon's Outline button
        {
            h.A.Focus(); h.Press(ENTER); Invoke("ribbon-block-type"); Invoke("block-heading-1"); h.Type("Agenda"); h.Press(ENTER); h.Type("Short notes on the agenda"); h.Press(ENTER);
            Invoke("ribbon-block-type"); Invoke("block-heading-2"); h.Type("Decisions"); h.Press(ENTER);
            Invoke("ribbon-block-type"); Invoke("block-heading-2"); h.Type("Next steps"); Settle(700);
            Invoke("ribbon-outline"); Find("menu-outline"); Settle(400); Snap("outline");
        });
        Step("block-menu", () => { h.A.Focus(); Settle(400); Invoke("block-handle"); Find("menu-block"); Settle(400); Snap("block-menu"); });
        Step("backlinks", () => { Invoke("page-links-button"); Find("backlink-canvas"); Settle(700); Snap("backlinks"); try { Invoke("page-tasks-close"); } catch (Exception) { } });
        Step("page-canvas", () => { Invoke("page-row-canvas"); Settle(900); Snap("page-canvas"); });
        Step("page-ink", () => { Invoke("page-row-settings-ink"); Settle(900); Snap("page-ink"); });
        Step("ink-toolbar", () =>   // the pen row open over the ink page (pen chosen: colours and widths show)
        {
            Invoke("page-row-settings-ink"); Settle(900); Invoke("ribbon-draw"); Find("ink-tool-pen"); Settle(700); Snap("ink-toolbar");
            try { Invoke("ink-close"); } catch (Exception) { }
        });
        Step("workspace-menu", () => { Invoke("rail-workspace"); Find("menu-workspace"); Snap("workspace-menu"); });
        Step("notebook-picker", () => { Invoke("notebook-picker"); Find("menu-notebook-picker"); Snap("notebook-picker"); });
        Step("account-menu", () => { Invoke("rail-account"); Find("menu-account"); Snap("account-menu"); });
        Step("section-menu", () => { Invoke("section-more-corpus"); Find("menu-section"); Snap("section-menu"); });   // with the colour row
        Step("template-picker", () => { Invoke("section-more-empty"); Find("menu-section"); Invoke("menu-new-from-template"); Find("template-meeting-notes"); Settle(700); Snap("template-picker"); });
        Step("box-selected", () =>   // box b selected as a whole (Esc inside it): accent frame, move bar and width handle
        {
            h.B.Focus(); h.Press(ESCAPE); Settle(500); Snap("box-selected");
            var r = h.B.Bounds; FlaUI.Core.Input.Mouse.RightClick(new System.Drawing.Point(r.Left + 120, r.Top - 4));
            Find("menu-box"); Settle(400); Snap("box-menu");
        });
        Step("table", () =>   // a table inserted by the ribbon's Table button into box b, a row added; undone after the shot so the shots after it see the same page
        {
            h.B.Focus(); Invoke("ribbon-table"); h.B.WaitMedia("tables", v => v == "3x3", "a 3x3 table"); Invoke("ribbon-add-row"); h.B.WaitMedia("tables", v => v == "4x3", "a fourth row"); Settle(700); Snap("table");
            Invoke("ribbon-table-tools"); Find("table-delete-table"); Settle(400); Snap("table-menu");
        });
        Step("table-undo", () => { h.B.Focus(); for (var i = 0; i < 2; i++) { h.Chord(CONTROL, KEY_Z); Settle(150); } });
        Step("remote-caret", () => { h.B.WaitMedia("remote", v => v.StartsWith("Sample Viewer@"), "the sample viewer's caret"); Settle(500); Snap("remote-caret"); });   // a coloured caret with a name flag in box b
        Step("table-merged", () =>   // a table with two header cells merged (the caret's cell with its right neighbour), undone after the shot
        {
            h.B.Focus(); Invoke("ribbon-table"); h.B.WaitMedia("tables", v => v == "3x3", "a 3x3 table"); Invoke("ribbon-table-tools"); Invoke("table-merge-cells");
            h.B.WaitMedia("merged", v => v == "1", "a merged cell"); Settle(700); Snap("table-merged");
            h.B.Focus(); for (var i = 0; i < 2; i++) { h.Chord(CONTROL, KEY_Z); Settle(150); }
        });
        Step("workspace-settings", () => { Invoke("rail-workspace"); Find("menu-workspace"); Invoke("menu-workspace-settings"); Find("settings-root"); Settle(900); Snap("workspace-settings"); });
        Step("workspace-teams", () => { Invoke("rail-workspace"); Find("menu-workspace"); Invoke("menu-workspace-settings"); Find("settings-root"); Invoke("settings-section-ws-teams"); Find("team-row-staff"); Settle(700); Snap("workspace-teams"); });
        Step("workspace-tags", () => { Invoke("rail-workspace"); Find("menu-workspace"); Invoke("menu-workspace-settings"); Find("settings-root"); Invoke("settings-section-ws-tags"); Find("tag-row-launch"); Settle(700); Snap("workspace-tags"); });
        Step("activity", () => { Invoke("rail-workspace"); Find("menu-workspace"); Invoke("menu-activity"); Find("activity-list"); Settle(900); Snap("activity"); });
        Step("presence-list", () => { Invoke("page-presence"); Find("menu-presence"); Find("presence-sample-viewer"); Settle(500); Snap("presence-list"); });
        Step("notebook-menu", () => { Invoke("notebook-more"); Find("menu-notebook"); Snap("notebook-menu"); });
        Step("shortcut-sheet", () => { Invoke("rail-account"); Find("menu-account"); Invoke("menu-shortcuts"); Find("shortcuts-sheet"); Settle(500); Snap("shortcut-sheet"); });
        Step("notebook-share", () =>
        {
            Invoke("notebook-more"); Invoke("menu-notebook-share"); Find("notebook-share-dialog");
            Invoke("nbshare-private"); Find("nbshare-member-u2"); Invoke("nbshare-member-u2"); Settle(700); Snap("notebook-share");
        });
        Step("quick-add", () => {   // the Add task row is in the Tasks panel
            Find("rail-tasks")!.Click(); Settle(700); Invoke("sidebar-add-task"); Find("quickadd-card"); Snap("quick-add"); });
        Step("search-palette", () =>
        {
            Invoke("rail-search"); Find("search-input")!.AsTextBox().Text = "launch"; Settle(900); Snap("search-palette");
        });
        Step("task-sheet", () =>
        {
            Invoke("rail-search"); Find("search-input")!.AsTextBox().Text = "launch"; Settle(900);
            Invoke("search-result-task-t-launch"); Find("task-sheet"); Snap("task-sheet");
        });
        Step("task-sheet-full", () =>   // every field of the sheet filled: due, repeat, tags, a reminder and a subtask (page-tasks-panel is the page's task panel)
        {
            Invoke("rail-search"); Find("search-input")!.AsTextBox().Text = "launch"; Settle(900);
            Invoke("search-result-task-t-launch"); Find("task-sheet");
            Invoke("task-sheet-due"); Invoke("pick-due-tomorrow"); Settle(300);
            Invoke("task-sheet-repeat"); Invoke("pick-repeat-2"); Settle(300);
            Invoke("task-sheet-tags"); Invoke("pick-tag-launch"); h.Press(ESCAPE); Settle(300);
            Invoke("task-sheet-add-reminder"); Invoke("pick-reminder-60"); Settle(300);
            var sub = Find("task-sheet-subtask-input")!; sub.AsTextBox().Text = "Draft the announcement"; sub.Focus(); h.Press(ENTER); Settle(500);
            Snap("task-sheet-full");
        });
        Step("page-tasks-panel", () =>
        {
            Invoke("page-row-tasks"); Settle(900); Invoke("page-tasks-button"); Find("page-tasks-panel"); Settle(500); Snap("page-tasks-panel");
            try { Invoke("page-tasks-close"); } catch (Exception) { }
        });
        Step("trash-dialog", () => { Invoke("rail-workspace"); Invoke("menu-trash"); Find("trash-dialog"); Snap("trash-dialog"); });
        Step("name-dialog", () => { Invoke("page-more-blocks"); Invoke("menu-rename"); Find("prompt-input"); Snap("name-dialog"); });
        // page tools (PARITY batch 2): the comments panel, version history, share, the page menu, the icon picker, the lock dialog and the locked page
        Step("page-comments", () =>
        {
            Invoke("page-row-canvas"); Settle(900); Invoke("page-comments-button"); Find("comments-panel"); Settle(700); Snap("page-comments");
            try { Invoke("page-tasks-close"); } catch (Exception) { }
        });
        Step("version-history", () => { Invoke("page-row-canvas"); Settle(700); Invoke("page-options"); Invoke("menu-version-history"); Find("version-dialog"); Settle(900); Snap("version-history"); });
        Step("share-dialog", () => { Invoke("page-row-canvas"); Settle(700); Invoke("page-share"); Find("share-dialog"); Settle(900); Snap("share-dialog"); });
        Step("page-menu", () => { Invoke("page-row-canvas"); Settle(700); Invoke("page-options"); Find("menu-page"); Snap("page-menu"); });
        Step("icon-picker", () => { Invoke("page-row-canvas"); Settle(700); Invoke("page-options"); Invoke("menu-page-icon"); Find("icon-picker"); Settle(500); Snap("icon-picker"); });
        Step("page-icon", () => { Invoke("page-row-canvas"); Settle(700); Invoke("page-options"); Invoke("menu-page-icon"); Invoke("icon-pick-14"); Settle(900); Snap("page-icon"); });
        Step("lock-dialog", () => { Invoke("page-row-sandbox"); Settle(700); Invoke("page-options"); Invoke("menu-lock-page"); Find("lock-dialog"); Settle(500); Snap("lock-dialog"); });
        Step("locked-page", () =>
        {
            Invoke("page-row-sandbox"); Settle(700); Invoke("page-options"); Invoke("menu-lock-page"); Find("lock-dialog");
            h.Type("secret1"); h.Press(TAB); h.Type("secret1"); Settle(300); Invoke("lock-ok"); Settle(900);
            Invoke("page-options"); Invoke("menu-lock-now"); Find("locked-page"); Settle(700); Snap("locked-page");
        });
        // people (PARITY batch 3): the workspace menu with Members and Join with invite link, the Members dialog (roles, pending invites, a link made) and the join dialog
        Step("members", () => { Invoke("rail-workspace"); Invoke("menu-members"); Find("members-dialog"); Settle(900); Snap("members"); });
        Step("members-invite", () =>
        {
            Invoke("rail-workspace"); Invoke("menu-members"); Find("members-dialog"); Settle(500);
            Find("members-invite-email")!.AsTextBox().Text = "casey@example.com"; Settle(300); Invoke("members-invite-submit"); Find("members-invite-url"); Settle(700); Snap("members-invite");
        });
        Step("join-invite", () =>
        {
            Invoke("rail-workspace"); Invoke("menu-join-invite"); Find("join-dialog");
            Find("join-input")!.AsTextBox().Text = "https://app.example.com/invite/sample-invite"; Settle(300); Invoke("join-continue"); Find("join-info"); Settle(700); Snap("join-invite");
        });
        Step("tasks", () => { Find("rail-tasks")!.Click(); Settle(900); Snap("tasks"); });
        Step("tasks-filters", () =>   // All tasks with a priority and an assignee filter on: the count, the conditions in words and the pressed ribbon buttons
        {
            Find("rail-tasks")!.Click(); Settle(500); Invoke("ribbon-all-tasks"); Settle(500);
            Invoke("ribbon-priority"); Find("menu-priority"); Snap("tasks-filter-menu"); Invoke("menu-priority-2"); Settle(500);
            Invoke("ribbon-assignee"); Invoke("menu-assignee-me"); Settle(800); Snap("tasks-filters");
            Invoke("ribbon-clear-filters"); Settle(300);
        });
        Step("notifications", () => { Invoke("rail-bell"); Find("inbox-popover"); Find("inbox-item-n1"); Settle(700); Snap("notifications"); });
        Step("share-link", () => { Invoke("page-row-canvas"); Settle(700); Invoke("page-share"); Find("share-dialog"); Invoke("share-link-create"); Find("share-link-url"); Settle(700); Snap("share-link"); });
        Step("delete-account", () => { OpenSettings(null); Invoke("settings-delete-account"); Find("delete-account-dialog"); Find("delete-account-preview"); Settle(900); Snap("delete-account"); });
        Step("calendar", () => { Find("rail-calendar")!.Click(); Settle(900); Snap("calendar"); });
        Step("settings", () => { OpenSettings(null); Snap("settings"); });
        Step("settings-password", () => { OpenSettings("password"); Snap("settings-password"); });
        Step("settings-notifications", () => { OpenSettings("notifications"); Snap("settings-notifications"); });
        Step("settings-apps", () => { OpenSettings("apps"); Snap("settings-apps"); });
        Step("settings-appearance", () => { OpenSettings("appearance"); Snap("settings-appearance"); });
        Step("settings-accent", () => { OpenSettings("appearance"); Invoke("settings-accent-teal"); Settle(500); Snap("settings-accent"); Invoke("settings-accent-blue"); });
        Step("template-empty-page", () =>   // a new, blank page: the strip offers the templates; then one is used and "Start blank" shows
        {
            Invoke("section-more-empty"); Find("menu-section"); Invoke("menu-new-page"); Find("empty-template-more"); Settle(900); Snap("template-empty-page");
            Invoke("empty-template-meeting-notes"); Find("page-start-blank"); Settle(900); Snap("template-applied");
        });
        Step("template-manager", () => { Invoke("section-more-empty"); Find("menu-section"); Invoke("menu-manage-templates"); Find("template-rename-weekly-review"); Settle(600); Snap("template-manager"); });
        Step("default-template", () => { Invoke("section-more-empty"); Find("menu-section"); Invoke("menu-default-template"); Find("default-template-inherit"); Settle(600); Snap("default-template"); });
        // left4: saved views (the sidebar list, the ribbon's menu, a view opened), the bulk bar and its date menu, the outline list, the block menu, the Linked tab
        Step("saved-views", () =>
        {
            Find("rail-tasks")!.Click(); Settle(500); Invoke("ribbon-all-tasks"); Settle(500);
            Invoke("ribbon-saved-views"); Find("menu-saved-views"); Settle(400); Snap("saved-views-menu");
            Invoke("menu-view-view-urgent"); Find("tasks-view-name"); Settle(800); Snap("saved-views");
            Invoke("ribbon-clear-filters"); Settle(300);
        });
        Step("bulk-bar", () =>
        {
            Find("rail-tasks")!.Click(); Settle(500); Invoke("ribbon-all-tasks"); Settle(500);
            Invoke("tasks-select"); Find("bulk-bar"); Invoke("task-select-t-launch"); Invoke("task-select-t-welcome"); Settle(700); Snap("bulk-bar");
            Invoke("bulk-date"); Find("bulk-date-menu"); Settle(400); Snap("bulk-date-menu");
            h.Press(ESCAPE); Settle(300);
            try { Invoke("bulk-done"); } catch (Exception) { }
        });
    }
}
