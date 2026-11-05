// Web push on this device, through the platform adapter.
//
// The adapter gains an optional `push` capability (Foundation owns
// src/platform/; requested in the Reminders PR). Until a platform provides it,
// pushSupported() is false and the settings panel says so; reminders still
// arrive by email and in-app.
import { platform } from '../../platform/index.ts';
import type { PushSubscriptionInput } from '../../../shared/types.ts';

export interface PushCapability {
  /** Push is possible here (service worker + PushManager, or a native shell). */
  supported(): boolean;
  /** This device's current subscription, if any. */
  current(): Promise<PushSubscriptionInput | null>;
  /** Asks permission if needed and subscribes with the server's VAPID key. Null if refused. */
  subscribe(vapidPublicKey: string): Promise<PushSubscriptionInput | null>;
  /** Unsubscribes; resolves to the endpoint that was removed, if any. */
  unsubscribe(): Promise<string | null>;
}

const cap = (): PushCapability | undefined => (platform as { push?: PushCapability }).push;

export const pushSupported = () => !!cap()?.supported();
export const currentPush = async () => (pushSupported() ? cap()!.current() : null);
export const subscribePush = async (key: string) => (pushSupported() ? cap()!.subscribe(key) : null);
export const unsubscribePush = async () => (pushSupported() ? cap()!.unsubscribe() : null);
