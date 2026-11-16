// Two- and three-finger taps (undo / redo, as in Notability) from DOM touch events: the web's own
// detector, used on touch screens when the iPad's native pen layer isn't attached (it has its own,
// MultiTouchObserver). A tap: two or three fingers that go down together, barely move, and all
// lift within TAP_MS. No DOM here (it takes touch points), so it is unit-tested.

export const TAP_MS = 400;
export const TAP_SLOP = 14;

interface Pt {
  id: number;
  x: number;
  y: number;
}

export class FingerTaps {
  private down = new Map<number, { x: number; y: number }>();
  private max = 0;
  private t0 = 0;
  private moved = false;

  /** Touches went down (`all`: every touch now on the screen). */
  start(all: Pt[], time: number) {
    if (this.down.size === 0) {
      this.max = 0;
      this.moved = false;
      this.t0 = time;
    }
    for (const p of all) if (!this.down.has(p.id)) this.down.set(p.id, { x: p.x, y: p.y });
    this.max = Math.max(this.max, this.down.size);
  }

  move(changed: Pt[]) {
    for (const p of changed) {
      const s = this.down.get(p.id);
      if (s && Math.hypot(p.x - s.x, p.y - s.y) > TAP_SLOP) this.moved = true;
    }
  }

  /** Touches lifted (or were cancelled). Returns 2 or 3 when that ended a tap, else null. */
  end(changed: Pt[], time: number, cancelled = false): 2 | 3 | null {
    for (const p of changed) this.down.delete(p.id);
    if (cancelled) this.moved = true;
    if (this.down.size > 0) return null;
    const n = this.max;
    if (this.moved || time - this.t0 > TAP_MS || (n !== 2 && n !== 3)) return null;
    return n;
  }
}

/** Listen for the taps on `el` (passive: scrolling and zooming are untouched). Returns the cleanup. */
export function listenFingerTaps(el: HTMLElement, onTap: (fingers: 2 | 3) => void): () => void {
  const taps = new FingerTaps();
  const pts = (l: TouchList) => [...l].filter((t) => (t as Touch & { touchType?: string }).touchType !== 'stylus').map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
  const start = (e: TouchEvent) => taps.start(pts(e.touches), e.timeStamp);
  const move = (e: TouchEvent) => taps.move(pts(e.changedTouches));
  const end = (e: TouchEvent) => {
    const n = taps.end(pts(e.changedTouches), e.timeStamp, e.type === 'touchcancel');
    if (n) onTap(n);
  };
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', move, { passive: true });
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });
  return () => {
    el.removeEventListener('touchstart', start);
    el.removeEventListener('touchmove', move);
    el.removeEventListener('touchend', end);
    el.removeEventListener('touchcancel', end);
  };
}
