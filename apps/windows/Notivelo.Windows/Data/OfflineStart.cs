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

    /// <summary>The user to open the shell as, or null to keep the old behaviour (the sign-in screen with "Try again"): only when the failure was the network, the device
    /// holds a stored workspace list and we know whose it is.</summary>
    public static N.User? Decide(Exception failure, int cachedWorkspaces, Kept? kept)
    {
        if (failure is not N.CoreException.Network || cachedWorkspaces <= 0 || kept is null || !kept.EmailVerified) return null;
        return new N.User(kept.Id, kept.Email, kept.Name, kept.Color, true);
    }

    /// <summary>The wait before the next try to restore the session: 5, 10, 20, 40 seconds, then a minute.</summary>
    public static TimeSpan RetryDelay(int attempt) => TimeSpan.FromSeconds(Math.Min(60, 5 * Math.Pow(2, Math.Clamp(attempt, 0, 6))));

    /// <summary>What a failed background try means: a rejected token ends the session (sign in again), anything else (still no network, a server error) tries again.</summary>
    public static bool GiveUp(bool tokenRejected) => tokenRejected;
}
