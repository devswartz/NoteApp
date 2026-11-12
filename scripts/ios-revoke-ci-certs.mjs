// Keeps the Apple developer account under its certificate limit. Automatic signing on a fresh macOS runner makes Xcode create an
// "Apple Development" certificate every run ("Created via API"); this revokes those (and only those) through the App Store
// Connect API, using the same key the release uses. Run before and after the iOS archive (.github/workflows/mobile.yml).
//
//   ASC_KEY_P8=... ASC_KEY_ID=... ASC_ISSUER_ID=... node scripts/ios-revoke-ci-certs.mjs [--dry-run]
//
// It revokes development certificates whose name or display name contains "Created via API", and deletes the INVALID
// Xcode-managed development profiles ("iOS Team Provisioning Profile…") left behind by them. Everything else is kept: your own
// Mac's "Apple Development: Your Name" certificate, distribution certificates, profiles that are still valid. It logs ids and
// display names, never keys. Failures here never fail the build (the build may still work), they only warn.
import { createSign } from 'node:crypto';

const { ASC_KEY_P8, ASC_KEY_ID, ASC_ISSUER_ID } = process.env;
const dry = process.argv.includes('--dry-run');
if (!ASC_KEY_P8 || !ASC_KEY_ID || !ASC_ISSUER_ID) {
  console.log('::warning::ASC_KEY_P8, ASC_KEY_ID and ASC_ISSUER_ID are needed to clean up development certificates; skipped.');
  process.exit(0);
}

function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' })}.${b64({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
  return `${body}.${createSign('SHA256').update(body).sign({ key: ASC_KEY_P8, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

async function api(method, path) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, { method, headers: { Authorization: `Bearer ${token()}` } });
  if (res.status === 204) return {};
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(data.errors ?? []).map((e) => `${e.title}: ${e.detail}`).join('; ')}`);
  return data;
}

/** Every page of a list endpoint. */
async function all(path) {
  const out = [];
  for (let next = `${path}${path.includes('?') ? '&' : '?'}limit=200`; next; ) {
    const page = await api('GET', next);
    out.push(...(page.data ?? []));
    next = page.links?.next ? page.links.next.replace('https://api.appstoreconnect.apple.com', '') : null;
  }
  return out;
}

try {
  const certs = await all('/v1/certificates?filter[certificateType]=DEVELOPMENT,IOS_DEVELOPMENT');
  const ours = certs.filter((c) => /created via api/i.test(`${c.attributes.name ?? ''} ${c.attributes.displayName ?? ''}`));
  console.log(`${certs.length} development certificate(s) in the account; ${ours.length} "Created via API"; keeping ${certs.length - ours.length}.`);
  for (const c of ours) {
    console.log(`${dry ? 'would revoke' : 'revoking'} certificate ${c.id}: ${c.attributes.displayName ?? c.attributes.name} (expires ${c.attributes.expirationDate ?? '?'})`);
    if (!dry) await api('DELETE', `/v1/certificates/${c.id}`);
  }
  // Their profiles become invalid; Xcode regenerates what it needs.
  const profiles = await all('/v1/profiles?filter[profileType]=IOS_APP_DEVELOPMENT&filter[profileState]=INVALID');
  const stale = profiles.filter((p) => /^iOS Team Provisioning Profile/i.test(p.attributes.name ?? ''));
  console.log(`${stale.length} invalid Xcode-managed development profile(s).`);
  for (const p of stale) {
    console.log(`${dry ? 'would delete' : 'deleting'} profile ${p.id}: ${p.attributes.name}`);
    if (!dry) await api('DELETE', `/v1/profiles/${p.id}`);
  }
} catch (e) {
  console.log(`::warning::Could not clean up development certificates: ${e.message}`);
}
