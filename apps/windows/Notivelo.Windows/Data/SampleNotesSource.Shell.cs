namespace Notivelo.Windows.Data;
using Tsk = System.Threading.Tasks.Task;

// Tree and shell polish on the sample data (PARITY batch 4): colours, reordering (with a place) and notebook sharing work in memory, so the menus and dialogs can be
// driven (the UI tests, the look screenshots) with no server. Every change is logged for the tests (NOTIVELO_OFFLINE_LOG).
public sealed partial class SampleNotesSource
{
    private readonly Dictionary<string, List<string>> _nbShares = new();

    /// <summary>NOTIVELO_FORCE_OFFLINE=1 makes the sample report a lost connection (the offline pill, the top bar's "Offline").</summary>
    public bool IsOffline => _forcedOffline;
    private readonly bool _forcedOffline = Environment.GetEnvironmentVariable("NOTIVELO_FORCE_OFFLINE") == "1";

    public Task<TreeResult> SetColor(TreeKind kind, string id, string hex)
    {
        if (kind == TreeKind.Notebook) Notebooks = Notebooks.Select(n => n.Id == id ? n with { ColorHex = hex } : n).ToList();
        else if (kind == TreeKind.Section) MapTree(s => s.Id == id ? s with { ColorHex = hex } : s);
        Log($"color {kind.ToString().ToLowerInvariant()} {id} {hex}");
        Raise();
        return Done();
    }

    private void InsertSection(string notebookId, string? parentId, Section sec, int? index)
    {
        List<Section> Put(IReadOnlyList<Section> list) { var l = list.ToList(); l.Insert(index is null ? l.Count : Math.Clamp(index.Value, 0, l.Count), sec); return l; }
        if (parentId is null) Notebooks = Notebooks.Select(n => n.Id == notebookId ? n with { Sections = Put(n.Sections) } : n).ToList();
        else MapTree(s => s.Id == parentId ? s with { Children = Put(s.Children) } : s);
    }

    public Task<TreeResult> MoveTo(TreeKind kind, string id, string notebookId, string? parentId, int? index)
    {
        switch (kind)
        {
            case TreeKind.Notebook:
                if (Notebooks.All(n => n.Id != id)) return Tsk.FromResult(new TreeResult(Error: "That notebook is gone."));
                Notebooks = ShellRules.Reorder(Notebooks, n => n.Id == id, index);
                break;
            case TreeKind.Page:
            {
                var host = AllSections().FirstOrDefault(x => x.S.Pages.Any(p => p.Id == id));
                var page = host.S?.Pages.FirstOrDefault(p => p.Id == id);
                if (page is null) return Tsk.FromResult(new TreeResult(Error: "That page is gone."));
                if (parentId is null) return Tsk.FromResult(new TreeResult(Error: "Pick a section."));
                MapTree(s => s.Id == host.S!.Id ? s with { Pages = s.Pages.Where(p => p.Id != id).ToList() } : s);
                MapTree(s =>
                {
                    if (s.Id != parentId) return s;
                    var l = s.Pages.ToList();
                    l.Insert(index is null ? l.Count : Math.Clamp(index.Value, 0, l.Count), page);
                    return s with { Pages = l };
                });
                break;
            }
            default:
            {
                var found = AllSections().FirstOrDefault(x => x.S.Id == id);
                if (found.S is null) return Tsk.FromResult(new TreeResult(Error: "That section is gone."));
                if (parentId == id || (parentId is not null && IsInside(found.S, parentId))) return Tsk.FromResult(new TreeResult(Error: "A section can't go inside itself."));
                Notebooks = Notebooks.Select(n => n with { Sections = n.Sections.Select(s => MapSec(s, x => x.Id == id ? null : x)).Where(s => s is not null).Select(s => s!).ToList() }).ToList();
                InsertSection(notebookId, parentId, found.S, index);
                break;
            }
        }
        Log($"move {kind.ToString().ToLowerInvariant()} {id} to {parentId ?? notebookId} at {(index?.ToString() ?? "end")}");
        Raise();
        return Done();
    }

    private NotebookSharesInfo NbSharesOf(string nb) =>
        new(Notebooks.FirstOrDefault(n => n.Id == nb)?.IsPrivate == true, Me, _nbShares.TryGetValue(nb, out var l) ? l.ToList() : new List<string>());

    public Task<PageToolResult<NotebookSharesInfo>> LoadNotebookShares(string notebookId) =>
        Notebooks.Any(n => n.Id == notebookId) ? PDone(NbSharesOf(notebookId)) : PFail<NotebookSharesInfo>("That notebook is gone.");

    public Task<PageToolResult<NotebookSharesInfo>> SetNotebookPrivate(string notebookId, bool isPrivate)
    {
        if (Notebooks.All(n => n.Id != notebookId)) return PFail<NotebookSharesInfo>("That notebook is gone.");
        Notebooks = Notebooks.Select(n => n.Id == notebookId ? n with { IsPrivate = isPrivate } : n).ToList();
        if (!isPrivate) _nbShares.Remove(notebookId);
        Log($"notebook {(isPrivate ? "private" : "shared")} {notebookId}");
        Raise();
        return PDone(NbSharesOf(notebookId));
    }

    public Task<PageToolResult<NotebookSharesInfo>> SetNotebookShares(string notebookId, IReadOnlyList<string> userIds)
    {
        if (Notebooks.All(n => n.Id != notebookId)) return PFail<NotebookSharesInfo>("That notebook is gone.");
        var ok = userIds.Where(u => _people.Any(m => m.Id == u && u != Me)).Distinct().ToList();
        _nbShares[notebookId] = ok;
        Log($"notebook shares {notebookId} {string.Join(",", ok)}");
        return PDone(NbSharesOf(notebookId));
    }
}
