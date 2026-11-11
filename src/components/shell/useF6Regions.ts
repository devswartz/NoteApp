// F6 / Shift+F6 move focus between the app's regions: rail → panel → pages
// panel → main (the editor when a page is open) → rail.
import { useEffect } from 'react';

const REGIONS = ['.rail', '.sidebar .sb-panel', '.sidebar .pages-panel', '.main'];

/** Pure order rule (unit-tested): the next region index from `current` (-1 = none). */
export function nextRegion(count: number, current: number, back: boolean): number {
  if (count === 0) return -1;
  if (current < 0) return back ? count - 1 : 0;
  return (current + (back ? -1 : 1) + count) % count;
}

const visible = (el: HTMLElement) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed';

function focusIn(region: HTMLElement) {
  // In main, prefer the editor; else the selected row, else the first focusable control.
  const target =
    region.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]') ??
    region.querySelector<HTMLElement>('.is-active, .is-selected, [aria-current="page"]') ??
    region.querySelector<HTMLElement>('button, a[href], input, select, textarea, [tabindex="0"]') ??
    region;
  target.focus({ preventScroll: false });
}

export function useF6Regions() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F6' || e.ctrlKey || e.metaKey || e.altKey) return;
      const regions = REGIONS.map((q) => document.querySelector<HTMLElement>(q)).filter((el): el is HTMLElement => !!el && visible(el));
      if (!regions.length) return;
      e.preventDefault();
      const current = regions.findIndex((r) => r.contains(document.activeElement));
      focusIn(regions[nextRegion(regions.length, current, e.shiftKey)]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
