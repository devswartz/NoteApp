using Notivelo.Windows.Text;
using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

// The second templates batch over the core: UseTemplate / InsertTemplateContent on an open page (with "Start blank"), UpdateTemplate (rename, scope), DeleteTemplate,
// SectionDefaultTemplates and SetSectionDefaultTemplate. Everything runs on the core's call queue; an error is one sentence.
internal sealed partial class CoreNotesSource
{
    internal static TemplateItem ToItem(N.TemplateInfo t) => new(t.Id, t.Name, t.Icon,
        t.TaskCount > 0 ? $"{t.TaskCount} task{(t.TaskCount == 1 ? "" : "s")}" : "Saved template", false, t.Visibility == "private", t.CanManage, t.Scoped,
        t.Sections.Select(s => (s.SectionId, s.IncludeSubsections)).ToList());

    public async Task<PageToolResult<IReadOnlyList<TemplateItem>>> LoadSavedTemplates()
    {
        if (_wsId is not { } ws) return PageToolResult<IReadOnlyList<TemplateItem>>.Fail("No workspace is open.");
        try
        {
            var saved = await _session.CallAsync(c => c.Templates(ws));
            return new PageToolResult<IReadOnlyList<TemplateItem>>(saved.Select(ToItem).ToList());
        }
        catch (OperationCanceledException) { return PageToolResult<IReadOnlyList<TemplateItem>>.Fail("You were signed out. Sign in again."); }
        catch (Exception e) { NoteNetwork(e); return PageToolResult<IReadOnlyList<TemplateItem>>.Fail(ErrorText.Message(e)); }
    }

    private async Task<string?> TemplateCall(Action<N.Core> call)
    {
        try { await _session.CallAsync(c => { call(c); return 0; }); return null; }
        catch (OperationCanceledException) { return "You were signed out. Sign in again."; }
        catch (Exception e) { NoteNetwork(e); return ErrorText.Message(e); }
    }

    public Task<string?> RenameTemplate(string templateId, string name) => TemplateCall(c => c.UpdateTemplate(templateId, name));
    public Task<string?> DeleteTemplate(string templateId) => TemplateCall(c => c.DeleteTemplate(templateId));
    public Task<string?> SetTemplateScope(string templateId, IReadOnlyList<(string SectionId, bool IncludeSub)> sections) =>
        TemplateCall(c => c.UpdateTemplate(templateId, null, null, sections.Select(s => new N.TemplateSectionScope(s.SectionId, s.IncludeSub)).ToArray()));

    public async Task<PageToolResult<SectionDefault>> LoadSectionDefault(string sectionId)
    {
        if (_wsId is not { } ws) return PageToolResult<SectionDefault>.Fail("No workspace is open.");
        try
        {
            var all = await _session.CallAsync(c => c.SectionDefaultTemplates(ws));
            // a section with neither a template nor "None" has no choice of its own (the core lists only sections with one)
            var ownOnly = all.Where(d => d.NoDefaultTemplate || d.DefaultTemplateId is not null).ToDictionary(d => d.SectionId, d => d.NoDefaultTemplate ? null : d.DefaultTemplateId);
            var mine = all.FirstOrDefault(d => d.SectionId == sectionId);
            var choice = mine is null ? DefaultChoice.Inherit : mine.NoDefaultTemplate ? DefaultChoice.None : mine.DefaultTemplateId is not null ? DefaultChoice.Template : DefaultChoice.Inherit;
            return new PageToolResult<SectionDefault>(new SectionDefault(choice, mine?.DefaultTemplateId, TemplateRules.EffectiveDefault(SectionChain(sectionId), ownOnly)));
        }
        catch (OperationCanceledException) { return PageToolResult<SectionDefault>.Fail("You were signed out. Sign in again."); }
        catch (Exception e) { NoteNetwork(e); return PageToolResult<SectionDefault>.Fail(ErrorText.Message(e)); }
    }

    public Task<string?> SetSectionDefault(string sectionId, DefaultChoice choice, string? templateId) => TemplateCall(c => c.SetSectionDefaultTemplate(sectionId,
        choice switch { DefaultChoice.None => new N.DefaultTemplateChoice.NoDefault(), DefaultChoice.Template when templateId is not null => new N.DefaultTemplateChoice.Template(templateId), _ => new N.DefaultTemplateChoice.Inherit() }));

    public async Task<TemplateApplied> ApplyTemplate(string pageId, TemplateItem t)
    {
        if (LivePageOf(pageId) is not { } live) return new TemplateApplied("Wait until the page has loaded.");
        try
        {
            var now = DateTime.Now;
            string json, kind = "canvas", title, name = t.Name; string? icon; string[] taskIds = Array.Empty<string>();
            if (t.Builtin)
            {
                json = TemplateRules.ContentJson(t.Id, now); title = TemplateRules.TitleOf(t.Id, now); icon = t.Icon;
            }
            else
            {
                var c = await _session.CallAsync(x => x.UseTemplate(t.Id, pageId));
                json = c.ContentJson; kind = c.Kind; title = FillWords(c.Title, now); icon = c.Icon ?? t.Icon; taskIds = c.TaskIds;
            }
            if (LivePageOf(pageId) != live) return new TemplateApplied("The page changed. Try again.");
            live.InsertTemplateContent(json, kind, TemplateRules.LongDate(now), TemplateRules.ShortTime(now));
            _info = live.Info();
            Raise();
            var meta = _tree?.Pages.FirstOrDefault(p => p.Id == pageId);
            var setTitle = meta is not null && (meta.Title.Length == 0 || meta.Title == "Untitled") && title.Length > 0;
            var setIcon = meta is not null && string.IsNullOrEmpty(meta.Icon) && !string.IsNullOrEmpty(icon);
            if (taskIds.Length > 0) await RefreshTasksNow();
            if (setTitle) await Rename(TreeKind.Page, pageId, title);
            if (setIcon) await SetPageIcon(pageId, icon);
            return new TemplateApplied(null, name, async () =>
            {
                try
                {
                    if (LivePageOf(pageId) is { } l) { l.Undo(); _info = l.Info(); Raise(); }
                    if (taskIds.Length > 0) await _session.CallAsync(x => { foreach (var id in taskIds) { try { x.DeleteTask(id); } catch (Exception) { } } return 0; });
                    if (setTitle) await Rename(TreeKind.Page, pageId, "");
                    if (setIcon) await SetPageIcon(pageId, null);
                    if (taskIds.Length > 0) await RefreshTasksNow();
                    return null;
                }
                catch (Exception e) { return ErrorText.Message(e); }
            });
        }
        catch (OperationCanceledException) { return new TemplateApplied("You were signed out. Sign in again."); }
        catch (Exception e) { NoteNetwork(e); return new TemplateApplied(ErrorText.Message(e)); }
    }
}

internal sealed partial class CoreNotesSource
{
    /// <summary>The template's tasks (made by the server when it is used) show in the task list without a reload; the same after they are deleted again.</summary>
    private async Task RefreshTasksNow()
    {
        var ws = _wsId;
        if (ws is null) return;
        try
        {
            var fresh = await _session.CallAsync(c => c.Tasks(ws));
            if (ws != _wsId || _disposed) return;
            _tasks = fresh; _tasksVersion++; Raise();
        }
        catch (Exception) { }
    }
}
