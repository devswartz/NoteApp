using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

// People over the core (PARITY batch 3): workspace_people, invite_member, resend_invite, revoke_invite, set_member_role, remove_member, leave_workspace,
// invite_info, accept_invite. Every call runs on the core's call queue (AppSession.CallAsync); a failure comes back as one sentence (the server's own words
// for 400, 403, 404, 409 and 410).
internal sealed partial class CoreNotesSource
{
    private string? Ws => _wsId;

    private static PageToolResult<T> NoWorkspace<T>() => PageToolResult<T>.Fail("Open a workspace first.");

    public Task<PageToolResult<PeopleInfo>> LoadPeople()
    {
        if (Ws is not { } ws) return Task.FromResult(NoWorkspace<PeopleInfo>());
        return Tool(async () =>
        {
            var p = await _session.CallAsync(c => c.WorkspacePeople(ws));
            return new PeopleInfo(
                p.Members.Select(m => new MemberInfo(m.Id, m.Name, m.Email, m.Color, m.Role)).ToList(),
                p.Invites.Select(i => new PendingInviteInfo(i.Email, i.Role, i.ExpiresAt)).ToList());
        });
    }

    public Task<PageToolResult<InviteOutcome>> InviteToWorkspace(string email, string role)
    {
        if (Ws is not { } ws) return Task.FromResult(NoWorkspace<InviteOutcome>());
        return Tool(async () =>
        {
            var r = await _session.CallAsync(c => c.InviteMember(ws, email, role));
            if (r.Status == "added") _ = LoadMembersAsync(ws);
            return new InviteOutcome(r.Status, r.Emailed, r.InviteUrl);
        });
    }

    public Task<PageToolResult<InviteOutcome>> ResendWorkspaceInvite(string email)
    {
        if (Ws is not { } ws) return Task.FromResult(NoWorkspace<InviteOutcome>());
        return Tool(async () =>
        {
            var r = await _session.CallAsync(c => c.ResendInvite(ws, email));
            return new InviteOutcome(r.Status, r.Emailed, r.InviteUrl);
        });
    }

    public Task<PageToolResult<bool>> RevokeWorkspaceInvite(string email)
    {
        if (Ws is not { } ws) return Task.FromResult(NoWorkspace<bool>());
        return Tool(async () => { await _session.CallAsync(c => { c.RevokeInvite(ws, email); return true; }); return true; });
    }

    public Task<PageToolResult<bool>> SetMemberRole(string userId, string role)
    {
        if (Ws is not { } ws) return Task.FromResult(NoWorkspace<bool>());
        return Tool(async () =>
        {
            await _session.CallAsync(c => { c.SetMemberRole(ws, userId, role); return true; });
            _ = LoadMembersAsync(ws);
            if (userId == _user.Id) await ReloadWorkspacesAsync(null);   // your own role is on the workspace list
            return true;
        });
    }

    public Task<PageToolResult<bool>> RemoveMember(string userId)
    {
        if (Ws is not { } ws) return Task.FromResult(NoWorkspace<bool>());
        return Tool(async () =>
        {
            await _session.CallAsync(c => { c.RemoveMember(ws, userId); return true; });
            _ = LoadMembersAsync(ws);
            return true;
        });
    }

    public Task<PageToolResult<bool>> LeaveWorkspace()
    {
        if (Ws is not { } ws) return Task.FromResult(NoWorkspace<bool>());
        return Tool(async () =>
        {
            OpenPage(null);                                              // the core wants its open pages closed first
            await _session.CallAsync(c => { c.LeaveWorkspace(ws); return true; });
            await ReloadWorkspacesAsync(null);
            return true;
        });
    }

    public Task<PageToolResult<InviteLinkInfo>> LookUpInvite(string token) => Tool(async () =>
    {
        var i = await _session.CallAsync(c => c.InviteInfo(token));
        return new InviteLinkInfo(i.WorkspaceId, i.WorkspaceName, i.InvitedByName, i.Email, i.Role, i.Expired, i.Page?.Title, i.Page?.CanEdit ?? false);
    });

    public Task<PageToolResult<JoinedInfo>> AcceptInvite(string token) => Tool(async () =>
    {
        var a = await _session.CallAsync(c => c.AcceptInvite(token));
        if (a.PageId is null) await ReloadWorkspacesAsync(a.WorkspaceId);
        else await LoadSharedAsync();
        Raise();
        return new JoinedInfo(a.WorkspaceId, a.PageId);
    });

    /// <summary>The workspace list again (the core stored it after a change of membership); <paramref name="select"/> becomes the open workspace.</summary>
    private async Task ReloadWorkspacesAsync(string? select)
    {
        var list = await _session.CallAsync(c => c.Workspaces());
        if (_disposed) return;
        _workspaces = list;
        LoadError = list.Length == 0 ? "No workspaces yet. Create one in the web app." : null;
        if (select is not null && list.Any(w => w.Id == select)) SelectWorkspace(select);
        else PickWorkspace();
        Raise();
    }
}
