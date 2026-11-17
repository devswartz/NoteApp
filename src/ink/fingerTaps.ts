// Two- and three-finger taps (undo / redo, as in Notability), from pointer events. This is what
// undoes and redoes on touch screens, the iPad included. Touch events can't be used there: an iPad
// web view presents itself as a desktop browser, which hides them (Devon's 0.5.90 (107) round:
// no gesture was ever seen). A tap: two or three fingers down together that barely move and all
// lift within TAP_MS. No DOM in FingerTaps (it takes pointer ids and points), so it is unit-tested.

export const TAP_MS = 400;
export const TAP_SLOP = 14;

export class FingerTaps {
  private down = new Map<number, { x: number; y: number }>();
  private max = 0;
  private t0 = 0;
  private spoiled = false;

  /** A finger went down. */
  start(id: number, x: number, y: number, time: number) {
    if (this.down.size === 0) {
      this.max = 0;
      this.spoiled = false;
      this.t0 = time;
    }
    this.down.set(id, { x, y });
    this.max = Math.max(this.max, this.down.size);
  }

  move(id: number, x: number, y: number) {
    const s = this.down.get(id);
    if (s && Math.hypot(x - s.x, y - s.y) > TAP_SLOP) this.spoiled = true;
  }

  /** A finger lifted (or was cancelled: the page started scrolling or zooming). Returns 2 or 3 when that ended a tap, else null. */
  end(id: number, time: number, cancelled = false): 2 | 3 | null {
    if (!this.down.delete(id)) return null;
    if (cancelled) this.spoiled = true;
    if (this.down.size > 0) return null;
    const n = this.max;
    if (this.spoiled || time - this.t0 > TAP_MS || (n !== 2 && n !== 3)) return null;
    return n;
  }
}

/**
 * Listen for the taps anywhere in `root` (capture, passive: nothing else is affected).
 * `onTouch(fingers)` reports each finger count seen, for the status readout.
 */
export function listenFingerTaps(root: Document | HTMLElement, onTap: (fingers: 2 | 3) => void, onTouch?: (fingers: number) => void): () => void {
  const taps = new FingerTaps();
  let seen = 0;
  const touch = (e: Event): e is PointerEvent => (e as PointerEvent).pointerType === 'touch';
  const down = (e: Event) => {
    if (!touch(e)) return;
    taps.start(e.pointerId, e.clientX, e.clientY, e.timeStamp);
    seen++;
    onTouch?.(seen);
  };
  const move = (e: Event) => touch(e) && taps.move(e.pointerId, e.clientX, e.clientY);
  const up = (e: Event) => {
    if (!touch(e)) return;
    seen = Math.max(0, seen - 1);
    const n = taps.end(e.pointerId, e.timeStamp, e.type === 'pointercancel');
    if (n) onTap(n);
  };
  const opts = { capture: true, passive: true } as const;
  root.addEventListener('pointerdown', down, opts);
  root.addEventListener('pointermove', move, opts);
  root.addEventListener('pointerup', up, opts);
  root.addEventListener('pointercancel', up, opts);
  return () => {
    root.removeEventListener('pointerdown', down, opts);
    root.removeEventListener('pointermove', move, opts);
    root.removeEventListener('pointerup', up, opts);
    root.removeEventListener('pointercancel', up, opts);
  };
}
