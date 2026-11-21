// The page-format corpus (tests/corpus/README.md): today's TS code must still say the same
// things about every committed page as when the corpus was generated. crates/nv-model runs the
// same files against the Rust implementation. After an intended change, regenerate with
// `node --import tsx scripts/corpus/generate.ts` and commit the diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CASES } from '../scripts/corpus/cases.ts';
import { expectations, listMarkerTable } from '../scripts/corpus/expect.ts';

const ROOT = path.join(import.meta.dirname, 'corpus');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('every corpus case has its files, and nothing else is in cases/', () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'cases')).sort(), CASES.map((c) => c.name).sort());
});

for (const dir of fs.readdirSync(path.join(ROOT, 'cases'))) {
  test(`corpus: ${dir}`, () => {
    const input = JSON.parse(read('cases', dir, 'input.json'));
    const e = expectations(fs.readFileSync(path.join(ROOT, 'cases', dir, 'page.bin')), input.title, input.tasks);
    assert.deepEqual(JSON.parse(JSON.stringify(e.json)), JSON.parse(read('cases', dir, 'expected.json')));
    assert.equal(e.markdown, read('cases', dir, 'page.md'));
    assert.equal(e.text, read('cases', dir, 'page.txt'));
  });
}

test('corpus: list markers', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(listMarkerTable())), JSON.parse(read('list-markers.json')));
});
