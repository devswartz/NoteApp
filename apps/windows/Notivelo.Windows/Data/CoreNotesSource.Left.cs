using Notivelo.Windows.Text;
using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

// The left batch over the core: the box clipboard (LivePage BoxesJson / PasteBoxes / DuplicateBoxes / DeleteBoxWithContent), templates (Templates,
// SavePageAsTemplate, CreatePageFromTemplate, ClaimPendingTemplate, LivePage.InsertTemplateContent) and the reminders the toasts are scheduled from
// (TaskReminders, SnoozeReminder). Box calls are local edits of the open page's document (as the other box calls), the rest run on the core's call queue.
internal sealed partial class CoreNotesSource
{
    // ---- box clipboard ----

    /// <summary>One box call that answers something, on the open page; an error is one sentence.</summary>
    private PageToolResult<T> BoxCall<T>(string pageId, Func<N.LivePage, T> call)
    {
        if (LivePageOf(pageId) is not { } live) return PageToolResult<T>.Fail("Wait until the page has loaded.");
        try { var r = call(live); _info = live.Info(); Raise(); return new PageToolResult<T>(r); }
        catch (N.BoxException e) { return PageToolResult<T>.Fail(e.Message.Length > 0 ? e.Message : "That didn't work."); }
        catch (Exception e) { return PageToolResult<T>.Fail(ErrorText.Message(e)); }
    }

    public PageToolResult<string> BoxClip(string pageId, IReadOnlyList<string> boxIds) => BoxCall(pageId, l => l.BoxesJson(boxIds.ToArray()));

    public PageToolResult<IReadOnlyList<string>> PasteBoxes(string pageId, string clipJson, double? x, double? y) =>
        BoxCall<IReadOnlyList<string>>(pageId, l => l.PasteBoxes(clipJson, x, y, new Dictionary<string, string>()));

    public PageToolResult<IReadOnlyList<string>> DuplicateBoxes(string pageId, IReadOnlyList<string> boxIds) =>
        BoxCall<IReadOnlyList<string>>(pageId, l => l.DuplicateBoxes(boxIds.ToArray()));

    public PageToolResult<bool> DeleteBoxesWithContent(string pageId, IReadOnlyList<string> boxIds) =>
        BoxCall(pageId, l => { foreach (var id in boxIds) l.DeleteBoxWithContent(id); return true; });

    // ---- templates ----

    private IReadOnlyList<string> SectionChain(string sectionId)
    {
        var chain = new List<string>();
        var sections = _tree?.Sections ?? Array.Empty<N.Section>();
        for (var cur = sectionId; cur is not null && chain.Count < 24;)
        {
            chain.Add(cur);
            cur = sections.FirstOrDefault(s => s.Id == cur)?.ParentId;
        }
        return chain;
    }

    public async Task<PageToolResult<IReadOnlyList<TemplateItem>>> LoadTemplates(string sectionId)
    {
        var items = new List<TemplateItem>(TemplateRules.Builtins);
        var ws = _wsId;
        if (ws is null) return PageToolResult<IReadOnlyList<TemplateItem>>.Fail("No workspace is open.");
        try
        {
            var saved = await _session.CallAsync(c => c.Templates(ws));
            var chain = SectionChain(sectionId);
            foreach (var t in saved)
                if (TemplateRules.Offered(t.Scoped, t.Sections.Select(s => (s.SectionId, s.IncludeSubsections)), chain))
                    items.Add(new TemplateItem(t.Id, t.Name, t.Icon, t.TaskCount > 0 ? $"{t.TaskCount} task{(t.TaskCount == 1 ? "" : "s")}" : "Saved template", false, t.Visibility == "private"));
            return new PageToolResult<IReadOnlyList<TemplateItem>>(items);
        }
        catch (OperationCanceledException) { return PageToolResult<IReadOnlyList<TemplateItem>>.Fail("You were signed out. Sign in again."); }
        catch (Exception e)
        {
            // the built-in templates still work without the server's list
            return new PageToolResult<IReadOnlyList<TemplateItem>>(items, null);
        }
    }

    /// <summary>A page made from a template waits here for its page to open and sync (Apple's TemplatesModel.pending); a built-in one carries the template's id,
    /// a saved one is claimed from the server.</summary>
    private readonly Dictionary<string, string> _pendingTemplate = new();

    public async Task<TreeResult> CreatePageFromTemplate(string sectionId, TemplateItem template)
    {
        if (template.Builtin)
        {
            var r = await Change(c => (c.CreatePage(sectionId, TemplateRules.TitleOf(template.Id, DateTime.Now)), null));
            if (r.Ok && r.Id is not null) _pendingTemplate[r.Id] = template.Id;
            return r;
        }
        N.CreatedPage? created = null;
        var res = await Change(c => { created = c.CreatePageFromTemplate(sectionId, null, template.Id); return (created.Id, null); });
        if (res.Ok && created?.PendingTemplate is not null && res.Id is not null) _pendingTemplate[res.Id] = "claim";
        return res;
    }

