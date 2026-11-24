namespace Notivelo.Windows.Data;
using Tsk = System.Threading.Tasks.Task;

// People on the sample data (PARITY batch 3): members, roles, email invites and invite links work in memory, so the dialogs can be driven (the UI tests, the
// look screenshots) with no server. The core source does the same through the core's calls. Every change is logged for the tests (NOTIVELO_OFFLINE_LOG).
public sealed partial class SampleNotesSource
{
    private readonly List<MemberInfo> _people = new(SampleMembers);
    private readonly List<PendingInviteInfo> _pending = new() { new("jordan@example.com", "member", "2026-12-07T09:00:00Z") };
    private int _inviteSerial;

    private static PageToolResult<T> POk<T>(T v) => new(v);
    private static Task<PageToolResult<T>> PDone<T>(T v) => Tsk.FromResult(POk(v));
    private static Task<PageToolResult<T>> PFail<T>(string e) => Tsk.FromResult(PageToolResult<T>.Fail(e));

    public Task<PageToolResult<PeopleInfo>> LoadPeople() => PDone(new PeopleInfo(_people.ToList(), _pending.ToList()));

    public Task<PageToolResult<InviteOutcome>> InviteToWorkspace(string email, string role)
    {
        email = email.Trim();
        if (!PageToolRules.LooksLikeEmail(email)) return PFail<InviteOutcome>("That doesn't look like an email address.");
        if (_people.Any(m => m.Email.Equals(email, StringComparison.OrdinalIgnoreCase))) return PFail<InviteOutcome>("That person is already a member.");
        _pending.RemoveAll(i => i.Email.Equals(email, StringComparison.OrdinalIgnoreCase));
        _pending.Add(new PendingInviteInfo(email, role, DateTimeOffset.UtcNow.AddDays(14).ToString("o")));
        Log($"people invite {email} {role}");
        return PDone(new InviteOutcome("invited", false, $"https://app.example.com/invite/sample-link-{++_inviteSerial}"));
    }

    public Task<PageToolResult<InviteOutcome>> ResendWorkspaceInvite(string email)
    {
        if (!_pending.Any(i => i.Email.Equals(email, StringComparison.OrdinalIgnoreCase))) return PFail<InviteOutcome>("No pending invite for that address.");
        Log($"people resend {email}");
        return PDone(new InviteOutcome("invited", false, $"https://app.example.com/invite/sample-link-{++_inviteSerial}"));
    }

    public Task<PageToolResult<bool>> RevokeWorkspaceInvite(string email)
    {
        _pending.RemoveAll(i => i.Email.Equals(email, StringComparison.OrdinalIgnoreCase));
        Log($"people revoke {email}");
        return PDone(true);
    }

    public Task<PageToolResult<bool>> SetMemberRole(string userId, string role)
    {
        var i = _people.FindIndex(m => m.Id == userId);
        if (i < 0) return PFail<bool>("That person is no longer a member.");
        if (_people[i].Role == "owner" && role != "owner" && _people.Count(m => m.Role == "owner") == 1) return PFail<bool>("A workspace needs at least one owner.");
        _people[i] = _people[i] with { Role = role };
        Log($"people role {_people[i].Name} {role}");
        return PDone(true);
    }

    public Task<PageToolResult<bool>> RemoveMember(string userId)
    {
        var m = _people.FirstOrDefault(x => x.Id == userId);
        if (m is null) return PFail<bool>("That person is no longer a member.");
        if (m.Role == "owner" && _people.Count(x => x.Role == "owner") == 1) return PFail<bool>("A workspace needs at least one owner.");
        _people.Remove(m);
        Log($"people remove {m.Name}");
        return PDone(true);
    }

    public Task<PageToolResult<bool>> LeaveWorkspace() =>
        PFail<bool>("A workspace needs at least one owner. Make someone else an owner first.");

    /// <summary>The sample knows two links: ".../invite/sample-invite" (a workspace) and ".../invite/sample-page" (one page); "sample-expired" is out of date; anything else is gone.</summary>
    public Task<PageToolResult<InviteLinkInfo>> LookUpInvite(string token) => token switch
    {
        "sample-invite" => PDone(new InviteLinkInfo("ws-sam", "Sam's workspace", "Sam Rivera", "demo@example.com", "member", false, null, false)),
        "sample-page" => PDone(new InviteLinkInfo("ws-sam", "Sam's workspace", "Sam Rivera", "demo@example.com", "member", false, "Q4 launch plan", true)),
        "sample-expired" => PDone(new InviteLinkInfo("ws-sam", "Sam's workspace", "Sam Rivera", "demo@example.com", "member", true, null, false)),
        _ => PFail<InviteLinkInfo>("This invite is no longer valid."),
    };

    public Task<PageToolResult<JoinedInfo>> AcceptInvite(string token)
    {
        if (token == "sample-expired") return PFail<JoinedInfo>("This invite has expired. Ask for a new one.");
        if (token is not ("sample-invite" or "sample-page")) return PFail<JoinedInfo>("This invite is no longer valid.");
        Log($"people accept {token}");
        return PDone(new JoinedInfo("ws-sam", token == "sample-page" ? "shared-q4" : null));
    }
}
