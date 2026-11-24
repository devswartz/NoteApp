using System.Globalization;

namespace Notivelo.Windows.Data;

// Models and pure rules for the notification inbox, the save state, the public share link and account deletion (Apple's Inbox.swift, AppBadge.swift, SettingsAccount).

/// <summary>One notification of the inbox. <see cref="ActorName"/> is the person who caused it (none for a reminder).</summary>
public sealed record InboxItem(
    string Id, string Kind, string? ActorName, string? ActorColor, string Title, string Body, string CreatedAt, bool IsRead, string? WorkspaceId, string? PageId, string? TaskId);

public sealed record InboxPage(IReadOnlyList<InboxItem> Items, int Unread, string? NextBefore);

/// <summary>What the page bar says about saving: Saved, Saving (edits not yet confirmed), Offline, Offline with edits kept on the device.</summary>
public enum SaveState { Saved, Saving, Offline, OfflineKept }

/// <summary>What deleting the account would do (the server's preview).</summary>
public sealed record DeletionPreviewInfo(
    IReadOnlyList<string> Deleted, IReadOnlyList<(string Name, string NewOwner)> Transferred, IReadOnlyList<string> SharedOwnership, IReadOnlyList<string> Left, int PrivateNotebooks);

public static class AuditRules
{
    public static SaveState SaveOf(bool offline, long unsentUpdates, int unsentPages)
    {
        var unsent = unsentUpdates > 0 || unsentPages > 0;
        return offline ? (unsent ? SaveState.OfflineKept : SaveState.Offline) : unsent ? SaveState.Saving : SaveState.Saved;
    }

    /// <summary>What the bar shows now: the polled state, read against whether the connection is down at this moment.</summary>
    public static SaveState Combine(bool offline, SaveState polled) =>
        offline ? (polled is SaveState.Saving or SaveState.OfflineKept ? SaveState.OfflineKept : SaveState.Offline) : polled is SaveState.Saving ? SaveState.Saving : SaveState.Saved;

    public static string SaveText(SaveState s) => s switch
    {
        SaveState.Saving => "Saving…", SaveState.Offline => "Offline", SaveState.OfflineKept => "Offline — changes kept", _ => "Saved",
    };

    /// <summary>"6 minutes ago" (the web's formatDistanceToNow with a suffix).</summary>
    public static string Ago(string iso, DateTimeOffset now)
    {
        if (!DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)) return "";
        var s = (now - t).TotalSeconds;
        if (s < 45) return "less than a minute ago";
        string N(double n, string unit) { var r = (int)Math.Round(n); return r + " " + unit + (r == 1 ? "" : "s") + " ago"; }
        if (s < 90) return "1 minute ago";
        if (s < 45 * 60) return N(s / 60, "minute");
        if (s < 90 * 60) return "about 1 hour ago";
        if (s < 22 * 3600) return "about " + N(s / 3600, "hour");
        if (s < 36 * 3600) return "1 day ago";
        if (s < 26 * 86400) return N(s / 86400, "day");
        if (s < 330 * 86400) return "about " + N(s / (30 * 86400.0), "month");
        return N(s / (365 * 86400.0), "year");
    }

    /// <summary>The taskbar badge's XML (the numeric badge template).</summary>
    public static string BadgeXml(int count) => "<badge value=\"" + count.ToString(CultureInfo.InvariantCulture) + "\"/>";

    public static string BellLabel(int unread) => unread > 0 ? $"Notifications, {unread} unread" : "Notifications";
    public static string BadgeText(int unread) => unread > 99 ? "99+" : unread.ToString(CultureInfo.InvariantCulture);

    public static string InboxIcon(string kind) => kind switch
    {
        "mention" => "at-sign", "comment" => "message-square", "shared" => "share-2", "invite" => "user-plus", "assigned" => "user-plus", "reminder" => "alarm-clock", _ => "bell",
    };

    /// <summary>Mark one read in a loaded list (the list and count follow at once; the server is told after).</summary>
    public static (IReadOnlyList<InboxItem> Items, int Unread) MarkRead(IReadOnlyList<InboxItem> items, int unread, string id)
    {
        var i = items.ToList().FindIndex(x => x.Id == id);
        if (i < 0 || items[i].IsRead) return (items, unread);
        var copy = items.ToList(); copy[i] = copy[i] with { IsRead = true };
        return (copy, Math.Max(0, unread - 1));
    }

    public static (IReadOnlyList<InboxItem> Items, int Unread) MarkAll(IReadOnlyList<InboxItem> items) => (items.Select(x => x with { IsRead = true }).ToList(), 0);

    /// <summary>Older items joined below the loaded ones, none twice.</summary>
    public static IReadOnlyList<InboxItem> Append(IReadOnlyList<InboxItem> have, IReadOnlyList<InboxItem> more)
    {
        var ids = have.Select(x => x.Id).ToHashSet();
        return have.Concat(more.Where(x => !ids.Contains(x.Id))).ToList();
    }

    /// <summary>The sentences of the delete-account dialog, from the preview.</summary>
    public static IReadOnlyList<string> DeletionLines(DeletionPreviewInfo p)
    {
        var l = new List<string>();
        foreach (var w in p.Deleted) l.Add($"“{w}” will be deleted for everyone: you are its only member who can run it.");
        foreach (var (name, owner) in p.Transferred) l.Add($"“{name}” will go to {owner}, who becomes its owner.");
        foreach (var w in p.SharedOwnership) l.Add($"“{w}” has another owner and carries on without you.");
        foreach (var w in p.Left) l.Add($"You will be removed from “{w}”.");
        if (p.PrivateNotebooks > 0) l.Add($"{p.PrivateNotebooks} private notebook{(p.PrivateNotebooks == 1 ? "" : "s")} and everything in {(p.PrivateNotebooks == 1 ? "it" : "them")} will be deleted.");
        return l;
    }

    /// <summary>The share link's address, shown in full and copied as is.</summary>
    public static bool LooksLikeLink(string? url) => url is { Length: > 8 } && (url.StartsWith("https://", StringComparison.Ordinal) || url.StartsWith("http://", StringComparison.Ordinal));
}