    /// <summary>Called on every change: a page waiting for its template that is now live gets it (one undoable edit).</summary>
    private void TryApplyPending()
    {
        if (_openId is not { } id || _pendingTemplate.Count == 0 || !_pendingTemplate.TryGetValue(id, out var what) || LivePageOf(id) is not { } live) return;
        _pendingTemplate.Remove(id);
        ApplyPending(id, what, live);
    }

    private async void ApplyPending(string pageId, string what, N.LivePage live)
    {
        try
        {
            var now = DateTime.Now;
            string json, kind = "canvas", title, name; string? icon;
            if (what == "claim")
            {
                var c = await _session.CallAsync(x => x.ClaimPendingTemplate(pageId, false));
                if (c is null) return;                     // another device got it
                json = c.ContentJson; kind = c.Kind; title = FillWords(c.Title, now); icon = c.Icon; name = c.Title;
            }
            else
            {
                json = TemplateRules.ContentJson(what, now);
                title = TemplateRules.TitleOf(what, now);
                var b = TemplateRules.Builtins.First(t => t.Id == what);
                icon = b.Icon; name = b.Name;
            }
            if (LivePageOf(pageId) != live) return;
            live.InsertTemplateContent(json, kind, TemplateRules.LongDate(now), TemplateRules.ShortTime(now));
            _info = live.Info();
            Raise();
            var meta = _tree?.Pages.FirstOrDefault(p => p.Id == pageId);
            if (meta is not null && meta.Title.Length == 0 && title.Length > 0) await Rename(TreeKind.Page, pageId, title);
            if (meta is not null && string.IsNullOrEmpty(meta.Icon) && !string.IsNullOrEmpty(icon)) await SetPageIcon(pageId, icon);
            Notice?.Invoke("Started from " + name);
        }
        catch (Exception e) { Notice?.Invoke("Couldn't fill the page from the template. " + ErrorText.Message(e)); }
    }

    private static string FillWords(string s, DateTime now) =>
        s.Replace("{date}", TemplateRules.LongDate(now), StringComparison.OrdinalIgnoreCase).Replace("{time}", TemplateRules.ShortTime(now), StringComparison.OrdinalIgnoreCase);

    public event Action<string>? Notice;

    public async Task<string?> SaveAsTemplate(string pageId, string name)
    {
        if (LivePageOf(pageId) is not { } live) return "Wait until the page has loaded.";
        try
        {
            var json = live.CanvasTemplateJson();
            var icon = _tree?.Pages.FirstOrDefault(p => p.Id == pageId)?.Icon;
            await _session.CallAsync(c => c.SavePageAsTemplate(pageId, name, string.IsNullOrEmpty(icon) ? null : icon, json, "canvas", null));
            return null;
        }
        catch (OperationCanceledException) { return "You were signed out. Sign in again."; }
        catch (Exception e) { return ErrorText.Message(e); }
    }

    // ---- reminders ----

    public bool SchedulesReminders => true;

    public async Task<IReadOnlyList<ReminderEntry>> UpcomingReminders()
    {
        var ws = _wsId;
        if (ws is null) return Array.Empty<ReminderEntry>();
        var mine = Mine().Where(t => !t.Done).Take(80).ToList();
        try
        {
            var found = await _session.CallAsync(c =>
            {
                var list = new List<(N.Task T, N.TaskReminder R)>();
                foreach (var t in mine)
                {
                    try { foreach (var r in c.TaskReminders(t.Id)) if (r.NextFireAt is not null) list.Add((t, r)); } catch (N.CoreException.Network) { throw; } catch (Exception) { }
                }
                return list;
            });
            var res = new List<ReminderEntry>();
            foreach (var (t, r) in found)
                if (ReminderRules.ParseInstant(r.NextFireAt) is { } at)
                    res.Add(new ReminderEntry(r.Id, t.Id, t.Title, at, t.DueDate, t.DueTime, t.PageId, ws, IsLockedPage(t.PageId ?? "")));
            return res;
        }
        catch (Exception) { return Array.Empty<ReminderEntry>(); }
    }

    public async Task<string?> SnoozeReminder(string snoozeToken, string option)
    {
        try { await _session.CallAsync(c => c.SnoozeReminder(snoozeToken, option)); return null; }
        catch (OperationCanceledException) { return "You were signed out. Sign in again."; }
        catch (Exception e) { return ErrorText.Message(e); }
    }
}
