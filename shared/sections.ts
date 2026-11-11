// Section nesting helpers (subsections), shared by the server and the client. Pure: they take the
// flat section list from the tree (each section has `parentId`, null at the top of its notebook).
import type { Section } from './types.ts';

/** Sections nest at most this many levels (a top-level section is level 1). */
export const MAX_SECTION_DEPTH = 3;

type S = Pick<Section, 'id' | 'parentId'>;
type Sections<T extends S = S> = { sections: readonly T[] } | readonly T[];
const list = <T extends S>(t: Sections<T>): readonly T[] => (Array.isArray(t) ? t : (t as { sections: readonly T[] }).sections);

/**
 * `sectionId` and every section nested under it, at any depth. An unknown id gives just that id.
 * Use it for "this section and its subsections", e.g. filtering tasks or pages by section.
 */
export function sectionDescendants(tree: Sections, sectionId: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const s of list(tree)) if (s.parentId) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s.id]);
  const out = new Set<string>([sectionId]);
  const stack = [sectionId];
  while (stack.length) {
    for (const k of kids.get(stack.pop()!) ?? []) {
      if (out.has(k)) continue;
      out.add(k);
      stack.push(k);
    }
  }
  return out;
}

/** The chain from the top-level section down to `sectionId` (inclusive). Stops at cycles and unknown parents. */
export function sectionAncestry<T extends S>(tree: Sections<T>, sectionId: string): T[] {
  const byId = new Map(list(tree).map((s) => [s.id, s]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (let s = byId.get(sectionId); s && !seen.has(s.id); s = s.parentId ? byId.get(s.parentId) : undefined) {
    seen.add(s.id);
    out.unshift(s);
  }
  return out;
}

/** Level of a section: 1 for a top-level section, 2 for a subsection, and so on. */
export const sectionDepth = (tree: Sections, sectionId: string) => Math.max(1, sectionAncestry(tree, sectionId).length);

/** Levels in the subtree rooted at `sectionId` (1 when it has no subsections). */
export function subtreeHeight(tree: Sections, sectionId: string): number {
  const all = list(tree);
  const height = (id: string, guard: number): number =>
    guard > 50 ? 1 : 1 + Math.max(0, ...all.filter((s) => s.parentId === id).map((s) => height(s.id, guard + 1)));
  return height(sectionId, 0);
}

/** A notebook's sections in tree order (parents before their subsections, siblings by position), with their level (1 = top). */
export function sectionsInOrder<T extends S & Pick<Section, 'notebookId' | 'position'>>(tree: Sections<T>, notebookId: string): { section: T; level: number }[] {
  const mine = list(tree).filter((s) => s.notebookId === notebookId);
  const ids = new Set(mine.map((s) => s.id));
  const kids = (parent: string | null) =>
    mine.filter((s) => (parent ? s.parentId === parent : !s.parentId || !ids.has(s.parentId))).sort((a, b) => a.position - b.position);
  const out: { section: T; level: number }[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, level: number) => {
    for (const s of kids(parent)) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ section: s, level });
      visit(s.id, level + 1);
    }
  };
  visit(null, 1);
  return out;
}

/** Whether `sectionId` may be moved under `parentId` (null = top level): no cycle, and within MAX_SECTION_DEPTH levels. */
export function canNestUnder(tree: Sections, sectionId: string, parentId: string | null): boolean {
  if (!parentId) return true;
  if (sectionDescendants(tree, sectionId).has(parentId)) return false;
  return sectionDepth(tree, parentId) + subtreeHeight(tree, sectionId) <= MAX_SECTION_DEPTH;
}

/**
 * Whether a template is offered in `sectionId`: 'section' when it's tied to that section (directly,
 * or to an ancestor with includeSubsections), 'everywhere' when it isn't tied to any section, and
 * null when it's tied to other sections only.
 */
export function templateOffer(
  t: { scoped: boolean; sections: readonly { sectionId: string; includeSubsections: boolean }[] },
  sectionId: string | null | undefined,
  tree: Sections,
): 'section' | 'everywhere' | null {
  if (!t.scoped) return 'everywhere';
  if (!sectionId) return null;
  const chain = sectionAncestry(tree, sectionId).map((s) => s.id);
  if (!chain.length) chain.push(sectionId);
  const self = chain[chain.length - 1];
  return t.sections.some((r) => r.sectionId === self || (r.includeSubsections && chain.includes(r.sectionId))) ? 'section' : null;
}

/** "Section › Sub", or "Notebook › Section › Sub" when the notebook name is given. */
export function sectionPathLabel(tree: Sections<Pick<Section, 'id' | 'parentId' | 'name'>>, sectionId: string, notebookName?: string): string {
  const names = sectionAncestry(tree, sectionId).map((s) => s.name);
  return (notebookName !== undefined ? [notebookName, ...names] : names).join(' › ');
}
