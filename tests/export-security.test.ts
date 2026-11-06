// Workspace import treats the archive as untrusted: unsafe links/images/file cards are
// removed, ids and values are checked, nothing is written under a name from the archive,
// and oversized or damaged archives are refused. Also: what export includes.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

async function raw(method: string, url: string, token: string, body?: Buffer, headers: Record<string, string> = {}) {
  const res = await fetch(`${app.origin}/api${url}`, { method, headers: { authorization: `Bearer ${token}`, ...headers }, body: body ? new Uint8Array(body) : undefined });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}
// Imports are rate limited (tests/export-limits.test.ts); these tests import many times, so start each from full buckets.
const importZip = async (token: string, zip: Buffer) => {
  const { resetRateLimits } = await import('../server/ratelimit.ts');
  resetRateLimits();
  return raw('POST', '/workspaces/import', token, zip, { 'content-type': 'application/zip' });
};

const FILE_ID = 'a'.repeat(32);

function nastyDoc(): string {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, 'evil', { link: { href: 'javascript:alert(1)' } });
  t.insert(4, ' tab', { link: { href: 'java\tscript:alert(2)' } });
  t.insert(8, ' good', { link: { href: 'https://example.com/' } });
  t.insert(13, ' mine', { link: { href: `/uploads/${FILE_ID}.png` } });
  p.insert(0, [t]);
  const img = (src: string) => {
    const el = new Y.XmlElement('image');
    el.setAttribute('src', src);
    return el;
  };
  const card = (url: string) => {
    const el = new Y.XmlElement('fileAttachment');
    el.setAttribute('url', url);
    el.setAttribute('name', 'x');
    return el;
  };
  frag.insert(0, [
    p,
    img('data:image/svg+xml,<svg onload=alert(1)>'),
    img('javascript:alert(1)'),
    img('https://example.com/ok.png'),
    img(`/uploads/${FILE_ID}.png`),
    card('javascript:alert(1)'),
    card('//evil.example/x'),
    card(`/uploads/${FILE_ID}.png`),
  ]);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

async function manifestZip(over: Record<string, unknown> = {}, extra: { name: string; data: Buffer }[] = []) {
  const { writeZip } = await import('../server/zip.ts');
  const manifest = {
    format: 'noteapp-workspace',
    version: 1,
    workspace: { name: 'Crafted' },
    members: [],
    notebooks: [{ id: 'nb1', name: 'NB', color: 'red; background:url(javascript:alert(1))', visibility: 'shared', position: 0 }],
    sections: [{ id: 's1', notebook_id: 'nb1', name: 'S', color: '#123456', position: 0 }],
    pages: [{ id: 'p1', section_id: 's1', title: 'Nasty', icon: 'x'.repeat(500), kind: 'document', position: 0, ydoc: nastyDoc() }],
    tasks: [],
    files: [
      { id: FILE_ID, ext: '.png', name: 'pic.png', mime: 'text/html', page_id: 'p1' },
      { id: '../../../../tmp/evil', ext: '.png', name: 'evil', mime: 'image/png' },
      { id: 'b'.repeat(32), ext: '/../../x', name: 'evil', mime: 'image/png' },
    ],
    templates: [
      {
        id: 't1',
        name: 'Tpl',
        visibility: 'workspace',
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
            { type: 'image', attrs: { src: 'data:text/html,<script>alert(1)</script>' } },
            { type: 'image', attrs: { src: `/uploads/${FILE_ID}.png` } },
          ],
        },
        tasks: [{ key: 'tpl-task-0', title: 42, priority: 99, subtasks: 'nope' }],
      },
    ],
    ...over,
  };
  return writeZip([
    { name: 'workspace.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: `files/${FILE_ID}.png`, data: Buffer.from('PNGDATA') },
    { name: '../../../../tmp/evil.png', data: Buffer.from('zip-slip') },
    { name: 'files/../../escape.png', data: Buffer.from('zip-slip') },
    ...extra,
  ]);
}

function pageDoc(pageId: string) {
  return import('../server/db.ts').then(({ db }) => {
    const row = db.prepare('SELECT ydoc FROM pages WHERE id = ?').get(pageId) as { ydoc: Buffer };
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.ydoc));
    return doc;
  });
}

