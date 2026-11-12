/**
 * True from beforeprint until just after afterprint. While the print dialog is open the viewport is the
 * paper's width, so queries like (max-width: 760px) match; layout-deciding code ignores that, or the whole app
 * switches to its phone layout (closing and un-remembering the sidebar, remounting the ribbon) and stays changed.
 */
let printing = false;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeprint', () => {
    printing = true;
  });
  window.addEventListener('afterprint', () => {
    // The screen layout comes back a moment after the dialog closes; read the queries then.
    setTimeout(() => {
      printing = false;
      listeners.forEach((f) => f());
    }, 300);
  });
}
export const isPrinting = () => printing;
/** Called when printing has finished and the screen layout is back. Returns the unsubscribe. */
export const onPrintDone = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};
