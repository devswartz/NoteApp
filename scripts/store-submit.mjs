// Submits one platform's App Store version for review through the App Store Connect API. Run by
// .github/workflows/store-submit.yml after the `app-store` environment is approved; see docs/STORE_RELEASES.md.
//
//   ASC_KEY_P8=... ASC_KEY_ID=... ASC_ISSUER_ID=... PLATFORM=IOS|MAC_OS VERSION=0.5.4 WHATS_NEW_FILE=whats-new.txt \
//     node scripts/store-submit.mjs [--dry-run]
//
// Steps:
//   1. Wait for the build of VERSION on PLATFORM (the newest one, by build number) to finish processing (state VALID),
//      polling with backoff for BUILD_TIMEOUT_MIN minutes (default 90). The build numbers come from the uploading
//      workflows' run numbers (mobile.yml, mac-app-store.yml), so the build is found by version string, not number.
//   2. Look at the platform's App Store versions:
//      - VERSION already released, or pending release: nothing to do.
//      - A version WAITING_FOR_REVIEW / IN_REVIEW: its review submission is cancelled so this build replaces it (it was
//        an older version, or the same version with an older build). Unless it's a newer version than VERSION: then stop.
//      - PENDING_DEVELOPER_RELEASE / PENDING_APPLE_RELEASE of another version: stop, never touched.
//   3. Reuse the editable version (PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED, REJECTED, METADATA_REJECTED), renamed to
//      VERSION, or create one. Release type AFTER_APPROVAL, build attached, What's New set on every localization.
//      Description, keywords and screenshots are left as they are (a new version copies them from the live one).
//   4. Submit: a review submission for the platform with this version as its item.
//
// --dry-run (or DRY_RUN=1) only reads, and logs what it would change. Nothing here logs the key.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = process.env;
const DRY = process.argv.includes('--dry-run') || env.DRY_RUN === '1';
const BASE = env.ASC_API_BASE || 'https://api.appstoreconnect.apple.com';
const BUNDLE_ID = env.BUNDLE_ID || 'com.devswartz.notivelo';
const PLATFORM = env.PLATFORM;
const VERSION = (env.VERSION || '').replace(/^v/, '');
const BUILD_TIMEOUT_MS = Number(env.BUILD_TIMEOUT_MIN || 90) * 60_000;
const POLL_FIRST_MS = Number(env.POLL_FIRST_SEC || 30) * 1000;
const POLL_MAX_MS = Number(env.POLL_MAX_SEC || 300) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME = { IOS: 'iOS', MAC_OS: 'macOS' }[PLATFORM];

class Fatal extends Error {}
const fail = (msg) => {
  throw new Fatal(msg);
};

// States (appVersionState; older responses only have appStoreState, mapped where the names differ).
const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED']);
const IN_REVIEW = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW']);
const PENDING_RELEASE = new Set(['PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'ACCEPTED']);
const LIVE = new Set(['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE']);
const STATE_ALIAS = { PROCESSING_FOR_APP_STORE: 'PROCESSING_FOR_DISTRIBUTION', READY_FOR_SALE: 'READY_FOR_DISTRIBUTION' };
const stateOf = (v) => {
  const s = v.attributes.appVersionState || v.attributes.appStoreState || 'UNKNOWN';
  return STATE_ALIAS[s] || s;
};

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// ---- API ----

function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' })}.${b64({ iss: env.ASC_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' })}`;
  return `${body}.${createSign('SHA256').update(body).sign({ key: env.ASC_KEY_P8, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

class ApiError extends Error {
  constructor(method, path, status, errors) {
    super(`${method} ${path.split('?')[0]}: HTTP ${status} ${errors.map((e) => `${e.code ?? ''} ${e.title ?? ''}: ${e.detail ?? ''}`.trim()).join('; ')}`);
    this.status = status;
    this.errors = errors;
  }
}

/** One request; retries rate limits, server errors and network failures with backoff. */
async function api(method, path, body) {
  const write = method !== 'GET';
  if (write && DRY) {
    console.log(`  [dry run] would ${method} ${path} ${body ? JSON.stringify(body) : ''}`);
    return { data: body?.data ? { id: 'dry-run', ...body.data } : null };
  }
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt >= 5) throw new Error(`${method} ${path.split('?')[0]}: ${e.message}`);
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      console.log(`  ${method} ${path.split('?')[0]}: HTTP ${res.status}, retrying`);
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (res.status === 204) return {};
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { errors: [{ title: 'non-JSON response', detail: text.slice(0, 200) }] };
    }
    if (!res.ok) throw new ApiError(method, path, res.status, data.errors ?? []);
    return data;
  }
}

