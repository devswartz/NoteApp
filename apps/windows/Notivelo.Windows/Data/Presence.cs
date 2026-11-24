using System.Text.Json;

namespace Notivelo.Windows.Data;

/// <summary>Someone else who has the page open (the web's PagePresence): one entry per person, even with several devices.</summary>
public sealed record PagePerson(string Id, string Name, string Color, bool CanEdit, int Sessions);

/// <summary>The XAML-free rules of presence: the core's states (JSON <c>{"user":{id,name,color,canEdit}}</c>, one per open copy of the page) to the people shown.</summary>
public static class PresenceRules
{
    /// <summary>Everyone but <paramref name="me"/>, sorted by name; two devices of one person make one entry (editing if either edits).</summary>
    public static IReadOnlyList<PagePerson> From(IEnumerable<string> states, string? me)
    {
        var by = new Dictionary<string, PagePerson>();
        foreach (var s in states)
        {
            try
            {
                using var doc = JsonDocument.Parse(s);
                if (!doc.RootElement.TryGetProperty("user", out var u) || u.ValueKind != JsonValueKind.Object) continue;
                if (!u.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.String) continue;
                var id = idEl.GetString() ?? "";
                if (id.Length == 0 || id == me) continue;
                var canEdit = !(u.TryGetProperty("canEdit", out var ce) && ce.ValueKind == JsonValueKind.False);
                if (by.TryGetValue(id, out var known)) { by[id] = known with { Sessions = known.Sessions + 1, CanEdit = known.CanEdit || canEdit }; continue; }
                var name = u.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(n.GetString()) ? n.GetString()! : "Someone";
                var color = u.TryGetProperty("color", out var c) && c.ValueKind == JsonValueKind.String && c.GetString() is { Length: 7 } hex && hex[0] == '#' ? hex : "#888888";
                by[id] = new PagePerson(id, name, color, canEdit, 1);
            }
            catch (JsonException) { }
        }
        return by.Values.OrderBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
    }

    /// <summary>The label of the avatar stack: "Sam is here" or "3 people are here".</summary>
    public static string Label(IReadOnlyList<PagePerson> people) => people.Count == 1 ? people[0].Name + " is here" : people.Count + " people are here";

    /// <summary>How many avatars show of <paramref name="count"/> people with room for <paramref name="max"/> circles (the last one is "+N" when there are more).</summary>
    public static int Shown(int count, int max) => count > max ? max - 1 : count;

    public static string Role(PagePerson p) => (p.CanEdit ? "editing" : "viewing") + (p.Sessions > 1 ? " · " + p.Sessions + " devices" : "");

    public static bool Same(IReadOnlyList<PagePerson> a, IReadOnlyList<PagePerson> b) => a.Count == b.Count && a.Zip(b).All(x => x.First == x.Second);
}
