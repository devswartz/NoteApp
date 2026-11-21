// Lists the most recent builds of com.devswartz.notivelo on App Store Connect with Apple's processing state
// (PROCESSING, VALID, FAILED, INVALID), so CI logs show whether earlier 1.99.x uploads went through. Read-only.
//
//   ASC_KEY_P8=... ASC_KEY_ID=... ASC_ISSUER_ID=... node apps/apple/scripts/testflight-builds.mjs [count]
//
// Never fails the build: problems are printed as warnings.
import { createSign } from 'node:crypto';

const { ASC_KEY_P8, ASC_KEY_ID, ASC_ISSUER_ID } = process.env;
const BUNDLE_ID = 'com.devswartz.notivelo';
const count = Number(process.argv[2] ?? 10);

function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' })}.${b64({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
  return `${body}.${createSign('SHA256').update(body).sign({ key: ASC_KEY_P8, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

async function get(path) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, { headers: { Authorization: `Bearer ${token()}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${(data.errors ?? []).map((e) => `${e.title}: ${e.detail}`).join('; ')}`);
  return data;
}

try {
  if (!ASC_KEY_P8 || !ASC_KEY_ID || !ASC_ISSUER_ID) throw new Error('ASC_KEY_P8, ASC_KEY_ID and ASC_ISSUER_ID are needed');
  const apps = await get(`/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=bundleId,name`);
  const app = apps.data?.[0];
  if (!app) throw new Error(`no app with bundle ID ${BUNDLE_ID}`);
  const builds = await get(
    `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=${count}&include=preReleaseVersion` +
      '&fields[builds]=version,processingState,uploadedDate,expired,preReleaseVersion&fields[preReleaseVersions]=version,platform',
  );
  const versions = new Map((builds.included ?? []).map((v) => [v.id, v.attributes]));
  console.log(`Recent builds of ${app.attributes.name} (${BUNDLE_ID}):`);
  for (const b of builds.data ?? []) {
    const v = versions.get(b.relationships?.preReleaseVersion?.data?.id);
    const a = b.attributes;
    console.log(`  ${v?.platform ?? '?'} ${v?.version ?? '?'} (${a.version})  ${a.processingState}${a.expired ? ' expired' : ''}  uploaded ${a.uploadedDate}`);
  }
} catch (e) {
  console.log(`::warning::Could not list TestFlight builds: ${e.message}`);
}
