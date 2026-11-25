namespace Notivelo.Windows.Data;

/// <summary>A team as the settings screen edits it (the core's <c>TaskTeam</c>): members and a parent (one level of subteams).</summary>
public sealed record TeamDetail(string Id, string Name, string Color, string? ParentId, IReadOnlyList<string> MemberIds);

/// <summary>One line of the activity feed (the core's <c>ActivityEntry</c> with the actor looked up): <see cref="Summary"/> follows the actor's name.</summary>
public sealed record ActivityItem(long Id, string Actor, string? ActorColor, string Verb, string TargetType, string TargetId, string Summary, string CreatedAt);

/// <summary>Another person's caret or selection in a box, in view offsets of the box's text (the core's <c>BoxCursor</c>). Anchor == Head is a caret.</summary>
public sealed record RemoteCaret(string UserId, string Name, string Color, string BoxId, int Anchor, int Head);

/// <summary>The XAML-free rules of the workspace screens and the carets.</summary>
public static class AdminRules
{
    public const int WorkspaceNameMax = 100, TeamNameMax = 60, TagNameMax = 40;

    /// <summary>The colours a tag or team can take (the web's palette).</summary>
    public static readonly IReadOnlyList<string> Colors = new[] { "#ef4444", "#f97316", "#f59e0b", "#22c55e", "#14b8a6", "#0ea5e9", "#6366f1", "#a855f7", "#ec4899", "#64748b" };

    /// <summary>A trimmed name, or the sentence that says why it can't be used (null name).</summary>
    public static (string? Name, string? Error) CheckName(string raw, int max, string what)
    {
        var n = raw.Trim();
        if (n.Length == 0) return (null, $"Give the {what} a name.");
        if (n.Length > max) return (null, $"A {what} name can have at most {max} characters.");
        return (n, null);
    }

    /// <summary>Teams top level first in their given order, each followed by its subteams (the screen's list order).</summary>
    public static IReadOnlyList<(TeamDetail Team, int Depth)> OrderTeams(IReadOnlyList<TeamDetail> teams)
    {
        var res = new List<(TeamDetail, int)>();
        var ids = teams.Select(t => t.Id).ToHashSet();
        foreach (var top in teams.Where(t => t.ParentId is null || !ids.Contains(t.ParentId)))
        {
            res.Add((top, 0));
            foreach (var kid in teams.Where(t => t.ParentId == top.Id)) res.Add((kid, 1));
        }
        return res;
    }

    /// <summary>"just now", "5 min ago", "3 h ago", "yesterday", or a date, from an ISO instant.</summary>
    public static string When(string iso, DateTimeOffset now)
    {
        if (!DateTimeOffset.TryParse(iso, null, System.Globalization.DateTimeStyles.AssumeUniversal, out var t)) return "";
        var d = now - t;
        if (d < TimeSpan.FromMinutes(1)) return "just now";
        if (d < TimeSpan.FromHours(1)) return (int)d.TotalMinutes + " min ago";
        if (d < TimeSpan.FromDays(1)) return (int)d.TotalHours + " h ago";
        if (d < TimeSpan.FromDays(2)) return "yesterday";
        return t.ToLocalTime().ToString("d MMM yyyy", System.Globalization.CultureInfo.CurrentCulture);
    }

    /// <summary>The page opens from an activity line (page, task, notebook and section targets can be opened).</summary>
    public static bool CanOpen(string targetType) => targetType is "page" or "task";

    public static bool Same(IReadOnlyList<RemoteCaret> a, IReadOnlyList<RemoteCaret> b) => a.Count == b.Count && a.Zip(b).All(x => x.First == x.Second);

    /// <summary>The caret's offsets kept inside the box's text, anchor first.</summary>
    public static (int Anchor, int Head) Clamp(RemoteCaret c, int length) => (Math.Clamp(c.Anchor, 0, length), Math.Clamp(c.Head, 0, length));

    /// <summary>The readout of a box's remote carets for the UI tests: "Name@head" or "Name@anchor-head", joined by "/".</summary>
    public static string Readout(IEnumerable<RemoteCaret> carets, int length) =>
        string.Join("/", carets.Select(c => { var (a, h) = Clamp(c, length); return c.Name.Replace(';', ',').Replace('/', ',') + "@" + (a == h ? h.ToString() : a + "-" + h); }));
}
