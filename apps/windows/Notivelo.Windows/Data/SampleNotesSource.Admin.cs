using Tsk = System.Threading.Tasks.Task;

namespace Notivelo.Windows.Data;

// Workspaces, teams, tags and the activity feed on the sample data (offline test mode and screenshots): everything lives in memory, and the "Sample Viewer" has a caret in the
// offline page's second box so the carets can be seen and tested without a server.
public sealed partial class SampleNotesSource
{
    private readonly Dictionary<string, List<string>> _teamMembers = new() { ["team-staff"] = new() { "u1", "u2" }, ["team-eng"] = new() { "u1" } };
    private readonly List<ActivityItem> _activity = new();
    private int _admins;

    private static System.Threading.Tasks.Task<string?> Fin(string? error = null) => Tsk.FromResult(error);

    // ---- workspaces ----

    public System.Threading.Tasks.Task<string?> CreateWorkspace(string name)
    {
        var (n, bad) = AdminRules.CheckName(name, AdminRules.WorkspaceNameMax, "workspace");
        if (bad is not null) return Fin(bad);
        var id = "ws-n" + ++_admins;
        Workspaces = Workspaces.Append(new WorkspaceInfo(id, n!, "owner")).ToList();
        Note("created", "workspace", id, $"created the workspace “{n}”");
        SelectWorkspace(id);
        return Fin();
    }

    public System.Threading.Tasks.Task<string?> RenameWorkspace(string name)
    {
        var (n, bad) = AdminRules.CheckName(name, AdminRules.WorkspaceNameMax, "workspace");
        if (bad is not null) return Fin(bad);
        var old = Workspaces.First(w => w.Id == _wsId).Name;
        Workspaces = Workspaces.Select(w => w.Id == _wsId ? w with { Name = n! } : w).ToList();
        Note("renamed", "workspace", _wsId, $"renamed the workspace “{old}” to “{n}”");
        SelectWorkspace(_wsId);
        return Fin();
    }

    public System.Threading.Tasks.Task<string?> DeleteWorkspace()
    {
        if (Workspaces.Count < 2) return Fin("This is your only workspace. Make another one first.");
        var gone = _wsId;
        Workspaces = Workspaces.Where(w => w.Id != gone).ToList();
        SelectWorkspace(Workspaces[0].Id);
        return Fin();
    }

    // ---- teams ----

    private TeamInfo MakeTeam(string id, string name, string color, string? parent)
    {
        var parentName = parent is null ? null : TeamList.FirstOrDefault(t => t.Id == parent)?.Name;
        return new TeamInfo(id, name, TaskLogic.TeamLabel(name, parentName), color, parent);
    }

    public System.Threading.Tasks.Task<PageToolResult<IReadOnlyList<TeamDetail>>> LoadTeams() =>
        Tsk.FromResult(new PageToolResult<IReadOnlyList<TeamDetail>>(TeamList.Select(t => new TeamDetail(t.Id, t.Name, t.Color, t.ParentId, _teamMembers.GetValueOrDefault(t.Id) ?? new List<string>())).ToList()));

    public System.Threading.Tasks.Task<string?> CreateTeam(string name, string? parentId)
    {
        var (n, bad) = AdminRules.CheckName(name, AdminRules.TeamNameMax, "team");
        if (bad is not null) return Fin(bad);
        if (parentId is not null && TeamList.FirstOrDefault(t => t.Id == parentId)?.ParentId is not null) return Fin("A subteam can't have subteams.");
        var id = "team-n" + ++_admins;
        TeamList.Add(MakeTeam(id, n!, AdminRules.Colors[TeamList.Count % AdminRules.Colors.Count], parentId));
        Note("created", "team", id, $"created the team “{n}”");
        Raise();
        return Fin();
    }

    public System.Threading.Tasks.Task<string?> RenameTeam(string teamId, string name)
    {
        var (n, bad) = AdminRules.CheckName(name, AdminRules.TeamNameMax, "team");
        if (bad is not null) return Fin(bad);
        var i = TeamList.FindIndex(t => t.Id == teamId);
        if (i < 0) return Fin("That team is gone.");
        TeamList[i] = MakeTeam(teamId, n!, TeamList[i].Color, TeamList[i].ParentId);
        for (var k = 0; k < TeamList.Count; k++) if (TeamList[k].ParentId == teamId) TeamList[k] = MakeTeam(TeamList[k].Id, TeamList[k].Name, TeamList[k].Color, teamId);
        Raise();
        return Fin();
    }

