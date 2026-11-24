using Notivelo.Windows.Data;
using Xunit;

namespace Notivelo.Windows.Tests;

public class ShellRulesTests
{
    [Theory]
    [InlineData(ThemeMode.System, true, ThemeMode.Dark)]
    [InlineData(ThemeMode.System, false, ThemeMode.Light)]
    [InlineData(ThemeMode.Hybrid, true, ThemeMode.Hybrid)]
    [InlineData(ThemeMode.Light, true, ThemeMode.Light)]
    [InlineData(ThemeMode.Dark, false, ThemeMode.Dark)]
    public void System_theme_follows_windows_and_the_rest_stay(ThemeMode mode, bool systemDark, ThemeMode shown) => Assert.Equal(shown, ShellRules.Resolve(mode, systemDark));

    [Fact]
    public void Theme_names_round_trip_and_unknown_ones_fall_back()
    {
        foreach (var m in Enum.GetValues<ThemeMode>()) Assert.Equal(m, ShellRules.ParseTheme(ShellRules.ThemeKey(m), ThemeMode.Hybrid));
        Assert.Equal(ThemeMode.Hybrid, ShellRules.ParseTheme(null, ThemeMode.Hybrid));
        Assert.Equal(ThemeMode.Light, ShellRules.ParseTheme("nonsense", ThemeMode.Light));
    }

    [Fact]
    public void There_are_eight_accents_and_unknown_keys_give_blue()
    {
        Assert.Equal(8, ShellRules.Accents.Count);
        Assert.Equal(8, ShellRules.Accents.Select(a => a.Key).Distinct().Count());
        Assert.Equal("blue", ShellRules.AccentOf(null).Key);
        Assert.Equal("blue", ShellRules.AccentOf("magenta").Key);
        Assert.Equal("teal", ShellRules.AccentOf("TEAL").Key);
        // Apple's sets: pink on light surfaces is #be185d, on dark #f472b6
        Assert.Equal(0xBE185Du, ShellRules.AccentOf("pink").Light.Accent);
        Assert.Equal(0xF472B6u, ShellRules.AccentOf("pink").Dark.Accent);
        Assert.Equal(0x4F46E5u, ShellRules.AccentOf("blue").Light.Accent);
    }

    [Fact]
    public void A_disabled_solid_is_the_solid_faded_towards_the_surface()
    {
        var light = ShellRules.DisabledSolid(0x4F46E5, false);
        Assert.True((light >> 16) > 0x4F && (light >> 16) <= 0xFF);
        var dark = ShellRules.DisabledSolid(0x4F46E5, true);
        Assert.True((dark >> 16) < (light >> 16));
    }

    [Fact]
    public void The_colour_row_is_apples_eight_and_names_them()
    {
        Assert.Equal(8, ShellRules.TreeColours.Count);
        Assert.Equal("#6366f1", ShellRules.TreeColours[0].Hex);
        Assert.Equal("Pink", ShellRules.ColourName("#EC4899"));
        Assert.Equal("Custom", ShellRules.ColourName("#123456"));
        Assert.True(ShellRules.SameColour("#EC4899", "#ec4899"));
        Assert.False(ShellRules.SameColour(null, "#ec4899"));
    }

    [Theory]
    [InlineData("b", false, 1)]
    [InlineData("b", true, 2)]
    [InlineData("a", false, 0)]
    [InlineData("c", true, 3)]
    [InlineData("zzz", false, 3)]
    public void A_drop_next_to_a_row_takes_the_index_the_core_would(string target, bool after, int expected) =>
        Assert.Equal(expected, ShellRules.DropIndex(new[] { "a", "b", "c" }, target, after));

