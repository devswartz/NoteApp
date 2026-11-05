// Which tasks have upcoming reminders (yours), for the bell on task rows.
// Loaded once per workspace and refreshed when ReminderPicker changes something.
import { create } from 'zustand';
import { notificationsApi } from './api.ts';

interface ReminderIndex {
  wsId: string | null;
  next: Record<string, string>;
  load(wsId: string): Promise<void>;
}

export const useReminderIndex = create<ReminderIndex>((set, get) => ({
  wsId: null,
  next: {},
  async load(wsId) {
    try {
      const next = await notificationsApi.reminderIndex(wsId);
      set({ wsId, next });
    } catch {
      /* indicator only; ignore */
    }
  },
}));

/** Refresh after reminders change (no-op until an index was loaded). */
export function refreshReminderIndex() {
  const { wsId, load } = useReminderIndex.getState();
  if (wsId) void load(wsId);
}
