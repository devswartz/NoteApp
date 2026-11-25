using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

// Who else has the open page (Apple's PageSource.startPresence): every 3 s the live page announces this user and reads everyone's presence. The core's presence states
// carry the user only: no caret or selection, so other people's carets are not drawn (waits for apple-left3).
internal sealed partial class CoreNotesSource
{
    private IReadOnlyList<PagePerson> _people = Array.Empty<PagePerson>();

    public IReadOnlyList<PagePerson> PagePeople(string pageId) => pageId == _openId ? _people : Array.Empty<PagePerson>();

    private async void StartPresence(N.LivePage live, int gen)
    {
        while (gen == _gen && !_disposed && ReferenceEquals(_live, live))
        {
            try
            {
                var canEdit = WorkspaceRole != "viewer";
                var states = await Task.Run(() => { live.AnnouncePresence(canEdit); return live.Presence(); });
                if (gen != _gen || _disposed) return;
                var list = PresenceRules.From(states, UserId);
                if (!PresenceRules.Same(list, _people)) { _people = list; Raise(); }
            }
            catch (Exception) { /* the page closed under the call, or the socket is down: try again */ }
            await Task.Delay(3000);
        }
    }
}
