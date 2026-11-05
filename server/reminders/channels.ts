// Delivery channels. A channel turns one Notice into messages to a user's
// targets (devices, email address). Add APNs/FCM in Phase 3 by implementing
// DeliveryChannel and listing it in defaultChannels().
//
// Delivery is idempotent per (notice key, channel, target): see deliver.ts.

export interface Notice {
  /** Identifies this firing, e.g. "reminder:<id>:<fireAt>" or "digest:<userId>:<date>". */
  key: string;
  userId: string;
  title: string;
  body: string;
  /** In-app path to open, e.g. /w/<wsId>/tasks/today?task=<id>. */
  path: string;
  taskId?: string;
  /** Collapses repeated notifications for the same thing on a device. */
  tag?: string;
  /** Optional HTML body for email. */
  html?: string;
  /** Lets the push notification snooze the reminder without an access token (snooze.ts). */
  snoozeToken?: string;
  /** Only deliver through these channels (e.g. the digest is email only). */
  channels?: string[];
}

/** Thrown by send() when a target is permanently gone (expired push subscription). */
export class TargetGoneError extends Error {}

export interface DeliveryChannel {
  name: string;
  /** False when the channel isn't configured (env vars missing). It is then skipped. */
  available(): boolean;
  /** Where to send for this user: subscription endpoints, an email address, … Empty = skip. */
  targets(userId: string): string[];
  send(target: string, notice: Notice): Promise<void>;
  /** Called after TargetGoneError, e.g. to delete an expired subscription. */
  forget?(target: string): void;
}
