// The block handle (⋮⋮) in a nested list: keeping it on the line you point at while the pointer travels to it.
// The handle library picks its target from the pointer's position in the text. Moving left toward the handle crosses the
// indent in front of a nested line, which is part of the parent item's box, so the target jumped to the parent and only
// top-level lines could be dragged. Two fixes, both here:
//  1. The target follows the pointer's ROW: when the pointer is in the gutter/indent beside a list line, or at the very start of
//     its text (level with its first line), the library is told the pointer is a little way into that line's text, so the line
//     under the pointer's Y is the target, whatever the X.
//  2. When the pointer leaves the text on its way to the handle, the handle stays for a short grace period (300 ms) as long as
//     the pointer is level with that line's row, and while it is over the handle itself. Moving to another row retargets as usual.
export const REACH_GRACE_MS = 300;
/** The handle library's edge-detection threshold is 12px; stay clear of it. */
const EDGE_CLEAR = 16;

interface Band {
  top: number;
  bottom: number;
  at: number;
}

/** A list line's own first line (not its sub-points): the first paragraph directly in the item. */
function lineOf(li: Element): HTMLElement | null {
  return li.querySelector<HTMLElement>(':scope > p, :scope > div > p');
}

/**
 * Installs the two behaviours on an editor's DOM. `handle` is the handle's class name. Returns the cleanup.
 * Pointer events are adjusted (clientX only) in the capture phase, before the handle plugin reads them.
 */
export function installHandleReach(dom: HTMLElement, handleClass = 'block-handle'): () => void {
  let band: Band | null = null;
  let overHandle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const synthetic = new WeakSet<Event>();

  const onMove = (e: MouseEvent) => {
    if (synthetic.has(e)) return;
    clearTimeout(timer);
    if (e.buttons) return; // a drag or a selection in progress
    const box = dom.getBoundingClientRect();
    // The deepest list item on this row: what is at the middle of the box at the pointer's height (list items span the width).
    const probe = document.elementFromPoint(box.left + box.width / 2, e.clientY);
    const li = probe && dom.contains(probe) ? probe.closest('li') : null;
    const line = li && dom.contains(li) ? lineOf(li) : null;
    if (!line) {
      band = null;
      return;
    }
    const r = line.getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom) {
      band = null;
      return;
    }
    band = { top: r.top, bottom: r.bottom, at: performance.now() };
    // In the gutter or indent beside the line, or in the first pixels of its text: as far as the handle is concerned, the pointer is
    // a little way into the line's text. (A list item's box starts exactly at its text, and the library prefers the parent when
    // the pointer is within ~12px of a box's left edge: that is the jump to the parent item.)
    if (e.clientX < r.left + EDGE_CLEAR) Object.defineProperty(e, 'clientX', { value: r.left + EDGE_CLEAR, configurable: true });
  };

  const onLeave = (e: MouseEvent) => {
    if (synthetic.has(e) || !band) return;
    const level = e.clientY >= band.top - 2 && e.clientY <= band.bottom + 2 && performance.now() - band.at < REACH_GRACE_MS;
    if (!level) return;
    // Level with the line it is on, heading for the handle: keep the handle for a moment (it hides if the pointer never arrives).
    e.stopImmediatePropagation();
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (overHandle) return;
      band = null;
      const again = new MouseEvent('mouseleave', { bubbles: false, relatedTarget: null });
      synthetic.add(again);
      dom.dispatchEvent(again);
    }, REACH_GRACE_MS);
  };

  const onOver = (e: MouseEvent) => {
    const on = !!(e.target as Element | null)?.closest?.(`.${handleClass}`);
    if (on) clearTimeout(timer);
    overHandle = on;
  };

  dom.addEventListener('mousemove', onMove, true);
  dom.addEventListener('mouseleave', onLeave, true);
  document.addEventListener('mouseover', onOver, true);
  return () => {
    clearTimeout(timer);
    dom.removeEventListener('mousemove', onMove, true);
    dom.removeEventListener('mouseleave', onLeave, true);
    document.removeEventListener('mouseover', onOver, true);
  };
}
