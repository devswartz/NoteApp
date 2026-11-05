# QA and end-to-end tests

Owner: QA (agent 8). The suite lives in `tests/e2e/`; the config is `playwright.config.ts`.

## Running it

```bash
npm run test:e2e                         # builds, starts `npm start` on :4317 with a temp DATA_DIR, runs Chromium
E2E_NO_BUILD=1 npm run test:e2e          # reuse an existing dist/ (much faster when iterating)
npx playwright test 03 --project=chromium   # one file
E2E_BASE_URL=http://localhost:3001 npx playwright test   # against a server you started yourself
E2E_PORT=4500 npm run test:e2e           # pick other ports (uses E2E_PORT, +1 and +2) when several worktrees run at once
```

- Ports: the main server listens on `E2E_PORT` (default 4317), the short-token server on `E2E_PORT+1`, the invite-only server on `E2E_PORT+2`. Give each concurrent checkout its own `E2E_PORT`, or the second run fails to start its servers.
- Each run uses a fresh, throwaway `DATA_DIR` (and a fixed test-only `JWT_SECRET`), so tests never touch `./data`.
- Projects: `chromium` (desktop, every `*.spec.ts`), `mobile` (iPhone 13 viewport, only `*.mobile.spec.ts`) `short-tokens` (only `*.tokens.spec.ts`, against a second server on port+1 started with `ACCESS_TOKEN_TTL_S=6`, so access tokens expire mid-test) and `invite-only` (only `*.invite.spec.ts`, against a third server on port+2 with the production default `SIGNUP_MODE=invite` and `ADMIN_EMAILS=gate-owner@e2e.test`). The main and short-token servers use `SIGNUP_MODE=open` so tests can create users freely.
- The browser runs in UTC (`timezoneId`), so "today" in tests matches `isoDay()` in `helpers.ts`.
- On failure, a trace and a screenshot land in `test-results/`; in CI the HTML report is uploaded as the `playwright-report` artifact.
- CI: the `e2e` job in `.github/workflows/ci.yml` runs `npx playwright test` after `check`; `publish` waits for it.

## Writing tests

