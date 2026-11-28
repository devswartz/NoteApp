using Notivelo.Native;
using Notivelo.Windows.Data;
using Xunit;

namespace Notivelo.Windows.Tests;

/// <summary>left6: the offline start with no kept user, the tray's tooltip, menu and close rule, the global shortcut and quick capture's words.</summary>
public class Left6RulesTests
{
    // ---- opening offline with no kept user ----

    [Fact]
    public void An_install_that_signed_in_before_has_no_kept_user_and_opens_with_a_placeholder()
    {
        var user = OfflineStart.Decide(new CoreException.Network("down"), 2, null);
        Assert.NotNull(user);
        Assert.False(OfflineStart.IsKnown(user));
        Assert.Equal("", user!.Id);
        Assert.True(user.EmailVerified);
    }

    [Fact]
    public void The_placeholder_still_needs_stored_data_and_a_network_failure()
    {
        Assert.Null(OfflineStart.Decide(new CoreException.Network("down"), 0, null));
        Assert.Null(OfflineStart.Decide(new CoreException.SignedOut(), 3, null));
        Assert.Null(OfflineStart.Decide(new InvalidOperationException(), 3, null));
    }

    [Fact]
    public void A_kept_user_wins_over_the_placeholder_and_an_unverified_one_does_not_open_the_shell()
    {
        var kept = new OfflineStart.Kept("u1", "demo@example.com", "Demo User", "#6366f1");
        Assert.True(OfflineStart.IsKnown(OfflineStart.Decide(new CoreException.Network("down"), 1, kept)));
        Assert.Null(OfflineStart.Decide(new CoreException.Network("down"), 1, kept with { EmailVerified = false }));
        Assert.False(OfflineStart.IsKnown(null));
        Assert.True(OfflineStart.IsKnown(new User("u1", "demo@example.com", "Demo User", "#6366f1", true)));
    }

    // ---- the tray ----

    [Theory]
    [InlineData(0, "Notivelo: nothing due today")]
    [InlineData(1, "Notivelo: 1 task due today")]
    [InlineData(2, "Notivelo: 2 tasks due today")]
    [InlineData(12, "Notivelo: 12 tasks due today")]
    [InlineData(-4, "Notivelo: nothing due today")]
    public void The_tooltip_says_how_many_tasks_are_due_today(int count, string tip) => Assert.Equal(tip, TrayRules.Tooltip("Notivelo", count));

    [Fact]
    public void A_tooltip_is_cut_at_the_127_characters_windows_allows() =>
        Assert.Equal(127, TrayRules.Tooltip(new string('x', 200), 5).Length);

    [Fact]
    public void The_menu_is_the_tray_rs_menu_in_order()
    {
        var m = TrayRules.Menu("Notivelo", "Ctrl+Alt+N");
        Assert.Equal(new[]
        {
            TrayCommand.Open, TrayCommand.QuickCapture, TrayCommand.None, TrayCommand.Today, TrayCommand.Upcoming, TrayCommand.NewPage, TrayCommand.None, TrayCommand.Quit,
        }, m.Select(i => i.Command));
        Assert.Equal("Open Notivelo", m[0].Label);
        Assert.Equal("Quit Notivelo", m[^1].Label);
        Assert.Equal("Quick Capture…\tCtrl+Alt+N", TrayRules.Text(m[1]));
        Assert.Equal("Today", TrayRules.Text(m[3]));
        Assert.True(m[2].IsSeparator);
        Assert.False(m[0].IsSeparator);
    }

    [Fact]
    public void Tray_commands_map_to_the_shell_keys_and_to_showing_the_window()
    {
        Assert.Equal(ShellKey.Today, TrayRules.KeyOf(TrayCommand.Today));
        Assert.Equal(ShellKey.Upcoming, TrayRules.KeyOf(TrayCommand.Upcoming));
        Assert.Equal(ShellKey.NewPage, TrayRules.KeyOf(TrayCommand.NewPage));
        Assert.Equal(ShellKey.None, TrayRules.KeyOf(TrayCommand.Open));
        foreach (var c in new[] { TrayCommand.Open, TrayCommand.Today, TrayCommand.Upcoming, TrayCommand.NewPage }) Assert.True(TrayRules.ShowsMain(c));
        foreach (var c in new[] { TrayCommand.QuickCapture, TrayCommand.Quit }) Assert.False(TrayRules.ShowsMain(c));
    }

    [Theory]
    [InlineData(false, true, true)]     // closing the window: hide, keep running
    [InlineData(true, true, false)]     // Quit from the tray: really close
    [InlineData(false, false, false)]   // no tray icon to get back in by: really close
    [InlineData(true, false, false)]
    public void Closing_hides_the_window_only_while_the_tray_can_bring_it_back(bool quitting, bool tray, bool hide) =>
        Assert.Equal(hide, TrayRules.HideOnClose(quitting, tray));

    [Fact]
    public void The_readout_gives_the_count_the_tip_and_the_menu()
    {
        Assert.Equal("count=3;tip=Notivelo: 3 tasks due today;menu=open,quick,today,upcoming,newpage,quit;hotkey=ok", TrayRules.Readout(3, "Notivelo", "Ctrl+Alt+N", null));
        Assert.EndsWith("hotkey=taken", TrayRules.Readout(0, "Notivelo", "Ctrl+Alt+N", "taken"));
    }

