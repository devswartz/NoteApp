// Signed links to uploaded files (server/fileAccess.ts). Pure, shared by the web app and tests.
//
// Uploads are only served to someone who may open the page or workspace they belong to. An <img>
// or a download link can't send the bearer token, and the native shells (tauri://, capacitor://)
// can't rely on cookies for the API's origin, so the permission travels in the URL:
//
//   /uploads/<id><ext>?u=<userId>&e=<expiry, unix seconds>&s=<signature>
//
// With each session the server hands the client a FileKey: k = HMAC(server secret, "files:<u>:<e>").
// The client signs a file itself, s = first 32 hex of HMAC(k, "<id><ext>"), so pages render
// synchronously with no request per image. The server recomputes k and s, checks the expiry and then
// checks that user u may still see the file right now. A copied link therefore opens one file, only
// until it expires, and only while that user still has access. Documents keep storing the plain
// "/uploads/<id><ext>" path; the signature is added when rendering and stripped again on paste.

/** What the server hands out with every session (AuthSession.fileKey). */
export interface FileKey {
  /** User id the key is for. */
  u: string;
  /** Expiry, unix seconds. */
  e: number;
  /** HMAC key (hex) for signing file names until `e`. */
  k: string;
}

/** Keys roll over on fixed boundaries so a file's URL (and so the browser cache) is stable for hours. */
export const FILE_KEY_BUCKET_S = 6 * 60 * 60;
/** Longest a key (and so a signed link) can be valid: the rest of the current bucket plus one more. */
export const FILE_KEY_MAX_S = 2 * FILE_KEY_BUCKET_S;

/** The expiry to issue at `nowS`: the end of the next bucket (between 6 and 12 hours away). */
export function fileKeyExpiry(nowS: number): number {
  return (Math.floor(nowS / FILE_KEY_BUCKET_S) + 2) * FILE_KEY_BUCKET_S;
}

/** Stored file name in an upload path: "<32 hex><.ext>". */
export const UPLOAD_PATH = /^\/uploads\/([0-9a-f]{32}(?:\.[a-z0-9]{1,10})?)$/;

/** Signature for one stored file name ("<id><ext>") under a key. */
export function signFileName(key: string, name: string): string {
  return hmacSha256Hex(key, name).slice(0, 32);
}

/** "/uploads/<name>" → the same path with the signature query; anything else unchanged. */
export function signUploadPath(path: string, key: FileKey | null): string {
  const m = UPLOAD_PATH.exec(path);
  if (!m || !key) return path;
  return `${path}?u=${encodeURIComponent(key.u)}&e=${key.e}&s=${signFileName(key.k, m[1])}`;
}

/**
 * A signed upload link (relative, or absolute on any origin) → its stored path "/uploads/<name>";
 * anything else → null. Used so a signed link that was copied or pasted is stored unsigned and
 * never expires inside a document.
 */
export function unsignedUploadPath(url: string): string | null {
  const m = /^(?:https?:\/\/[^/?#\s]+)?(\/uploads\/[0-9a-f]{32}(?:\.[a-z0-9]{1,10})?)\?([^#\s]*)$/i.exec(url.trim());
  if (!m || !/(?:^|&)s=[0-9a-f]{32}(?:&|$)/.test(m[2])) return null;
  return m[1].toLowerCase();
}

// ── HMAC-SHA-256 (synchronous; WebCrypto is async and images render synchronously) ──

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(padded.length - 4, (len << 3) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA-256 of `message` under `key` (both UTF-8 strings), as hex. Matches node:crypto createHmac. */
export function hmacSha256Hex(key: string, message: string): string {
  let k: Uint8Array = utf8(key);
  if (k.length > 64) k = sha256(k);
  const block = new Uint8Array(64);
  block.set(k);
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  const m = utf8(message);
  const ih = new Uint8Array(64 + m.length);
  ih.set(inner);
  ih.set(m, 64);
  const oh = new Uint8Array(96);
  oh.set(outer);
  oh.set(sha256(ih), 64);
  return hex(sha256(oh));
}
