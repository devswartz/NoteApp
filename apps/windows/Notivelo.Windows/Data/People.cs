namespace Notivelo.Windows.Data;

// People (PARITY batch 3): sign-up, the check-email screen, workspace members, roles, email invites and invite links. Plain records for the dialogs and the pure
// rules behind them (the unit tests compile this file without WinUI). The wording and rules are Apple's (Shell/Members.swift, SessionModel.register).

public sealed record PendingInviteInfo(string Email, string Role, string? ExpiresAt);

/// <summary>The workspace's members and (owners and admins only) its pending invites.</summary>
public sealed record PeopleInfo(IReadOnlyList<MemberInfo> Members, IReadOnlyList<PendingInviteInfo> Invites);

/// <summary>What an invite did: Status "added" (a member now) or "invited" (a link was made: <see cref="InviteUrl"/> is shown to be copied, mailed or not).</summary>
public sealed record InviteOutcome(string Status, bool Emailed, string? InviteUrl);

/// <summary>What an invite link is for, before accepting it. <see cref="PageTitle"/> is set for an invite to one page.</summary>
public sealed record InviteLinkInfo(string WorkspaceId, string WorkspaceName, string InvitedBy, string Email, string Role, bool Expired, string? PageTitle, bool PageCanEdit);

/// <summary>Where an accepted invite led: the shared page (single-page invite) or just the workspace.</summary>
public sealed record JoinedInfo(string WorkspaceId, string? PageId);

/// <summary>The pure rules of the people screens.</summary>
public static class PeopleRules
{
    public static readonly string[] AllRoles = { "owner", "admin", "member", "viewer" };

    /// <summary>The sign-up form's problem as one sentence (Apple's SessionModel.register), or null when it can be sent.</summary>
    public static string? SignUpProblem(string name, string email, string password)
    {
        if (name.Trim().Length == 0 || email.Trim().Length == 0 || password.Length == 0) return "Enter your name, email and a password.";
        if (!PageToolRules.LooksLikeEmail(email)) return "Enter a valid email address.";
        if (password.Length < 8 || password.Length > 72) return "Use a password of 8 to 72 characters.";
        return null;
    }

    public static bool CanManage(string? role) => role is "owner" or "admin";

    /// <summary>The roles the signed-in person may give: only an owner makes an owner.</summary>
    public static IReadOnlyList<string> RolesFor(string? myRole) =>
        myRole == "owner" ? AllRoles : AllRoles.Where(r => r != "owner").ToArray();

    /// <summary>Whether a member's role can be changed or the member removed by the signed-in person: not yourself, and only an owner touches an owner.</summary>
    public static bool CanEditMember(string? myRole, string memberRole, bool isMe) => CanManage(myRole) && !isMe && (memberRole != "owner" || myRole == "owner");

    public static string RoleLabel(string role) => role.Length == 0 ? role : char.ToUpperInvariant(role[0]) + role[1..];

    /// <summary>The token of a pasted invite link (<c>.../invite/&lt;token&gt;</c>) or the token itself; empty for nothing.</summary>
    public static string TokenFromLink(string text)
    {
        var t = text.Trim();
        if (t.Length == 0) return "";
        if (Uri.TryCreate(t, UriKind.Absolute, out var u))
        {
            var parts = u.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            var i = Array.FindIndex(parts, p => p is "invite" or "invites");
            if (i >= 0 && i + 1 < parts.Length) return parts[i + 1];
            return parts.Length > 0 ? parts[^1] : "";
        }
        var cut = t.IndexOfAny(new[] { '?', '#' });
        if (cut >= 0) t = t[..cut];
        return t.TrimEnd('/').Split('/').LastOrDefault() ?? "";
    }

    /// <summary>The toast after inviting (Apple's wording).</summary>
    public static string InvitedToast(InviteOutcome r, string email) =>
        r.Status == "invited" ? (r.Emailed ? $"Invite sent to {email}. You can also copy the link." : $"Invite created for {email}: copy the link.") : $"{email} is a member now";

    public static string ResentToast(InviteOutcome r, string email) => r.Emailed ? $"Invite sent again to {email}" : $"New link made for {email}: copy it.";
}
