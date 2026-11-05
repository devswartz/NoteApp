// "Who's here" for a page: an overlapping avatar stack (with +N overflow) that
// opens a list of everyone on the page and whether they can edit.
// Owner: Collaboration & Access.
//
//   <PresenceStack users={presence} />           // presence: PagePresence[] (see ./collab.ts)
//   useAwarenessPresence(provider.awareness, me.id) → PagePresence[]
import { useEffect, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import { Avatar, Popover } from '../components/ui.tsx';
import { presenceFrom, samePresence, type PagePresence } from './collab.ts';
import '../components/sharing/sharing.css';

/** Live list of other people on the page, re-rendering only when it actually changes. */
export function useAwarenessPresence(awareness: Awareness | null | undefined, selfUserId: string): PagePresence[] {
  const [list, setList] = useState<PagePresence[]>([]);
  useEffect(() => {
    if (!awareness) return;
    const update = () => setList((prev) => {
      const next = presenceFrom(awareness, selfUserId);
      return samePresence(prev, next) ? prev : next;
    });
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [awareness, selfUserId]);
  return list;
}

export function PresenceStack({ users, max = 4, size = 24 }: { users: PagePresence[]; max?: number; size?: number }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!users.length) return null;
  const shown = users.slice(0, users.length > max ? max - 1 : max);
  const extra = users.length - shown.length;
  const label = users.length === 1 ? `${users[0].name} is here` : `${users.length} people are here`;
  return (
    <>
      <button ref={anchor} type="button" className="presence presence-btn" aria-label={label} title={label} onClick={() => setOpen((o) => !o)}>
        {shown.map((u) => (
          <span key={u.id} className="presence-avatar" style={{ ['--ring' as string]: u.color }}>
            <Avatar user={u} size={size} title={u.name} />
          </span>
        ))}
        {extra > 0 && (
          <span className="avatar presence-more" style={{ width: size, height: size, fontSize: size * 0.4 }}>
            +{extra}
          </span>
        )}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" className="presence-pop">
        <div className="menu-label-row">On this page now</div>
        {users.map((u) => (
          <div key={u.id} className="presence-row">
            <Avatar user={u} size={22} />
            <span className="grow">{u.name}</span>
            <span className="muted small">
              {u.canEdit ? 'editing' : 'viewing'}
              {u.sessions > 1 ? ` · ${u.sessions} tabs` : ''}
            </span>
          </div>
        ))}
      </Popover>
    </>
  );
}
