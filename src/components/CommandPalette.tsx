import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleCheck, FileText, Plus, Search } from 'lucide-react';
import { formatKeys, isEnabled, useCommandList } from '../hooks/useShortcuts.ts';
import { ui, useStore, toggleTask } from '../store.ts';
import { get } from '../api.ts';
import { ENTER, Kbd, MOD, Modal, keyLabel } from './ui.tsx';
import type { SearchResult, Task } from '../../shared/types.ts';
import { describeDue } from '../lib/format.ts';

interface Item {
  key: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  sub?: React.ReactNode;
  run: () => void;
  alt?: () => void;
  match?: string;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  if (!open) return null;
  return <PaletteInner />;
}

function highlightSnippet(s: string) {
  return s.split(/(«[^»]*»)/).map((part, i) => (part.startsWith('«') ? <mark key={i}>{part.slice(1, -1)}</mark> : part));
}

function PaletteInner() {
  const wsId = useStore((s) => s.wsId);
  const tree = useStore((s) => s.tree);
  const tasks = useStore((s) => s.tasks);
  const commands = useCommandList();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const [remote, setRemote] = useState<SearchResult | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) return setRemote(null);
    const t = setTimeout(() => {
      get<SearchResult>(`/workspaces/${wsId}/search?q=${encodeURIComponent(q)}`).then(setRemote).catch(() => {});
    }, 150);
    return () => clearTimeout(t);
  }, [q, wsId]);

  const go = (path: string) => () => {
    ui.closePalette();
    navigate(path);
  };

  const items: { title: string; items: Item[] }[] = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const crumb = (sectionId: string) => {
      const s = tree.sections.find((x) => x.id === sectionId);
      const n = tree.notebooks.find((x) => x.id === s?.notebookId);
      return `${n?.name ?? ''} › ${s?.name ?? ''}`;
    };
    const pageItem = (p: { id: string; title: string }, sub: React.ReactNode): Item => ({
      key: `p${p.id}`,
      icon: <FileText size={16} />,
      label: p.title || 'Untitled',
      sub,
      run: go(`/w/${wsId}/p/${p.id}`),
    });
    const taskItem = (t: Task): Item => ({
      key: `t${t.id}`,
      icon: <CircleCheck size={16} className={t.status === 'done' ? 'success' : ''} />,
      label: <span className={t.status === 'done' ? 'strike' : ''}>{t.title || 'Untitled task'}</span>,
      sub: t.dueDate ? describeDue(t.dueDate) : undefined,
      run: () => {
        ui.closePalette();
        ui.openTask(t.id);
      },
      alt: () => toggleTask(t.id),
    });

    const actions: Item[] = commands
      .filter((c) => c.run && (c.palette ?? true) && isEnabled(c))
      .map((c) => ({
        key: `c-${c.id}`,
        icon: c.icon,
        label: c.title,
        sub: c.keys ? <KeyHint keys={Array.isArray(c.keys) ? c.keys[0] : c.keys} /> : c.group,
        match: `${c.title} ${c.group ?? ''} ${c.keywords ?? ''}`.toLowerCase(),
        run: () => {
          ui.closePalette();
          // Let the palette close (and focus return) before the command runs.
          setTimeout(() => void c.run!(), 0);
        },
      }));

    if (!needle) {
      const recent = [...tree.pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
      return [
        { title: 'Recent pages', items: recent.map((p) => pageItem(p, crumb(p.sectionId))) },
        { title: 'Actions', items: actions },
      ];
    }

    const titleHits = tree.pages.filter((p) => (p.title || 'untitled').toLowerCase().includes(needle)).slice(0, 8);
    const seen = new Set(titleHits.map((p) => p.id));
    const contentHits = (remote?.pages ?? []).filter((p) => !seen.has(p.id));
    const localTasks = Object.values(tasks).filter((t) => t.title.toLowerCase().includes(needle));
    const taskMap = new Map<string, Task>();
    for (const t of [...localTasks, ...(remote?.tasks ?? [])]) taskMap.set(t.id, tasks[t.id] ?? t);
    const taskHits = [...taskMap.values()].sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1)).slice(0, 8);

    return [
      { title: 'Pages', items: [...titleHits.map((p) => pageItem(p, crumb(p.sectionId))), ...contentHits.map((p) => pageItem(p, <span className="snippet">{highlightSnippet(p.snippet)}</span>))] },
      { title: 'Tasks', items: taskHits.map(taskItem) },
      { title: 'Actions', items: actions.filter((a) => needle.split(/\s+/).every((w) => a.match!.includes(w))) },
      {
        title: '',
        items: [
          {
            key: 'create-task',
            icon: <Plus size={16} />,
            label: (
              <>
                Create task “<b>{q}</b>”
              </>
            ),
            run: () => {
              ui.closePalette();
              ui.openQuickAdd({ text: q });
            },
          },
        ],
      },
    ].filter((g) => g.items.length);
  }, [q, tree, tasks, remote, wsId, commands]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = items.flatMap((g) => g.items);
  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  return (
    <Modal open onClose={ui.closePalette} className="palette" label="Search">
      <div className="palette-input">
        <Search size={18} className="muted" />
        <input
          autoFocus
          placeholder="Search pages and tasks, or type a command…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(flat.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const it = flat[index];
              if (!it) return;
              if ((e.metaKey || e.ctrlKey) && it.alt) it.alt();
              else it.run();
            }
          }}
        />
      </div>
      <div className="palette-list" ref={listRef}>
        {items.map((g) => (
          <div key={g.title || 'x'}>
            {g.title && <div className="palette-group">{g.title}</div>}
            {g.items.map((it) => {
              const i = flat.indexOf(it);
              return (
                <button key={it.key} className={`palette-item ${i === index ? 'is-active' : ''}`} onMouseMove={() => setIndex(i)} onClick={it.run}>
                  <span className="palette-icon">{it.icon}</span>
                  <span className="palette-label truncate">{it.label}</span>
                  {it.sub && <span className="palette-sub truncate">{it.sub}</span>}
                </button>
              );
            })}
          </div>
        ))}
        {q && !flat.length && <div className="empty">No results</div>}
      </div>
      <div className="palette-foot muted small">
        ↑↓ navigate · ↵ open · {keyLabel(MOD, ENTER)} complete task · esc close
      </div>
    </Modal>
  );
}

function KeyHint({ keys }: { keys: string }) {
  return (
    <span className="key-hint">
      {formatKeys(keys).map((k, i) => (k === 'then' ? null : <Kbd key={i}>{k}</Kbd>))}
    </span>
  );
}