    [Theory]
    [InlineData(2, 30, true, ShellRules.Zone.Before)]
    [InlineData(15, 30, true, ShellRules.Zone.Into)]
    [InlineData(28, 30, true, ShellRules.Zone.After)]
    [InlineData(5, 28, false, ShellRules.Zone.Before)]
    [InlineData(20, 28, false, ShellRules.Zone.After)]
    public void The_pointer_in_a_row_picks_before_into_or_after(double y, double h, bool nest, ShellRules.Zone zone) => Assert.Equal(zone, ShellRules.DropZone(y, h, nest));

    [Fact]
    public void Move_up_and_down_count_without_the_item()
    {
        var l = new[] { "a", "b", "c" };
        Assert.Null(ShellRules.StepIndex(l, "a", -1));
        Assert.Equal(0, ShellRules.StepIndex(l, "b", -1));
        Assert.Equal(2, ShellRules.StepIndex(l, "b", 1));
        Assert.Null(ShellRules.StepIndex(l, "c", 1));
        Assert.Null(ShellRules.StepIndex(l, "x", 1));
    }

    [Fact]
    public void Reorder_puts_an_item_at_its_index_among_the_others()
    {
        var l = new[] { "a", "b", "c", "d" };
        Assert.Equal(new[] { "b", "a", "c", "d" }, ShellRules.Reorder(l, x => x == "a", 1));
        Assert.Equal(new[] { "d", "a", "b", "c" }, ShellRules.Reorder(l, x => x == "d", 0));
        Assert.Equal(new[] { "b", "c", "d", "a" }, ShellRules.Reorder(l, x => x == "a", null));
        Assert.Equal(new[] { "b", "c", "d", "a" }, ShellRules.Reorder(l, x => x == "a", 99));
        Assert.Equal(l, ShellRules.Reorder(l, x => x == "nope", 1));
    }

    [Fact]
    public void The_offline_pill_waits_thirty_seconds_and_stays_dismissed()
    {
        var t0 = new DateTime(2026, 11, 23, 9, 0, 0, DateTimeKind.Utc);
        Assert.False(ShellRules.ShowOfflinePill(null, t0, false));
        Assert.False(ShellRules.ShowOfflinePill(t0, t0.AddSeconds(29), false));
        Assert.True(ShellRules.ShowOfflinePill(t0, t0.AddSeconds(30), false));
        Assert.False(ShellRules.ShowOfflinePill(t0, t0.AddMinutes(5), true));
        Assert.True(ShellRules.ShowOfflinePill(t0, t0, false, immediate: true));
        Assert.Equal("Offline. Changes sync when you reconnect.", ShellRules.OfflineText);
    }

    [Theory]
    [InlineData("Plan", "Plan", null)]
    [InlineData("Plan", "  Plan  ", null)]
    [InlineData("Plan", "Roadmap", "Roadmap")]
    [InlineData("Untitled", "", null)]
    [InlineData("Untitled", "First", "First")]
    [InlineData("Plan", "   ", "")]
    public void A_title_edit_saves_only_a_change(string current, string typed, string? saved) => Assert.Equal(saved, ShellRules.TitleChange(current, typed));

    [Fact]
    public void The_shortcut_sheet_lists_the_basics_and_opens_on_the_right_keys()
    {
        var all = ShellRules.Shortcuts.SelectMany(g => g.Items).ToList();
        Assert.Contains(all, s => s.Title == "Search" && s.Keys.SequenceEqual(new[] { "Ctrl", "K" }));
        Assert.Contains(all, s => s.Title == "Keyboard shortcuts" && s.Keys.SequenceEqual(new[] { "Ctrl", "/" }));
        Assert.All(all, s => Assert.NotEmpty(s.Keys));
        Assert.Equal(all.Count, all.Select(s => s.Title).Distinct().Count());
        Assert.True(ShellRules.OpensShortcuts(true, false, true, "/"));
        Assert.True(ShellRules.OpensShortcuts(false, true, false, "?"));
        Assert.False(ShellRules.OpensShortcuts(false, true, true, "?"));   // typing a question mark in a text field
        Assert.False(ShellRules.OpensShortcuts(false, false, false, "/"));   // the slash menu
    }
}
