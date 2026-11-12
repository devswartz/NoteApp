// Trash (/trash): what was deleted in the last 60 days. Restore puts it back; Delete forever removes it now.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpen, FileText, Folder, Trash2 } from 'lucide-react';
import { del, get } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { restoreFromTrash } from '../lib/trash.ts';
import { confirmDialog } from '../components/shell/dialogs.tsx';
import type { TrashItem } from '../../shared/types.ts';

const ICON = { page: FileText, section: Folder, notebook: BookOpen } as const;

function describe(i: TrashItem): string {
  const parts: string[] = [];
  if (i.path) parts.push(`from ${i.path}`);
  if (i.kind !== 'page') {
    const bits = [i.sections ? `${i.sections} subsection${i.sections === 1 ? '' : 's'}` : '', i.pages ? `${i.pages} page${i.pages === 1 ? '' : 's'}` : ''].filter(Boolean);
    if (bits.length) parts.push(bits.join(', '));
  }
  const ago = Math.max(0, Math.floor((Date.now() - new Date(i.deletedAt).getTime()) / 86_400_000));
  parts.push(`deleted ${ago === 0 ? 'today' : `${ago} day${ago === 1 ? '' : 's'} ago`}${i.deletedByName ? ` by ${i.deletedByName}` : ''}`);
  parts.push(`removed in ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function TrashView() {
  const { wsId } = useParams() as { wsId: string };
  const role = useStore((s) => s.workspaces.find((w) => w.id === wsId)?.role);
  const tree = useStore((s) => s.tree); // changes when something is restored or deleted
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const load = useCallback(() => get<TrashItem[]>(`/workspaces/${wsId}/trash`).then(setItems).catch((e) => { errorToast(e); setItems([]); }), [wsId]);
  useEffect(() => {
    void load();
  }, [load, tree]);

  const forever = async (i: TrashItem) => {
    const ok = await confirmDialog({
      title: `Delete “${i.name || 'Untitled'}” forever?`,
      message: 'It cannot be restored after this. Its tasks stay as standalone tasks.',
      confirmLabel: 'Delete forever',
      danger: true,
    });
    if (!ok) return;
    await del(`/trash/${i.kind}/${i.id}`).catch(errorToast);
    void load();
  };
  const empty = async () => {
    const ok = await confirmDialog({ title: 'Empty the Trash?', message: 'Everything in it is deleted forever. Its tasks stay as standalone tasks.', confirmLabel: 'Empty Trash', danger: true });
    if (!ok) return;
    try {
      const r = await del<{ removed: number }>(`/workspaces/${wsId}/trash`);
      toast(`Deleted ${r.removed} item${r.removed === 1 ? '' : 's'} forever`);
    } catch (e) {
      errorToast(e);
    }
    void load();
  };

  return (
    <div className="tasks-page">
      <div className="tasks-inner">
        <header className="view-head">
          <Trash2 size={20} />
          <h1>Trash</h1>
          {(role === 'owner' || role === 'admin') && items && items.length > 0 && (
            <button className="btn btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => void empty()}>
              Empty Trash
            </button>
          )}
        </header>
        <p className="muted">Deleted pages, sections and notebooks stay here for 60 days, then they are removed for good.</p>
        {items?.length === 0 && <p className="muted">Nothing in the Trash.</p>}
        <div className="trash-list">
          {items?.map((i) => {
            const Icon = ICON[i.kind];
            return (
              <div key={`${i.kind}-${i.id}`} className="trash-row" data-testid="trash-row">
                <Icon size={18} aria-hidden />
                <div className="trash-main">
                  <div className="trash-name truncate">
                    {i.kind === 'page' ? <Link to={`/w/${wsId}/p/${i.id}`}>{i.name || 'Untitled'}</Link> : i.name}
                  </div>
                  <div className="trash-meta">{describe(i)}</div>
                </div>
                <div className="trash-actions">
                  <button className="btn btn-secondary" onClick={() => void restoreFromTrash(i.kind, i.id).then(load)}>
                    Restore
                  </button>
                  <button className="btn btn-secondary" onClick={() => void forever(i)}>
                    Delete forever
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
