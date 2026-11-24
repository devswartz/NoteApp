using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Notivelo.Windows.Data;

// Page tools (PARITY batch 2): comments, version history, page sharing, locked pages, Markdown export, page icons. Plain records for the dialogs and the
// pure rules behind them (the unit tests compile this file without WinUI). The sources fill the records from the core's calls (comments, versions, sharing,
// locked) or from memory (the offline sample).

/// <summary>The outcome of a page-tool call: the value, or one sentence for the screen.</summary>
public sealed record PageToolResult<T>(T? Value = default, string? Error = null)
{
    public bool Ok => Error is null;
    public static PageToolResult<T> Fail(string error) => new(default, error);
}

public sealed record CommentInfo(string Id, string AuthorId, string Author, string? AuthorColor, string Body, string When, bool Edited, bool Mine, bool CanChange);

/// <summary>A comment thread as the panel shows it: the quoted text, who may delete it, its comments (oldest first).</summary>
public sealed record CommentThreadInfo(string Id, string Quote, bool Resolved, string? ResolvedLine, bool CanDelete, IReadOnlyList<CommentInfo> Comments);

public sealed record VersionInfo(string Id, string When, string Who, string Detail);

public sealed record ShareEntry(string UserId, string Name, string Email, string Color, bool CanEdit, bool Member, bool ViewerOnly);
public sealed record InviteEntry(string Email, bool CanEdit);
public sealed record PageSharesInfo(IReadOnlyList<ShareEntry> Shares, IReadOnlyList<InviteEntry> Invites);

/// <summary>What sharing did: Status "shared" or "invited" (then <see cref="InviteUrl"/> is a link to copy), and the lists as they are now.</summary>
public sealed record ShareOutcome(PageSharesInfo Shares, string Status, bool Emailed, string? InviteUrl);

public sealed record MemberInfo(string Id, string Name, string Email, string Color, string Role);

/// <summary>A page someone shared with you (the sidebar's "Shared with me").</summary>
public sealed record SharedPageInfo(string Id, string Title, string? Icon, string WorkspaceId, string WorkspaceName, bool CanEdit, string? SharedBy);

/// <summary>The locked-pages state of this sign-in: a password is set, and the locked pages are open now.</summary>
public sealed record LockInfo(bool HasPassword, bool Unlocked);

/// <summary>The pure rules of the page tools.</summary>
public static class PageToolRules
{
    /// <summary>A file name from a page title: no path characters, "Untitled" when empty, at most 80 characters, ending .md.</summary>
    public static string ExportFileName(string title)
    {
        var bad = new HashSet<char>("/\\:*?\"<>|\n\r");
        var cleaned = new string(title.Select(c => bad.Contains(c) ? ' ' : c).ToArray()).Trim();
        if (cleaned.Length == 0) cleaned = "Untitled";
        if (cleaned.Length > 80) cleaned = cleaned[..80].TrimEnd();
        return cleaned + ".md";
    }

    public static bool LooksLikeEmail(string s)
    {
        var t = s.Trim();
        var parts = t.Split('@');
        if (parts.Length != 2 || parts[0].Length == 0 || t.Contains(' ')) return false;
        var host = parts[1];
        return host.Contains('.') && !host.StartsWith('.') && !host.EndsWith('.');
    }

    /// <summary>The locked-pages password: 6 to 72 bytes (the core's rule). Null when fine.</summary>
    public static string? PasswordProblem(string first, string again)
    {
        var n = Encoding.UTF8.GetByteCount(first);
        if (n < 6) return "Use at least 6 characters.";
        if (n > 72) return "Use at most 72 characters.";
        if (first != again) return "The two passwords differ.";
        return null;
    }

    /// <summary>"12 Nov 2026, 14:30" in local time; the text itself when it isn't a date.</summary>
    public static string WhenLabel(string iso) =>
        DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d.ToLocalTime().ToString("d MMM yyyy, HH:mm", CultureInfo.InvariantCulture) : iso;

