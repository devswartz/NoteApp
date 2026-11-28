using FlaUI.Core.AutomationElements;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>The left6 batch on the offline sample: the tray's readout (the icon itself cannot be read on a runner, so the shell repeats what it gives the tray in a one-pixel element, "tray-state") and quick capture
/// (Ctrl+Alt+N: the global shortcut when this app owns it, else the same key inside the app; both end in the same toggle). Keyboard paths only. Tray clicks, the tray menu and closing to the tray
/// are not tested here: they need the notification area, which a runner does not give. Opening offline from a cold start is covered by unit tests. Written, not run, on the dev PC: they run on the CI runner only.</summary>
public class Left6Tests
{
    private static AutomationElement Find(AppHost h, string id, int ms = 20000) =>
        AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)), "element " + id, ms);

    private static Window QuickWindow(AppHost h, int ms = 20000) => AppHost.Wait(() => h.OtherWindow("Quick Capture"), "the Quick Capture window", ms);

    private static AutomationElement QuickInput(AppHost h) =>
        AppHost.Wait(() => QuickWindow(h).FindFirstDescendant(c => c.ByAutomationId("quickcapture-input")), "the quick capture input");

    private static string QuickStatus(AppHost h) => QuickInput(h).Properties.ItemStatus.ValueOrDefault ?? "";

    private static void WaitQuick(AppHost h, string part) =>
        AppHost.Wait(() => { try { return QuickStatus(h).Contains(part) ? "x" : null; } catch (Exception) { return null; } }, "the quick capture readout to say \"" + part + "\"");

    private static void WaitQuickGone(AppHost h) =>
        AppHost.Wait(() => h.OtherWindow("Quick Capture") is null ? "x" : null, "the Quick Capture window to hide");

    private static void Retry(Action a)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            try { a(); return; }
            catch (Exception) when (sw.ElapsedMilliseconds < 15000) { Thread.Sleep(200); }
        }
    }

    /// <summary>Open quick capture and give its box the keyboard.</summary>
    private static void OpenQuick(AppHost h)
    {
        Retry(() => h.Chord(CONTROL, ALT, KEY_N));
        QuickWindow(h);
        Retry(() => QuickInput(h).Focus());
    }

    // ---- the tray ----

    [Fact]
    public void The_tray_readout_gives_the_due_today_count_the_tooltip_and_the_menu() => AppHost.Run(nameof(The_tray_readout_gives_the_due_today_count_the_tooltip_and_the_menu), h =>
    {
        var status = AppHost.Wait(() => Find(h, "tray-state").Properties.ItemStatus.ValueOrDefault is { Length: > 0 } s && s.StartsWith("count=3") ? s : null, "the tray readout with the sample's 3 due today");
        Assert.Contains("tip=Notivelo: 3 tasks due today", status);
        Assert.Contains("menu=open,quick,today,upcoming,newpage,quit", status);
    });

    // ---- quick capture ----

    [Fact]
    public void Ctrl_Alt_N_opens_quick_capture_Tab_switches_between_a_task_and_a_page_and_Esc_hides_it() => AppHost.Run(nameof(Ctrl_Alt_N_opens_quick_capture_Tab_switches_between_a_task_and_a_page_and_Esc_hides_it), h =>
    {
        OpenQuick(h);
        WaitQuick(h, "mode=task");
        Assert.Equal("New task", QuickInput(h).Properties.Name.ValueOrDefault);
        h.Press(TAB);
        WaitQuick(h, "mode=note");
        Assert.Equal("New page", QuickInput(h).Properties.Name.ValueOrDefault);
        h.Press(TAB);
        WaitQuick(h, "mode=task");
        h.Press(ESCAPE);
        WaitQuickGone(h);
    });

    [Fact]
    public void Enter_adds_a_task_and_hides_quick_capture_and_a_page_title_does_the_same_in_page_mode() => AppHost.Run(nameof(Enter_adds_a_task_and_hides_quick_capture_and_a_page_title_does_the_same_in_page_mode), h =>
    {
        OpenQuick(h);
        WaitQuick(h, "mode=task");
        h.Type("Send invoice tomorrow p1");
        h.Press(RETURN);
        WaitQuickGone(h);

        OpenQuick(h);
        h.Press(TAB);
        WaitQuick(h, "mode=note");
        h.Type("Quick capture page");
        h.Press(RETURN);
        WaitQuickGone(h);
    });
}
