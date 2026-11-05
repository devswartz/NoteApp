// Pure keyboard-navigation rules shared by ui.tsx (unit-tested in tests/focusNav.test.ts).

/**
 * Where Tab should go inside a focus trap, or null to let the browser move
 * focus normally. `current` is the index of the focused element among the
 * focusable items, or -1 when focus is on the container itself (or elsewhere).
 */
export function trapTarget(count: number, current: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (current < 0) return shift ? count - 1 : 0;
  if (shift && current === 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return null;
}

/** The menu item to focus for a key, or null if the key isn't a menu navigation key. */
export function menuTarget(key: string, count: number, current: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
    case 'PageUp':
      return 0;
    case 'End':
    case 'PageDown':
      return count - 1;
    default:
      return null;
  }
}
