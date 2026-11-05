// The notification bell: unread badge + inbox popover (mentions, replies,
// assignments, shares, reminders). Owner: Collaboration & Access.
//
//   <NotificationBell />   // place in the sidebar header / mobile top bar
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { AtSign, Bell, CheckCheck, MessageSquare, Share2, UserPlus, AlarmClock } from 'lucide-react';
import { Avatar, Popover } from '../ui.tsx';
import { useStore } from '../../store.ts';
import { loadInbox, markAllRead, markRead, resetInbox, useInbox } from './inbox.ts';
import type { AppNotification } from '../../../shared/types.ts';
import './inbox.css';

const ICON: Record<string, typeof Bell> = { mention: AtSign, comment: MessageSquare, shared: Share2, invite: UserPlus, assigned: UserPlus, reminder: AlarmClock };

export function NotificationBell({ size = 18 }: { size?: number }) {
  const { items, unread } = useInbox();
  const userId = useStore((s) => s.user?.id);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    // (Re)load for whoever is signed in; a different account must never see the previous inbox.
    resetInbox();
    if (userId) void loadInbox().catch(() => {});
  }, [userId]);

  const openItem = (n: AppNotification) => {
    void markRead(n.id);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="btn-ghost icon-btn bell-btn"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        title="Notifications"
        onClick={() => setOpen((o) => !o)}
      >
        <Bell size={size} />
        {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-start" className="inbox-pop">
        <div className="inbox-head">
          <strong>Notifications</strong>
          {unread > 0 && (
            <button className="btn-ghost btn-sm" onClick={() => void markAllRead()}>
              <CheckCheck size={14} /> Mark all read
            </button>
          )}
        </div>
        <div className="inbox-list" role="list">
          {!items.length && <p className="muted small inbox-empty">You’re all caught up. Mentions, replies and shares show up here.</p>}
          {items.map((n) => (
            <InboxRow key={n.id} n={n} onOpen={() => openItem(n)} />
          ))}
        </div>
      </Popover>
    </>
  );
}

function InboxRow({ n, onOpen }: { n: AppNotification; onOpen: () => void }) {
  const actor = useStore((s) => s.members.find((m) => m.id === n.actorId));
  const Icon = ICON[n.kind] ?? Bell;
  return (
    <button role="listitem" className={`inbox-row ${n.readAt ? '' : 'is-unread'}`} onClick={onOpen}>
      <span className="inbox-avatar">
        {actor ? <Avatar user={actor} size={28} /> : <span className="inbox-icon"><Icon size={15} /></span>}
      </span>
      <span className="inbox-text">
        <span className="inbox-title">{n.title}</span>
        {n.body && <span className="inbox-body">{n.body}</span>}
        <span className="muted small">{formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}</span>
      </span>
      {!n.readAt && <span className="inbox-dot" aria-label="unread" />}
    </button>
  );
}
