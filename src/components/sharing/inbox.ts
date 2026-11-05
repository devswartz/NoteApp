// Notification inbox store (the bell). Owner: Collaboration & Access.
import { create } from 'zustand';
import { get, post } from '../../api.ts';
import type { AppNotification } from '../../../shared/types.ts';

interface InboxState {
  items: AppNotification[];
  unread: number;
  loaded: boolean;
}
export const useInbox = create<InboxState>(() => ({ items: [], unread: 0, loaded: false }));
const set = useInbox.setState;
const st = useInbox.getState;

export async function loadInbox() {
  const r = await get<{ items: AppNotification[]; unread: number }>('/notifications');
  set({ items: r.items, unread: r.unread, loaded: true });
}

/** A live `notification` event arrived. */
export function receiveNotification(n: AppNotification) {
  if (st().items.some((x) => x.id === n.id)) return;
  set({ items: [n, ...st().items].slice(0, 100), unread: st().unread + (n.readAt ? 0 : 1) });
}

export async function markRead(id: string) {
  const n = st().items.find((x) => x.id === id);
  if (!n || n.readAt) return;
  set({ items: st().items.map((x) => (x.id === id ? { ...x, readAt: new Date().toISOString() } : x)), unread: Math.max(0, st().unread - 1) });
  await post(`/notifications/${id}/read`).catch(() => {});
}

export async function markAllRead() {
  const ts = new Date().toISOString();
  set({ items: st().items.map((x) => (x.readAt ? x : { ...x, readAt: ts })), unread: 0 });
  await post('/notifications/read-all').catch(() => {});
}

export function resetInbox() {
  set({ items: [], unread: 0, loaded: false });
}
