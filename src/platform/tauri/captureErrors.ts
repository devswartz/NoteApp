// Quick-capture failure messages (pure, for tests).

export class SignedOut extends Error {}

/** What to tell the user when adding failed. */
export function describeFailure(e: unknown, online = typeof navigator === 'undefined' || navigator.onLine): string {
  if (e instanceof SignedOut) return 'Sign in to the app first. ↵ opens it.';
  if (!online || e instanceof TypeError) return 'You’re offline. Your text is kept; try again when you’re connected.';
  return e instanceof Error ? e.message : String(e);
}
