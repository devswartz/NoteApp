// The contents list of a section or a notebook: its subsections and pages as a hierarchy, titles only
// (no page content). Pure (no DOM or store), so tests/printContents.test.ts runs it in node; printDoc.ts draws it.
// Order is the sidebar's: a section's own pages first, then its subsections, siblings by position.
import type { Tree } from '../../shared/types.ts';

export interface ContentsNode {
  kind: 'notebook' | 'section' | 'page';
  id: string;
  title: string;
  icon: string | null;
  children: ContentsNode[];
}

export type ContentsTarget = { kind: 'section' | 'notebook'; id: string };

/** Deeper than the sidebar allows (3 levels): a guard against a malformed tree looping. */
const MAX_DEPTH = 8;

export function contentsOf(tree: Tree, target: ContentsTarget): ContentsNode | null {
  const byPos = <T extends { position: number }>(a: T, b: T) => a.position - b.position;
  const pagesOf = (sectionId: string): ContentsNode[] =>
    tree.pages
      .filter((p) => p.sectionId === sectionId)
      .sort(byPos)
      .map((p) => ({ kind: 'page', id: p.id, title: p.title, icon: p.icon ?? null, children: [] }));
  const sectionNode = (id: string, depth: number): ContentsNode | null => {
    const s = tree.sections.find((x) => x.id === id);
    if (!s || depth > MAX_DEPTH) return null;
    const subs = tree.sections
      .filter((x) => x.parentId === id)
      .sort(byPos)
      .map((x) => sectionNode(x.id, depth + 1))
      .filter((n): n is ContentsNode => !!n);
    return { kind: 'section', id, title: s.name, icon: null, children: [...pagesOf(id), ...subs] };
  };

  if (target.kind === 'section') return sectionNode(target.id, 0);
  const nb = tree.notebooks.find((n) => n.id === target.id);
  if (!nb) return null;
  const top = tree.sections
    .filter((s) => s.notebookId === nb.id && (!s.parentId || !tree.sections.some((p) => p.id === s.parentId)))
    .sort(byPos)
    .map((s) => sectionNode(s.id, 0))
    .filter((n): n is ContentsNode => !!n);
  return { kind: 'notebook', id: nb.id, title: nb.name, icon: null, children: top };
}

/** How many sections (below the top one) and pages a contents list holds. */
export function contentsCounts(node: ContentsNode): { sections: number; pages: number } {
  let sections = 0;
  let pages = 0;
  const walk = (n: ContentsNode, top: boolean) => {
    if (n.kind === 'page') pages++;
    else if (!top && n.kind === 'section') sections++;
    for (const c of n.children) walk(c, false);
  };
  walk(node, true);
  return { sections, pages };
}

/** "3 sections · 12 pages" (parts that are zero are left out). */
export function contentsSummary(node: ContentsNode): string {
  const { sections, pages } = contentsCounts(node);
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return [sections ? plural(sections, node.kind === 'notebook' ? 'section' : 'subsection') : '', pages ? plural(pages, 'page') : ''].filter(Boolean).join(' · ');
}
