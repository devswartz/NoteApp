// The contents list of a section or notebook (src/print/contents.ts): hierarchy, order, titles only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentsCounts, contentsOf, contentsSummary, type ContentsNode } from '../src/print/contents.ts';
import type { Tree } from '../shared/types.ts';

const s = (id: string, notebookId: string, parentId: string | null, name: string, position: number) => ({ id, notebookId, parentId, name, color: '', position });
const pg = (id: string, sectionId: string, title: string, position: number, icon: string | null = null) => ({ id, sectionId, title, icon, position });

// Handbook: Intro (pages Welcome, Rules; subsections Setup (page Install), Extras (sub Deep (page Hidden))), Archive (page Old).
const tree = {
  notebooks: [{ id: 'nb', name: 'Handbook' }, { id: 'other', name: 'Other' }],
  sections: [
    s('archive', 'nb', null, 'Archive', 2),
    s('intro', 'nb', null, 'Intro', 1),
    s('extras', 'nb', 'intro', 'Extras', 2),
    s('setup', 'nb', 'intro', 'Setup', 1),
    s('deep', 'nb', 'extras', 'Deep', 1),
    s('elsewhere', 'other', null, 'Elsewhere', 1),
  ],
  pages: [pg('p3', 'intro', 'Rules', 2), pg('p1', 'intro', 'Welcome', 1, '👋'), pg('p4', 'setup', 'Install', 1), pg('p5', 'deep', '', 1), pg('p6', 'archive', 'Old', 1), pg('p7', 'elsewhere', 'Nope', 1)],
} as unknown as Tree;

/** A compact outline: "Section", "- page", indented by depth. */
const outline = (n: ContentsNode, depth = 0): string[] => [`${'  '.repeat(depth)}${n.kind === 'page' ? '- ' : ''}${n.title || 'Untitled'}`, ...n.children.flatMap((c) => outline(c, depth + 1))];

test('a notebook lists its sections in order, each with its pages first and then its subsections', () => {
  assert.deepEqual(outline(contentsOf(tree, { kind: 'notebook', id: 'nb' })!), [
    'Handbook',
    '  Intro',
    '    - Welcome',
    '    - Rules',
    '    Setup',
    '      - Install',
    '    Extras',
    '      Deep',
    '        - Untitled',
    '  Archive',
    '    - Old',
  ]);
});

test('a section lists just itself and what is under it; pages carry their icon', () => {
  const intro = contentsOf(tree, { kind: 'section', id: 'intro' })!;
  assert.equal(intro.kind, 'section');
  assert.equal(outline(intro)[0], 'Intro');
  assert.equal(intro.children[0].icon, '👋');
  assert.ok(!outline(intro).some((l) => /Archive|Old|Nope/.test(l)));
  assert.equal(contentsOf(tree, { kind: 'section', id: 'missing' }), null);
  assert.equal(contentsOf(tree, { kind: 'notebook', id: 'missing' }), null);
});

test('titles only: no page content, and counts say what is in the list', () => {
  const nb = contentsOf(tree, { kind: 'notebook', id: 'nb' })!;
  assert.deepEqual(contentsCounts(nb), { sections: 5, pages: 5 });
  assert.equal(contentsSummary(nb), '5 sections · 5 pages');
  assert.equal(contentsSummary(contentsOf(tree, { kind: 'section', id: 'archive' })!), '1 page');
  assert.equal(contentsSummary(contentsOf(tree, { kind: 'section', id: 'setup' })!), '1 page');
  assert.equal(contentsSummary(contentsOf(tree, { kind: 'section', id: 'intro' })!), '3 subsections · 4 pages');
});

test('a section loop in a malformed tree ends instead of running forever', () => {
  const loop = { notebooks: [{ id: 'nb', name: 'N' }], sections: [s('a', 'nb', 'b', 'A', 1), s('b', 'nb', 'a', 'B', 1)], pages: [] } as unknown as Tree;
  assert.ok(contentsOf(loop, { kind: 'section', id: 'a' }));
});
