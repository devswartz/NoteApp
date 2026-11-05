// Collab load test (manual): N editors on one page through a real in-process server.
//   npx tsx scripts/load-collab.ts [editors=10] [editsEach=1000]
// Reports sync time, convergence time, message counts, server save time and doc size.
import * as Y from 'yjs';
import { startTestApp } from '../tests/helpers/app.ts';
import { collabClient, synced, waitFor, type CollabClient } from '../tests/helpers/collab.ts';

const N = Number(process.argv[2] ?? 10);
const EDITS = Number(process.argv[3] ?? 1000);
const app = await startTestApp();
const users = await Promise.all(Array.from({ length: N }, (_, i) => app.signUp(`Load${i}`)));
for (const u of users.slice(1)) await app.call('POST', `/workspaces/${users[0].wsId}/members`, users[0].token, { email: u.user.email, role: 'member' });
const nb = (await app.call('POST', `/workspaces/${users[0].wsId}/notebooks`, users[0].token, { name: 'Load' })).data.id;
const sec = (await app.call('POST', `/notebooks/${nb}/sections`, users[0].token, { name: 'S' })).data.id;
const pageId = (await app.call('POST', `/sections/${sec}/pages`, users[0].token, { title: 'Load' })).data.id;

const clients: CollabClient[] = users.map((u) => collabClient(app, pageId, u.token, { id: u.user.id, name: u.user.name, color: u.user.color }));
let t = Date.now();
await Promise.all(clients.map(synced));
console.log(`sync: ${Date.now() - t} ms for ${N} editors`);

let received = 0;
for (const c of clients) c.doc.on('update', (_u: Uint8Array, origin: unknown) => origin === c.provider && received++);
const frag0 = clients[0].doc.getXmlFragment('default');
const p0 = new Y.XmlElement('paragraph');
p0.insert(0, [new Y.XmlText('')]);
frag0.insert(0, [p0]);
await waitFor(() => clients.every((c) => c.doc.getXmlFragment('default').length === 1), 10_000, 'seed');

t = Date.now();
const mem0 = process.memoryUsage().rss;
for (let i = 0; i < EDITS; i++) {
  clients.forEach((c, k) => {
    const frag = c.doc.getXmlFragment('default');
    if (i % 20 === 0) {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText(`para ${k}-${i} `.repeat(3))]);
      frag.push([p]);
    } else {
      const text = (frag.get(0) as Y.XmlElement).get(0) as Y.XmlText;
      text.insert(text.length ? (k * 31 + i) % text.length : 0, 'x');
    }
    // Cursor/presence churn like real typing.
    c.provider.awareness.setLocalStateField('cursor', { i, k });
  });
  if (i % 25 === 24) await new Promise((r) => setTimeout(r, 1)); // let the network run, like keystrokes over time
}
const key = (c: CollabClient) => Y.encodeStateVector(c.doc).join(',');
await waitFor(() => clients.every((c) => key(c) === key(clients[0])), 60_000, 'convergence');
const converge = Date.now() - t;
const size = Y.encodeStateAsUpdate(clients[0].doc).length;
console.log(`edits: ${N * EDITS} total; converged ${converge} ms after the last edit started; ${received} remote updates applied`);
console.log(`doc: ${(size / 1024).toFixed(1)} KB encoded; process RSS +${((process.memoryUsage().rss - mem0) / 1048576).toFixed(0)} MB`);

// Server save cost for this doc (extract text + task refs + FTS + reconcile).
const { extractDoc } = await import('../server/collab.ts');
t = performance.now();
for (let i = 0; i < 20; i++) extractDoc(clients[0].doc.getXmlFragment('default'));
console.log(`extractDoc: ${((performance.now() - t) / 20).toFixed(1)} ms per save`);
await new Promise((r) => setTimeout(r, 1500));
const page = await app.call('GET', `/workspaces/${users[0].wsId}/search?q=para`, users[0].token);
console.log(`saved + searchable: ${page.data.pages.some((p: { id: string }) => p.id === pageId)}`);
for (const c of clients) c.destroy();
await app.close();
process.exit(0);
