// Subsections (sections.parent_id, migration 015) and templates tied to sections (template_sections, 016).
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';
import {
  MAX_SECTION_DEPTH,
  canNestUnder,
  sectionAncestry,
  sectionDescendants,
  sectionPathLabel,
  sectionsInOrder,
  templateOffer,
} from '../shared/sections.ts';
import type { Section, Tree } from '../shared/types.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

const tree = async (u: TestUser) => (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data as Tree;
const section = async (u: TestUser, notebookId: string, name: string, parentId?: string) => {
  const r = await app.call('POST', `/notebooks/${notebookId}/sections`, u.token, { name, parentId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id as string;
};

/** A notebook with A › B › C (three levels) and a top-level D. */
async function setup(name: string) {
  const u = await app.signUp(name);
  const nb = (await app.call('POST', `/workspaces/${u.wsId}/notebooks`, u.token, { name: 'Work' })).data;
  const a = await section(u, nb.id, 'A');
  const b = await section(u, nb.id, 'B', a);
  const c = await section(u, nb.id, 'C', b);
  const d = await section(u, nb.id, 'D');
  return { ...u, nb: nb.id as string, general: nb.sectionId as string, a, b, c, d };
}

test('shared helpers: descendants, ancestry, order, nesting rules, template offer', () => {
  const s = (id: string, parentId: string | null, position = 1): Section => ({ id, parentId, notebookId: 'n', name: id.toUpperCase(), color: '#000000', position });
  const t = { sections: [s('a', null, 1), s('b', 'a'), s('c', 'b'), s('d', null, 2), s('x', 'y')] };
  assert.deepEqual([...sectionDescendants(t, 'a')].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...sectionDescendants(t, 'zzz')], ['zzz']);
  assert.deepEqual(sectionAncestry(t, 'c').map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(sectionPathLabel(t, 'c', 'Work'), 'Work › A › B › C');
  // An unknown parent counts as top level.
  assert.deepEqual(sectionsInOrder(t, 'n').map((x) => [x.section.id, x.level]), [['a', 1], ['b', 2], ['c', 3], ['x', 1], ['d', 1]]);
  assert.equal(canNestUnder(t, 'd', 'b'), true, 'D under B is level 3');
  assert.equal(canNestUnder(t, 'd', 'c'), false, 'D under C would be level 4');
  assert.equal(canNestUnder(t, 'a', 'd'), false, 'A has two levels below it');
  assert.equal(canNestUnder(t, 'a', 'c'), false, 'not into its own subsection');
  assert.equal(MAX_SECTION_DEPTH, 3);
  const everywhere = { scoped: false, sections: [] };
  const inA = { scoped: true, sections: [{ sectionId: 'a', includeSubsections: true }] };
  const onlyA = { scoped: true, sections: [{ sectionId: 'a', includeSubsections: false }] };
  assert.equal(templateOffer(everywhere, 'c', t), 'everywhere');
  assert.equal(templateOffer(inA, 'c', t), 'section');
  assert.equal(templateOffer(onlyA, 'a', t), 'section');
  assert.equal(templateOffer(onlyA, 'b', t), null);
  assert.equal(templateOffer(inA, 'd', t), null);
});

test('subsections: tree carries parentId; depth limit on create', async () => {
  const u = await setup('Sub Sam');
  const t = await tree(u);
  const by = (id: string) => t.sections.find((s) => s.id === id)!;
  assert.equal(by(u.a).parentId, null);
  assert.equal(by(u.b).parentId, u.a);
  assert.equal(by(u.c).parentId, u.b);
  const tooDeep = await app.call('POST', `/notebooks/${u.nb}/sections`, u.token, { name: 'E', parentId: u.c });
  assert.equal(tooDeep.status, 400);
  assert.match(tooDeep.data.error, /at most 3 levels/);
  // A parent from another notebook is refused.
  const nb2 = (await app.call('POST', `/workspaces/${u.wsId}/notebooks`, u.token, { name: 'Other' })).data;
  assert.equal((await app.call('POST', `/notebooks/${nb2.id}/sections`, u.token, { name: 'X', parentId: u.a })).status, 400);
});

test('moving sections: nest, un-nest, cycles and depth checked, subtree follows to another notebook', async () => {
  const u = await setup('Move Max');
  const move = (id: string, body: object) => app.call('POST', `/sections/${id}/move`, u.token, body);
  // Cycle: A into its own subsection.
  assert.equal((await move(u.a, { parentId: u.c })).status, 400);
  assert.equal((await move(u.a, { parentId: u.a })).status, 400);
  // Depth: A (3 levels) under D would make 4.
  const deep = await move(u.a, { parentId: u.d });
  assert.equal(deep.status, 400);
  assert.match(deep.data.error, /at most 3 levels/);
  // D under B is fine (level 3), then back to the top level.
  assert.equal((await move(u.d, { parentId: u.b })).status, 200);
  assert.equal((await tree(u)).sections.find((s) => s.id === u.d)!.parentId, u.b);
  assert.equal((await move(u.d, { parentId: null, index: 0 })).status, 200);
  const t1 = await tree(u);
  assert.equal(t1.sections.find((s) => s.id === u.d)!.parentId, null);
  const top = t1.sections.filter((s) => s.notebookId === u.nb && !s.parentId).sort((p, q) => p.position - q.position);
  assert.equal(top[0].id, u.d, 'index among top-level siblings');
  // Plain reorder keeps the parent.
  assert.equal((await move(u.c, { index: 0 })).data.parentId, u.b);

  // Into another notebook: the whole subtree moves, pages and all.
  const page = (await app.call('POST', `/sections/${u.c}/pages`, u.token, { title: 'Deep page' })).data.id as string;
  const nb2 = (await app.call('POST', `/workspaces/${u.wsId}/notebooks`, u.token, { name: 'Archive' })).data;
  assert.equal((await move(u.a, { notebookId: nb2.id })).status, 200);
  const t2 = await tree(u);
  for (const id of [u.a, u.b, u.c]) assert.equal(t2.sections.find((s) => s.id === id)!.notebookId, nb2.id);
  assert.equal(t2.sections.find((s) => s.id === u.a)!.parentId, null);
  assert.equal(t2.pages.find((p) => p.id === page)!.sectionId, u.c);
  // Nest under a section in yet another notebook via parentId alone.
  const e = await section(u, u.nb, 'E');
  assert.equal((await move(u.b, { parentId: e })).status, 200);
  const t3 = await tree(u);
  assert.equal(t3.sections.find((s) => s.id === u.b)!.notebookId, u.nb);
  assert.equal(t3.sections.find((s) => s.id === u.c)!.notebookId, u.nb, 'subsections follow');
  // PATCH with parentId works too, with the same checks.
  assert.equal((await app.call('PATCH', `/sections/${e}`, u.token, { parentId: u.c })).status, 400);
});

test('deleting a section deletes its subsections and pages; their tasks become standalone', async () => {
  const u = await setup('Del Dee');
  const page = (await app.call('POST', `/sections/${u.c}/pages`, u.token, { title: 'Bottom' })).data.id as string;
  const task = (await app.call('POST', `/workspaces/${u.wsId}/tasks`, u.token, { title: 'Keep me', pageId: page })).data;
  assert.equal((await app.call('DELETE', `/sections/${u.a}`, u.token)).status, 200);
  const t = await tree(u);
  for (const id of [u.a, u.b, u.c]) assert.ok(!t.sections.some((s) => s.id === id));
  assert.ok(!t.pages.some((p) => p.id === page));
  assert.ok(t.sections.some((s) => s.id === u.d));
  const tasks = (await app.call('GET', `/workspaces/${u.wsId}/tasks`, u.token)).data as { id: string; pageId: string | null }[];
  assert.equal(tasks.find((x) => x.id === task.id)!.pageId, null);
  const { db } = await import('../server/db.ts');
  assert.equal(db.prepare('SELECT 1 FROM pages_fts WHERE page_id = ?').get(page), undefined, 'out of the search index');
});

test('duplicating a section copies its subsections', async () => {
  const u = await setup('Copy Cal');
  await app.call('POST', `/sections/${u.c}/pages`, u.token, { title: 'Leaf' });
  const copy = (await app.call('POST', `/sections/${u.b}/copy`, u.token, {})).data.id as string;
  const t = await tree(u);
  assert.equal(t.sections.find((s) => s.id === copy)!.parentId, u.a, 'next to the original');
  const sub = t.sections.find((s) => s.parentId === copy)!;
  assert.equal(sub.name, 'C');
  assert.ok(t.pages.some((p) => p.sectionId === sub.id && p.title === 'Leaf'));
});

test('search results carry the full path', async () => {
  const u = await setup('Path Pat');
  await app.call('POST', `/sections/${u.c}/pages`, u.token, { title: 'Zebrafish notes' });
  const r = await app.call('GET', `/workspaces/${u.wsId}/search?q=zebrafish`, u.token);
  assert.equal(r.data.pages[0].path, 'Work › A › B › C');
  assert.equal(r.data.pages[0].sectionName, 'C');
});

const DOC = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] };

test('templates tied to sections: save, list, edit; other people only see sections they can access', async () => {
  const u = await setup('Tpl Tia');
  const page = (await app.call('POST', `/sections/${u.d}/pages`, u.token, { title: 'Src' })).data.id as string;
  const saved = await app.call('POST', `/pages/${page}/templates`, u.token, { name: 'Scoped', content: DOC, sections: [{ sectionId: u.a, includeSubsections: true }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.scoped, true);
  assert.deepEqual(saved.data.sections, [{ sectionId: u.a, includeSubsections: true }]);
  const plain = (await app.call('POST', `/pages/${page}/templates`, u.token, { name: 'Plain', content: DOC })).data;
  assert.equal(plain.scoped, false);
  assert.deepEqual(plain.sections, []);

  // Edit: replace the list; [] makes it available everywhere again.
  const edited = await app.call('PATCH', `/templates/${saved.data.id}`, u.token, { sections: [{ sectionId: u.d, includeSubsections: false }, { sectionId: u.b }] });
  assert.equal(edited.status, 200);
  assert.deepEqual(
    [...edited.data.sections].sort((x: { sectionId: string }, y: { sectionId: string }) => x.sectionId.localeCompare(y.sectionId)),
    [{ sectionId: u.d, includeSubsections: false }, { sectionId: u.b, includeSubsections: true }].sort((x, y) => x.sectionId.localeCompare(y.sectionId)),
  );
  assert.equal((await app.call('PATCH', `/templates/${saved.data.id}`, u.token, { sections: 'nope' })).status, 400);
  assert.equal((await app.call('PATCH', `/templates/${saved.data.id}`, u.token, { sections: [{ sectionId: 'missing' }] })).status, 400);

  // A section in another workspace is refused.
  const stranger = await app.signUp('Tpl Stranger');
  const theirNb = (await app.call('POST', `/workspaces/${stranger.wsId}/notebooks`, stranger.token, { name: 'Theirs' })).data;
  assert.equal((await app.call('PATCH', `/templates/${saved.data.id}`, u.token, { sections: [{ sectionId: theirNb.sectionId }] })).status, 400);

  // A member who can't see a private section: it isn't listed to them, and their edit keeps it.
  const member = await app.signUp('Tpl Member');
  await app.call('POST', `/workspaces/${u.wsId}/members`, u.token, { email: member.user.email, role: 'admin' });
  const priv = (await app.call('POST', `/workspaces/${u.wsId}/notebooks`, u.token, { name: 'Mine', visibility: 'private' })).data;
  await app.call('PATCH', `/templates/${saved.data.id}`, u.token, { sections: [{ sectionId: priv.sectionId }] });
  const seen = ((await app.call('GET', `/workspaces/${u.wsId}/templates`, member.token)).data as { id: string; scoped: boolean; sections: unknown[] }[]).find(
    (t) => t.id === saved.data.id,
  )!;
  assert.equal(seen.scoped, true);
  assert.deepEqual(seen.sections, [], 'the private section is not revealed');
  assert.equal((await app.call('PATCH', `/templates/${saved.data.id}`, member.token, { sections: [{ sectionId: u.a }] })).status, 200);
  const mine = ((await app.call('GET', `/workspaces/${u.wsId}/templates`, u.token)).data as { id: string; sections: { sectionId: string }[] }[]).find(
    (t) => t.id === saved.data.id,
  )!;
  assert.deepEqual(mine.sections.map((s) => s.sectionId).sort(), [priv.sectionId, u.a].sort());

  // Deleting a section drops it from templates' lists.
  await app.call('DELETE', `/sections/${u.a}`, u.token);
  const after = ((await app.call('GET', `/workspaces/${u.wsId}/templates`, u.token)).data as { id: string; sections: { sectionId: string }[] }[]).find(
    (t) => t.id === saved.data.id,
  )!;
  assert.deepEqual(after.sections.map((s) => s.sectionId), [priv.sectionId]);
});

test('export → import keeps nesting and template sections', async () => {
  const u = await setup('Exp Eve');
  await app.call('POST', `/sections/${u.c}/pages`, u.token, { title: 'Nested page' });
  const page = (await app.call('POST', `/sections/${u.d}/pages`, u.token, { title: 'Src' })).data.id as string;
  await app.call('POST', `/pages/${page}/templates`, u.token, { name: 'For B', content: DOC, sections: [{ sectionId: u.b, includeSubsections: false }] });

  const res = await fetch(`${app.origin}/api/workspaces/${u.wsId}/export`, { headers: { authorization: `Bearer ${u.token}` } });
  const zip = Buffer.from(await res.arrayBuffer());
  const { readZip } = await import('../server/zip.ts');
  const names = (await readZip(zip)).map((e) => e.name);
  assert.ok(names.includes('pages/Work/A/B/C/Nested page.md'), names.join('\n'));

  const imp = await fetch(`${app.origin}/api/workspaces/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/zip' },
    body: new Uint8Array(zip),
  });
  assert.equal(imp.status, 200);
  const { workspaceId } = (await imp.json()) as { workspaceId: string };
  const t = (await app.call('GET', `/workspaces/${workspaceId}/tree`, u.token)).data as Tree;
  const named = (n: string) => t.sections.find((s) => s.name === n)!;
  assert.equal(named('A').parentId, null);
  assert.equal(named('B').parentId, named('A').id);
  assert.equal(named('C').parentId, named('B').id);
  assert.notEqual(named('B').id, u.b, 'fresh ids');
  assert.ok(t.pages.some((p) => p.title === 'Nested page' && p.sectionId === named('C').id));
  const tpls = (await app.call('GET', `/workspaces/${workspaceId}/templates`, u.token)).data as { name: string; sections: unknown[] }[];
  assert.deepEqual(tpls.find((x) => x.name === 'For B')!.sections, [{ sectionId: named('B').id, includeSubsections: false }]);
});

test('import: nesting that is too deep, cyclic or across notebooks falls back to the top level', async () => {
  const u = await app.signUp('Imp Ian');
  const { writeZip } = await import('../server/zip.ts');
  const sec = (id: string, notebook_id: string, parent_id: string | null) => ({ id, notebook_id, parent_id, name: id, color: '#123456', position: 1 });
  const manifest = {
    format: 'noteapp-workspace',
    version: 1,
    workspace: { name: 'Crafted' },
    notebooks: [{ id: 'n1', name: 'N1' }, { id: 'n2', name: 'N2' }],
    sections: [
      sec('s1', 'n1', null), sec('s2', 'n1', 's1'), sec('s3', 'n1', 's2'), sec('s4', 'n1', 's3'), // s4 would be level 4
      sec('c1', 'n1', 'c2'), sec('c2', 'n1', 'c1'), // cycle
      sec('x1', 'n2', 's1'), // parent in another notebook
    ],
  };
  const zip = writeZip([{ name: 'workspace.json', data: Buffer.from(JSON.stringify(manifest)) }]);
  const imp = await fetch(`${app.origin}/api/workspaces/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/zip' },
    body: new Uint8Array(zip),
  });
  assert.equal(imp.status, 200, await imp.clone().text());
  const { workspaceId } = (await imp.json()) as { workspaceId: string };
  const t = (await app.call('GET', `/workspaces/${workspaceId}/tree`, u.token)).data as Tree;
  const parentName = (n: string) => {
    const s = t.sections.find((x) => x.name === n)!;
    return t.sections.find((x) => x.id === s.parentId)?.name ?? null;
  };
  assert.deepEqual(['s1', 's2', 's3', 's4', 'c1', 'c2', 'x1'].map(parentName), [null, 's1', 's2', null, null, null, null]);
});
