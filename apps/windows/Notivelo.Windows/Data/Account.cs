using System.Globalization;
using System.Text.RegularExpressions;

namespace Notivelo.Windows.Data;

// The account calls of the core (profile, password, notification settings, connected apps). Online only: offline an answer says so and nothing changes.

public sealed record AccountProfile(string Name, string Email, string Color);

public sealed record NotificationPrefs(string TimeZone, bool EmailEnabled, string DefaultReminderTime, bool DigestEnabled, string DigestTime);

/// <summary>What to change: a field left null stays as it is.</summary>
public sealed record NotificationChange(string? TimeZone = null, bool? EmailEnabled = null, string? DefaultReminderTime = null, bool? DigestEnabled = null, string? DigestTime = null);

public sealed record ConnectedAppInfo(string ClientId, string Name, string Access, string ConnectedAt, string? LastUsed);

/// <summary>The outcome of an account call: the value, or one quiet reason. <see cref="Offline"/> (no server) is not an error to shout about;
/// <see cref="Code"/> is the server's stable code (e.g. wrong_password).</summary>
public sealed record AccountResult<T>(T? Value = default, string? Error = null, bool Offline = false, string? Code = null)
{
    public bool Ok => Error is null && !Offline;
    public static AccountResult<T> Off() => new(Offline: true);
}

/// <summary>The rules the Settings forms check before asking the server (the server checks again).</summary>
public static class AccountRules
{
    public const string OfflineText = "Offline";
    public const string OfflineDetail = "Offline: nothing was changed. Try again when you are connected.";

    public static readonly string[] Swatches =
    {
        "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e", "#14b8a6",
        "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899", "#64748b",
    };

    public static string Initials(string name, string email)
    {
        var parts = name.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length >= 2) return (parts[0][..1] + parts[^1][..1]).ToUpperInvariant();
        if (parts.Length == 1) return parts[0][..Math.Min(2, parts[0].Length)].ToUpperInvariant();
        return string.IsNullOrEmpty(email) ? "?" : email[..1].ToUpperInvariant();
    }

    /// <summary>A display name: 1 to 100 characters after trimming. Null when fine.</summary>
    public static string? NameProblem(string name)
    {
        var n = name.Trim();
        if (n.Length == 0) return "Enter a name.";
        if (n.Length > 100) return "Use at most 100 characters.";
        return null;
    }

    public static string? PasswordProblem(string current, string next)
    {
        if (current.Length == 0) return "Enter your current password.";
        if (next.Length < 8) return "The new password needs at least 8 characters.";
        if (next == current) return "Choose a password that differs from the current one.";
        return null;
    }

    /// <summary>"9:5", "9.30", "0930" and "09:30" to "09:30"; null when it is not a time of day.</summary>
    public static string? NormalizeTime(string text)
    {
        var m = Regex.Match(text.Trim(), @"^(?:(\d{1,2})[:.](\d{1,2})|(\d{2})(\d{2}))$");
        if (!m.Success) return null;
        var h = int.Parse(m.Groups[m.Groups[1].Success ? 1 : 3].Value, CultureInfo.InvariantCulture);
        var mi = int.Parse(m.Groups[m.Groups[2].Success ? 2 : 4].Value, CultureInfo.InvariantCulture);
        return h is >= 0 and <= 23 && mi is >= 0 and <= 59 ? $"{h:00}:{mi:00}" : null;
    }

    /// <summary>"notes:read" / "notes:write" as the words on a connected app's row.</summary>
    public static string AccessLabel(IEnumerable<string> scopes)
    {
        var s = scopes.ToHashSet();
        if (s.Contains("notes:write")) return "Read and write notes";
        if (s.Contains("notes:read")) return "Read notes";
        return "No access";
    }

    /// <summary>An ISO instant as a short date ("12 Nov 2026"); the text itself when it does not parse.</summary>
    public static string DateLabel(string iso) =>
        DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d.ToLocalTime().ToString("d MMM yyyy", CultureInfo.InvariantCulture) : iso;

    public static readonly string[] TimeZones =
    {
        "UTC", "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam",
        "Europe/Athens", "Europe/Istanbul", "Europe/Moscow", "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos", "Asia/Dubai", "Asia/Karachi",
        "Asia/Kolkata", "Asia/Dhaka", "Asia/Bangkok", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul",
        "Australia/Perth", "Australia/Sydney", "Pacific/Auckland", "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver",
        "America/Chicago", "America/New_York", "America/Toronto", "America/Halifax", "America/Sao_Paulo", "America/Argentina/Buenos_Aires", "America/Mexico_City",
    };

    /// <summary>The zones to offer: the list, plus the current one when it is not in it.</summary>
    public static IReadOnlyList<string> ZonesWith(string current) =>
        current.Length == 0 || TimeZones.Contains(current) ? TimeZones : TimeZones.Append(current).ToArray();
}