async function all(path) {
  const out = [];
  for (let next = path; next; ) {
    const page = await api('GET', next);
    out.push(...(page.data ?? []));
    next = page.links?.next ?? null;
  }
  return out;
}

// ---- Steps ----

async function findApp() {
  const apps = await all(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&fields[apps]=bundleId,name`);
  const app = apps.find((a) => a.attributes.bundleId === BUNDLE_ID);
  if (!app) fail(`No app with bundle ID ${BUNDLE_ID} in App Store Connect (is the API key for the right team?)`);
  console.log(`App: ${app.attributes.name} (${app.id})`);
  return app;
}

/** The newest build of VERSION on PLATFORM, once VALID. */
async function waitForBuild(app) {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  let wait = POLL_FIRST_MS;
  let last = '';
  for (;;) {
    const builds = await all(
      `/v1/builds?filter[app]=${app.id}&filter[preReleaseVersion.version]=${encodeURIComponent(VERSION)}` +
        `&filter[preReleaseVersion.platform]=${PLATFORM}&filter[expired]=false&fields[builds]=version,processingState,uploadedDate,usesNonExemptEncryption&limit=50`,
    );
    builds.sort((a, b) => Number(b.attributes.version) - Number(a.attributes.version) || String(b.attributes.uploadedDate).localeCompare(String(a.attributes.uploadedDate)));
    const build = builds[0];
    const state = build ? `build ${build.attributes.version}: ${build.attributes.processingState}` : 'no build uploaded yet';
    if (state !== last) console.log(`${NAME} ${VERSION}: ${state}${builds.length > 1 ? ` (${builds.length} builds of this version; using the newest)` : ''}`);
    last = state;
    if (build?.attributes.processingState === 'VALID') return build;
    if (build && ['FAILED', 'INVALID'].includes(build.attributes.processingState)) {
      fail(`${NAME} build ${build.attributes.version} of ${VERSION} is ${build.attributes.processingState} in App Store Connect; Apple emails the reason. Fix it and upload a new build, then run Store submit again for this tag.`);
    }
    if (Date.now() + wait > deadline) {
      fail(`Timed out after ${BUILD_TIMEOUT_MS / 60000} minutes waiting for the ${NAME} ${VERSION} build (${state}). Check the ${PLATFORM === 'IOS' ? 'Mobile' : 'Mac App Store'} workflow for this tag, then run Store submit again by hand.`);
    }
    await sleep(wait);
    wait = Math.min(Math.round(wait * 1.5), POLL_MAX_MS);
  }
}

async function versions(app) {
  return all(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=${PLATFORM}&fields[appStoreVersions]=versionString,appStoreState,appVersionState,releaseType,createdDate&limit=200`);
}

async function attachedBuildId(version) {
  try {
    const r = await api('GET', `/v1/appStoreVersions/${version.id}/relationships/build`);
    return r.data?.id ?? null;
  } catch {
    return null;
  }
}

