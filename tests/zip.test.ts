import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readZip, writeZip } from '../server/zip.ts';

test('zip round-trip: text, unicode names, binary, empty', async () => {
  const entries = [
    { name: 'workspace.json', data: Buffer.from(JSON.stringify({ a: 'x'.repeat(5000) })) },
    { name: 'pages/Café ☕/Notes.md', data: Buffer.from('# Hi\n') },
    { name: 'files/x.bin', data: Buffer.from([0, 1, 2, 255]) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const back = await readZip(writeZip(entries));
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  for (let i = 0; i < entries.length; i++) assert.ok(back[i].data.equals(entries[i].data));
});

test('zips we write open with the system unzip', { skip: !fs.existsSync('/usr/bin/unzip') }, () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zip-')), 'a.zip');
  fs.writeFileSync(f, writeZip([{ name: 'dir/hello.txt', data: Buffer.from('hello '.repeat(100)) }]));
  assert.match(execFileSync('unzip', ['-p', f, 'dir/hello.txt']).toString(), /^hello hello/);
});

test('corrupt archives are rejected', async () => {
  await assert.rejects(readZip(Buffer.from('not a zip at all, definitely not')), /Not a zip/);
  await assert.rejects(readZip(Buffer.alloc(0)), /Not a zip/);
  const z = writeZip([{ name: 'a.txt', data: Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') }]);
  z[40] ^= 0xff; // flip a byte inside the compressed data
  await assert.rejects(readZip(z));
});

/** Offsets in a one-entry archive written by writeZip. */
function layout(z: Buffer) {
  const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const eocd = z.length - 22;
  return { cd, eocd };
}

test('truncated and out-of-bounds archives fail with a plain error (never a RangeError)', async () => {
  const good = writeZip([{ name: 'a.txt', data: Buffer.from('hello '.repeat(200)) }, { name: 'b.txt', data: Buffer.from('second') }]);
  const plain = async (buf: Buffer, re: RegExp) => {
    const err = await readZip(buf).then(() => null, (e: Error) => e);
    assert.ok(err, 'rejected');
    assert.equal(err!.constructor, Error, `a plain Error, not ${err!.constructor.name}: ${err!.message}`);
    assert.match(err!.message, re);
  };
  const { cd, eocd } = layout(good);
  // Cut the file at every point: whatever is left must be refused cleanly.
  for (let cut = 1; cut < good.length; cut += 7) {
    const err = await readZip(good.subarray(0, cut)).then(() => null, (e: Error) => e);
    assert.ok(err, `cut at ${cut} rejected`);
    assert.equal(err!.constructor, Error, `cut at ${cut}: ${err!.constructor.name}: ${err!.message}`);
  }
  // The end record points past the end of the file / the directory claims more entries than exist.
  const far = Buffer.from(good);
  far.writeUInt32LE(good.length + 1000, eocd + 16);
  await plain(far, /Truncated|Corrupt/);
  const many = Buffer.from(good);
  many.writeUInt16LE(50, eocd + 10);
  await plain(many, /Truncated|Corrupt/);
  // A directory entry whose local header offset or compressed size points outside the file.
  const badLocal = Buffer.from(good);
  badLocal.writeUInt32LE(0xfffffff0, cd + 42);
  await plain(badLocal, /Truncated/);
  const badSize = Buffer.from(good);
  badSize.writeUInt32LE(0x7ffffff0, cd + 20);
  await plain(badSize, /Truncated/);
});

test('a deflated entry with no data: empty is fine, a lie about its size is refused', async () => {
  const { cd } = layout(writeZip([{ name: 'x', data: Buffer.alloc(0) }]));
  // writeZip stores empty files; hand-make "method 8, 0 bytes compressed".
  const z = writeZip([{ name: 'x', data: Buffer.alloc(0) }]);
  z.writeUInt16LE(8, 8); // local header: method
  z.writeUInt16LE(8, cd + 10); // central directory: method
  assert.deepEqual((await readZip(z)).map((e) => e.data.length), [0]);
  // Same, but the directory claims 10 bytes of content: nothing to inflate, refused cleanly.
  z.writeUInt32LE(10, cd + 24);
  const err = await readZip(z).then(() => null, (e: Error) => e);
  assert.equal(err?.constructor, Error);
});
