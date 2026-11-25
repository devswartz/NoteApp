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
    /// <summary>Open Settings on a section ("ws-general", "ws-teams", "ws-tags", "ws-activity", ...).</summary>
    public Action<string> OpenSettingsAt { get; set; } = _ => { };
    public Action OpenShortcuts { get; set; } = () => { };
    public TreeActions Tree { get; }
    public InboxState Inbox { get; }

    public ShellHost(INotesSource source, OverlayHost overlay)
    {
        Source = source; Overlay = overlay;
        Tree = new TreeActions(this);
        Inbox = new InboxState(source);
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

    public void NotebookMenu(FrameworkElement anchor, Notebook nb)
    {
        var items = new List<MenuEntry>
        {
            new("New section", "folder-plus", () => NewSection(nb.Id, null)),
            new("Rename", "pencil", () => RenameDialog(TreeKind.Notebook, nb.Id, nb.Name)),
            new("Share with people…", "user-plus", () => NotebookShareDialog.Show(_h, nb.Id, nb.Name), Id: "menu-notebook-share"),
            new(nb.IsPrivate ? "Share with workspace" : "Make private", "lock", () => SetPrivate(nb.Id, !nb.IsPrivate), Id: "menu-notebook-visibility"),
        };
        AddMoveSteps(items, TreeKind.Notebook, nb.Id);
        items.Add(MenuEntry.Colours(nb.ColorHex, c => Recolour(TreeKind.Notebook, nb.Id, c)));
        items.Add(MenuEntry.Sep());
        items.Add(new("Delete notebook", "trash", () => DeleteDialog(TreeKind.Notebook, nb.Id, nb.Name), Danger: true));
        PopupMenu.Show(O, items, anchor, endAlign: false, id: "menu-notebook");
    }

    public void SectionMenu(FrameworkElement? anchor, Notebook? nb, Section s, global::Windows.Foundation.Point? at = null)
    {
        var items = new List<MenuEntry>
        {
            new("New page", "file-plus", () => NewPage(s.Id)),
            new("New page from template…", "layout-template", () => TemplatePicker.Show(_h, s.Id, s.Name), Id: "menu-new-from-template"),
            new("Default template…", "file-cog", () => TemplateManager.Default(_h, s.Id, s.Name), Id: "menu-default-template"),
            new("Manage templates…", "layout-template", () => TemplateManager.Manage(_h, s.Id, s.Name), Id: "menu-manage-templates"),
            new("New subsection", "folder-plus", () => NewSection(nb?.Id ?? NotebookOf(s.Id) ?? "", s.Id)),
            new("Rename", "pencil", () => RenameDialog(TreeKind.Section, s.Id, s.Name)),
            new("Duplicate", "copy", () => Duplicate(TreeKind.Section, s.Id)),
            new("Move to…", "folder-input", () => MoveDialog(TreeKind.Section, s.Id, s.Name)),
        };
        AddMoveSteps(items, TreeKind.Section, s.Id);
        items.Add(MenuEntry.Colours(s.ColorHex, c => Recolour(TreeKind.Section, s.Id, c)));
        items.Add(MenuEntry.Sep());
        items.Add(new("Delete section", "trash", () => DeleteDialog(TreeKind.Section, s.Id, s.Name), Danger: true));
        PopupMenu.Show(O, items, anchor, endAlign: false, at: at, id: "menu-section");
    }

    public void PageMenu(FrameworkElement? anchor, PageSummary p, global::Windows.Foundation.Point? at = null, bool current = false)
    {
        var items = new List<MenuEntry>
        {
            new("Rename", "pencil", () => RenameDialog(TreeKind.Page, p.Id, p.Title == "Untitled" ? "" : p.Title)),
            new("Change icon", "star", () => PageDialogs.IconPicker(_h, p.Id, !string.IsNullOrEmpty(p.Emoji)), Id: "menu-page-icon"),
        };
        if (!p.Locked) items.Add(new("Duplicate", "copy", () => Duplicate(TreeKind.Page, p.Id)));
        items.Add(new("Move to…", "folder-input", () => MoveDialog(TreeKind.Page, p.Id, p.Title)));
        AddMoveSteps(items, TreeKind.Page, p.Id);
        items.Add(MenuEntry.Sep());
        if (!p.Locked) items.Add(new("Share…", "user-plus", () => PageDialogs.Share(_h, p.Id, p.Title == "Untitled" ? "" : p.Title), Id: "menu-share"));
        items.Add(new("Version history", "rotate-ccw", () => PageDialogs.VersionHistory(_h, p.Id), Id: "menu-version-history"));
        if (current && !p.Locked) items.Add(new("Use a template…", "layout-template", () => PageView.Current?.OpenTemplates(), Id: "menu-use-template"));
        if (current && !p.Locked) items.Add(new("Save as template…", "layout-template", () => TemplatePicker.Save(_h, p.Id, p.Title == "Untitled" ? "" : p.Title), Id: "menu-save-template"));
        if (current && !p.Locked) items.Add(new("Print…", "printer", () => PageView.Current?.Print(), Hint: "Ctrl+P", Id: "menu-print"));
        if (current) items.Add(new("Export as Markdown", "download", () => PageDialogs.ExportMarkdown(_h, p.Id, p.Title == "Untitled" ? "" : p.Title), Id: "menu-export-markdown"));
        if (p.Locked)
        {
            items.Add(new("Remove lock", "lock-open", () => PageDialogs.Lock(_h, LockMode.RemoveLock, p.Id, p.Title), Id: "menu-remove-lock"));
            if (S.LockState.Unlocked) items.Add(new("Lock pages now", "lock", async () => { var e = await S.LockNow(); _h.Toast(e ?? "Locked pages are locked", e is not null); }, Id: "menu-lock-now"));
        }
        else items.Add(new("Lock page", "lock", () => PageDialogs.Lock(_h, LockMode.LockPage, p.Id, p.Title), Id: "menu-lock-page"));
        items.Add(MenuEntry.Sep());
        items.Add(new("Delete page", "trash", () => DeleteDialog(TreeKind.Page, p.Id, p.Title), Danger: true));
        PopupMenu.Show(O, items, anchor, endAlign: true, at: at, id: "menu-page");
    }

    /// <summary>The page-options "…" menu of the top bar, for the page that is open.</summary>
    public void PageMenuFor(FrameworkElement anchor, string pageId)
    {
        var p = FindPage(pageId) ?? (S.GetPage(pageId) is { } np ? new PageSummary(pageId, np.Title, np.OpenTasks, np.Emoji, np.Locked) : null);
        if (p is not null) PageMenu(anchor, p, null, current: true);
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

    // ---- colours and order ----

    public async void Recolour(TreeKind kind, string id, string hex)
    {
        var err = await Run(S.SetColor(kind, id, hex));
        if (err is not null) _h.Toast(err, true);
    }

    private async void SetPrivate(string notebookId, bool isPrivate)
    {
        var r = await S.SetNotebookPrivate(notebookId, isPrivate);
        _h.Toast(r.Ok ? (isPrivate ? "Only you and the people you pick can see this notebook" : "Everyone in the workspace can see this notebook") : r.Error ?? "Couldn't change who sees it", !r.Ok);
    }

    /// <summary>The ids of the item's siblings in order (a page's section, a section's parent or notebook, the notebooks) and what a move call needs to place it.</summary>
    internal (IReadOnlyList<string> Siblings, string NotebookId, string? ParentId) PlaceOf(TreeKind kind, string id)
    {
        switch (kind)
        {
            case TreeKind.Notebook: return (S.Notebooks.Select(n => n.Id).ToList(), id, null);
            case TreeKind.Page:
            {
                var host = Sections().FirstOrDefault(x => x.S.Pages.Any(p => p.Id == id));
                return host.S is null ? (Array.Empty<string>(), "", null) : (host.S.Pages.Select(p => p.Id).ToList(), host.NotebookId, host.S.Id);
            }
            default:
            {
                var me = Sections().FirstOrDefault(x => x.S.Id == id);
                if (me.S is null) return (Array.Empty<string>(), "", null);
                return (Sections().Where(x => x.NotebookId == me.NotebookId && x.ParentId == me.ParentId).Select(x => x.S.Id).ToList(), me.NotebookId, me.ParentId);
            }
        }
    }

    /// <summary>Move up / Move down: the menu and keyboard way to reorder what a drag in the tree does.</summary>
    private void AddMoveSteps(List<MenuEntry> items, TreeKind kind, string id)
    {
        var (sibs, _, _) = PlaceOf(kind, id);
        if (ShellRules.StepIndex(sibs, id, -1) is not null) items.Add(new("Move up", "arrow-up", () => Step(kind, id, -1), Id: "menu-move-up"));
        if (ShellRules.StepIndex(sibs, id, 1) is not null) items.Add(new("Move down", "arrow-down", () => Step(kind, id, 1), Id: "menu-move-down"));
    }

    public async void Step(TreeKind kind, string id, int step)
    {
        var (sibs, nb, parent) = PlaceOf(kind, id);
        if (ShellRules.StepIndex(sibs, id, step) is not { } to) return;
        var err = await Run(S.MoveTo(kind, id, nb, parent, to));
        if (err is not null) _h.Toast(err, true);
    }

    /// <summary>A drop in the tree: put the item at <paramref name="index"/> among the children of <paramref name="parentId"/> (a section; for a section null is its notebook's top level).</summary>
    public async void Drop(TreeKind kind, string id, string notebookId, string? parentId, int? index)
    {
        var err = await Run(S.MoveTo(kind, id, notebookId, parentId, index));
        if (err is not null) _h.Toast(err, true);
    }

    /// <summary>A notebook dropped before or after another in the notebook picker (the same move as Move up / Move down, with a place).</summary>
    public void DropNotebook(string dragId, string targetId, bool after)
    {
        var sibs = S.Notebooks.Select(n => n.Id).Where(i => i != dragId).ToList();
        Drop(TreeKind.Notebook, dragId, dragId, null, ShellRules.DropIndex(sibs, targetId, after));
    }

    /// <summary>Whether <paramref name="candidate"/> is the section <paramref name="id"/> or inside it (a section cannot go into itself).</summary>
    internal bool IsSelfOrInside(string id, string candidate)
    {
        var all = Sections().ToList();
        for (var cur = (string?)candidate; cur is not null;)
        {
            if (cur == id) return true;
            cur = all.FirstOrDefault(x => x.S.Id == cur).ParentId;
        }
        return false;
    }

    /// <summary>Where a drop puts the dragged item: its notebook, parent section (null: top level; for a page the section) and index among the new siblings without itself
    /// (null: last), or null when the drop is not allowed (a section onto a page, a section into itself or what it holds, an item onto itself).</summary>
    internal (string NotebookId, string? ParentId, int? Index)? DropPlan(TreeKind dragKind, string dragId, TreeKind targetKind, string targetId, ShellRules.Zone zone)
    {
        if (dragKind == TreeKind.Page)
        {
            if (targetKind == TreeKind.Section) return (NotebookOf(targetId) ?? "", targetId, null);
            var host = SectionOfPage(targetId);
            if (host is null || targetId == dragId) return null;
            var sibs = PlaceOf(TreeKind.Page, targetId).Siblings.Where(x => x != dragId).ToList();
            return (NotebookOf(host) ?? "", host, ShellRules.DropIndex(sibs, targetId, zone != ShellRules.Zone.Before));
        }
        if (dragKind == TreeKind.Section)
        {
            if (targetKind != TreeKind.Section || IsSelfOrInside(dragId, targetId)) return null;
            var nb = NotebookOf(targetId) ?? "";
            if (zone == ShellRules.Zone.Into) return (nb, targetId, null);
            var sibs = PlaceOf(TreeKind.Section, targetId).Siblings.Where(x => x != dragId).ToList();
            return (nb, ParentOf(targetId), ShellRules.DropIndex(sibs, targetId, zone == ShellRules.Zone.After));
        }
        return null;
    }

    internal string? SectionNotebook(string sectionId) => NotebookOf(sectionId);
    internal string? ParentOf(string sectionId) => Sections().FirstOrDefault(x => x.S.Id == sectionId).ParentId;
    internal string? SectionOfPage(string pageId) => Sections().FirstOrDefault(x => x.S.Pages.Any(p => p.Id == pageId)).S?.Id;

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
