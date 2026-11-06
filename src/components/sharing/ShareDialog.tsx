// Notebook share dialog: shared with the whole workspace, or private to its
// creator plus chosen people. Open it from anywhere with openShareDialog(id);
// <ShareDialogHost /> is mounted once in App.tsx. Owner: Collaboration & Access.
import { useEffect, useMemo, useState } from 'react';
import { Globe, Lock, Search } from 'lucide-react';
import { create } from 'zustand';
import { api, get, patch } from '../../api.ts';
import { errorToast, loadTree, toast, useStore } from '../../store.ts';
import { Avatar, Modal } from '../ui.tsx';
import type { Visibility } from '../../../shared/types.ts';
import './sharing.css';

const useShare = create<{ notebookId: string | null }>(() => ({ notebookId: null }));
export const openShareDialog = (notebookId: string) => useShare.setState({ notebookId });
const close = () => useShare.setState({ notebookId: null });

export function ShareDialogHost() {
  const notebookId = useShare((s) => s.notebookId);
  return notebookId ? <ShareDialog key={notebookId} notebookId={notebookId} /> : null;
}

function ShareDialog({ notebookId }: { notebookId: string }) {
  const me = useStore((s) => s.user!);
  const nb = useStore((s) => s.tree.notebooks.find((n) => n.id === notebookId));
  const members = useStore((s) => s.members);
  const [visibility, setVisibility] = useState<Visibility>(nb?.visibility ?? 'shared');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [initial, setInitial] = useState<{ visibility: Visibility; userIds: string[] } | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<{ visibility: Visibility; userIds: string[] }>(`/notebooks/${notebookId}/shares`)
      .then((r) => {
        setInitial(r);
        setVisibility(r.visibility);
        setPicked(new Set(r.userIds));
      })
      .catch((e) => {
        errorToast(e);
        close();
      });
  }, [notebookId]);

  const isCreator = nb?.createdBy === me.id;
  const others = useMemo(
    () =>
      members
        .filter((m) => m.id !== nb?.createdBy)
        .filter((m) => !q || `${m.name} ${m.email}`.toLowerCase().includes(q.toLowerCase())),
    [members, nb?.createdBy, q],
  );
  if (!nb) return null;
  const creator = members.find((m) => m.id === nb.createdBy);

  const save = async () => {
    if (!picked || !initial) return;
    setBusy(true);
    try {
      let removed = 0;
      if (visibility !== initial.visibility) removed = (await patch<{ removedPageShares?: number }>(`/notebooks/${nb.id}`, { visibility })).removedPageShares ?? 0;
      const ids = [...picked].sort();
      if (visibility === 'private' && ids.join() !== [...initial.userIds].sort().join())
        await api(`/notebooks/${nb.id}/shares`, { method: 'PUT', json: { userIds: ids } });
      await loadTree();
      toast(
        visibility === 'shared'
          ? `${nb.name} is shared with everyone in the workspace`
          : ids.length
            ? `${nb.name} is shared with ${ids.length} ${ids.length === 1 ? 'person' : 'people'}`
            : `${nb.name} is private to you`,
      );
      // Single pages others had shared from it stop being shared (#98).
      if (removed) toast(`${removed} page ${removed === 1 ? 'share' : 'shares'} by other people ended, now that ${nb.name} is private`);
      close();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Modal open onClose={close} label={`Share ${nb.name}`} className="share-dialog">
      <h2>Share “{nb.name}”</h2>
      <p className="muted small">
        Created by {creator ? (creator.id === me.id ? 'you' : creator.name) : 'a former member'}.
        {!isCreator && ' Only the creator can change who can see it.'}
      </p>
      <div className="visibility-choice" role="radiogroup" aria-label="Who can see this notebook">
        <label className={visibility === 'shared' ? 'is-active' : ''}>
          <input type="radio" name="vis" checked={visibility === 'shared'} disabled={!isCreator} onChange={() => setVisibility('shared')} />
          <Globe size={16} />
          <span>
            <strong>Everyone in the workspace</strong>
            <div className="muted small">Members can edit; viewers can read.</div>
          </span>
        </label>
        <label className={visibility === 'private' ? 'is-active' : ''}>
          <input type="radio" name="vis" checked={visibility === 'private'} disabled={!isCreator} onChange={() => setVisibility('private')} />
          <Lock size={16} />
          <span>
            <strong>Private</strong>
            <div className="muted small">Only {isCreator ? 'you' : 'its creator'} and the people you pick below.</div>
          </span>
        </label>
      </div>

      {visibility === 'private' && picked && (
        <>
          {members.length > 6 && (
            <div className="row gap-8" style={{ marginTop: 12 }}>
              <Search size={15} className="muted" />
              <input className="input" placeholder="Find people" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          <div className="share-list">
            {others.length === 0 && <p className="muted small">No one else is in this workspace yet. Invite people from Settings.</p>}
            {others.map((m) => (
              <label key={m.id} className="share-row">
                <input type="checkbox" checked={picked.has(m.id)} disabled={!isCreator} onChange={() => toggle(m.id)} />
                <Avatar user={m} size={28} />
                <div className="grow">
                  <div>{m.name}</div>
                  <div className="muted small">{m.email}</div>
                </div>
                <span className="chip" title={m.role === 'viewer' ? 'Viewers can read but not edit' : undefined}>
                  {m.role === 'viewer' ? 'can view' : 'can edit'}
                </span>
              </label>
            ))}
          </div>
        </>
      )}

      <div className="row gap-8" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn btn-secondary" onClick={close}>
          {isCreator ? 'Cancel' : 'Close'}
        </button>
        {isCreator && (
          <button className="btn btn-primary" disabled={busy || !picked} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </Modal>
  );
}
