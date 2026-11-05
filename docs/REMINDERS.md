# Recurrence and reminders

Owner: Recurrence & Reminders (agent 5). This is how recurring tasks, reminders and notification delivery work.

## Recurrence (`shared/recurrence.ts`)

A rule is a `Recurrence` (`shared/types.ts`). The original small rules still work. The optional fields add:

| Rule | JSON |
|---|---|
| Every day / every 3 days | `{freq:'day', interval:1}` / `{freq:'day', interval:3}` |
| Weekdays (Mon–Fri) | `{freq:'weekday'}` |
| Every 2 weeks on Mon, Thu | `{freq:'week', interval:2, byWeekday:[1,4]}` |
| Monthly on the 15th / last day | `{freq:'month', interval:1, byMonthDay:15}` / `byMonthDay:-1` |
| Monthly on the 2nd Tuesday / last Friday | `{freq:'month', interval:1, byNthWeekday:{n:2, weekday:2}}` / `{n:-1, weekday:5}` |
| Yearly (keeps Feb 29 in leap years) | `{freq:'year', interval:1, byMonthDay:29}` |
| Ends | `until:'2027-06-30'` (inclusive) or `count:10` (total occurrences) |
| From completion | `basis:'completion'`, e.g. "3 days after I last did it". The default is `'due'`. |

- Dates are local calendar dates (`YYYY-MM-DD`). Calendar arithmetic runs on UTC dates, so a DST change never moves a day. The user's IANA time zone is used only for "what is today" and for turning a local date and time into an instant (`zonedTimeToUtc`). A time skipped by spring-forward moves to after the gap. An ambiguous time at fall-back resolves to its first occurrence.
- Month ends clamp without drifting: with `byMonthDay:31`, the series is Jan 31 → Feb 28 → Mar 31. Plain monthly rules without `byMonthDay` keep the old behaviour (they step from the current due date), so the pickers always set `byMonthDay`.
- A "5th Monday" rule skips months that don't have one.
- `nextOccurrence(rule, {dueDate, today, completedCount})` always lands **strictly after today**, so completing an overdue task never creates another overdue one. It returns `null` when `until` or `count` ends the series.
- `parseRecurrence(text)` handles quick-add phrases such as "every weekday", "every 2 weeks on mon,thu", "every month on the 15th", "every 2nd tuesday", "every last friday", "daily", "fortnightly", and the suffixes "until 2026-12-31", "for 10 times" and "after completion". It returns `{rule, start, end}` so the caller can strip the phrase from the title.
- `describeRecurrence(rule, dueDate)` gives the human-readable label, and `previewOccurrences(rule, start, n)` lists the next dates for the picker.

### Completing a recurring task: the same task rolls forward
Completing a recurring task keeps **one task** and moves its due date forward, so its id, note link (`taskRef`), assignee and reminders stay the same. For history, `server/tasks.ts` inserts a completed copy with `occurrence_of = <task id>`, and those copies show in Completed. When the series ends (`nextOccurrence` returns null), the task is completed normally.

`server/reminders/recurring.ts → nextDueDate(rule, dueDate, taskId, userId)` wraps this with the completing user's time zone. It also counts the recorded occurrences, which `count` rules need. `server/tasks.ts` (owned by Tasks) should call it in place of `shared/dates.ts → nextOccurrence`.

## Reminders (`server/reminders/`)

`task_reminders` (migration `005-reminders.sql`) holds one row per reminder and recipient:

- `at`: a fixed instant.
- `before`: N minutes before the task is due. Tasks with a date but no time use the user's default reminder time. This kind follows the task when the due date moves or a recurring task rolls forward.
- `legacy`: mirrors the original `tasks.reminder_at` field, so existing reminders keep working. The recipient is the assignee, or else the creator.

`next_fire_at` is cached on the row. `syncReminders()` recomputes it for rows whose task changed (`tasks.updated_at > synced_at`) or whose settings changed. `server/tasks.ts` needs no hooks.

### Scheduler (`scheduler.ts`)
The scheduler runs in-process and ticks every 20 s. It also runs a pass right away when a reminder is created. Each tick:
1. Syncs reminders with their tasks.
2. Claims every reminder with `next_fire_at <= now` using an atomic `UPDATE … WHERE next_fire_at = ?`, so overlapping passes can't take the same one. It then sets `last_fired_at` and clears `next_fire_at`.
3. Delivers each claimed reminder, provided the recipient can still see the task.
4. Sends any daily digests that are due.

**Restarts and catch-up:** all state is in SQLite. After a restart, the first tick sends anything that came due while the server was down within the last **12 hours**. Older reminders are dropped (counted as `missed`) rather than sent late.

**No duplicates:** `deliver.ts` claims a `(key, channel, target)` row in `notification_log` before each send. The key is `reminder:<id>:<fireAt>` or `digest:<user>:<date>`. If the row already exists, the send is skipped. The guarantee is at-most-once per device or address, and it holds even if the process dies between claiming and sending.

