using System.Text.Json;
using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

/// <summary>Opening the app with a kept sign-in but no network (the PARITY row "Opens offline from a cold start"): the rules, without WinUI or the core's I/O.
/// The shell opens from what the core stored on this device (CachedWorkspaces / CachedTree / CachedTasks) and the session is restored again in the background.</summary>
internal static class OfflineStart
{
    /// <summary>The last signed-in user of a server, kept in settings: the core cannot say who a kept sign-in belongs to until the server has answered.</summary>
    public sealed record Kept(string Id, string Email, string Name, string Color, bool EmailVerified = true);

    public static string Encode(N.User u) => JsonSerializer.Serialize(new Kept(u.Id, u.Email, u.Name, u.Color, u.EmailVerified));

    public static Kept? Decode(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize<Kept>(json) is { Id.Length: > 0 } k ? k : null; } catch { return null; }
    }

    /// <summary>The user to open the shell as, or null to keep the old behaviour (the sign-in screen with "Try again"): only when the failure was the network and the device
    /// holds a stored workspace list. The core has no call that names the user of a kept sign-in before the server has answered (<c>User()</c> reads the live session only and
    /// <c>CachedWorkspaces</c> carries no owner), so without a kept record (an install that signed in before this build) the shell opens with a placeholder identity
    /// (<see cref="Unknown"/>, an empty id); the real user is filled in when the session comes back.</summary>
    public static N.User? Decide(Exception failure, int cachedWorkspaces, Kept? kept)
    {
        if (failure is not N.CoreException.Network || cachedWorkspaces <= 0) return null;
        if (kept is null) return Unknown;
        return kept.EmailVerified ? new N.User(kept.Id, kept.Email, kept.Name, kept.Color, true) : null;
    }

    /// <summary>Whose stored data it is, when nobody knows yet: an empty id, so nothing is "mine" until the session answers.</summary>
    public static readonly N.User Unknown = new("", "", "", "#6366f1", true);

    /// <summary>Whether the user has a real id (assignee "me", the task counts and presence need one).</summary>
    public static bool IsKnown(N.User? u) => u is { Id.Length: > 0 };

    /// <summary>The wait before the next try to restore the session: 5, 10, 20, 40 seconds, then a minute.</summary>
    public static TimeSpan RetryDelay(int attempt) => TimeSpan.FromSeconds(Math.Min(60, 5 * Math.Pow(2, Math.Clamp(attempt, 0, 6))));

    /// <summary>What a failed background try means: a rejected token ends the session (sign in again), anything else (still no network, a server error) tries again.</summary>
    public static bool GiveUp(bool tokenRejected) => tokenRejected;
}