- **Set up through the API, test through the UI.** `createUser`, `createTeam`, `createPage`, `createTask` in `helpers.ts` make users and data over REST. `signInContext(context, user)` signs a browser context in by seeding the refresh token (the app's normal session restore).
- **Every test makes its own users**, with unique emails, so tests can run in parallel against one server.
- **No fixed sleeps.** Wait on UI state (`expect(...).toBeVisible()`), or on server state with `eventually(() => listTasks(...), check)`.
- **Selectors follow the UI primitives (#20):** menu entries are `getByRole('menuitem', { name })`, and icon buttons are `getByRole('button', { name })` (their name comes from `aria-label`/`title`). Use dialog/toolbar/radiogroup roles with their labels. Don't assert on toast wording; assert on the outcome.
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
| 7 | Daily and weekly recurrence roll forward with a completed copy; Repeat from task details; reminder time + bell; Settings "Enable notifications"; in-app reminder toast | `07-recurrence-reminders.spec.ts` | ✅ incl. Settings → Notifications (email, digest, default time, quiet hours) |
| 8 | Offline edit → reconnect → synced to server and another device; reload while offline | `08-offline.spec.ts` | ✅ |
| 9 | iPhone 13: tab bar, quick add, tap to complete, drawer sidebar → note, no horizontal scroll, editing, search | `09-mobile.mobile.spec.ts` | ✅ |
| 10 | Notes edge cases: ⌘↵ convert line to task, move page (tasks stay linked), delete page/notebook keeps tasks, live rename for others, theme | `10-notes-edge.spec.ts` | ✅ |
| 11 | Live access changes: notebook made private, member removed, member demoted (server rejects edits; UI read-only live) | `11-live-access.spec.ts` | ✅ |
| 12 | Bulk task actions + row keys (#16) | `12-bulk-tasks.spec.ts` | ✅ |
| 13 | Token refresh mid-session: editing, REST and live events survive repeated 6 s access-token expiries (collab 4401 → refresh → reconnect); reload after expiry restores the session | `13-token-refresh.tokens.spec.ts` | ✅ |
| 14 | Invite links (#11): invite → link → create account → joined, live in the owner's list; wrong signed-in account → Switch account; bad token. Private notebook shared with specific people (#14): live appear/disappear, others never see it, only the creator can change it | `14-invites-sharing.spec.ts` | ✅ incl. Notebook options → Share with people… |
| 15 | Command registry (#19): palette commands, `g` navigation, `?` overlay, `n` new page, theme command; shortcuts ignored while typing | `15-commands.spec.ts` | ✅ |
| 16 | Page links (#25): `[[` to an existing page, open it, "Linked from" backlink, rename shows through, create from `[[`. Callout + toggle blocks persist (#21) | `16-links-blocks.spec.ts` | ✅ |
| 17 | Live-event catch-up after a dropped socket (#18): tasks created, edited or completed while away appear on reconnect without a reload. Version history restore (#37). "Meeting notes" template on an empty page (#27). Change password (#61) | `17-sync-history-account.spec.ts` | ✅ |
| 18 | Sidebar (#40): right-click menu → add/remove favourite (kept after reload), inline rename, duplicate; Recent lists visited pages | `18-sidebar.spec.ts` | ✅ |
| 19 | Invite-only sign-up (#67, `SIGNUP_MODE=invite`): an `ADMIN_EMAILS` account can bootstrap; strangers see "Sign-up is by invitation" and get 403 from the API; an invited email signs up through the invite link and lands in the team | `19-signup.invite.spec.ts` | ✅ |
| 21 | Comment threads (#28/#55/#62): select text → bubble menu Comment → highlight; another member sees it live and replies; resolve hides it under "Show 1 resolved" (live for others); reopen | `21-comments.spec.ts` | ✅ |

## Open bugs

### BUG-4: a change made while the app is still connecting live events is never shown (until reload)
- **Area / owner:** Collaboration (`src/store/events.ts`: on the *first* connect there is no `?since=` and no `resync()`. Catch-up only happens on reconnects.)
- **Found on:** main @ 890bb6d, 2026-11-05 (3 out of 3 runs with the socket held for a moment; occasionally at random, it was the cause of a flake in a new test)
- **Steps:** 1. B opens the dashboard; tasks load over REST. 2. Before B's `/api/events` socket is open (slow network, or a token refresh first), A assigns B a task. 3. The socket opens and later changes arrive live.
- **Expected:** B sees A's task: changes between the initial load and the first `hello` are caught up.
- **Actual:** that task never appears for B until a reload, though everything after it does.
- **Suggested direction:** include the event cursor (`boot:seq`) in the initial REST loads and connect with `?since=`, or simply `resync()` once after the first `hello`.
- **Test:** `tests/e2e/17-sync-history-account.spec.ts` › "a change made while the app is still connecting its live events is not lost" (`test.fixme`; deterministic: it holds the socket until the dashboard has loaded)

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

- **BUG-3** (Editor & Notes): a page title typed just before navigating away was lost (debounced save cancelled on unmount). Fixed by #66; test `10-notes-edge` › "a page title typed just before navigating away is still saved" enabled.
- **BUG-1** (Foundation, offline/PWA): reloading while offline showed the login screen, so cached notes couldn't open. Fixed by #35 (precached shell, offline cold start, read-only data cache); test `08-offline` › "…still opens after a reload while offline" enabled.
- **BUG-2a** (Collaboration, server): a member demoted to viewer could keep editing an already-open page, and the edits were persisted. Fixed by #12 (socket access revalidation). Test `11-live-access` › "edits from a member demoted … are not saved (BUG-2a, fixed in #12)" is enabled.
- **BUG-2b** (Collaboration, client): after being demoted to viewer, an already-open page stayed editable (no "View only") until reload. Fixed by #41 (re-checks page edit rights when your role changes); its test is enabled.
