using Notivelo.Windows.Data;
using Xunit;

namespace Notivelo.Windows.Tests;

/// <summary>The inbox, save state and delete-account rules (AuditBatch.cs).</summary>
public class AuditRulesTests
{
    private static InboxItem N(string id, bool read) => new(id, "mention", "Sam Rivera", "#14b8a6", "t " + id, "", "2026-11-24T10:00:00Z", read, null, null, null);

    [Fact]
    public void Marking_one_read_lowers_the_count_once()
    {
        var items = new[] { N("a", false), N("b", false), N("c", true) };
        var (after, unread) = AuditRules.MarkRead(items, 2, "a");
        Assert.True(after[0].IsRead); Assert.False(after[1].IsRead); Assert.Equal(1, unread);
        var (same, u2) = AuditRules.MarkRead(after, unread, "a");        // again: nothing changes
        Assert.Same(after, same); Assert.Equal(1, u2);
        Assert.Equal(1, AuditRules.MarkRead(items, 1, "c").Unread);         // an already read one
        Assert.Equal(0, AuditRules.MarkRead(items, 0, "b").Unread);         // never below zero
    }

    [Fact]
    public void Mark_all_clears_the_count_and_load_more_adds_each_once()
    {
        var items = new[] { N("a", false), N("b", false) };
        var (all, unread) = AuditRules.MarkAll(items);
        Assert.All(all, n => Assert.True(n.IsRead)); Assert.Equal(0, unread);
        var more = AuditRules.Append(items, new[] { N("b", false), N("c", true) });
        Assert.Equal(new[] { "a", "b", "c" }, more.Select(x => x.Id).ToArray());
    }

    [Fact]
    public void The_bell_says_how_many_are_unread()
    {
        Assert.Equal("Notifications", AuditRules.BellLabel(0));
        Assert.Equal("Notifications, 3 unread", AuditRules.BellLabel(3));
        Assert.Equal("99+", AuditRules.BadgeText(120));
        Assert.Equal("7", AuditRules.BadgeText(7));
    }

    [Theory]
    [InlineData(10, "less than a minute ago")]
    [InlineData(60, "1 minute ago")]
    [InlineData(6 * 60, "6 minutes ago")]
    [InlineData(70 * 60, "about 1 hour ago")]
    [InlineData(3 * 3600, "about 3 hours ago")]
    [InlineData(30 * 3600, "1 day ago")]
    [InlineData(3 * 86400, "3 days ago")]
    [InlineData(60 * 86400, "about 2 months ago")]
    public void Times_read_like_the_web(int secondsAgo, string text)
    {
        var now = new DateTimeOffset(2026, 11, 24, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal(text, AuditRules.Ago(now.AddSeconds(-secondsAgo).ToString("o"), now));
    }

    [Fact]
    public void The_save_state_follows_unsent_edits_and_the_connection()
    {
        Assert.Equal(SaveState.Saved, AuditRules.SaveOf(false, 0, 0));
        Assert.Equal(SaveState.Saving, AuditRules.SaveOf(false, 2, 0));
        Assert.Equal(SaveState.Saving, AuditRules.SaveOf(false, 0, 1));
        Assert.Equal(SaveState.Offline, AuditRules.SaveOf(true, 0, 0));
        Assert.Equal(SaveState.OfflineKept, AuditRules.SaveOf(true, 3, 1));
        Assert.Equal("Saving…", AuditRules.SaveText(SaveState.Saving));
        Assert.Equal("Offline — changes kept", AuditRules.SaveText(SaveState.OfflineKept));
        // read against the connection now
        Assert.Equal(SaveState.OfflineKept, AuditRules.Combine(true, SaveState.Saving));
        Assert.Equal(SaveState.Offline, AuditRules.Combine(true, SaveState.Saved));
        Assert.Equal(SaveState.Saved, AuditRules.Combine(false, SaveState.OfflineKept));
        Assert.Equal(SaveState.Saving, AuditRules.Combine(false, SaveState.Saving));
    }

    [Fact]
    public void The_delete_account_dialog_lists_what_happens_to_each_workspace()
    {
        var p = new DeletionPreviewInfo(new[] { "Solo" }, new[] { ("Staff", "Sam Rivera") }, new[] { "Co-owned" }, new[] { "Priya’s notes" }, 2);
        var lines = AuditRules.DeletionLines(p);
        Assert.Equal(5, lines.Count);
        Assert.Contains("“Solo” will be deleted for everyone", lines[0]);
        Assert.Contains("“Staff” will go to Sam Rivera", lines[1]);
        Assert.Contains("2 private notebooks", lines[4]);
        Assert.Empty(AuditRules.DeletionLines(new DeletionPreviewInfo(Array.Empty<string>(), Array.Empty<(string, string)>(), Array.Empty<string>(), Array.Empty<string>(), 0)));
        Assert.Contains("1 private notebook and everything in it", AuditRules.DeletionLines(p with { PrivateNotebooks = 1 })[4]);
    }

    [Fact]
    public void A_share_link_is_a_web_address()
    {
        Assert.True(AuditRules.LooksLikeLink("https://app.notiveloapp.com/s/abc"));
        Assert.False(AuditRules.LooksLikeLink("abc"));
        Assert.False(AuditRules.LooksLikeLink(null));
    }
}
