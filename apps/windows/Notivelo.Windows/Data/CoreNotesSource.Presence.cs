using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

// Who else has the open page and where their carets are (Apple's PageSource.pollPresence): the live page announces this user (every 3 s), then the people and their
// carets are read (every 3 s alone, every 0.5 s while someone else is here). Our own caret goes out through SetLocalCaret, at most every 100 ms, off the UI thread.
internal sealed partial class CoreNotesSource
{
    private IReadOnlyList<PagePerson> _people = Array.Empty<PagePerson>();
    private IReadOnlyList<RemoteCaret> _carets = Array.Empty<RemoteCaret>();

    public IReadOnlyList<PagePerson> PagePeople(string pageId) => pageId == _openId ? _people : Array.Empty<PagePerson>();
    public IReadOnlyList<RemoteCaret> RemoteCarets(string pageId) => pageId == _openId ? _carets : Array.Empty<RemoteCaret>();
    public event Action? CaretsChanged;

    private async void StartPresence(N.LivePage live, int gen)
    {
        var announcedAt = DateTime.MinValue;
        _carets = Array.Empty<RemoteCaret>();
        while (gen == _gen && !_disposed && ReferenceEquals(_live, live))
        {
            try
            {
                var canEdit = WorkspaceRole != "viewer";
                var announce = DateTime.UtcNow - announcedAt > TimeSpan.FromSeconds(3);
                var (states, cursors) = await Task.Run(() =>
                {
                    if (announce) live.AnnouncePresence(canEdit);
                    return (live.Presence(), live.RemoteCursors());
                });
                if (announce) announcedAt = DateTime.UtcNow;
                if (gen != _gen || _disposed) return;
                var list = PresenceRules.From(states, UserId);
                if (!PresenceRules.Same(list, _people)) { _people = list; Raise(); }
                var carets = cursors.Where(c => c.UserId != UserId).Select(c => new RemoteCaret(c.UserId, NameOf(c), c.Color, c.BoxId, (int)c.Anchor, (int)c.Head)).ToList();
                if (!AdminRules.Same(carets, _carets)) { _carets = carets; CaretsChanged?.Invoke(); }
            }
            catch (Exception) { /* the page closed under the call, or the socket is down: try again */ }
            await Task.Delay(_people.Count == 0 ? 3000 : 500);
        }
    }

    private string NameOf(N.BoxCursor c) => c.Name.Length > 0 ? c.Name : _people.FirstOrDefault(p => p.Id == c.UserId)?.Name ?? "Someone";

    // ---- our caret ----

    private readonly object _caretLock = new();
    private (string Box, int Anchor, int Head)? _caretPending;
    private (string Box, int Anchor, int Head)? _caretSent;
    private bool _caretScheduled;

    public void SetLocalCaret(string pageId, string boxId, int anchor, int head)
    {
        if (pageId != _openId || LivePageOf(pageId) is null) return;
        lock (_caretLock)
        {
            _caretPending = (boxId, anchor, head);
            if (_caretScheduled) return;
            _caretScheduled = true;
        }
        _ = Task.Run(async () =>
        {
            await Task.Delay(100);
            (string Box, int Anchor, int Head)? send;
            lock (_caretLock) { _caretScheduled = false; send = _caretPending; _caretPending = null; if (send is not null && send == _caretSent) return; _caretSent = send; }
            if (send is not { } c || LivePageOf(pageId) is not { } live) return;
            try { live.SetLocalCursor(c.Box, (uint)Math.Max(0, c.Anchor), (uint)Math.Max(0, c.Head)); } catch (Exception) { }
        });
    }

    public void ClearLocalCaret(string pageId)
    {
        lock (_caretLock) { _caretPending = null; _caretSent = null; }
        if (pageId != _openId || LivePageOf(pageId) is not { } live) return;
        _ = Task.Run(() => { try { live.ClearLocalCursor(); } catch (Exception) { } });
    }
}
