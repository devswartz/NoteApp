import { set, type Toast } from './state.ts';

let toastSeq = 0;
export function toast(message: string, opts: Omit<Toast, 'id' | 'message'> = {}) {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, ...opts }] }));
  setTimeout(() => dismissToast(id), opts.action ? 6000 : 3500);
}
export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
export function errorToast(e: unknown) {
  toast(e instanceof Error ? e.message : 'Something went wrong', { tone: 'error' });
}
