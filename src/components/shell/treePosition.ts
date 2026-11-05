// Pure ordering helpers for the sidebar tree (no store or API imports, so they're unit-testable).

export const byPos = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

/** Same rule as server/tree.ts positionAt: a position that puts the item at `index` among `sibs` (sorted, without the item). */
export function positionAt(sibs: { position: number }[], index: number): number {
  if (!sibs.length) return 1;
  if (index >= sibs.length) return sibs[sibs.length - 1].position + 1;
  if (index <= 0) return sibs[0].position - 1;
  return (sibs[index - 1].position + sibs[index].position) / 2;
}
