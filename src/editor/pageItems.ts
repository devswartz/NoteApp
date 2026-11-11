// Suggestions for the [[ page-link picker. Pure (no store or API), so it's unit-tested.
import type { PageMeta, Tree } from '../../shared/types.ts';
import { sectionPathLabel } from '../../shared/sections.ts';

export type PageItem = { kind: 'page'; page: PageMeta; crumb: string } | { kind: 'create'; title: string };

/** Pages whose title matches `query` (prefix matches first), plus "Create" when nothing matches exactly. */
export function pageItems(query: string, currentPageId: string, tree: Tree): PageItem[] {
  const q = query.trim().toLowerCase();
  const crumb = (p: PageMeta) => {
    const s = tree.sections.find((x) => x.id === p.sectionId);
    const n = tree.notebooks.find((x) => x.id === s?.notebookId);
    return sectionPathLabel(tree, p.sectionId, n?.name ?? '');
  };
  const scored = tree.pages
    .filter((p) => p.id !== currentPageId)
    .map((p) => {
      const t = (p.title || 'Untitled').toLowerCase();
      const score = !q ? 1 : t.startsWith(q) ? 0 : t.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : t.includes(q) ? 2 : -1;
      return { p, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || (q ? 0 : b.p.updatedAt.localeCompare(a.p.updatedAt)))
    .slice(0, 8);
  const items: PageItem[] = scored.map(({ p }) => ({ kind: 'page', page: p, crumb: crumb(p) }));
  if (q && !tree.pages.some((p) => p.title.trim().toLowerCase() === q)) items.push({ kind: 'create', title: query.trim() });
  return items;
}