    public System.Threading.Tasks.Task<string?> DeleteTeam(string teamId)
    {
        TeamList.RemoveAll(t => t.Id == teamId || t.ParentId == teamId);
        _teamMembers.Remove(teamId);
        Raise();
        return Fin();
    }

    public System.Threading.Tasks.Task<string?> SetTeamMembers(string teamId, IReadOnlyList<string> userIds)
    {
        if (TeamList.All(t => t.Id != teamId)) return Fin("That team is gone.");
        _teamMembers[teamId] = userIds.ToList();
        Raise();
        return Fin();
    }

    // ---- tags ----

    public System.Threading.Tasks.Task<PageToolResult<IReadOnlyList<TagInfo>>> LoadTags() => Tsk.FromResult(new PageToolResult<IReadOnlyList<TagInfo>>(Tags()));

    public System.Threading.Tasks.Task<string?> RenameTag(string tagId, string name)
    {
        var (n, bad) = AdminRules.CheckName(name.TrimStart('#'), AdminRules.TagNameMax, "tag");
        if (bad is not null) return Fin(bad);
        var i = _tagList.FindIndex(t => t.Id == tagId);
        if (i < 0) return Fin("That tag is gone.");
        if (_tagList.Any(t => t.Id != tagId && string.Equals(t.Name, n, StringComparison.OrdinalIgnoreCase))) return Fin("There is already a tag with that name.");
        _tagList[i] = _tagList[i] with { Name = n! };
        Raise();
        return Fin();
    }

    public System.Threading.Tasks.Task<string?> RecolorTag(string tagId, string color)
    {
        var i = _tagList.FindIndex(t => t.Id == tagId);
        if (i < 0) return Fin("That tag is gone.");
        _tagList[i] = _tagList[i] with { Color = color.ToLowerInvariant() };
        Raise();
        return Fin();
    }

    public System.Threading.Tasks.Task<string?> DeleteTag(string tagId)
    {
        _tagList.RemoveAll(t => t.Id == tagId);
        foreach (var k in _x.Keys.ToList()) if (_x[k].Tags is { } tg && tg.Contains(tagId)) _x[k] = _x[k] with { Tags = tg.Where(i => i != tagId).ToArray() };
        Raise();
        return Fin();
    }

    // ---- activity ----

    private void Note(string verb, string type, string id, string summary) =>
        _activity.Insert(0, new ActivityItem(1000 + ++_admins, "Demo User", "#6366f1", verb, type, id, summary, DateTimeOffset.UtcNow.ToString("o")));

    public System.Threading.Tasks.Task<PageToolResult<IReadOnlyList<ActivityItem>>> LoadActivity(long? before)
    {
        var now = DateTimeOffset.UtcNow;
        var seed = new[]
        {
            new ActivityItem(12, "Demo User", "#6366f1", "edited", "page", "canvas", "edited the page “Welcome”", now.AddMinutes(-4).ToString("o")),
            new ActivityItem(11, "Sample Viewer", "#0ea5e9", "completed", "task", "t-welcome", "completed the task “Read the welcome page”", now.AddHours(-3).ToString("o")),
            new ActivityItem(10, "Demo User", "#6366f1", "created", "page", "canvas", "created the page “Meeting notes”", now.AddDays(-1).ToString("o")),
        };
        var all = _activity.Concat(seed).Where(a => before is null || a.Id < before).Take(50).ToList();
        return Tsk.FromResult(new PageToolResult<IReadOnlyList<ActivityItem>>(all));
    }

    // ---- carets ----

    private static readonly RemoteCaret[] ViewerCaret = { new("u-viewer", "Sample Viewer", "#0ea5e9", "b", 7, 7) };

    public IReadOnlyList<RemoteCaret> RemoteCarets(string pageId) => Offline && pageId == "uitest" ? ViewerCaret : Array.Empty<RemoteCaret>();

    /// <summary>The caret the offline page last sent, "box:anchor-head" (the UI tests read it through the box status).</summary>
    public string? LocalCaretSent { get; private set; }
    public void SetLocalCaret(string pageId, string boxId, int anchor, int head) => LocalCaretSent = $"{boxId}:{anchor}-{head}";
    public void ClearLocalCaret(string pageId) => LocalCaretSent = null;
}