test('import removes unsafe links, images and file cards, and rewrites file URLs to fresh copies', async () => {
  const u = await app.signUp('Mallory');
  const { FILES_DIR } = await import('../server/config.ts');
  const before = new Set(fs.readdirSync(FILES_DIR, { recursive: true }) as string[]);
  const r = await importZip(u.token, await manifestZip());
  assert.equal(r.status, 200, r.buf.toString());
  const { workspaceId } = JSON.parse(r.buf.toString());

  const tree = (await app.call('GET', `/workspaces/${workspaceId}/tree`, u.token)).data;
  assert.equal(tree.notebooks[0].color, '#6366f1', 'colour that is not #rrggbb is replaced');
  const page = tree.pages.find((p: { title: string }) => p.title === 'Nasty');
  assert.ok(page.icon === null || page.icon.length <= 16, 'icon is clamped');

  // Exactly one file was imported, under a fresh id, inside FILES_DIR.
  const { db } = await import('../server/db.ts');
  const files = db.prepare('SELECT * FROM files WHERE workspace_id = ?').all(workspaceId) as { id: string; ext: string; mime: string; page_id: string | null; template_id: string | null }[];
  const pageFile = files.find((f) => f.page_id === page.id)!;
  assert.ok(pageFile, 'the listed attachment is imported');
  assert.notEqual(pageFile.id, FILE_ID, 'attachments get fresh ids');
  assert.equal(pageFile.mime, 'image/png', 'the type comes from the extension, not the archive');
  const added = (fs.readdirSync(FILES_DIR, { recursive: true }) as string[]).filter((f) => !before.has(f));
  assert.deepEqual(added.sort(), files.map((f) => `${f.id}${f.ext}`).sort(), 'only fresh-id files are written');
  assert.ok(!fs.existsSync(path.join(FILES_DIR, `${FILE_ID}.png`)), 'the archive’s file id is not used on disk');
  assert.ok(!fs.existsSync('/tmp/evil.png') || fs.readFileSync('/tmp/evil.png', 'utf8') !== 'zip-slip', 'no zip-slip');
  assert.ok(!fs.existsSync(path.join(FILES_DIR, '..', 'escape.png')), 'no zip-slip');

  // The page document: only safe content remains, and file URLs point at the new copy.
  const newUrl = `/uploads/${pageFile.id}.png`;
  const frag = (await pageDoc(page.id)).getXmlFragment('default');
  const els = frag.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
  const srcs = els.filter((e) => e.nodeName === 'image').map((e) => e.getAttribute('src'));
  assert.deepEqual(srcs.sort(), ['https://example.com/ok.png', newUrl].sort(), 'unsafe images removed, upload rewritten');
  assert.deepEqual(els.filter((e) => e.nodeName === 'fileAttachment').map((e) => e.getAttribute('url')), [newUrl], 'unsafe file cards removed');
  const delta = (els[0].toArray()[0] as Y.XmlText).toDelta() as { insert: string; attributes?: { link?: { href: string } } }[];
  const hrefs = delta.map((d) => [d.insert.trim(), d.attributes?.link?.href ?? null]);
  assert.deepEqual(hrefs, [['evil tab', null], ['good', 'https://example.com/'], ['mine', newUrl]], 'unsafe links lose the link, keep the text');

  // Template: sanitised like Markdown import, file rewritten to its own fresh copy, task snapshot type-checked.
  const tpl = db.prepare('SELECT * FROM templates WHERE workspace_id = ?').get(workspaceId) as { id: string; content: string; tasks: string };
  const content = JSON.parse(tpl.content);
  assert.equal(content.content[0].content[0].marks.length, 0, 'unsafe link mark dropped');
  const images = content.content.filter((n: { type: string }) => n.type === 'image');
  assert.deepEqual(images.map((n: { attrs: { src: string } }) => n.attrs.src), [newUrl], 'data: image dropped, upload URL rewritten');
  assert.deepEqual(JSON.parse(tpl.tasks), [{ key: 'tpl-task-0', title: '', description: '', priority: 4, subtasks: [] }]);
});