### Delivery channels (`channels.ts`)
```ts
interface DeliveryChannel {
  name: string;
  available(): boolean;              // false → skipped (env vars missing)
  targets(userId): string[];         // devices / addresses for this user
  send(target, notice): Promise<void>;
  forget?(target): void;             // after TargetGoneError (expired subscription)
}
```
- **push** (`push.ts`): web push with VAPID through the `web-push` library, one subscription per browser or device (`push_subscriptions`). It is skipped unless `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set. Endpoints that return 404 or 410 are deleted.
- **email** (`email.ts`): sent through `server/mail.ts`. It is skipped unless `SMTP_HOST` is set, and for users who turned email off.
- **apns** (`apns.ts`) and **fcm** (`fcm.ts`): native push for the Phase 3 mobile app. The app registers its token with `POST /notifications/devices {platform:'ios'|'android', token}` (stored in `device_tokens`). APNs uses token auth (an ES256 JWT over HTTP/2). FCM uses the HTTP v1 API with a service-account OAuth token. Dead tokens are removed. Each channel is off unless its env vars are set:

  | Variable | Channel | Value |
  |---|---|---|
  | `APNS_KEY_ID` | apns | Key ID of the APNs auth key (.p8) |
  | `APNS_TEAM_ID` | apns | Apple Developer team ID |
  | `APNS_BUNDLE_ID` | apns | The iOS app's bundle ID (sent as `apns-topic`) |
  | `APNS_PRIVATE_KEY` | apns | Contents of the .p8 file (newlines may be written as `\n`) |
  | `APNS_ENV` | apns | `production` (default) or `sandbox` for development builds |
  | `FCM_SERVICE_ACCOUNT_JSON` | fcm | Firebase service-account key JSON (raw or base64) |

  The payloads carry `url`, `taskId` and `snoozeToken`, the same as web push. On iOS the notification category is `REMINDER`; on Android `click_action` is `REMINDER`. The app should register snooze actions under that name.
- Another channel: implement `DeliveryChannel` and add it to `defaultChannels()` in `scheduler.ts`.

### Snooze
A reminder's push payload includes a `snoozeToken`. The token is random, stored only as a hash in `action_tokens`, limited to one user and task, and valid for 7 days. The service worker shows Snooze 10 min / Snooze 1 hour / Tomorrow actions; browsers show as many as `Notification.maxActions` allows. Each action calls `POST /api/reminders/snooze {token, option:'10m'|'1h'|'tomorrow'}`, which needs no access token. The call sets (or moves) a single snooze reminder for that user and task. "Tomorrow" means tomorrow at the user's default reminder time.

Push payload, read by `public/sw-push.js`: `{ title, body, url, tag, taskId }`. The service worker shows the notification with an "Open task" action. A click focuses an open window and navigates it (it also posts `{type:'notification-click', url, taskId}` to the window), or opens a new window.

### Quiet hours
Each user can set quiet hours per workspace (`quiet_hours`, HH:mm in their time zone; a window like 22:00–07:00 wraps past midnight). A reminder for a task in that workspace that comes due inside the window is **held until the window ends**, not dropped. The scheduler moves its `next_fire_at` to the end of the window without marking it fired, so editing the task in the meantime still recomputes it. The daily digest ignores quiet hours, since its time is chosen explicitly.

## Settings and digest
`notification_settings` holds, per user: the time zone (default UTC), email on/off, the default reminder time (09:00), and the daily digest on/off with its time (08:00). The digest is an email listing open tasks assigned to you, or unassigned tasks you created, that are due today or overdue. It is sent once per local day at the chosen time. Empty digests aren't sent.

## API
| | |
|---|---|
| `GET/PATCH /notifications/settings` | `NotificationSettings` |
| `GET /notifications/push` | `{publicKey, emailAvailable, devices}` |
| `POST /notifications/push-subscriptions` | `PushSubscription.toJSON()` |
| `DELETE /notifications/push-subscriptions` | `{endpoint}` |
| `POST /notifications/test` | sends a test notification to yourself (at most once per 10 s) |
| `GET /notifications/quiet-hours` | your quiet hours, per workspace |
| `PUT/DELETE /workspaces/:id/quiet-hours` | `{start, end}` (HH:mm) / remove |
| `POST/DELETE /notifications/devices` | native push token `{platform, token}` / `{token}` |
| `POST /reminders/snooze` | `{token, option}`; no auth, the token comes from the push notification |
| `GET/POST /tasks/:id/reminders` | your reminders on a task / add one (`{kind:'before', minutes}` or `{kind:'at', at}`) |
| `PATCH/DELETE /reminders/:id` | change or remove one |

## UI (`src/components/notifications/`)
- `RecurrencePicker`: presets plus a custom editor, with a live description and a preview of the next dates.
- `ReminderPicker`: lists, adds and removes your reminders on a task.
- `NotificationSettingsPanel`: the Settings card.
- `useAutoTimeZone()`: saves the browser's time zone once.

Push on a device goes through an optional `platform.push` capability (`PushCapability` in `push.ts`). The web implementation belongs in `src/platform/web.ts` (owned by Foundation).
