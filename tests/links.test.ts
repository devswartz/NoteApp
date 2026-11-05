// [[Page links]] and backlinks.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startTestApp, type TestApp, type TestUser } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

async function page(u: TestUser, sectionId: string, title: string) {
  return (await app.call('POST', `/sections/${sectionId}/pages`, u.token, { title })).data.id as string;
}

/** Store a doc whose paragraph links to `targets` (as y-prosemirror does: text and inline nodes as siblings). */
async function linkFrom(pageId: string, targets: string[]) {
  const { db, now } = await import('../server/db.ts');
  const doc = new Y.Doc();
  const p = new Y.XmlElement('paragraph');
  const parts: (Y.XmlText | Y.XmlElement)[] = [new Y.XmlText('See ')];
  for (const t of targets) {
    const l = new Y.XmlElement('pageLink');
    l.setAttribute('pageId', t);
    parts.push(l, new Y.XmlText(' and '));
  }
  p.insert(0, parts);
  const list = new Y.XmlElement('bulletList');
  list.insert(0, [new Y.XmlElement('listItem')]);
  doc.getXmlFragment('default').insert(0, [p, list]);
  // Like the collab server's save: new state and a new updated_at.
  await new Promise((r) => setTimeout(r, 2));
  db.prepare('UPDATE pages SET ydoc = ?, updated_at = ? WHERE id = ?').run(Buffer.from(Y.encodeStateAsUpdate(doc)), now(), pageId);
}

test('linksInDoc finds pageLink nodes, nested ones included', async () => {
  const { linksInDoc } = await import('../server/links.ts');
  const doc = new Y.Doc();
  const quote = new Y.XmlElement('blockquote');
  const p = new Y.XmlElement('paragraph');
  const l = new Y.XmlElement('pageLink');
  l.setAttribute('pageId', 'deep');
  p.insert(0, [new Y.XmlText('x'), l]);
  quote.insert(0, [p]);
  const top = new Y.XmlElement('pageLink');
  top.setAttribute('pageId', 'top');
  doc.getXmlFragment('default').insert(0, [quote, top]);
  assert.deepEqual([...linksInDoc(doc)].sort(), ['deep', 'top']);
});

test('backlinks list linking pages, follow edits, and respect private notebooks', async () => {
  const u = await app.signUp('Linker');
  const tree = (await app.call('GET', `/workspaces/${u.wsId}/tree`, u.token)).data;
  const sec = tree.sections[0].id as string;
  const target = await page(u, sec, 'Glossary');
  const a = await page(u, sec, 'Meeting A');
  const b = await page(u, sec, 'Meeting B');
  await linkFrom(a, [target]);
  await linkFrom(b, [target, a]);

  const bl = async (id: string, who = u) => (await app.call('GET', `/pages/${id}/backlinks`, who.token)).data as { id: string; title: string }[];
  assert.deepEqual((await bl(target)).map((x) => x.title).sort(), ['Meeting A', 'Meeting B']);
  assert.deepEqual((await bl(a)).map((x) => x.title), ['Meeting B']);

  // B drops its link to the glossary: the cached index notices the new updated_at.
  await linkFrom(b, [a]);
  assert.deepEqual((await bl(target)).map((x) => x.title), ['Meeting A']);

  // A link from a private notebook is invisible to other members.
  const other = await app.signUp('Other');
  await app.call('POST', `/workspaces/${u.wsId}/members`, u.token, { email: other.user.email, role: 'member' });
  const priv = (await app.call('POST', `/workspaces/${u.wsId}/notebooks`, u.token, { name: 'Diary', visibility: 'private' })).data;
  const secret = await page(u, priv.sectionId, 'Secret notes');
  await linkFrom(secret, [target]);
  assert.ok((await bl(target)).some((x) => x.title === 'Secret notes'));
  assert.ok(!(await bl(target, other)).some((x) => x.title === 'Secret notes'));

  // No access to the page itself → 404.
  const stranger = await app.signUp('Stranger');
  assert.equal((await app.call('GET', `/pages/${target}/backlinks`, stranger.token)).status, 404);
});
