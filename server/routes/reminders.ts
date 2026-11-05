// Reminder and notification-settings REST endpoints. Owner: Recurrence & Reminders.
//
//   GET    /notifications/settings                → NotificationSettings
//   PATCH  /notifications/settings                → NotificationSettings
//   GET    /notifications/push                    → { publicKey: string | null, emailAvailable, devices }
//   POST   /notifications/push-subscriptions      PushSubscriptionInput → { ok }
//   DELETE /notifications/push-subscriptions      { endpoint } → { ok }
//   POST   /notifications/test                    → sends a test notice to yourself
//   GET    /tasks/:id/reminders                   → Reminder[] (yours)
//   POST   /tasks/:id/reminders                   ReminderSpec → Reminder
//   PATCH  /reminders/:id                         ReminderSpec → Reminder
//   DELETE /reminders/:id                         → { ok }
import { Router } from 'express';
import { h, param } from '../http.ts';
import { HttpError } from '../access.ts';
import { getSettings, updateSettings } from '../reminders/settings.ts';
import { countSubscriptions, deleteSubscription, saveSubscription, vapidPublicKey } from '../reminders/push.ts';
import { createReminder, deleteReminder, listReminders, updateReminder } from '../reminders/store.ts';
import { defaultChannels, pokeScheduler } from '../reminders/scheduler.ts';
import { deliver } from '../reminders/deliver.ts';
import { mailConfigured } from '../mail.ts';

export const reminderRoutes = Router();

reminderRoutes.get('/notifications/settings', h((req) => getSettings(req.user.id)));
reminderRoutes.patch('/notifications/settings', h((req) => updateSettings(req.user.id, req.body ?? {})));

reminderRoutes.get(
  '/notifications/push',
  h((req) => ({ publicKey: vapidPublicKey(), emailAvailable: mailConfigured(), devices: countSubscriptions(req.user.id) })),
);

reminderRoutes.post(
  '/notifications/push-subscriptions',
  h((req) => {
    saveSubscription(req.user.id, req.body, req.get('user-agent'));
    return { ok: true };
  }),
);

reminderRoutes.delete(
  '/notifications/push-subscriptions',
  h((req) => {
    if (typeof req.body?.endpoint !== 'string') throw new HttpError(400, 'endpoint is required');
    deleteSubscription(req.user.id, req.body.endpoint);
    return { ok: true };
  }),
);

const lastTest = new Map<string, number>();

reminderRoutes.post(
  '/notifications/test',
  h(async (req) => {
    const prev = lastTest.get(req.user.id) ?? 0;
    if (Date.now() - prev < 10_000) throw new HttpError(429, 'Please wait a few seconds before sending another test');
    lastTest.set(req.user.id, Date.now());
    const report = await deliver(
      {
        key: `test:${req.user.id}:${Date.now()}`,
        userId: req.user.id,
        title: 'Test notification',
        body: 'Reminders will arrive like this.',
        path: '/',
        tag: 'test',
      },
      defaultChannels(),
    );
    return report;
  }),
);

reminderRoutes.get('/tasks/:id/reminders', h((req) => listReminders(param(req, 'id'), req.user.id)));

reminderRoutes.post(
  '/tasks/:id/reminders',
  h((req) => {
    const r = createReminder(param(req, 'id'), req.user.id, req.body);
    pokeScheduler();
    return r;
  }),
);

reminderRoutes.patch(
  '/reminders/:id',
  h((req) => {
    const r = updateReminder(param(req, 'id'), req.user.id, req.body);
    pokeScheduler();
    return r;
  }),
);

reminderRoutes.delete(
  '/reminders/:id',
  h((req) => {
    deleteReminder(param(req, 'id'), req.user.id);
    return { ok: true };
  }),
);
