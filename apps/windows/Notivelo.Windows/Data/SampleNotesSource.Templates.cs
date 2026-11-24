using Notivelo.Windows.Text;
using Tsk = System.Threading.Tasks.Task;

namespace Notivelo.Windows.Data;

// The second templates batch on the sample data: saved templates that can be renamed, deleted and scoped, a default per section, and a template put on an open page
// (the page's boxes are swapped for a heading and a line; "Start blank" puts them back). Everything is logged for the UI tests.
public sealed partial class SampleNotesSource
{
    private readonly Dictionary<string, (bool Scoped, List<(string SectionId, bool IncludeSub)> Scopes)> _templateScopes = new();
    /// <summary>A section's own choice: a template id, or null for "None"; a section without an entry inherits.</summary>
    private readonly Dictionary<string, string?> _sectionDefaults = new();

    private IReadOnlyList<TemplateItem> SavedNow() => _savedTemplates.Select(t =>
        _templateScopes.TryGetValue(t.Id, out var s) ? t with { CanManage = true, Scoped = s.Scoped, Scopes = s.Scopes } : t with { CanManage = true }).ToList();

    private IReadOnlyList<string> ChainOf(string sectionId)
    {
        var chain = new List<string>();
        var all = AllSections().ToList();
        for (var cur = (string?)sectionId; cur is not null && chain.Count < 24;)
        {
            chain.Add(cur);
            cur = all.FirstOrDefault(x => x.S.Id == cur).ParentId;
        }
        return chain;
    }

    public Task<PageToolResult<IReadOnlyList<TemplateItem>>> LoadSavedTemplates() => Tsk.FromResult(new PageToolResult<IReadOnlyList<TemplateItem>>(SavedNow()));

    public Task<string?> RenameTemplate(string templateId, string name)
    {
        var i = _savedTemplates.FindIndex(t => t.Id == templateId);
        if (i < 0) return Tsk.FromResult<string?>("That template is gone.");
        _savedTemplates[i] = _savedTemplates[i] with { Name = name };
        Log("rename template " + templateId + " " + name);
        return Tsk.FromResult<string?>(null);
    }

    public Task<string?> DeleteTemplate(string templateId)
    {
        if (_savedTemplates.RemoveAll(t => t.Id == templateId) == 0) return Tsk.FromResult<string?>("That template is gone.");
        _templateScopes.Remove(templateId);
        foreach (var k in _sectionDefaults.Where(d => d.Value == templateId).Select(d => d.Key).ToList()) _sectionDefaults.Remove(k);
        Log("delete template " + templateId);
        return Tsk.FromResult<string?>(null);
    }

    public Task<string?> SetTemplateScope(string templateId, IReadOnlyList<(string SectionId, bool IncludeSub)> sections)
    {
        if (_savedTemplates.All(t => t.Id != templateId)) return Tsk.FromResult<string?>("That template is gone.");
        _templateScopes[templateId] = (sections.Count > 0, sections.ToList());
        Log("scope template " + templateId + " " + (sections.Count == 0 ? "everywhere" : string.Join(",", sections.Select(s => s.SectionId))));
        return Tsk.FromResult<string?>(null);
    }

    public Task<PageToolResult<SectionDefault>> LoadSectionDefault(string sectionId)
    {
        var own = _sectionDefaults.TryGetValue(sectionId, out var t) ? (t is null ? DefaultChoice.None : DefaultChoice.Template) : DefaultChoice.Inherit;
        return Tsk.FromResult(new PageToolResult<SectionDefault>(new SectionDefault(own, t, TemplateRules.EffectiveDefault(ChainOf(sectionId), _sectionDefaults))));
    }

    public Task<string?> SetSectionDefault(string sectionId, DefaultChoice choice, string? templateId)
    {
        switch (choice)
        {
            case DefaultChoice.Inherit: _sectionDefaults.Remove(sectionId); break;
            case DefaultChoice.None: _sectionDefaults[sectionId] = null; break;
            default: _sectionDefaults[sectionId] = templateId; break;
        }
        Log("default template " + sectionId + " " + choice.ToString().ToLowerInvariant() + (templateId is null ? "" : " " + templateId));
        Raise();
        return Tsk.FromResult<string?>(null);
    }

    public Task<TemplateApplied> ApplyTemplate(string pageId, TemplateItem template)
    {
        if (!_pages.TryGetValue(pageId, out var page)) return Tsk.FromResult(new TemplateApplied("That page is gone."));
        var before = page.Boxes; var beforeTitle = page.Title;
        _pages[pageId] = page with
        {
            Boxes = new CanvasBox[] { new(20, 20, 560, true, new BoxBlock[] { new(BlockKind.Heading1, template.Name), new(BlockKind.Paragraph, "Started from the " + template.Name + " template.") }) },
        };
        Log("apply template " + template.Id + " to " + pageId);
        Raise();
        return Tsk.FromResult(new TemplateApplied(null, template.Name, () =>
        {
            if (_pages.TryGetValue(pageId, out var now)) _pages[pageId] = now with { Boxes = before, Title = beforeTitle };
            Log("start blank " + pageId);
            Raise();
            return Tsk.FromResult<string?>(null);
        }));
    }
}
