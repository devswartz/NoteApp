using Microsoft.UI.Xaml;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>What the shell's views share: the data source, the overlay layer, and the ways to open a page, a task, search or the Trash.</summary>
internal sealed class ShellHost
{
    public INotesSource Source { get; }
    public OverlayHost Overlay { get; }
    public Action<string> OpenPage { get; set; } = _ => { };
    public Action<string> OpenTask { get; set; } = _ => { };
    public Action OpenSearch { get; set; } = () => { };
    public Action OpenTrash { get; set; } = () => { };
    public Action<QuickAddDialog.Seed?> OpenQuickAdd { get; set; } = _ => { };
    public Action OpenSettings { get; set; } = () => { };
    public TreeActions Tree { get; }

    public ShellHost(INotesSource source, OverlayHost overlay)
    {
        Source = source; Overlay = overlay;
        Tree = new TreeActions(this);
    }

    public void Toast(string text, bool error = false)
    {
        Microsoft.UI.Xaml.Media.Brush B(string k) => ThemeBrushes.Get(k, Overlay);
        Overlay.Toast(text, error ? B("Danger") : B("Text"), B("BgElevated"), B("Border"));
    }
}

/// <summary>Create, rename, duplicate, move and delete on notebooks, sections and pages, through the source's tree calls (the core's, as Apple's TreeActions).
/// The menus are LOOK 4.9's: notebook options, section options, page options.</summary>
internal sealed class TreeActions
{
    private readonly ShellHost _h;
    public TreeActions(ShellHost host) => _h = host;
    private INotesSource S => _h.Source;
    private OverlayHost O => _h.Overlay;

    private async Task<string?> Run(Task<TreeResult> work, Action<TreeResult>? ok = null)
    {
        var r = await work;
        if (!r.Ok) return r.Error;
        ok?.Invoke(r);
        if (r.Note is not null) _h.Toast(r.Note);
        return null;
    }

    // ---- menus ----

    public void NotebookMenu(FrameworkElement anchor, Notebook nb) => PopupMenu.Show(O, new[]
    {
        new MenuEntry("New section", "folder-plus", () => NewSection(nb.Id, null)),
        new MenuEntry("Rename", "pencil", () => RenameDialog(TreeKind.Notebook, nb.Id, nb.Name)),
        MenuEntry.Sep(),
        new MenuEntry("Delete notebook", "trash", () => DeleteDialog(TreeKind.Notebook, nb.Id, nb.Name), Danger: true),
    }, anchor, endAlign: true, id: "menu-notebook");

    public void SectionMenu(FrameworkElement? anchor, Notebook? nb, Section s, global::Windows.Foundation.Point? at = null) => PopupMenu.Show(O, new[]
    {
        new MenuEntry("New page", "file-plus", () => NewPage(s.Id)),
        new MenuEntry("New subsection", "folder-plus", () => NewSection(nb?.Id ?? NotebookOf(s.Id) ?? "", s.Id)),
        new MenuEntry("Rename", "pencil", () => RenameDialog(TreeKind.Section, s.Id, s.Name)),
        new MenuEntry("Duplicate", "copy", () => Duplicate(TreeKind.Section, s.Id)),
        new MenuEntry("Move to…", "folder-input", () => MoveDialog(TreeKind.Section, s.Id, s.Name)),
        MenuEntry.Sep(),
        new MenuEntry("Delete section", "trash", () => DeleteDialog(TreeKind.Section, s.Id, s.Name), Danger: true),
    }, anchor, endAlign: true, at: at, id: "menu-section");

    public void PageMenu(FrameworkElement? anchor, PageSummary p, global::Windows.Foundation.Point? at = null) => PopupMenu.Show(O, new[]
    {
        new MenuEntry("Rename", "pencil", () => RenameDialog(TreeKind.Page, p.Id, p.Title == "Untitled" ? "" : p.Title)),
        new MenuEntry("Duplicate", "copy", () => Duplicate(TreeKind.Page, p.Id)),
        new MenuEntry("Move to…", "folder-input", () => MoveDialog(TreeKind.Page, p.Id, p.Title)),
        MenuEntry.Sep(),
        new MenuEntry("Delete page", "trash", () => DeleteDialog(TreeKind.Page, p.Id, p.Title), Danger: true),
    }, anchor, endAlign: true, at: at, id: "menu-page");