test('import refuses damaged, malformed and oversized archives', async () => {
  const u = await app.signUp('Trudy');
  const { writeZip } = await import('../server/zip.ts');
  const { db } = await import('../server/db.ts');
  const workspaces = () => (db.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ?').get(u.user.id) as { n: number }).n;
  const start = workspaces();

  // A page whose Yjs state is garbage.
  const bad = await manifestZip({ pages: [{ id: 'p1', section_id: 's1', title: 'Broken', ydoc: Buffer.from('not yjs at all').toString('base64') }] });
  let r = await importZip(u.token, bad);
  assert.equal(r.status, 400, r.buf.toString());
  assert.match(r.buf.toString(), /damaged/);

  // Lists that aren't lists.
  r = await importZip(u.token, await manifestZip({ notebooks: 'all of them' }));
  assert.equal(r.status, 400);
  r = await importZip(u.token, await manifestZip({ tasks: [null] }));
  assert.equal(r.status, 400);

  // Not our format / from the future.
  r = await importZip(u.token, writeZip([{ name: 'workspace.json', data: Buffer.from('{"format":"other"}') }]));
  assert.equal(r.status, 400);
  r = await importZip(u.token, await manifestZip({ version: 99 }));
  assert.equal(r.status, 400);

  // A "zip bomb": the directory claims more unpacked data than the cap. Refused before inflating.
  const zip = writeZip([{ name: 'workspace.json', data: Buffer.from('{}') }]);
  const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(600 * 1024 * 1024, cd + 24); // uncompressed size
  r = await importZip(u.token, zip);
  assert.equal(r.status, 400);
  assert.match(r.buf.toString(), /too large/);

  // An entry whose data inflates past its declared size is refused (inflate is capped at the declared size).
  const { readZip } = await import('../server/zip.ts');
  const big = writeZip([{ name: 'a.txt', data: Buffer.alloc(100_000) }]);
  const cd2 = big.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  big.writeUInt32LE(10, cd2 + 24);
  await assert.rejects(readZip(big));

  assert.equal(workspaces(), start, 'nothing was created by a refused import');
});

test('export: private notebooks shared with the exporter are included, others are not; subtasks and templates round-trip', async () => {
  const owner = await app.signUp('Ola');
  const mate = await app.signUp('Mat');
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: mate.user.email, role: 'admin' });
  const sharedWithMe = (await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, mate.token, { name: 'Mat shared', visibility: 'private' })).data;
  assert.equal((await app.call('PUT', `/notebooks/${sharedWithMe.id}/shares`, mate.token, { userIds: [owner.user.id] })).status, 200);
  await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, mate.token, { name: 'Mat only', visibility: 'private' });

  const nb = (await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'Work' })).data;
  const pageId = (await app.call('POST', `/sections/${nb.sectionId}/pages`, owner.token, { title: 'Plan' })).data.id as string;
  const parent = (await app.call('POST', `/workspaces/${owner.wsId}/tasks`, owner.token, { title: 'Parent', pageId })).data;
  const child = await app.call('POST', `/workspaces/${owner.wsId}/tasks`, owner.token, { title: 'Child', parentId: parent.id });
  assert.equal(child.status, 200, JSON.stringify(child.data));
  const tpl = await app.call('POST', `/pages/${pageId}/templates`, owner.token, { name: 'Weekly', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] } });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.data));

  const exp = await raw('GET', `/workspaces/${owner.wsId}/export`, owner.token);
  assert.equal(exp.status, 200);
  const { readZip } = await import('../server/zip.ts');
  const m = JSON.parse((await readZip(exp.buf)).find((e) => e.name === 'workspace.json')!.data.toString());
  const names = m.notebooks.map((n: { name: string }) => n.name);
  assert.ok(names.includes('Mat shared'), 'a private notebook shared with the exporter is included');
  assert.ok(!names.includes('Mat only'), 'a private notebook not shared with the exporter is excluded');
  assert.deepEqual(m.templates.map((t: { name: string }) => t.name), ['Weekly']);

  const imp = await importZip(owner.token, exp.buf);
  assert.equal(imp.status, 200, imp.buf.toString());
  const { workspaceId } = JSON.parse(imp.buf.toString());
  const { db } = await import('../server/db.ts');
  const rows = db.prepare('SELECT id, title, parent_id FROM tasks WHERE workspace_id = ?').all(workspaceId) as { id: string; title: string; parent_id: string | null }[];
  const p = rows.find((r) => r.title === 'Parent')!;
  assert.equal(rows.find((r) => r.title === 'Child')!.parent_id, p.id, 'subtask keeps its (new) parent');
  const tpls = (await app.call('GET', `/workspaces/${workspaceId}/templates`, owner.token)).data as { name: string }[];
  assert.deepEqual(tpls.map((t) => t.name), ['Weekly']);
});
