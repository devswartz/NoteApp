// Sidebar section "Shared with me" (#98): pages shared with this user one by one.
// Owner: Collaboration & Access. Rendered in the Notes panel's notebook picker (shell/NotesPanel.tsx)
// and on the phone's Notes screen.
import { useEffect, useState } from 'react';
import { Navigate, NavLink, useParams } from 'react-router-dom';
import { FileText, Users, X } from 'lucide-react';
import { del, get } from '../../api.ts';
import { errorToast, toast, useStore } from '../../store.ts';
import { confirmDialog } from '../shell/dialogs.tsx';
import { loadSharedPages, sharedPagePath, useShared } from './sharedPages.ts';
import './sharing.css';

export function SharedWithMe({ wsId, heading = true, onOpen }: { wsId: string; heading?: boolean; onOpen?: () => void }) {
  const pages = useShared((s) => s.pages);
  const me = useStore((s) => s.user?.id);
  // Workspaces I belong to change the link (open in its own workspace when I'm a member).
  useStore((s) => s.workspaces);
  useEffect(() => {
    void loadSharedPages();
  }, [me]);
  if (!pages.length) return null;
  return (
    <div className="sb-group shared-with-me" data-testid="shared-with-me">
      {heading && (
        <div className="sb-heading">
          <span className="sb-heading-btn sb-heading-static">
            <Users size={12} />
            <span>Shared with me</span>
          </span>
        </div>
      )}
      {pages.map((p) => (
        <NavLink
          key={p.id}
          to={sharedPagePath(p.workspaceId, p.id)}
          className={({ isActive }) => `sb-item sb-shared-page ${isActive ? 'is-active' : ''}`}
          onClick={onOpen}
          title={`${p.title || 'Untitled'}: shared by ${p.sharedByName ?? 'someone'}${p.workspaceId !== wsId ? ` in ${p.workspaceName}` : ''}${p.canEdit ? '' : ' (view only)'}`}
        >
          {p.icon ? <span className="sb-page-icon">{p.icon}</span> : <FileText size={15} />}
          <span className="truncate">{p.title || 'Untitled'}</span>
          {p.workspaceId !== wsId && <span className="muted small truncate sb-shared-ws">{p.workspaceName}</span>}
          <button
            type="button"
            className="btn-ghost icon-btn sb-shared-remove"
            aria-label={`Remove “${p.title || 'Untitled'}” from Shared with me`}
            title="Remove from Shared with me"
            onClick={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!me) return;
              const ok = await confirmDialog({
                title: 'Remove this page from Shared with me?',
                message: 'You will lose access until it is shared with you again.',
                confirmLabel: 'Remove',
                danger: true,
              });
              if (!ok) return;
              void del(`/pages/${p.id}/shares/${me}`)
                .then(() => {
                  toast('Removed from Shared with me');
                  void loadSharedPages();
                })
                .catch(errorToast);
            }}
          >
            <X size={13} />
          </button>
        </NavLink>
      ))}
    </div>
  );
}

/** /shared/:pageId (the link in "shared a page with you" emails): open it in the right workspace. */
export function SharedPageRedirect() {
  const { pageId } = useParams() as { pageId: string };
  const workspaces = useStore((s) => s.workspaces);
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    get<{ workspaceId: string }>(`/pages/${encodeURIComponent(pageId)}`)
      .then((r) => {
        void loadSharedPages();
        if (!cancelled) setTo(sharedPagePath(r.workspaceId, pageId));
      })
      .catch((e) => {
        errorToast(e);
        if (!cancelled) setTo('/');
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, workspaces.length]);
  return to ? <Navigate to={to} replace /> : <div className="splash" />;
}
