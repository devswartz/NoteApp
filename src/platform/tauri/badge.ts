// Dock badge (macOS) and tray count: the signed-in user's open tasks that are
// due today or overdue, i.e. what the Today view lists.
import { invoke } from '@tauri-apps/api/core';
import type { Task } from '../../../shared/types.ts';
import { today } from '../../../shared/dates.ts';

export function todayCount(tasks: Record<string, Task> | Task[], me: string | null | undefined, day = today()): number {
  if (!me) return 0;
  let n = 0;
  for (const t of Object.values(tasks)) {
    const mine = t.assigneeId === me || (!t.assigneeId && t.createdBy === me);
    if (mine && t.status === 'open' && t.dueDate && t.dueDate <= day) n++;
  }
  return n;
}

export async function startBadgeSync() {
  const { useStore } = await import('../../store.ts');
  let last = -1;
  const update = () => {
    const s = useStore.getState();
    const n = todayCount(s.tasks, s.user?.id);
    if (n === last) return;
    last = n;
    void invoke('set_today_count', { count: n }).catch(() => {});
  };
  update();
  useStore.subscribe(update);
  // The date changes at midnight even if no task does.
  setInterval(() => {
    last = -1;
    update();
  }, 10 * 60_000);
}
