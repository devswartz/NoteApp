import { set, type Toast } from './state.ts';
import { ApiError } from '../api.ts';

let toastSeq = 0;
export function toast(message: string, opts: Omit<Toast, 'id' | 'message'> = {}) {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, ...opts }] }));
  if (!opts.sticky) setTimeout(() => dismissToast(id), opts.action ? 6000 : 3500);
}
export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
export function errorToast(e: unknown) {
  toast(errorMessage(e), { tone: 'error' });
}

/** User-facing text for an error; server errors get a short reference to quote when reporting. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status >= 500 && e.requestId) return `${e.message} (ref ${e.requestId.slice(0, 8)})`;
  if (e instanceof TypeError) return "Couldn't reach the server. Check your connection.";
  return e instanceof Error ? e.message : 'Something went wrong';
}
