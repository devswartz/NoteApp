// "Move to…": pick a destination section (for a page) or notebook (for a section).
// The keyboard and touch alternative to dragging in the sidebar.
import { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { useStore } from '../../store.ts';
import { Dialog, Input } from '../ui.tsx';
import { byPos, movePage, moveSection } from './treeDnd.ts';

export function MoveDialog({ item, onClose }: { item: { kind: 'page' | 'section'; id: string } | null; onClose: () => void }) {
  const tree = useStore((s) => s.tree);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();

  const current = useMemo(() => {
    if (!item) return null;
    return item.kind === 'page' ? tree.pages.find((p) => p.id === item.id)?.sectionId : tree.sections.find((s) => s.id === item.id)?.notebookId;
  }, [item, tree]);

  if (!item) return null;
  const notebooks = [...tree.notebooks].sort(byPos);

  const choose = (destId: string) => {
    if (item.kind === 'page') void movePage(item.id, destId, null, 'inside');
    else void moveSection(item.id, destId, null, 'inside');
    setQ('');
    onClose();
  };

  return (
    <Dialog open onClose={onClose} title={item.kind === 'page' ? 'Move page to…' : 'Move section to…'} size="sm">
      <Input icon={<Search size={15} />} placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Filter destinations" />
      <div className="move-list" role="listbox" aria-label="Destinations">
        {notebooks.map((nb) => {
          if (item.kind === 'section') {
            if (needle && !nb.name.toLowerCase().includes(needle)) return null;
            return (
              <button key={nb.id} type="button" role="option" aria-selected={nb.id === current} className="move-option" onClick={() => choose(nb.id)}>
                <span className="nb-icon" style={{ background: nb.color }}>
                  {nb.name[0]?.toUpperCase()}
                </span>
                <span className="grow truncate">{nb.name}</span>
                {nb.id === current && <Check size={14} className="menu-check" />}
              </button>
            );
          }
          const secs = tree.sections
            .filter((s) => s.notebookId === nb.id)
            .sort(byPos)
            .filter((s) => !needle || `${nb.name} ${s.name}`.toLowerCase().includes(needle));
          if (!secs.length) return null;
          return (
            <div key={nb.id} className="move-group">
              <div className="move-group-title">{nb.name}</div>
              {secs.map((s) => (
                <button key={s.id} type="button" role="option" aria-selected={s.id === current} className="move-option" onClick={() => choose(s.id)}>
                  <span className="sec-tab" style={{ background: s.color }} />
                  <span className="grow truncate">{s.name}</span>
                  {s.id === current && <Check size={14} className="menu-check" />}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
