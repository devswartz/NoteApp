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

    private static Data Load()
    {
        lock (Gate)
        {
            if (_data is not null) return _data;
            try { _data = JsonSerializer.Deserialize<Data>(File.ReadAllText(FilePath)); } catch { }
            return _data ??= new Data();
        }
    }

    private static void Save()
    {
        lock (Gate) { try { File.WriteAllText(FilePath, JsonSerializer.Serialize(_data)); } catch { } }
    }

    public static bool Staging { get => Load().Staging; set { Load().Staging = value; Save(); } }

    public static string? Workspace(string server) => Load().Workspaces.GetValueOrDefault(server);

    public static void SetWorkspace(string server, string id) { Load().Workspaces[server] = id; Save(); }
}