    /// <summary>"5 minutes ago", "2 hours ago", "3 days ago" (a date after a month).</summary>
    public static string Ago(string iso, DateTimeOffset? now = null)
    {
        if (!DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)) return "";
        var d = (now ?? DateTimeOffset.UtcNow) - t;
        static string Plural(double n, string unit) => $"{(int)n} {unit}{((int)n == 1 ? "" : "s")} ago";
        if (d.TotalSeconds < 45) return "just now";
        if (d.TotalMinutes < 60) return Plural(Math.Max(1, d.TotalMinutes), "minute");
        if (d.TotalHours < 24) return Plural(d.TotalHours, "hour");
        if (d.TotalDays < 31) return Plural(d.TotalDays, "day");
        return t.ToLocalTime().ToString("d MMM yyyy", CultureInfo.InvariantCulture);
    }

    /// <summary>The words after a version's author: "auto" saves say nothing, "manual" is "saved", "restore" is "before restore".</summary>
    public static string VersionTag(string reason) => reason switch { "restore" => " · before restore", "manual" => " · saved", _ => "" };

    public sealed record Piece(string Text, string? MentionId = null);

    private static readonly Regex Mention = new(@"@\[([^\]\n]{1,100})\]\(([0-9a-fA-F-]{36})\)", RegexOptions.Compiled);

    /// <summary>A comment's text split into plain runs and @mentions (stored as <c>@[Name](id)</c>).</summary>
    public static IReadOnlyList<Piece> Pieces(string body)
    {
        var list = new List<Piece>();
        var last = 0;
        foreach (Match m in Mention.Matches(body))
        {
            if (m.Index > last) list.Add(new Piece(body[last..m.Index]));
            list.Add(new Piece("@" + m.Groups[1].Value, m.Groups[2].Value));
            last = m.Index + m.Length;
        }
        if (last < body.Length) list.Add(new Piece(body[last..]));
        return list;
    }

    /// <summary>The "@word" at the end of the text (null when there is none): what the @ menu filters on.</summary>
    public static string? MentionQuery(string text)
    {
        var m = Regex.Match(text, @"(^|\s)@([\w.\-]{0,30})$");
        return m.Success ? m.Groups[2].Value : null;
    }

    /// <summary>The text with its trailing "@word" replaced by the mention token and a space.</summary>
    public static string InsertMention(string text, string name, string id)
    {
        var q = MentionQuery(text);
        var head = q is null ? text : text[..^(q.Length + 1)];
        return head + $"@[{name}]({id}) ";
    }

    /// <summary>The page as Markdown for the offline sample (the core's <c>page_markdown</c> does it for a real page).</summary>
    public static string Markdown(NotePage page)
    {
        var sb = new StringBuilder();
        sb.Append("# ").Append(page.Title).Append("\n\n");
        foreach (var box in page.Boxes.OrderBy(b => b.Y).ThenBy(b => b.X))
        {
            foreach (var b in box.Blocks)
            {
                var text = b.Text;
                switch (b.Kind)
                {
                    case BlockKind.Heading1: sb.Append("# ").Append(text).Append("\n\n"); break;
                    case BlockKind.Heading2: sb.Append("## ").Append(text).Append("\n\n"); break;
                    case BlockKind.Heading3: sb.Append("### ").Append(text).Append("\n\n"); break;
                    case BlockKind.Task: sb.Append(b.Task is { } t ? $"- [{(t.Done ? "x" : " ")}] {t.Title}\n" : "- [ ] \n"); break;
                    case BlockKind.ListItem: sb.Append(new string(' ', 2 * b.Indent)).Append("- ").Append(text).Append('\n'); break;
                    case BlockKind.CheckItem: sb.Append("- [").Append(b.Checked ? "x" : " ").Append("] ").Append(text).Append('\n'); break;
                    case BlockKind.Quote: sb.Append("> ").Append(text).Append("\n\n"); break;
                    case BlockKind.Code: sb.Append("```\n").Append(text).Append("\n```\n\n"); break;
                    case BlockKind.Rule: sb.Append("---\n\n"); break;
                    default: sb.Append(text).Append("\n\n"); break;
                }
            }
        }
        return sb.ToString().TrimEnd() + "\n";
    }

    /// <summary>The curated page icons (the web's list, as Apple's IconPicker) with their search words.</summary>
    public static readonly IReadOnlyList<(string Emoji, string Words)> Icons = new (string, string)[]
    {
        ("\U0001F4C4", "page document doc"), ("\U0001F4DD", "memo note write"), ("\U0001F4D3", "notebook"), ("\U0001F4D2", "ledger notebook"), ("\U0001F4DA", "books library"),
        ("\U0001F4CC", "pin"), ("\U0001F4CE", "clip attachment"), ("\U0001F5C2️", "folders index"), ("\U0001F5D3️", "calendar date"), ("⏰", "alarm clock time"),
        ("✅", "done check tick"), ("☑️", "checkbox"), ("\U0001F3AF", "goal target"), ("\U0001F680", "launch rocket ship"), ("\U0001F4A1", "idea bulb"),
        ("\U0001F525", "fire hot"), ("⭐", "star favourite"), ("❤️", "heart love"), ("⚠️", "warning"), ("❗", "important"),
        ("❓", "question"), ("\U0001F512", "lock private secret"), ("\U0001F511", "key password"), ("\U0001F6E0️", "tools build"), ("⚙️", "settings gear"),
        ("\U0001F41B", "bug"), ("\U0001F4BB", "computer laptop code"), ("\U0001F9EA", "test experiment"), ("\U0001F4CA", "chart bar stats"), ("\U0001F4C8", "growth up chart"),
        ("\U0001F4B0", "money budget"), ("\U0001F4B3", "card payment"), ("\U0001F9FE", "receipt invoice"), ("\U0001F3E0", "home house"), ("\U0001F3E2", "office work"),
        ("✈️", "travel plane flight"), ("\U0001F30D", "world globe"), ("\U0001F37D️", "food meal recipe"), ("☕", "coffee"), ("\U0001F3CB️", "gym workout"),
        ("\U0001F9D8", "health calm"), ("\U0001F3A8", "design art"), ("\U0001F3B5", "music"), ("\U0001F3AC", "film movie video"), ("\U0001F4F7", "photo camera"),
        ("\U0001F389", "party celebrate"), ("\U0001F381", "gift"), ("\U0001F465", "team people"), ("\U0001F91D", "meeting deal"), ("\U0001F4AC", "chat discussion"),
        ("\U0001F4E3", "announce"), ("\U0001F4E7", "email mail"), ("\U0001F4DE", "phone call"), ("\U0001F9E0", "brain think"), ("\U0001F4D6", "read book"),
        ("\U0001F331", "plant growth"), ("\U0001F31F", "sparkle"), ("\U0001F9ED", "compass direction"), ("\U0001F5FA️", "map roadmap"), ("\U0001F3C1", "finish flag"),
    };

    /// <summary>The icons whose words contain the query (all of them for an empty query).</summary>
    public static IReadOnlyList<(string Emoji, string Words)> FilterIcons(string query)
    {
        var q = query.Trim().ToLowerInvariant();
        return q.Length == 0 ? Icons : Icons.Where(i => i.Words.Contains(q)).ToList();
    }

    /// <summary>Typed or pasted text that is one emoji (so Enter can use it directly). Null when it isn't one.</summary>
    public static string? AsEmoji(string text)
    {
        var t = text.Trim();
        if (t.Length == 0 || t.Length > 16) return null;
        var ok = false;
        for (var i = 0; i < t.Length; i++)
        {
            var cp = char.ConvertToUtf32(t, i);
            if (char.IsHighSurrogate(t[i])) i++;
            if (cp >= 0x1F000 || (cp >= 0x2190 && cp <= 0x2BFF && cp != 0x2022)) ok = true;
            else if (cp is 0xFE0F or 0x200D or 0x20E3) { }
            else if (!ok) return null;
        }
        return ok ? t : null;
    }
}
