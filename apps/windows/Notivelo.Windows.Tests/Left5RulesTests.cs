using Notivelo.Native;
using Notivelo.Windows.Data;
using Notivelo.Windows.Text;
using Xunit;
using Notebook = Notivelo.Windows.Data.Notebook;
using Section = Notivelo.Windows.Data.Section;
using PageSummary = Notivelo.Windows.Data.PageSummary;

namespace Notivelo.Windows.Tests;

/// <summary>left5: the highlight colour menu, inline rename, the app-menu shortcuts and opening offline from a cold start.</summary>
public class Left5RulesTests
{
    private sealed class Tasks : TaskCallbacks
    {
        public string NewId() => Guid.NewGuid().ToString();
        public void Create(string id, string title, bool done) { }
        public void Delete(string id) { }
        public bool Restore(string id) => false;
        public string? Title(string id) => null;
        public void SetTitle(string id, string title) { }
    }

    private static EditorSession Open() => EditorSession.Open(new byte[] { 0, 0 }, "default", new Tasks());

    // ---- highlight colours ----

    [Fact]
    public void The_colour_command_is_setHighlight_with_a_name_or_the_unset()
    {
        Assert.Equal(("setHighlight", "{\"color\":\"red\"}"), TextColors.Command(true, "red"));
        Assert.Equal(("unsetHighlight", "{}"), TextColors.Command(true, null));
        Assert.Equal(("setColor", "{\"color\":\"blue\"}"), TextColors.Command(false, "blue"));
        Assert.Equal(("unsetColor", "{}"), TextColors.Command(false, null));
    }

    [Fact]
    public void The_palette_is_the_webs_eight_names_and_each_has_a_highlight_colour()
    {
        Assert.Equal(new[] { "gray", "red", "orange", "yellow", "green", "blue", "purple", "pink" }, TextColors.Names);
        foreach (var n in TextColors.Names) { Assert.NotEqual(TextColors.Highlight(n, false), TextColors.Highlight(n, true)); }
    }

    [Fact]
    public void The_engine_highlights_with_a_name_and_takes_it_off()
    {
        var s = Open();
        s.InsertText("hello");
        s.SetViewSelection(0, 5);
        var (cmd, args) = TextColors.Command(true, "green");
        Assert.True(s.Command(cmd, args));
        s.SetViewSelection(1, 3);
        Assert.Contains(s.ViewRender().Active.Marks, m => m.Kind == ViewMarkKind.Highlight);
        s.SetViewSelection(0, 5);
        (cmd, args) = TextColors.Command(true, null);
        Assert.True(s.Command(cmd, args));
        s.SetViewSelection(1, 3);
        Assert.DoesNotContain(s.ViewRender().Active.Marks, m => m.Kind == ViewMarkKind.Highlight);
        Assert.Equal("hello", s.ViewState().Text.TrimEnd((char)10));
    }

    // ---- inline rename ----

    [Theory]
    [InlineData("Plan", "Roadmap", true, "Roadmap")]
    [InlineData("Plan", "  Roadmap  ", true, "Roadmap")]
    [InlineData("Plan", "Plan", true, null)]
    [InlineData("Plan", "   ", true, null)]
    [InlineData("Plan", "", true, null)]
    [InlineData("Plan", "Roadmap", false, null)]
    public void A_rename_saves_only_a_real_change_and_Esc_cancels(string current, string typed, bool save, string? saved) =>
        Assert.Equal(saved, RenameRules.Result(current, typed, save));

    // ---- app-menu shortcuts ----

    [Theory]
    [InlineData(true, false, false, 0x4E, ShellKey.NewPage)]
    [InlineData(true, true, false, 0x54, ShellKey.NewTask)]
    [InlineData(true, false, false, 0x31, ShellKey.Today)]
    [InlineData(true, false, false, 0x32, ShellKey.Upcoming)]
    [InlineData(true, false, false, 0x33, ShellKey.MyTasks)]
    [InlineData(true, false, false, 0x34, ShellKey.Team)]
    [InlineData(true, false, false, 0x35, ShellKey.AllTasks)]
    [InlineData(true, false, false, 0x36, ShellKey.Calendar)]
    [InlineData(true, false, false, 0x37, ShellKey.None)]       // the Mac menu has no 7
    [InlineData(true, false, false, 0x38, ShellKey.Notes)]
    [InlineData(true, false, false, 0x61, ShellKey.Today)]      // number pad
    [InlineData(true, false, false, 0xBC, ShellKey.Settings)]
    [InlineData(false, false, false, 0x4E, ShellKey.None)]      // a plain n is just a letter
    [InlineData(true, true, false, 0x4E, ShellKey.None)]
    [InlineData(true, false, false, 0x54, ShellKey.None)]       // Ctrl+T alone is not ours
    [InlineData(true, true, false, 0x31, ShellKey.None)]
    [InlineData(true, false, true, 0x31, ShellKey.None)]        // Ctrl+Alt+1 is a heading style in the editor
    public void The_menu_shortcuts_map_as_the_Mac_menu_does(bool ctrl, bool shift, bool alt, int vk, ShellKey expected) =>
        Assert.Equal(expected, ShellKeys.Of(ctrl, shift, alt, vk));

