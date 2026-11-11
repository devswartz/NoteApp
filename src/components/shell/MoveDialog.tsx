// "Move to…": pick a destination section (for a page), or a notebook's top level or a parent section (for a section).
// The keyboard and touch alternative to dragging in the sidebar.
import { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { useStore } from '../../store.ts';
import { Dialog, Input } from '../ui.tsx';
import { byPos, movePage, moveSection } from './treeDnd.ts';
import { canNestUnder, sectionPathLabel, sectionsInOrder } from '../../../shared/sections.ts';

export function MoveDialog({ item, onClose }: { item: { kind: 'page' | 'section'; id: string } | null; onClose: () => void }) {
  const tree = useStore((s) => s.tree);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();

  // Where it is now: a page's section, or a section's parent (its notebook when at the top level).
  const current = useMemo(() => {
    if (!item) return null;
    if (item.kind === 'page') return tree.pages.find((p) => p.id === item.id)?.sectionId;
    const s = tree.sections.find((x) => x.id === item.id);
    return s ? (s.parentId ?? s.notebookId) : null;
  }, [item, tree]);

  if (!item) return null;
  const notebooks = [...tree.notebooks].sort(byPos);

  const choose = (notebookId: string, sectionId: string | null) => {
    if (item.kind === 'page') void movePage(item.id, sectionId!, null, 'inside');
    else void moveSection(item.id, notebookId, sectionId, null, 'inside');
    setQ('');
    onClose();
  };

  const option = (key: string, selected: boolean, onClick: () => void, icon: React.ReactNode, label: string, level = 1) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={selected}
      className="move-option"
      style={level > 1 ? { paddingLeft: `${(level - 1) * 16 + 8}px` } : undefined}
      onClick={onClick}
    >
      {icon}
      <span className="grow truncate">{label}</span>
      {selected && <Check size={14} className="menu-check" />}
    </button>
  );

  return (
    <Dialog open onClose={onClose} title={item.kind === 'page' ? 'Move page to…' : 'Move section to…'} size="sm">
      <Input icon={<Search size={15} />} placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Filter destinations" />
      <div className="move-list" role="listbox" aria-label="Destinations">
        {notebooks.map((nb) => {
          const matches = (sectionId: string) => !needle || sectionPathLabel(tree, sectionId, nb.name).toLowerCase().includes(needle);
          // A section can go inside any section that keeps it within the nesting limit (not inside itself).
          const secs = sectionsInOrder(tree, nb.id).filter(
            ({ section: s }) => matches(s.id) && (item.kind === 'page' || canNestUnder(tree, item.id, s.id)),
          );
          const topLevel = item.kind === 'section' && (!needle || nb.name.toLowerCase().includes(needle));
          if (!secs.length && !topLevel) return null;
          return (
            <div key={nb.id} className="move-group">
              <div className="move-group-title">{nb.name}</div>
              {topLevel &&
                option(
                  `nb-${nb.id}`,
                  nb.id === current,
                  () => choose(nb.id, null),
                  <span className="nb-icon" style={{ background: nb.color }}>
                    {nb.name[0]?.toUpperCase()}
                  </span>,
                  'Top level',
                )}
              {secs.map(({ section: s, level }) =>
                option(s.id, s.id === current, () => choose(nb.id, s.id), <span className="sec-tab" style={{ background: s.color }} />, s.name, level),
              )}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