    // ---- the global shortcut ----

    private sealed class FakeApi : IHotkeyApi
    {
        public int Error; public bool Throw; public readonly List<(int Id, Hotkey Key)> Registered = new(); public readonly List<int> Unregistered = new();
        public bool Register(int id, Hotkey key, out int error)
        {
            if (Throw) throw new InvalidOperationException();
            error = Error;
            if (Error != 0) return false;
            Registered.Add((id, key)); return true;
        }
        public void Unregister(int id) => Unregistered.Add(id);
    }

    [Theory]
    [InlineData("Ctrl+Alt+N", 3u, 0x4Eu)]
    [InlineData("Alt+CmdOrCtrl+N", 3u, 0x4Eu)]
    [InlineData("ctrl+shift+f9", 6u, 0x78u)]
    [InlineData("Win+5", 8u, 0x35u)]
    public void A_shortcut_text_becomes_modifiers_and_a_key(string text, uint mods, uint vk) => Assert.Equal(new Hotkey(mods, vk), HotkeyService.Parse(text));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("N")]                // no modifier
    [InlineData("Ctrl+Alt")]         // no key
    [InlineData("Ctrl+N+M")]         // two keys
    [InlineData("Ctrl++")]
    [InlineData("Ctrl+F13")]
    [InlineData("Ctrl+Enter")]
    public void Anything_else_is_not_a_shortcut(string? text) => Assert.Null(HotkeyService.Parse(text));

    [Fact]
    public void Registering_ctrl_alt_n_asks_windows_for_it_without_auto_repeat()
    {
        var api = new FakeApi();
        var s = new HotkeyService(api);
        Assert.Equal(HotkeyState.Registered, s.Register());
        Assert.Null(s.Problem);
        Assert.Equal(HotkeyService.Id, api.Registered.Single().Id);
        Assert.Equal(3u | 0x4000u, api.Registered.Single().Key.Modifiers);
        Assert.Equal(0x4Eu, api.Registered.Single().Key.Vk);
        Assert.True(s.Owns(HotkeyService.Id));
        Assert.False(s.Owns(99));
    }

    [Fact]
    public void A_shortcut_another_app_owns_is_reported_not_thrown()
    {
        var s = new HotkeyService(new FakeApi { Error = 1409 });
        Assert.Equal(HotkeyState.Taken, s.Register());
        Assert.Contains("used by another app", s.Problem);
        Assert.Contains("tray menu", s.Problem);
        Assert.False(s.Owns(HotkeyService.Id));
    }

    [Fact]
    public void Other_failures_and_a_throwing_api_leave_the_shortcut_off()
    {
        var failed = new HotkeyService(new FakeApi { Error = 5 });
        Assert.Equal(HotkeyState.Failed, failed.Register());
        Assert.Contains("could not be set", failed.Problem);
        Assert.Equal(HotkeyState.Failed, new HotkeyService(new FakeApi { Throw = true }).Register());
        var bad = new HotkeyService(new FakeApi(), "Ctrl+Nope");
        Assert.Equal(HotkeyState.Invalid, bad.Register());
        Assert.NotNull(bad.Problem);
    }

    [Fact]
    public void Registering_again_frees_the_first_registration_and_unregister_is_safe_twice()
    {
        var api = new FakeApi();
        var s = new HotkeyService(api);
        s.Register(); s.Register();
        Assert.Single(api.Unregistered);
        s.Unregister(); s.Unregister();
        Assert.Equal(2, api.Unregistered.Count);
        Assert.Equal(HotkeyState.NotRegistered, s.State);
    }

    [Fact]
    public void Ctrl_alt_n_is_also_an_in_app_key_and_the_other_alt_chords_stay_the_editors()
    {
        Assert.Equal(ShellKey.QuickCapture, ShellKeys.Of(true, false, true, 0x4E));
        Assert.Equal(ShellKey.None, ShellKeys.Of(true, false, true, 0x31));
        Assert.Equal(ShellKey.None, ShellKeys.Of(true, true, true, 0x4E));
        Assert.Equal(ShellKey.NewPage, ShellKeys.Of(true, false, false, 0x4E));
    }

    // ---- quick capture's words ----

    [Fact]
    public void Tab_switches_between_a_task_and_a_page_and_the_words_follow()
    {
        Assert.Equal(QuickMode.Note, QuickCaptureRules.Toggle(QuickMode.Task));
        Assert.Equal(QuickMode.Task, QuickCaptureRules.Toggle(QuickMode.Note));
        Assert.Equal("Add a task: “Send invoice tomorrow p1”", QuickCaptureRules.Placeholder(QuickMode.Task));
        Assert.Equal("New page title", QuickCaptureRules.Placeholder(QuickMode.Note));
        Assert.Equal("New task", QuickCaptureRules.Label(QuickMode.Task));
        Assert.Equal("New page", QuickCaptureRules.Label(QuickMode.Note));
        Assert.Equal("page", QuickCaptureRules.Other(QuickMode.Task));
        Assert.Equal("task", QuickCaptureRules.Other(QuickMode.Note));
        Assert.Equal("Task", QuickCaptureRules.Name(QuickMode.Task));
        Assert.Equal("mode=note;busy=1;signedout=0", QuickCaptureRules.Readout(QuickMode.Note, true, false));
    }
}
