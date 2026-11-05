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
| 6 | Editor blocks, slash menu, uploads, search | — | next |
| 7 | Recurring completion, reminder settings UI | — | next |
| 8 | Offline edit → reconnect → synced | — | next |
| 9 | Mobile (iPhone) smoke | — | next |

## Open bugs

None found yet on `main`.

<!-- Template:
### BUG-N: short title
- **Area / owner:** …
- **Found on:** main @ <sha>, YYYY-MM-DD
- **Steps:** 1. … 2. …
- **Expected:** …
- **Actual:** …
- **Test:** `tests/e2e/<file>` › "<test name>" (`test.fixme`)
-->

## Fixed bugs

None yet.
