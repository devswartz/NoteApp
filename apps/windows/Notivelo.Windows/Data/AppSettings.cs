using System.Text.Json;

namespace Notivelo.Windows.Data;

/// <summary>Small per-user settings in %LOCALAPPDATA%\Notivelo\settings.json (works packaged and unpackaged): the server choice and
/// the last workspace per server. No secrets here; the refresh token lives in the Credential Locker.</summary>
internal static class AppSettings
{
    private sealed class Data
    {
        public bool Staging { get; set; }
        public Dictionary<string, string> Workspaces { get; set; } = new();
        public uint? PenColor { get; set; }
        public float? PenWidth { get; set; }
        public uint? HighlighterColor { get; set; }
        public float? HighlighterWidth { get; set; }
        /// <summary>The Calendar's view, kept on this device (the server stores no calendar filters): week or month, everyone's tasks or yours, the status select (0 open, 1 completed, 2 all).</summary>
        public bool CalendarWeek { get; set; }
        public bool CalendarEveryone { get; set; }
        public int CalendarStatus { get; set; }
    }

    private static readonly object Gate = new();
    private static Data? _data;

    public static string Folder
    {
        get
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Notivelo");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    private static string FilePath => Path.Combine(Folder, "settings.json");

    /// <summary>The offline sample mode (NOTIVELO_SOURCE=offline, the UI tests and look shots) starts from defaults and keeps its changes in memory only.</summary>
    private static bool Memory => Environment.GetEnvironmentVariable("NOTIVELO_SOURCE") == "offline";

    private static Data Load()
    {
        lock (Gate)
        {
            if (_data is not null) return _data;
            if (!Memory) try { _data = JsonSerializer.Deserialize<Data>(File.ReadAllText(FilePath)); } catch { }
            return _data ??= new Data();
        }
    }

    private static void Save()
    {
        if (Memory) return;
        lock (Gate) { try { File.WriteAllText(FilePath, JsonSerializer.Serialize(_data)); } catch { } }
    }

    public static bool Staging { get => Load().Staging; set { Load().Staging = value; Save(); } }

    public static uint? PenColor { get => Load().PenColor; set { Load().PenColor = value; Save(); } }
    public static float? PenWidth { get => Load().PenWidth; set { Load().PenWidth = value; Save(); } }
    public static uint? HighlighterColor { get => Load().HighlighterColor; set { Load().HighlighterColor = value; Save(); } }
    public static float? HighlighterWidth { get => Load().HighlighterWidth; set { Load().HighlighterWidth = value; Save(); } }

    public static bool CalendarWeek { get => Load().CalendarWeek; set { Load().CalendarWeek = value; Save(); } }
    public static bool CalendarEveryone { get => Load().CalendarEveryone; set { Load().CalendarEveryone = value; Save(); } }
    public static int CalendarStatus { get => Load().CalendarStatus; set { Load().CalendarStatus = value; Save(); } }

    public static string? Workspace(string server) => Load().Workspaces.GetValueOrDefault(server);

    public static void SetWorkspace(string server, string id) { Load().Workspaces[server] = id; Save(); }
}