    /// <summary>The page-options "…" menu of the top bar, for the page that is open.</summary>
    public void PageMenuFor(FrameworkElement anchor, string pageId)
    {
        var p = FindPage(pageId);
        if (p is not null) PageMenu(anchor, p);
    }

    // ---- tree lookups ----

    private IEnumerable<(Section S, string NotebookId, string? ParentId)> Sections()
    {
        IEnumerable<(Section, string, string?)> Walk(Section s, string nb, string? parent)
        {
            yield return (s, nb, parent);
            foreach (var c in s.Children) foreach (var x in Walk(c, nb, s.Id)) yield return x;
        }
        foreach (var n in S.Notebooks) foreach (var s in n.Sections) foreach (var x in Walk(s, n.Id, null)) yield return x;
    }

    private string? NotebookOf(string sectionId) => Sections().FirstOrDefault(x => x.S.Id == sectionId).NotebookId;
    private PageSummary? FindPage(string id) => Sections().SelectMany(x => x.S.Pages).FirstOrDefault(p => p.Id == id);

    // ---- actions ----

    public void NewNotebook() => Dialogs.Prompt(O, "New notebook", "Name", "", "Create", name => Run(S.CreateNotebook(name)));

    public void NewSection(string notebookId, string? parentId) =>
        Dialogs.Prompt(O, parentId is null ? "New section" : "New subsection", "Name", "", "Create", name => Run(S.CreateSection(notebookId, parentId, name)));

    /// <summary>A new, untitled page in the section, opened at once.</summary>
    public async void NewPage(string sectionId)
    {
        var err = await Run(S.CreatePage(sectionId, ""), r => { if (r.Id is not null) _h.OpenPage(r.Id); });
        if (err is not null) _h.Toast(err, true);
    }

    public void RenameDialog(TreeKind kind, string id, string current) =>
        Dialogs.Prompt(O, "Rename " + kind.ToString().ToLowerInvariant(), kind == TreeKind.Page ? "Title" : "Name", current, "Rename", name => Run(S.Rename(kind, id, name)));

    public async void Duplicate(TreeKind kind, string id)
    {
        var err = await Run(S.Duplicate(kind, id), r => { if (kind == TreeKind.Page && r.Id is not null) _h.OpenPage(r.Id); });
        if (err is not null) _h.Toast(err, true);
    }

    public void DeleteDialog(TreeKind kind, string id, string name)
    {
        var what = kind.ToString().ToLowerInvariant();
        Dialogs.Confirm(O, $"Delete {what}?", $"“{name}” moves to the Trash. You can restore it from there for 60 days.", "Delete", true,
            () => Run(S.Delete(kind, id), _ => _h.Toast("Moved to the Trash")));
    }

    public void MoveDialog(TreeKind kind, string id, string name)
    {
        var dests = new List<Dialogs.Dest>();
        string? currentSection = Sections().FirstOrDefault(x => kind == TreeKind.Page ? x.S.Pages.Any(p => p.Id == id) : x.S.Id == id).ParentId;
        string? currentPageSection = kind == TreeKind.Page ? Sections().FirstOrDefault(x => x.S.Pages.Any(p => p.Id == id)).S?.Id : null;
        string? currentNotebook = kind == TreeKind.Section ? Sections().FirstOrDefault(x => x.S.Id == id).NotebookId : null;
        void Walk(IEnumerable<Section> list, string nb, int depth, bool skip)
        {
            foreach (var s in list)
            {
                if (kind == TreeKind.Section && s.Id == id) continue;   // not into itself or what it holds
                dests.Add(new Dialogs.Dest(s.Name, depth, true, nb, s.Id, Current: kind == TreeKind.Page ? s.Id == currentPageSection : s.Id == currentSection && nb == currentNotebook));
                Walk(s.Children, nb, depth + 1, skip);
            }
        }
        foreach (var n in S.Notebooks)
        {
            dests.Add(new Dialogs.Dest(n.Name, 0, kind == TreeKind.Section, n.Id, null, Current: kind == TreeKind.Section && n.Id == currentNotebook && currentSection is null));
            Walk(n.Sections, n.Id, 1, false);
        }
        Dialogs.Pick(O, $"Move “{name}” to…", dests, d => Run(S.Move(kind, id, d.NotebookId, d.SectionId), _ => _h.Toast("Moved")));
    }
}