/** Cancels the review of `version` so a newer build can take its place. Waits until it is editable again. */
async function cancelReview(app, version) {
  const subs = await all(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=${PLATFORM}&filter[state]=WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=50`);
  let cancelled = 0;
  for (const s of subs) {
    if (s.attributes.canceled) continue;
    console.log(`::warning::Cancelling ${NAME} review submission ${s.id} (${s.attributes.state}) of version ${version.attributes.versionString}, so this build replaces it.`);
    await api('PATCH', `/v1/reviewSubmissions/${s.id}`, { data: { type: 'reviewSubmissions', id: s.id, attributes: { canceled: true } } });
    cancelled++;
  }
  if (!cancelled) {
    // Versions submitted the old way (before review submissions) have an appStoreVersionSubmission instead.
    let legacy = null;
    try {
      legacy = (await api('GET', `/v1/appStoreVersions/${version.id}/appStoreVersionSubmission`)).data;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
    if (!legacy) fail(`${NAME} ${version.attributes.versionString} is ${stateOf(version)} but no review submission was found to cancel. Remove it from review in App Store Connect, then run Store submit again.`);
    console.log(`::warning::Removing ${NAME} ${version.attributes.versionString} from review (version submission ${legacy.id}), so this build replaces it.`);
    await api('DELETE', `/v1/appStoreVersionSubmissions/${legacy.id}`);
  }
  if (DRY) return { ...version, attributes: { ...version.attributes, appVersionState: 'DEVELOPER_REJECTED' } };
  // Cancelling is asynchronous: wait for DEVELOPER_REJECTED (or another editable state).
  for (let i = 0; i < 40; i++) {
    const v = (await api('GET', `/v1/appStoreVersions/${version.id}?fields[appStoreVersions]=versionString,appStoreState,appVersionState,releaseType`)).data;
    if (EDITABLE.has(stateOf(v))) {
      console.log(`${NAME} ${v.attributes.versionString} is back to ${stateOf(v)}.`);
      return v;
    }
    await sleep(15_000);
  }
  fail(`Cancelled the ${NAME} review, but ${version.attributes.versionString} didn't become editable within 10 minutes. Check App Store Connect, then run Store submit again.`);
}

async function prepareVersion(app, list) {
  const target = list.find((v) => v.attributes.versionString === VERSION);
  let editable = list.find((v) => EDITABLE.has(stateOf(v)));
  if (target && EDITABLE.has(stateOf(target))) editable = target;
  const attributes = { releaseType: 'AFTER_APPROVAL', earliestReleaseDate: null };
  if (editable) {
    const from = editable.attributes.versionString;
    if (from !== VERSION) {
      console.log(`Reusing ${NAME} version ${from} (${stateOf(editable)}), renamed to ${VERSION}.`);
      attributes.versionString = VERSION;
    } else {
      console.log(`Reusing ${NAME} version ${VERSION} (${stateOf(editable)}).`);
    }
    try {
      await api('PATCH', `/v1/appStoreVersions/${editable.id}`, { data: { type: 'appStoreVersions', id: editable.id, attributes } });
    } catch (e) {
      fail(`Could not update ${NAME} version ${from} (rename to ${VERSION}, release after approval): ${e.message}`);
    }
    return editable.id;
  }
  console.log(`Creating ${NAME} version ${VERSION} (metadata and screenshots carry over from the current version).`);
  try {
    const r = await api('POST', '/v1/appStoreVersions', {
      data: { type: 'appStoreVersions', attributes: { platform: PLATFORM, versionString: VERSION, releaseType: 'AFTER_APPROVAL' }, relationships: { app: { data: { type: 'apps', id: app.id } } } },
    });
    return r.data.id;
  } catch (e) {
    fail(`Could not create ${NAME} version ${VERSION}: ${e.message}`);
  }
}

async function setWhatsNew(versionId, text, hasLive) {
  const locs = await all(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale,whatsNew&limit=50`);
  if (!locs.length && !DRY) fail(`${NAME} version ${VERSION} has no localizations; open it once in App Store Connect.`);
  for (const l of locs) {
    if (l.attributes.whatsNew === text) {
      console.log(`What's New (${l.attributes.locale}) already set.`);
      continue;
    }
    try {
      await api('PATCH', `/v1/appStoreVersionLocalizations/${l.id}`, { data: { type: 'appStoreVersionLocalizations', id: l.id, attributes: { whatsNew: text } } });
      console.log(`What's New (${l.attributes.locale}) set, ${text.length} characters.`);
    } catch (e) {
      // The first version of an app on a platform has no What's New.
      if (!hasLive && e instanceof ApiError && e.status === 409) console.log(`::notice::What's New not set for ${l.attributes.locale}: this is the first ${NAME} version (${e.message}).`);
      else fail(`Could not set What's New (${l.attributes.locale}): ${e.message}`);
    }
  }
}

