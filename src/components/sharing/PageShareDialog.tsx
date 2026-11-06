// Share one page (#98): pick people with "Can view" or "Can edit". They see only
// this page, under "Shared with me". Members share with members; owners and admins
// may also share with people outside the workspace (by email), who can only view.
// A viewer stays view-only whatever the share says (rights = min(share, role)). Open with openPageShareDialog(pageId, title);
// <PageShareDialogHost /> is mounted once in PageView. Owner: Collaboration & Access.
import { useEffect, useMemo, useState } from 'react';
import { Copy, Lock, Search, X } from 'lucide-react';
import { create } from 'zustand';
import { del, get, patch, post } from '../../api.ts';
import { errorToast, toast, useStore } from '../../store.ts';
import { Avatar, Modal } from '../ui.tsx';
import type { PageShares } from '../../../shared/types.ts';
import './sharing.css';

const usePageShare = create<{ pageId: string | null; title: string }>(() => ({ pageId: null, title: '' }));
export const openPageShareDialog = (pageId: string, title: string) => usePageShare.setState({ pageId, title });
const close = () => usePageShare.setState({ pageId: null });

export function PageShareDialogHost() {
  const { pageId, title } = usePageShare();
  return pageId ? <PageShareDialog key={pageId} pageId={pageId} title={title} /> : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Level = 'view' | 'edit';

function PageShareDialog({ pageId, title }: { pageId: string; title: string }) {
  const me = useStore((s) => s.user!);
  const members = useStore((s) => s.members);
  const myRole = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role);
  const canShareOutside = myRole === 'owner' || myRole === 'admin';
  const [data, setData] = useState<PageShares | null>(null);
  const [q, setQ] = useState('');
  const [level, setLevel] = useState<Level>('edit');
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  useEffect(() => {
    get<PageShares>(`/pages/${pageId}/shares`)
      .then(setData)
      .catch((e) => {
        errorToast(e);
        close();
      });
  }, [pageId]);

  const sharedIds = useMemo(() => new Set(data?.shares.map((s) => s.userId)), [data]);
  const needle = q.trim().toLowerCase();
  const suggestions = useMemo(
    () =>
      needle
        ? members.filter((m) => m.id !== me.id && !sharedIds.has(m.id) && `${m.name} ${m.email}`.toLowerCase().includes(needle)).slice(0, 6)
        : [],
    [members, me.id, sharedIds, needle],
  );
  const isEmail = EMAIL_RE.test(q.trim());
  const memberByEmail = members.find((m) => m.email.toLowerCase() === q.trim().toLowerCase());
  /** An email that isn't a member: only owners and admins may share outside the workspace. */
  const outsideEmail = isEmail && !memberByEmail;

  const add = async (body: { userId: string } | { email: string }, label: string) => {
    setBusy(true);
    try {
      const r = await post<PageShares & { status: 'shared' | 'invited'; emailed: boolean; inviteUrl?: string }>(`/pages/${pageId}/shares`, { ...body, canEdit: level === 'edit' });
      setData(r);
      setQ('');
      if (r.status === 'invited') {
        setInviteUrl(r.emailed ? null : (r.inviteUrl ?? null));
        toast(r.emailed ? `Invite sent to ${label}` : `Invite created for ${label}: copy the link below`);
      } else toast(`Shared with ${label}`);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (suggestions.length === 1 && !isEmail) return void add({ userId: suggestions[0].id }, suggestions[0].name);
    if (memberByEmail) return void add({ userId: memberByEmail.id }, memberByEmail.name);
    if (outsideEmail && canShareOutside) return void add({ email: q.trim() }, q.trim());
  };
  const canSubmit = !busy && (suggestions.length === 1 || !!memberByEmail || (outsideEmail && canShareOutside));

  return (
    <Modal open onClose={close} label={`Share ${title || 'Untitled'}`} className="share-dialog page-share-dialog">
      <h2>Share “{title || 'Untitled'}”</h2>
      <p className="muted small">
        <Lock size={12} /> Only this page: not its notebook or other pages.{' '}
        {canShareOutside
          ? 'You can also share it with people outside the workspace by email; they can view it but not edit.'
          : 'You can share it with members of this workspace; owners and admins can also share it outside.'}
      </p>

      <form
        className="row gap-8 page-share-add"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Search size={15} className="muted" />
        <input
          className="input grow"
          placeholder={canShareOutside ? 'Name or email' : 'Name or email of a member'}
          aria-label="Name or email"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="input page-share-level" aria-label="Access" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
          <option value="edit">Can edit</option>
          <option value="view">Can view</option>
        </select>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          Share
        </button>
      </form>
      {outsideEmail && !canShareOutside && (
        <p className="muted small" role="note">
          {q.trim()} isn’t a member of this workspace. Ask a workspace owner or admin to share with people outside it.
        </p>
      )}
      {suggestions.length > 0 && (
        <div className="share-list page-share-suggestions" role="listbox" aria-label="Members">
          {suggestions.map((m) => (
            <button key={m.id} type="button" role="option" aria-selected={false} className="share-row btn-ghost" disabled={busy} onClick={() => void add({ userId: m.id }, m.name)}>
              <Avatar user={m} size={24} />
              <div className="grow">
                <div>{m.name}</div>
                <div className="muted small">{m.email}</div>
              </div>
              {m.role === 'viewer' && <span className="chip" title="Viewers can only view, even with an edit share">view only</span>}
            </button>
          ))}
        </div>
      )}
      {inviteUrl && (
        <div className="invite-link">
          <code>{inviteUrl}</code>
          <button
            type="button"
            className="btn-ghost icon-btn"
            title="Copy link"
            onClick={() => void navigator.clipboard?.writeText(inviteUrl).then(() => toast('Link copied'))}
          >
            <Copy size={15} />
          </button>
        </div>
      )}

      <div className="share-list" aria-label="People with access">
        {data && !data.shares.length && !data.invites.length && <p className="muted small">Not shared with anyone yet.</p>}
        {data?.shares.map((s) => {
          // Rights are min(share, role): outside the workspace, or as a viewer, it's view only.
          const viewerRole = members.find((m) => m.id === s.userId)?.role === 'viewer';
          const editable = s.member && !viewerRole;
          return (
          <div key={s.userId} className="share-row" data-testid="page-share-row">
            <Avatar user={{ name: s.name, color: s.color }} size={28} />
            <div className="grow">
              <div>
                {s.name} {!s.member && <span className="chip">outside the workspace</span>}
              </div>
              <div className="muted small">{s.email}</div>
            </div>
            <select
              className="input page-share-level"
              aria-label={`Access for ${s.name}`}
              value={editable && s.canEdit ? 'edit' : 'view'}
              disabled={!editable}
              title={editable ? undefined : s.member ? 'Viewers can only view' : 'People outside the workspace can only view'}
              onChange={(e) => patch<PageShares>(`/pages/${pageId}/shares/${s.userId}`, { canEdit: e.target.value === 'edit' }).then(setData).catch(errorToast)}
            >
              <option value="edit">Can edit</option>
              <option value="view">Can view</option>
            </select>
            <button
              type="button"
              className="btn-ghost icon-btn"
              aria-label={`Stop sharing with ${s.name}`}
              title="Stop sharing"
              onClick={() =>
                del<PageShares>(`/pages/${pageId}/shares/${s.userId}`)
                  .then((r) => {
                    setData(r);
                    toast(`Stopped sharing with ${s.name}`);
                  })
                  .catch(errorToast)
              }
            >
              <X size={15} />
            </button>
          </div>
          );
        })}
        {data?.invites.map((i) => (
          <div key={i.email} className="share-row">
            <span className="avatar-placeholder" aria-hidden>
              @
            </span>
            <div className="grow">
              <div>{i.email}</div>
              <div className="muted small">Invited: can view once they sign up</div>
            </div>
            <button
              type="button"
              className="btn-ghost icon-btn"
              aria-label={`Cancel the invite for ${i.email}`}
              title="Cancel invite"
              onClick={() => del<PageShares>(`/pages/${pageId}/invites/${encodeURIComponent(i.email)}`).then(setData).catch(errorToast)}
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>

      <div className="row gap-8" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn btn-secondary" onClick={close}>
          Done
        </button>
      </div>
    </Modal>
  );
}
