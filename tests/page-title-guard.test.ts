// PATCH /pages/:id with titleWas / iconWas: a write that says what it replaces is refused (409) when the page has something else,
// so a stale or crossed client can't overwrite a page's title or icon blindly.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers/app.ts';

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(() => app.close());

test('a title or icon write that states the wrong "was" is refused and changes nothing; the right one, or none, goes through', async () => {
  const u = await app.signUp('Guard Owner');
  const nb = (await app.call('POST', `/workspaces/${u.wsId}/notebooks`, u.token, { name: 'NB' })).data as { sectionId: string };
  const id = (await app.call('POST', `/sections/${nb.sectionId}/pages`, u.token, { title: 'Original' })).data.id as string;
  const title = async () => (await app.call('GET', `/pages/${id}`, u.token)).data.page.title as string;

  const wrong = await app.call('PATCH', `/pages/${id}`, u.token, { title: 'Crossed', titleWas: '' });
  assert.equal(wrong.status, 409);
  assert.equal(await title(), 'Original', 'nothing was written');
  assert.equal((await app.call('PATCH', `/pages/${id}`, u.token, { title: 'Right', titleWas: 'Original' })).status, 200);
  assert.equal(await title(), 'Right');
  assert.equal((await app.call('PATCH', `/pages/${id}`, u.token, { title: 'No claim' })).status, 200, 'clients that send nothing still work');
  // The icon the same way.
  assert.equal((await app.call('PATCH', `/pages/${id}`, u.token, { icon: '🔥', iconWas: '🎯' })).status, 409);
  assert.equal((await app.call('PATCH', `/pages/${id}`, u.token, { icon: '🔥', iconWas: null })).status, 200);
  assert.equal((await app.call('PATCH', `/pages/${id}`, u.token, { icon: null, iconWas: '🔥' })).status, 200);
});

test('a page-share editor in another workspace is held to the same check', async () => {
  const owner = await app.signUp('Share Owner');
  const editor = await app.signUp('Share Editor');
  const nb = (await app.call('POST', `/workspaces/${owner.wsId}/notebooks`, owner.token, { name: 'NB' })).data as { sectionId: string };
  const id = (await app.call('POST', `/sections/${nb.sectionId}/pages`, owner.token, { title: 'Scott title' })).data.id as string;
  await app.call('POST', `/pages/${id}/shares`, owner.token, { email: editor.user.email, canEdit: true });
  assert.equal((await app.call('PATCH', `/pages/${id}`, editor.token, { title: '', titleWas: 'A new page title' })).status, 409);
  assert.equal((await app.call('GET', `/pages/${id}`, owner.token)).data.page.title, 'Scott title');
});
