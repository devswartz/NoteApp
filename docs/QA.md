# QA and end-to-end tests

Owner: QA (agent 8). The suite lives in `tests/e2e/`; the config is `playwright.config.ts`.

## Running it

```bash
npm run test:e2e                         # builds, starts `npm start` on :4317 with a temp DATA_DIR, runs Chromium
E2E_NO_BUILD=1 npm run test:e2e          # reuse an existing dist/ (much faster when iterating)
npx playwright test 03 --project=chromium   # one file
E2E_BASE_URL=http://localhost:3001 npx playwright test   # against a server you started yourself
```

- Each run uses a fresh, throwaway `DATA_DIR` (and a fixed test-only `JWT_SECRET`), so tests never touch `./data`.
- Projects: `chromium` (desktop, every `*.spec.ts`) and `mobile` (iPhone 13 viewport, only `*.mobile.spec.ts`).
- The browser runs in UTC (`timezoneId`), so "today" in tests matches `isoDay()` in `helpers.ts`.
- On failure, a trace and a screenshot land in `test-results/`; in CI the HTML report is uploaded as the `playwright-report` artifact.
- CI: the `e2e` job in `.github/workflows/ci.yml` runs `npx playwright test` after `check`; `publish` waits for it.

## Writing tests

- **Set up through the API, test through the UI.** `createUser`, `createTeam`, `createPage`, `createTask` in `helpers.ts` make users and data over REST. `signInContext(context, user)` signs a browser context in by seeding the refresh token (the app's normal session restore).
- **Every test makes its own users**, with unique emails, so tests can run in parallel against one server.
- **No fixed sleeps.** Wait on UI state (`expect(...).toBeVisible()`), or on server state with `eventually(() => listTasks(...), check)`.
- Two users = two `browser.newContext()`s (see `03-collab.spec.ts`).
- A feature that isn't on `main` yet: `test.fixme(true, 'waiting for feature: …')`. A known bug: `test.fixme(true, 'BUG-N: …')` plus an entry below.

## Coverage (v1, PLAN.md §1)

| # | Area | Spec | State |
|---|---|---|---|
| 1 | Sign up / in / out, workspace → notebook → section → page | `01-auth-tree.spec.ts` | ✅ |
| 2 | Inline task ↔ My Tasks/Today; complete and rename both ways; live in-session; detached when removed from note | `02-task-sync.spec.ts` | ✅ |
| 3 | Invite → sign up → join; two-user co-editing with cursors + presence; task assigned by A appears live for B; removed member loses access | `03-collab.spec.ts` | ✅ |
| 4 | Viewer can't edit (UI + API + collab); private notebook hidden, then shared live | `04-permissions.spec.ts` | ✅ |
| 5 | Today/Upcoming/Calendar/Completed/All, filters, quick add parsing | `05-dashboard.spec.ts` | ✅ |
| 6 | Markdown shortcuts, slash menu (filter, table, divider, task, Escape), image upload, attachment, bubble menu; ⌘K search over page text, titles and tasks; no private results | `06-editor-search.spec.ts` | ✅ |
| 7 | Daily and weekly recurrence roll forward with a completed copy; Repeat from task details; reminder time + bell; Settings "Enable notifications"; in-app reminder toast | `07-recurrence-reminders.spec.ts` | ✅ (push/email settings: fixme, waiting for feature) |
| 8 | Offline edit → reconnect → synced to server and another device; reload while offline | `08-offline.spec.ts` | ✅ / reload: fixme BUG-1 |
| 9 | iPhone 13: tab bar, quick add, tap to complete, drawer sidebar → note, no horizontal scroll, editing, search | `09-mobile.mobile.spec.ts` | ✅ |

## Open bugs

### BUG-1: reloading the app while offline shows the login screen, so cached notes can't be opened
- **Area / owner:** Foundation (offline/PWA, `src/store/session.ts` `bootstrap()`, `public/sw.js`)
- **Found on:** main @ 5814595, 2026-11-05
- **Steps:** 1. Sign in and open a page; type something (it's cached in IndexedDB and the service worker is active). 2. Go offline (DevTools → Network → Offline). 3. Reload.
- **Expected:** the app shell loads from the service worker and the note opens from the local cache, with the offline banner (PLAN §1: "Notes cached locally … so they open offline").
- **Actual:** the login screen. `bootstrap()` needs `POST /auth/refresh` to succeed, and on a network error it stays signed out. There is no cached user, workspace list or tree to fall back on, so the editor never mounts. (The refresh token is kept, so it recovers once you're online again.)
- **Suggested direction:** cache the last user, workspaces and tree (`platform.kv`) and boot from them in an "offline session" when the refresh fails with a network error (not a 401).
- **Test:** `tests/e2e/08-offline.spec.ts` › "a page opened before going offline still opens after a reload while offline" (`test.fixme`)

<!-- Template:
### BUG-N: short title
- **Area / owner:** …
- **Found on:** main @ <sha>, YYYY-MM-DD
- **Steps:** 1. … 2. …
- **Expected:** …
- **Actual:** …
- **Test:** `tests/e2e/<file>` › "<test name>" (`test.fixme`)
-->

### BUG-2: a member demoted to viewer can keep editing an open page, and the edits are saved
- **Area / owner:** Collaboration & Access (`server/collab.ts`: the role is checked only when the socket connects). Possibly fixed by open PRs #12 (socket access revalidation) and #14 (live access re-checks); the fixme test will confirm.
- **Found on:** main @ 1b38732, 2026-11-05
- **Steps:** 1. A (owner) and B (member) are in a team workspace; B opens a page. 2. A changes B's role to Viewer (Settings → Members). 3. Without reloading, B types in the page.
- **Expected:** the server drops B's updates as soon as B is a viewer (and B's UI switches to "View only").
- **Actual:** B's text reaches A live and is persisted (it's still there after A reloads); B's UI stays editable until B reloads.
- **Test:** `tests/e2e/11-live-access.spec.ts` › "member demoted to viewer while the page is open can no longer edit (server + UI)" (`test.fixme`)

## Fixed bugs

None yet.
