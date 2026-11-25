using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

// Workspaces, teams, tags and the activity feed over the core (apple-left3: create/rename/delete_workspace, the team and tag calls, activity). All online only; each runs
// on the core's call queue and answers one sentence on failure (the server's own words for 400 name, 403 role, 404 gone, 409 taken).
internal sealed partial class CoreNotesSource
{
    private async Task<string?> Do(Func<N.Core, string?> call)
    {
        try { return await _session.CallAsync(call); }
        catch (OperationCanceledException) { return "You were signed out. Sign in again."; }
        catch (Exception e) { return ErrorText.Message(e); }
    }

    // ---- workspaces ----

    public async Task<string?> CreateWorkspace(string name)
    {
        var (n, bad) = AdminRules.CheckName(name, AdminRules.WorkspaceNameMax, "workspace");
        if (bad is not null) return bad;
        string? id = null;
        var err = await Do(c => { id = c.CreateWorkspace(n!); return null; });
        if (err is not null) return err;
        try { await ReloadWorkspacesAsync(id); } catch (Exception e) { return ErrorText.Message(e); }
        return null;
    }

    public async Task<string?> RenameWorkspace(string name)
    {
        if (_wsId is not { } ws) return "Open a workspace first.";
        var (n, bad) = AdminRules.CheckName(name, AdminRules.WorkspaceNameMax, "workspace");
        if (bad is not null) return bad;
        var err = await Do(c => { c.RenameWorkspace(ws, n!); return null; });
        if (err is not null) return err;
        try
        {
            _workspaces = await _session.CallAsync(c => c.Workspaces());
            Workspace = Workspace with { Name = n!, Initial = n![..1].ToUpperInvariant() };
            Raise();
        }
        catch (Exception) { }
        return null;
    }

    public async Task<string?> DeleteWorkspace()
    {
        if (_wsId is not { } ws) return "Open a workspace first.";
        OpenPage(null);                                               // the core wants its open pages closed first
        var err = await Do(c => { c.DeleteWorkspace(ws); return null; });
        if (err is not null) return err;
        try { await ReloadWorkspacesAsync(null); } catch (Exception e) { return ErrorText.Message(e); }
        return null;
    }

    // ---- teams ----

    private static TeamDetail Detail(N.TaskTeam t) => new(t.Id, t.Name, t.Color, t.ParentId, t.MemberIds);

    public async Task<PageToolResult<IReadOnlyList<TeamDetail>>> LoadTeams()
    {
        if (_wsId is not { } ws) return NoWorkspace<IReadOnlyList<TeamDetail>>();
        return await Tool<IReadOnlyList<TeamDetail>>(async () =>
        {
            var teams = await _session.CallAsync(c => c.Teams(ws));
            if (ws == _wsId) { _teams = teams; Raise(); }
            return teams.Select(Detail).ToList();
        });
    }

    public async Task<string?> CreateTeam(string name, string? parentId)
    {
        if (_wsId is not { } ws) return "Open a workspace first.";
        var (n, bad) = AdminRules.CheckName(name, AdminRules.TeamNameMax, "team");
        if (bad is not null) return bad;
        var err = await Do(c => { c.CreateTeam(ws, n!, null, parentId, Array.Empty<string>()); return null; });
        if (err is null) await LoadTeams();
        return err;
    }

    public async Task<string?> RenameTeam(string teamId, string name)
    {
        var (n, bad) = AdminRules.CheckName(name, AdminRules.TeamNameMax, "team");
        if (bad is not null) return bad;
        var err = await Do(c => { c.RenameTeam(teamId, n!); return null; });
        if (err is null) await LoadTeams();
        return err;
    }

    public async Task<string?> DeleteTeam(string teamId)
    {
        var err = await Do(c => { c.DeleteTeam(teamId); return null; });
        if (err is null) await LoadTeams();
        return err;
    }

    public async Task<string?> SetTeamMembers(string teamId, IReadOnlyList<string> userIds)
    {
        var ids = userIds.ToArray();
        var err = await Do(c => { c.SetTeamMembers(teamId, ids); return null; });
        if (err is null) await LoadTeams();
        return err;
    }

    // ---- tags ----

    public async Task<PageToolResult<IReadOnlyList<TagInfo>>> LoadTags()
    {
        if (_wsId is not { } ws) return NoWorkspace<IReadOnlyList<TagInfo>>();
        return await Tool<IReadOnlyList<TagInfo>>(async () =>
        {
            var tags = await _session.CallAsync(c => c.Tags(ws));
            if (ws == _wsId) { _tags = tags; Raise(); }
            return Tags();
        });
    }

    public async Task<string?> RenameTag(string tagId, string name)
    {
        var (n, bad) = AdminRules.CheckName(name.TrimStart('#'), AdminRules.TagNameMax, "tag");
        if (bad is not null) return bad;
        var err = await Do(c => { c.RenameTag(tagId, n!); return null; });
        if (err is null) await LoadTags();
        return err;
    }

    public async Task<string?> RecolorTag(string tagId, string color)
    {
        var err = await Do(c => { c.RecolorTag(tagId, color); return null; });
        if (err is null) await LoadTags();
        return err;
    }

    public async Task<string?> DeleteTag(string tagId)
    {
        var err = await Do(c => { c.DeleteTag(tagId); return null; });
        if (err is null) { _tasksVersion++; await LoadTags(); }
        return err;
    }

    // ---- activity ----

    public async Task<PageToolResult<IReadOnlyList<ActivityItem>>> LoadActivity(long? before)
    {
        if (_wsId is not { } ws) return NoWorkspace<IReadOnlyList<ActivityItem>>();
        return await Tool<IReadOnlyList<ActivityItem>>(async () =>
        {
            var rows = await _session.CallAsync(c => c.Activity(ws, 50, before));
            return rows.Select(a =>
            {
                var m = a.ActorId is null ? null : _members.FirstOrDefault(x => x.Id == a.ActorId);
                var who = a.ActorId is null ? "Someone" : a.ActorId == _user.Id ? "You" : m is null ? "Someone" : m.Name.Length > 0 ? m.Name : m.Email;
                return new ActivityItem(a.Id, who, m?.Color, a.Verb, a.TargetType, a.TargetId, a.Summary, a.CreatedAt);
            }).ToList();
        });
    }
}
