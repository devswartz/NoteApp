// Minimal ZIP writer/reader (deflate or stored, no zip64, no encryption):
// enough for workspace export/import without a dependency. Files up to a few
// hundred MB in total; everything is held in memory.
import { promisify } from 'node:util';
import zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const DOS_EPOCH = (d: Date) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const { time, date } = DOS_EPOCH(new Date());
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const deflated = zlib.deflateRawSync(e.data);
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const crc = zlib.crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // made by
    cd.writeUInt16LE(20, 6); // needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

const inflateRaw = promisify(zlib.inflateRaw);

/**
 * Read every file entry. Throws (a plain Error, which callers turn into a 400) on anything malformed,
 * truncated, encrypted or oversized; every offset is bounds-checked before it is read. Inflating runs on
 * the libuv thread pool, so a large archive doesn't block the event loop, and each entry is inflated no
 * further than its declared size (checked against `maxTotal` before anything is inflated).
 */
export async function readZip(buf: Buffer, { maxTotal = 300 * 1024 * 1024, maxEntries = 100_000 } = {}): Promise<ZipEntry[]> {
  const need = (at: number, len: number, what: string) => {
    if (!Number.isSafeInteger(at) || at < 0 || at + len > buf.length) throw new Error(`Truncated zip (${what})`);
  };
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > maxEntries) throw new Error('Too many entries');
  let p = buf.readUInt32LE(eocd + 16);
  const found: { name: string; method: number; crc: number; start: number; compSize: number; size: number }[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    need(p, 46, 'central directory');
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    need(p + 46, nameLen, 'file name');
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new Error('Encrypted zip entries are not supported');
    if (name.endsWith('/')) continue;
    if (method !== 0 && method !== 8) throw new Error(`Unsupported compression in ${name}`);
    total += size;
    if (total > maxTotal) throw new Error('Archive is too large');
    need(localOff, 30, 'local header');
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`Corrupt entry ${name}`);
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    need(start, compSize, `data of ${name}`);
    if (method === 0 && compSize !== size) throw new Error(`Corrupt entry ${name}`);
    found.push({ name, method, crc, start, compSize, size });
  }
  const out: ZipEntry[] = [];
  for (const e of found) {
    const raw = buf.subarray(e.start, e.start + e.compSize);
    let data: Buffer;
    if (e.method === 0) data = Buffer.from(raw);
    else if (e.size === 0) data = Buffer.alloc(0); // nothing to inflate (and zlib refuses maxOutputLength 0)
    else {
      try {
        data = await inflateRaw(raw, { maxOutputLength: e.size });
      } catch {
        throw new Error(`Corrupt entry ${e.name}`);
      }
    }
    if (data.length !== e.size || zlib.crc32(data) !== e.crc) throw new Error(`Corrupt entry ${e.name}`);
    out.push({ name: e.name, data });
  }
  return out;
}