    private static IReadOnlyList<Notebook> Tree() => new[]
    {
        new Notebook("n1", "Work", "W", "#000", false, new[]
        {
            new Section("s1", "Inbox", "#000", new[] { new PageSummary("p1", "One", 0) }, new[] { new Section("s1a", "Sub", "#000", new[] { new PageSummary("p2", "Two", 0) }, Array.Empty<Section>()) }),
            new Section("s2", "Plans", "#000", Array.Empty<PageSummary>(), Array.Empty<Section>()),
        }),
        new Notebook("n2", "Home", "H", "#000", false, new[] { new Section("s3", "Chores", "#000", Array.Empty<PageSummary>(), Array.Empty<Section>()) }),
    };

    [Fact]
    public void A_new_page_goes_in_the_open_pages_section_else_the_shown_notebooks_first()
    {
        Assert.Equal("s1", ShellKeys.SectionForNewPage(Tree(), "n2", "p1"));
        Assert.Equal("s1a", ShellKeys.SectionForNewPage(Tree(), "n1", "p2"));
        Assert.Equal("s3", ShellKeys.SectionForNewPage(Tree(), "n2", null));
        Assert.Equal("s1", ShellKeys.SectionForNewPage(Tree(), null, "gone"));
        Assert.Null(ShellKeys.SectionForNewPage(Array.Empty<Notebook>(), null, null));
    }

    [Fact]
    public void The_shortcut_sheet_lists_the_menu_keys()
    {
        var all = ShellRules.Shortcuts.SelectMany(g => g.Items).ToList();
        Assert.Contains(all, s => s.Title == "New page" && s.Keys.SequenceEqual(new[] { "Ctrl", "N" }));
        Assert.Contains(all, s => s.Title == "Settings" && s.Keys.SequenceEqual(new[] { "Ctrl", "," }));
        Assert.Contains(all, s => s.Title == "Calendar" && s.Keys.SequenceEqual(new[] { "Ctrl", "6" }));
        Assert.Equal(all.Count, all.Select(s => s.Title).Distinct().Count());
    }

    // ---- opening offline ----

    private static readonly OfflineStart.Kept Me = new("u1", "demo@example.com", "Demo User", "#6366f1");

    [Fact]
    public void A_network_failure_with_stored_data_and_a_known_user_opens_the_shell()
    {
        var user = OfflineStart.Decide(new CoreException.Network("down"), 2, Me);
        Assert.NotNull(user);
        Assert.Equal("u1", user!.Id);
        Assert.Equal("Demo User", user.Name);
        Assert.True(user.EmailVerified);
    }

    [Fact]
    public void Anything_else_keeps_the_sign_in_screen()
    {
        Assert.Null(OfflineStart.Decide(new CoreException.Network("down"), 0, Me));          // nothing stored yet
        Assert.Null(OfflineStart.Decide(new CoreException.Network("down"), 2, null));        // who is it?
        Assert.Null(OfflineStart.Decide(new CoreException.SignedOut(), 2, Me));     // the token was refused
        Assert.Null(OfflineStart.Decide(new InvalidOperationException(), 2, Me));
    }

    [Fact]
    public void The_kept_user_round_trips_and_garbage_is_ignored()
    {
        var json = OfflineStart.Encode(new User("u1", "demo@example.com", "Demo User", "#6366f1", true));
        Assert.Equal(Me, OfflineStart.Decode(json));
        Assert.Null(OfflineStart.Decode(null));
        Assert.Null(OfflineStart.Decode("not json"));
        Assert.Null(OfflineStart.Decode("{\"Id\":\"\"}"));
    }

    [Fact]
    public void The_retry_waits_longer_each_time_up_to_a_minute_and_only_a_rejected_token_gives_up()
    {
        Assert.Equal(TimeSpan.FromSeconds(5), OfflineStart.RetryDelay(0));
        Assert.Equal(TimeSpan.FromSeconds(10), OfflineStart.RetryDelay(1));
        Assert.Equal(TimeSpan.FromSeconds(40), OfflineStart.RetryDelay(3));
        Assert.Equal(TimeSpan.FromSeconds(60), OfflineStart.RetryDelay(50));
        Assert.True(OfflineStart.GiveUp(true));
        Assert.False(OfflineStart.GiveUp(false));
    }
}
