import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readZip, writeZip } from '../server/zip.ts';

test('zip round-trip: text, unicode names, binary, empty', () => {
  const entries = [
    { name: 'workspace.json', data: Buffer.from(JSON.stringify({ a: 'x'.repeat(5000) })) },
    { name: 'pages/Café ☕/Notes.md', data: Buffer.from('# Hi\n') },
    { name: 'files/x.bin', data: Buffer.from([0, 1, 2, 255]) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const back = readZip(writeZip(entries));
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  for (let i = 0; i < entries.length; i++) assert.ok(back[i].data.equals(entries[i].data));
});

test('zips we write open with the system unzip', { skip: !fs.existsSync('/usr/bin/unzip') }, () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zip-')), 'a.zip');
  fs.writeFileSync(f, writeZip([{ name: 'dir/hello.txt', data: Buffer.from('hello '.repeat(100)) }]));
  assert.match(execFileSync('unzip', ['-p', f, 'dir/hello.txt']).toString(), /^hello hello/);
});

test('corrupt archives are rejected', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /Not a zip/);
  const z = writeZip([{ name: 'a.txt', data: Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') }]);
  z[40] ^= 0xff; // flip a byte inside the compressed data
  assert.throws(() => readZip(z));
});
