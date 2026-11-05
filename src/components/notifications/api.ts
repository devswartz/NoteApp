// Client for the reminders/notifications API (server/routes/reminders.ts).
import { api, del, get, patch, post } from '../../api.ts';
import type { NotificationSettings, PushSubscriptionInput, QuietHours, Reminder, ReminderSpec } from '../../../shared/types.ts';

export interface PushInfo {
  /** VAPID public key, or null when web push isn't configured on the server. */
  publicKey: string | null;
  emailAvailable: boolean;
  /** How many devices of yours are subscribed. */
  devices: number;
}

export const notificationsApi = {
  settings: () => get<NotificationSettings>('/notifications/settings'),
  updateSettings: (p: Partial<NotificationSettings>) => patch<NotificationSettings>('/notifications/settings', p),
  pushInfo: () => get<PushInfo>('/notifications/push'),
  subscribe: (s: PushSubscriptionInput) => post<{ ok: true }>('/notifications/push-subscriptions', s),
  unsubscribe: (endpoint: string) => api<{ ok: true }>('/notifications/push-subscriptions', { method: 'DELETE', json: { endpoint } }),
  test: () => post<{ sent: number; failed: number; skipped: number }>('/notifications/test'),
  quietHours: () => get<QuietHours[]>('/notifications/quiet-hours'),
  setQuietHours: (workspaceId: string, start: string, end: string) => api<QuietHours>(`/workspaces/${workspaceId}/quiet-hours`, { method: 'PUT', json: { start, end } }),
  clearQuietHours: (workspaceId: string) => del<{ ok: true }>(`/workspaces/${workspaceId}/quiet-hours`),
  reminders: (taskId: string) => get<Reminder[]>(`/tasks/${taskId}/reminders`),
  addReminder: (taskId: string, spec: ReminderSpec) => post<Reminder>(`/tasks/${taskId}/reminders`, spec),
  updateReminder: (id: string, spec: ReminderSpec) => patch<Reminder>(`/reminders/${id}`, spec),
  deleteReminder: (id: string) => del<{ ok: true }>(`/reminders/${id}`),
};
