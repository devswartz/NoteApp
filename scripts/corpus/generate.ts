// Builds tests/corpus/ from ./cases.ts with today's TS code (tests/corpus/README.md).
//   node --import tsx scripts/corpus/generate.ts
// Rewrites every case's page.bin and its expectations. Commit the result; tests/corpus.test.ts
// checks the TS code still produces the same expectations from the committed page.bin files,
// and crates/nv-model checks Rust does.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { CASES } from './cases.ts';
import { expectations, listMarkerTable } from './expect.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/corpus');
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

fs.rmSync(path.join(ROOT, 'cases'), { recursive: true, force: true });
for (const c of CASES) {
  const doc = new Y.Doc();
  doc.clientID = 1; // fixed, so the same case always encodes to the same bytes
  c.build(doc);
  const update = Y.encodeStateAsUpdate(doc);
  const dir = path.join(ROOT, 'cases', c.name);
  fs.mkdirSync(dir, { recursive: true });
  const e = expectations(update, c.title, c.tasks);
  fs.writeFileSync(path.join(dir, 'page.bin'), update);
  fs.writeFileSync(path.join(dir, 'input.json'), json({ about: c.about, title: c.title, tasks: c.tasks }));
  fs.writeFileSync(path.join(dir, 'expected.json'), json(e.json));
  fs.writeFileSync(path.join(dir, 'page.md'), e.markdown);
  fs.writeFileSync(path.join(dir, 'page.txt'), e.text);
  console.log(`${c.name}: ${update.length} bytes`);
}
fs.writeFileSync(path.join(ROOT, 'list-markers.json'), json(listMarkerTable()));
