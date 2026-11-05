// Desktop notifications (tauri-plugin-notification) can't report clicks back
// to the app. Clicking one does bring the app forward, though, so this treats
// "the app was in the background, showed a notification, and then came to the
// front within a short window" as a click on the latest such notification.
// Pure, so it can be unit-tested.

export const CLICK_WINDOW_MS = 60_000;

export function createClickTracker(windowMs = CLICK_WINDOW_MS) {
  let pending: { onClick: () => void; at: number } | null = null;
  return {
    /** A notification was shown. Only ones shown while the app was in the background can be "clicked". */
    shown(onClick: (() => void) | undefined, appHidden: boolean, now = Date.now()) {
      if (onClick && appHidden) pending = { onClick, at: now };
    },
    /** The app came to the front. Runs the pending click, if any and recent. */
    focused(now = Date.now()): boolean {
      const p = pending;
      pending = null;
      if (!p || now - p.at > windowMs) return false;
      p.onClick();
      return true;
    },
  };
}
