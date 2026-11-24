using Tsk = System.Threading.Tasks.Task;

namespace Notivelo.Windows.Data;

// The audit batch in memory (the offline sample): task facts for the filters, a few notifications, the share link and an account that is never deleted for real.
public sealed partial class SampleNotesSource
{
    private DateOnly? SeedDue(string id)
    {
        var today = DateOnly.FromDateTime(DateTime.Now);
        if (_extra.TryGetValue(id, out var e)) return e.Due is { } str && DateOnly.TryParse(str, out var p) ? p : null;
        return id switch
        {
            "t-launch" => today.AddDays(-1), "t-welcome" or "t-notes" or "t-other" or "t-slow" => today, "t-up1" => today.AddDays(1), "t-up2" => today.AddDays(2),
            "t-plan" => today.AddDays(9), _ => null,
        };
    }

    private static string? SampleUser(string? initials) => initials switch { "DU" => "u1", "SR" => "u2", null => null, _ => "u3" };

    public IReadOnlyList<TaskFact> TaskFacts()
    {
        var n = 0;
        return AllTasks().DistinctBy(t => t.Id).Select(t =>
        {
            var x = X(t.Id);
            // the sample's flavour: the roadmap carries the docs tag, Sam's task belongs to Design
            var tags = x.Tags ?? (t.Id == "t-plan" ? new[] { "tag-docs" } : t.Id == "t-launch" ? new[] { "tag-launch" } : Array.Empty<string>());
            var team = x.TeamId ?? (t.Id == "t-other" ? "team-design" : null);
            var item = t with { Team = team is null ? t.Team : TeamList.FirstOrDefault(tm => tm.Id == team)?.Name ?? t.Team };
            return new TaskFact(item, t.Priority == 0 ? 4 : t.Priority, SeedDue(t.Id)?.ToString("yyyy-MM-dd"), x.Time, SampleUser(t.Assignee), team, tags, t.PageTitle is null ? null : PageIdOf(t.PageTitle),
                "2026-11-" + (10 + n++ % 15).ToString("D2") + "T09:00:00Z", t.Done ? DateTime.UtcNow.AddDays(-1).ToString("o") : null, _desc.GetValueOrDefault(t.Id) ?? "");
        }).ToList();
    }

    private string? PageIdOf(string title) => _pages.Values.FirstOrDefault(p => p.Title == title)?.Id ?? title;

    public void LoadTaskTeams() { }

    public Task<string?> SetPageSetting(string pageId, string kind, string value)
    {
        if (!_pages.TryGetValue(pageId, out var p)) return Tsk.FromResult<string?>("That page is not open.");
        if (kind == "colour" && Enum.TryParse<PageColour>(value, true, out var c)) _pages[pageId] = p with { Colour = c };
        else if (kind == "rules" && Enum.TryParse<RuleLines>(value, true, out var r)) _pages[pageId] = p with { Rules = r };
        else return Tsk.FromResult<string?>("Not a setting of the page.");
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    // ---- inbox ----
    private List<InboxItem>? _inbox;
    private List<InboxItem> Inbox => _inbox ??= SeedInbox();

    private static string Iso(double minutesAgo) => DateTimeOffset.UtcNow.AddMinutes(-minutesAgo).ToString("o");

    private static List<InboxItem> SeedInbox() => new()
    {
        new("n1", "mention", "Sam Rivera", "#14b8a6", "Sam Rivera mentioned you in “Weekly sync”", "@Demo can you take the launch checklist?", Iso(6), false, null, "canvas", null),
        new("n2", "assigned", "Priya Nair", "#ec4899", "Priya Nair assigned you “Review the launch checklist”", "", Iso(42), false, null, null, "t-launch"),
        new("n3", "comment", "Sam Rivera", "#14b8a6", "Sam Rivera commented on “Canvas”", "Looks good, moving the table up.", Iso(3 * 60), false, null, "canvas", null),
        new("n4", "shared", "Priya Nair", "#ec4899", "Priya Nair shared “Q4 roadmap” with you", "", Iso(26 * 60), true, null, null, null),
        new("n5", "reminder", null, null, "Reminder: Send the meeting notes to the team", "Due today", Iso(2 * 24 * 60), true, null, null, "t-notes"),
    };

    public Task<PageToolResult<InboxPage>> LoadInbox(string? before) =>
        Tsk.FromResult(new PageToolResult<InboxPage>(new InboxPage(Inbox.ToList(), Inbox.Count(i => !i.IsRead), null)));

    public Task<int?> UnreadCount() => Tsk.FromResult<int?>(Inbox.Count(i => !i.IsRead));

    public Tsk MarkNotificationRead(string id)
    {
        var i = Inbox.FindIndex(x => x.Id == id);
        if (i >= 0) Inbox[i] = Inbox[i] with { IsRead = true };
        return Tsk.CompletedTask;
    }

    public Tsk MarkAllNotificationsRead() { _inbox = Inbox.Select(i => i with { IsRead = true }).ToList(); return Tsk.CompletedTask; }

    // ---- public share link (in memory per page; the address is a sample one, never a real link) ----
    private readonly Dictionary<string, string> _links = new();
    private int _linkSeq;

    public Task<PageToolResult<string?>> LoadShareLink(string pageId) => Tsk.FromResult(new PageToolResult<string?>(_links.GetValueOrDefault(pageId)));

    public Task<PageToolResult<string>> CreateShareLink(string pageId)
    {
        if (!_links.TryGetValue(pageId, out var url)) _links[pageId] = url = "https://example.com/s/sample" + (++_linkSeq).ToString("D4") + "0123456789abcdefghij";
        return Tsk.FromResult(new PageToolResult<string>(url));
    }

    public Task<PageToolResult<bool>> DeleteShareLink(string pageId) { _links.Remove(pageId); return Tsk.FromResult(new PageToolResult<bool>(true)); }

    // ---- delete account: a preview and a password check, nothing deleted ----
    public Task<AccountResult<DeletionPreviewInfo>> LoadDeletionPreview() => Tsk.FromResult(new AccountResult<DeletionPreviewInfo>(new DeletionPreviewInfo(
        new[] { "Demo workspace" }, new[] { ("Staff", "Sam Rivera") }, Array.Empty<string>(), new[] { "Priya’s notes" }, 1)));

    public Task<AccountResult<bool>> DeleteAccount(string password) => Tsk.FromResult(password == "wrong"
        ? new AccountResult<bool>(Error: "That password is not right.", Code: "wrong_password")
        : new AccountResult<bool>(true));
}
