// One-time iOS signing setup, runnable on Windows/macOS/Linux with Node 20+ and OpenSSL (Git for Windows ships it).
// It creates an Apple Distribution certificate and the three App Store provisioning profiles through the App Store Connect
// API (with the same API key the release workflow uses), builds the .p12 the macOS keychain accepts, and prints the
// GitHub secrets to paste. See docs/IOS-SIGNING.md.
//
//   node scripts/ios-signing-setup.mjs --key C:\path\AuthKey_ABC123.p8 --key-id ABC123 --issuer 00000000-0000-... [--out DIR]
//
// Private key, certificate, .p12 and profiles are written to --out (default ~/notivelo-ios-signing), which must be OUTSIDE
// this repository. The private key and the .p12 password are printed only in the secrets block at the end: that block is
// what you paste into GitHub. Keep the output folder safe (it is the only copy of the private key); don't commit it.
import { createSign, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLES = [
  { id: 'com.devswartz.notivelo', secret: 'IOS_PROFILE_APP', label: 'App' },
  { id: 'com.devswartz.notivelo.ShareExtension', secret: 'IOS_PROFILE_SHARE', label: 'ShareExtension' },
  { id: 'com.devswartz.notivelo.TodayWidget', secret: 'IOS_PROFILE_WIDGET', label: 'TodayWidget' },
];

function args() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    if (!a[i]?.startsWith('--') || a[i + 1] === undefined) fail(`Unexpected argument "${a[i]}". Usage: node scripts/ios-signing-setup.mjs --key AuthKey.p8 --key-id ID --issuer UUID [--out DIR]`);
    out[a[i].slice(2)] = a[i + 1];
  }
  return out;
}
function fail(msg) {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

const opt = args();
for (const k of ['key', 'key-id', 'issuer']) if (!opt[k]) fail(`Missing --${k}. Usage: node scripts/ios-signing-setup.mjs --key AuthKey.p8 --key-id ID --issuer UUID [--out DIR]`);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(opt.out ?? join(homedir(), 'notivelo-ios-signing'));
if (!relative(repo, out).startsWith('..')) fail(`--out (${out}) is inside the repository. Choose a folder outside it: it will hold your private key.`);
mkdirSync(out, { recursive: true });

function openssl(args, env = {}) {
  try {
    return execFileSync('openssl', args, { env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*', ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    fail(`openssl ${args[0]} failed: ${e.stderr?.toString().trim() || e.message}. Is OpenSSL installed (Git for Windows includes it) and on PATH?`);
  }
}
openssl(['version']);

// ── App Store Connect API (JWT, ES256) ──
const p8 = readFileSync(opt.key, 'utf8');
function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'ES256', kid: opt['key-id'], typ: 'JWT' })}.${b64({ iss: opt.issuer, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' })}`;
  const sig = createSign('SHA256').update(body).sign({ key: p8, dsaEncoding: 'ieee-p1363' });
  return `${body}.${sig.toString('base64url')}`;
}
async function api(method, path, json) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) fail(`App Store Connect ${method} ${path}: ${res.status} ${(data.errors ?? []).map((e) => `${e.title}: ${e.detail}`).join('; ') || text}`);
  return data;
}

// ── (a) private key and CSR ──
const keyPem = join(out, 'distribution.key.pem');
const csrFile = join(out, 'distribution.csr');
if (existsSync(keyPem)) fail(`${keyPem} already exists. Move the old folder away (or pick another --out) so a key is never overwritten.`);
openssl(['genrsa', '-out', keyPem, '2048']);
openssl(['req', '-new', '-key', keyPem, '-out', csrFile, '-subj', '/CN=Notivelo CI Distribution/O=Notivelo/C=US']);
console.log('1/5 private key and certificate signing request created');

// ── (b) Apple Distribution certificate via the API ──
const csr = readFileSync(csrFile, 'utf8');
const cert = (await api('POST', '/v1/certificates', { data: { type: 'certificates', attributes: { certificateType: 'IOS_DISTRIBUTION', csrContent: csr } } })).data;
const cerFile = join(out, 'distribution.cer');
writeFileSync(cerFile, Buffer.from(cert.attributes.certificateContent, 'base64'));
const certPem = join(out, 'distribution.cert.pem');
openssl(['x509', '-inform', 'DER', '-in', cerFile, '-out', certPem]);
console.log(`2/5 Apple Distribution certificate created (${cert.attributes.displayName ?? cert.id}, expires ${cert.attributes.expirationDate ?? '?'})`);

// ── (c) .p12 the macOS keychain accepts (3DES / SHA1: OpenSSL 3's defaults are rejected by `security import`) ──
const password = randomBytes(18).toString('base64url');
const p12File = join(out, 'distribution.p12');
const legacy = ['-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'];
openssl(['pkcs12', '-export', '-inkey', keyPem, '-in', certPem, '-name', 'Notivelo Apple Distribution', '-out', p12File, '-passout', 'env:P12_PASSWORD', ...legacy], { P12_PASSWORD: password });
console.log('3/5 .p12 built');

// ── (d) App Store provisioning profiles for the three bundle ids ──
const stamp = new Date().toISOString().slice(0, 10);
const secrets = {};
for (const b of BUNDLES) {
  const found = (await api('GET', `/v1/bundleIds?filter[identifier]=${encodeURIComponent(b.id)}&filter[platform]=IOS&limit=50`)).data.filter((x) => x.attributes.identifier === b.id);
  if (!found.length) fail(`The identifier ${b.id} does not exist in your developer account. Register it (docs/MOBILE.md lists its capabilities) and run this again with a new --out.`);
  const name = `Notivelo ${b.label} App Store ${stamp}`;
  const profile = (
    await api('POST', '/v1/profiles', {
      data: {
        type: 'profiles',
        attributes: { name, profileType: 'IOS_APP_STORE' },
        relationships: { bundleId: { data: { type: 'bundleIds', id: found[0].id } }, certificates: { data: [{ type: 'certificates', id: cert.id }] } },
      },
    })
  ).data;
  const file = join(out, `${b.label}.mobileprovision`);
  writeFileSync(file, Buffer.from(profile.attributes.profileContent, 'base64'));
  secrets[b.secret] = profile.attributes.profileContent.replace(/\s+/g, '');
  console.log(`4/5 profile "${name}" created for ${b.id}`);
}

// ── (e) the secrets ──
const p12B64 = readFileSync(p12File).toString('base64');
const block = [
  '',
  '=================== GitHub secrets (repository → Settings → Secrets and variables → Actions) ===================',
  'Paste each value as its own secret. They contain your private key: do not share, do not commit, do not post.',
  '',
  `IOS_DIST_P12:\n${p12B64}\n`,
  `IOS_DIST_P12_PASSWORD:\n${password}\n`,
  ...BUNDLES.map((b) => `${b.secret}:\n${secrets[b.secret]}\n`),
  '=================================================================================================================',
].join('\n');
console.log('5/5 done.');
console.log(block);
console.log(`Files are in ${out} (private key: distribution.key.pem, .p12: distribution.p12). Store that folder safely, e.g. in a password manager; it is the only copy of the key.`);
console.log('The secrets block above is not saved to disk. If you lose it, re-run this script with a new --out (a new certificate and profiles are created; revoke the old ones).');
