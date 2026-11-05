// Member matching for @mention pickers (no DOM, unit-tested). Owner: Collaboration & Access.
import type { Member } from '../../shared/types.ts';

/** Members matching `query` (name or email prefix/substring), best first. */
export function matchMembers(members: Member[], query: string, limit = 8): Member[] {
  const q = query.trim().toLowerCase();
  if (!q) return members.slice(0, limit);
  const scored = members
    .map((m) => {
      const name = m.name.toLowerCase();
      const score = name.startsWith(q) ? 0 : name.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : name.includes(q) || m.email.toLowerCase().startsWith(q) ? 2 : -1;
      return { m, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.m.name.localeCompare(b.m.name));
  return scored.slice(0, limit).map((x) => x.m);
}
