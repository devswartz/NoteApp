// Share links: "Anyone with the link can view" (server/routes/pageLinks.ts, server/publicPage.ts).
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

const view = async (url: string) => {
  const res = await fetch(app.origin + new URL(url).pathname);
  return { status: res.status, headers: res.headers, html: await res.text() };
};

async function pageWithContent(owner: { token: string; wsId: string; user: { id: string } }, title = 'Launch plan') {
  const nb = await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'Projects' });
  const pageId = (await app.call('POST', `/sections/${nb.data.sectionId}/pages`, owner.token, { title })).data.id as string;
  const task = (await app.call('POST', `/workspaces/${owner.wsId}/tasks`, owner.token, { title: 'Book venue', pageId, dueDate: '2026-12-01' })).data;
  const { seedPageDoc } = await import('../server/collab.ts');
  seedPageDoc(pageId, (frag) => {
    const h = new Y.XmlElement('heading');
    h.setAttribute('level', '2' as never);
    h.insert(0, [new Y.XmlText('Goals')]);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.applyDelta([
      { insert: 'See ' },
      { insert: 'the site', attributes: { link: { href: 'https://example.com/x' } } },
      { insert: ' and <script>alert(1)</script> ' },
      { insert: 'bad', attributes: { link: { href: 'javascript:alert(1)' } } },
    ]);
    const ref = new Y.XmlElement('taskRef');
    ref.setAttribute('taskId', task.id);
    const img = new Y.XmlElement('image');
    img.setAttribute('src', `/uploads/${'a'.repeat(32)}.png`);
    frag.insert(0, [h, p, ref, img]);
  });
  return { pageId, notebookId: nb.data.id as string };
}

test('turning a link on gives a public read-only page; off ends it at once; on again makes a new link', async () => {
  const owner = await app.signUp('Olive');
  const { pageId } = await pageWithContent(owner);

  assert.deepEqual((await app.call('GET', `/pages/${pageId}/link`, owner.token)).data, { url: null });
  const on = await app.call('PUT', `/pages/${pageId}/link`, owner.token);
  assert.equal(on.status, 200);
  const url = on.data.url as string;
  assert.match(url, /\/s\/[A-Za-z0-9_-]{32}$/);
  assert.equal((await app.call('PUT', `/pages/${pageId}/link`, owner.token)).data.url, url, 'PUT again keeps the same link');

  const page = await view(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /script-src/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.html, /<h1>Launch plan<\/h1>/);
  assert.match(page.html, /<h3>Goals<\/h3>/);
  assert.match(page.html, /<a href="https:\/\/example.com\/x" rel="noopener noreferrer nofollow" target="_blank">the site<\/a>/);
  assert.match(page.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'text is escaped');
  assert.doesNotMatch(page.html, /<script/i, 'no scripts on the page at all');
  assert.doesNotMatch(page.html, /javascript:/i, 'unsafe links become plain text');
  assert.match(page.html, /Book venue/);
  assert.match(page.html, /due 2026-12-01/);
  assert.match(page.html, /\/uploads\/a{32}\.png\?u=[^"]+&amp;s=[0-9a-f]{32}/, 'images are signed for the link creator');
  assert.match(page.html, /Shared by Olive/);

  const off = await app.call('DELETE', `/pages/${pageId}/link`, owner.token);
  assert.deepEqual(off.data, { url: null });
  const dead = await view(url);
  assert.equal(dead.status, 404);
  assert.match(dead.html, /isn't available/);

  const again = (await app.call('PUT', `/pages/${pageId}/link`, owner.token)).data.url as string;
  assert.notEqual(again, url, 'a new link, so the old one never comes back');
  assert.equal((await view(url)).status, 404);
  assert.equal((await view(again)).status, 200);
});

test('only people who may share the page manage links; viewers and outsiders get 403/404', async () => {
  const owner = await app.signUp('Owen');
  const viewer = await app.signUp('Vera');
  const stranger = await app.signUp('Sam');
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: viewer.user.email, role: 'viewer' });
  const { pageId } = await pageWithContent(owner);
  assert.equal((await app.call('PUT', `/pages/${pageId}/link`, viewer.token)).status, 403);
  assert.ok([403, 404].includes((await app.call('PUT', `/pages/${pageId}/link`, stranger.token)).status));
  assert.ok([403, 404].includes((await app.call('GET', `/pages/${pageId}/link`, stranger.token)).status));
});

test('a link stops working when the page goes to Trash, and unknown or malformed tokens look the same', async () => {
  const owner = await app.signUp('Tara');
  const { pageId } = await pageWithContent(owner);
  const url = (await app.call('PUT', `/pages/${pageId}/link`, owner.token)).data.url as string;
  assert.equal((await view(url)).status, 200);
  await app.call('DELETE', `/pages/${pageId}`, owner.token);
  assert.equal((await view(url)).status, 404, 'trashed page');

  const unknown = await fetch(`${app.origin}/s/${'x'.repeat(32)}`);
  const malformed = await fetch(`${app.origin}/s/..%2F..%2Fetc`);
  assert.equal(unknown.status, 404);
  assert.equal(malformed.status, 404);
});

test('a link stops working when its creator loses access to the page', async () => {
  const owner = await app.signUp('Nora');
  const member = await app.signUp('Max');
  await app.call('POST', `/workspaces/${owner.wsId}/members`, owner.token, { email: member.user.email, role: 'member' });
  const { pageId } = await pageWithContent(owner);
  const url = (await app.call('PUT', `/pages/${pageId}/link`, member.token)).data.url as string;
  assert.equal((await view(url)).status, 200);
  const removed = await app.call('DELETE', `/workspaces/${owner.wsId}/members/${member.user.id}`, owner.token);
  assert.ok(removed.status < 300, `remove member: ${removed.status}`);
  assert.equal((await view(url)).status, 404);
});
