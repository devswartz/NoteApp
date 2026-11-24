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

    private static void Run(string theme)
    {
        AppHost host;
        try { host = AppHost.Launch(new Dictionary<string, string> { ["NOTIVELO_THEME"] = theme }, 1196, 859); }   // outer size: the visible frame is then 1180 wide and 851 high (31 of it the title bar, so the client is 1180x820)
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
                    || Exists("search-input") || Exists("quickadd-card") || Exists("task-sheet") || Exists("trash-dialog") || Exists("confirm-ok"))
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
        Step("section-menu", () => { Invoke("section-more-corpus"); Find("menu-section"); Snap("section-menu"); });
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
        Step("tasks", () => { Find("rail-tasks")!.Click(); Settle(900); Snap("tasks"); });
        Step("calendar", () => { Find("rail-calendar")!.Click(); Settle(900); Snap("calendar"); });
        Step("settings", () => { OpenSettings(null); Snap("settings"); });
        Step("settings-password", () => { OpenSettings("password"); Snap("settings-password"); });
        Step("settings-notifications", () => { OpenSettings("notifications"); Snap("settings-notifications"); });
        Step("settings-apps", () => { OpenSettings("apps"); Snap("settings-apps"); });
        Step("settings-appearance", () => { OpenSettings("appearance"); Snap("settings-appearance"); });
    }
}