async function submit(app, versionId) {
  // Reuse a draft submission for this platform (App Store Connect allows one), else create one.
  const drafts = await all(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=${PLATFORM}&filter[state]=READY_FOR_REVIEW&limit=50`);
  let sub = drafts[0];
  if (sub) console.log(`Using draft review submission ${sub.id}.`);
  else {
    sub = (await api('POST', '/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: PLATFORM }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data;
    console.log(`Created review submission ${sub.id}.`);
  }
  try {
    await api('POST', '/v1/reviewSubmissionItems', {
      data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } }, appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } } },
    });
  } catch (e) {
    // Already in this draft (a re-run after a failed submit).
    if (!(e instanceof ApiError && e.status === 409 && /already|exist/i.test(e.message))) fail(`Could not add ${NAME} ${VERSION} to review submission ${sub.id}: ${e.message}`);
    console.log(`${NAME} ${VERSION} is already in submission ${sub.id}.`);
  }
  try {
    await api('PATCH', `/v1/reviewSubmissions/${sub.id}`, { data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } });
  } catch (e) {
    fail(`App Store Connect refused to submit ${NAME} ${VERSION} for review: ${e.message}. Usually missing metadata (screenshots for a new device size, age rating, App Review contact): fix it in App Store Connect, then run Store submit again.`);
  }
  console.log(`::notice::${NAME} ${VERSION} submitted for review (submission ${sub.id}); it is released automatically once approved.`);
}

async function main() {
  if (!NAME) fail(`PLATFORM must be IOS or MAC_OS, got "${PLATFORM ?? ''}"`);
  if (!/^\d+\.\d+\.\d+$/.test(VERSION)) fail(`VERSION must look like 1.2.3, got "${env.VERSION ?? ''}"`);
  for (const k of ['ASC_KEY_P8', 'ASC_KEY_ID', 'ASC_ISSUER_ID']) if (!env[k]) fail(`${k} is not set (repository secret).`);
  if (!env.WHATS_NEW_FILE) fail('WHATS_NEW_FILE is not set.');
  const whatsNew = readFileSync(env.WHATS_NEW_FILE, 'utf8').trim();
  if (!whatsNew || whatsNew.length > 4000) fail(`What's New must be 1 to 4000 characters, got ${whatsNew.length}.`);
  if (DRY) console.log('Dry run: reading only.');

  const app = await findApp();

  // Nothing to do when this version is already out or on its way (a re-run).
  let list = await versions(app);
  const summary = list.map((v) => `${v.attributes.versionString}=${stateOf(v)}`).join(', ');
  console.log(`${NAME} versions: ${summary || 'none'}`);
  const done = list.find((v) => v.attributes.versionString === VERSION && (LIVE.has(stateOf(v)) || PENDING_RELEASE.has(stateOf(v))));
  if (done) {
    console.log(`::notice::${NAME} ${VERSION} is already ${stateOf(done)}; nothing to submit.`);
    return;
  }
  const live = list.filter((v) => LIVE.has(stateOf(v)));
  const newestLive = live.filter((v) => stateOf(v) === 'READY_FOR_DISTRIBUTION').map((v) => v.attributes.versionString).sort(cmpVersion).pop();
  if (newestLive && cmpVersion(newestLive, VERSION) > 0) {
    fail(`${NAME} ${newestLive} is live, newer than ${VERSION}; App Store Connect only accepts higher versions.`);
  }
  const pending = list.find((v) => PENDING_RELEASE.has(stateOf(v)));
  if (pending) {
    fail(`${NAME} ${pending.attributes.versionString} is ${stateOf(pending)} (approved, not yet released). Left untouched: release or reject it in App Store Connect, then run Store submit again for v${VERSION}.`);
  }

  const build = await waitForBuild(app);

  // Re-read: the review state may have changed while waiting for the build.
  list = await versions(app);
  const reviewing = list.find((v) => IN_REVIEW.has(stateOf(v)));
  if (reviewing) {
    const rv = reviewing.attributes.versionString;
    if (cmpVersion(rv, VERSION) > 0) fail(`${NAME} ${rv} is ${stateOf(reviewing)}, newer than ${VERSION}; not replacing it with an older version.`);
    if (rv === VERSION && (await attachedBuildId(reviewing)) === build.id) {
      console.log(`::notice::${NAME} ${VERSION} with build ${build.attributes.version} is already ${stateOf(reviewing)}; nothing to do.`);
      return;
    }
    console.log(`::warning::${NAME} ${rv} is ${stateOf(reviewing)}; replacing it with ${VERSION} (build ${build.attributes.version}).`);
    const back = await cancelReview(app, reviewing);
    list = list.map((v) => (v.id === back.id ? back : v));
  }
  const versionId = await prepareVersion(app, list);

  if (build.attributes.usesNonExemptEncryption == null) {
    // The Info.plists set ITSAppUsesNonExemptEncryption = false; this covers a build made before that.
    console.log(`Build ${build.attributes.version} has no export compliance answer; setting "no non-exempt encryption" (HTTPS only).`);
    await api('PATCH', `/v1/builds/${build.id}`, { data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } } });
  }
  try {
    await api('PATCH', `/v1/appStoreVersions/${versionId}/relationships/build`, { data: { type: 'builds', id: build.id } });
    console.log(`Attached build ${build.attributes.version} to ${NAME} ${VERSION}.`);
  } catch (e) {
    fail(`Could not attach build ${build.attributes.version} to ${NAME} ${VERSION}: ${e.message}`);
  }

  await setWhatsNew(versionId, whatsNew, live.length > 0);
  await submit(app, versionId);
}

main().catch((e) => {
  console.log(`::error::${NAME ?? PLATFORM} store submission failed: ${e.message}`);
  if (!(e instanceof Fatal) && e.stack) console.log(e.stack);
  process.exit(1);
});
