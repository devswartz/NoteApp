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

- Ports: the main server listens on `E2E_PORT` (default 4317), the short-token server on `E2E_PORT+1`, the invite-only server on `E2E_PORT+2`, the email-verification server on `E2E_PORT+3`. Give each concurrent checkout its own `E2E_PORT`, or the second run fails to start its servers.
- Each run uses a fresh, throwaway `DATA_DIR` (and a fixed test-only `JWT_SECRET`), so tests never touch `./data`.
- Projects: `chromium` (desktop, every `*.spec.ts`), `mobile` (iPhone 13 viewport, only `*.mobile.spec.ts`) `short-tokens` (only `*.tokens.spec.ts`, against a second server on port+1 started with `ACCESS_TOKEN_TTL_S=6`, so access tokens expire mid-test) and `invite-only` (only `*.invite.spec.ts`, against a third server on port+2 with the production default `SIGNUP_MODE=invite` and `ADMIN_EMAILS=gate-owner@e2e.test`). The main and short-token servers use `SIGNUP_MODE=open` so tests can create users freely. `verify-email` (only `*.verify.spec.ts`) runs against a fourth server on port+3, open sign-up with **no SMTP** but started with `NODE_ENV=test` and `E2E_TEST_HOOKS=1` (not `npm start`): that makes email verification required and exposes the mail outbox at `GET /api/__test/outbox?to=<address>`. Both are ignored in production. Every other project has no SMTP, so accounts there are auto-verified and the other specs are unaffected. To run it by hand against your own server, start one that way and use `E2E_BASE_URL=… E2E_VERIFY_URL=http://localhost:<port> npx playwright test 23 --project=verify-email`.
- The browser runs in UTC (`timezoneId`), so "today" in tests matches `isoDay()` in `helpers.ts`.
- On failure, a trace and a screenshot land in `test-results/`; in CI the HTML report is uploaded as the `playwright-report` artifact.
- CI: the `e2e` job in `.github/workflows/ci.yml` runs `npx playwright test` after `check`; `publish` waits for it.

## Writing tests

- **Set up through the API, test through the UI.** `createUser`, `createTeam`, `createPage`, `createTask` in `helpers.ts` make users and data over REST. `signInContext(context, user)` signs a browser context in by seeding the refresh token (the app's normal session restore).
- **Every test makes its own users**, with unique emails, so tests can run in parallel against one server.
- **No fixed sleeps.** Wait on UI state (`expect(...).toBeVisible()`), or on server state with `eventually(() => listTasks(...), check)`.
- **Selectors follow the UI primitives (#20):** menu entries are `getByRole('menuitem', { name })`, and icon buttons are `getByRole('button', { name })` (their name comes from `aria-label`/`title`). Use dialog/toolbar/radiogroup roles with their labels. Don't assert on toast wording; assert on the outcome.
- **Avoid hover-revealed buttons** when there's another way in: right-click the sidebar row (same menu as the ⋯ button) or use the command palette. Hover reveals can animate and never settle under load, so Playwright's stability check times out.
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
| 9 | iPhone 13: tab bar, quick add, tap to complete, drawer sidebar → note, no horizontal scroll, editing, search; new page from search → `/task` → on Today with its source note → tap to complete | `09-mobile.mobile.spec.ts` | ✅ |
| 10 | Notes edge cases: ⌘↵ convert line to task, move page (tasks stay linked), delete page/notebook keeps tasks, live rename for others, theme | `10-notes-edge.spec.ts` | ✅ |
| 11 | Live access changes: notebook made private, member removed, member demoted (server rejects edits; UI read-only live) | `11-live-access.spec.ts` | ✅ |
| 12 | Bulk task actions + row keys (#16) | `12-bulk-tasks.spec.ts` | ✅ |
| 13 | Token refresh mid-session: editing, REST and live events survive repeated 6 s access-token expiries (collab 4401 → refresh → reconnect); reload after expiry restores the session | `13-token-refresh.tokens.spec.ts` | ✅ |
| 14 | Invite links (#11): invite → link → create account → joined, live in the owner's list; wrong signed-in account → Switch account; bad token. Private notebook shared with specific people (#14): live appear/disappear, others never see it, only the creator can change it | `14-invites-sharing.spec.ts` | ✅ incl. Notebook options → Share with people… |
| 15 | Command registry (#19): palette commands, `g` navigation, `?` overlay, `n` new page, theme command; shortcuts ignored while typing | `15-commands.spec.ts` | ✅ |
| 16 | Page links (#25): `[[` to an existing page, open it, "Linked from" backlink, rename shows through, create from `[[`. Callout + toggle blocks persist (#21) | `16-links-blocks.spec.ts` | ✅ |
| 17 | Live-event catch-up after a dropped socket (#18): tasks created, edited or completed while away appear on reconnect without a reload. Version history restore (#37). "Meeting notes" template on an empty page (#27). Change password (#61) | `17-sync-history-account.spec.ts` | ✅ |
| 18 | Sidebar (#40): right-click menu → add/remove favourite (kept after reload), inline rename, duplicate; Recent lists visited pages ; New notebook dialog with the "Team project" template (#71) | `18-sidebar.spec.ts` | ✅ |
| 19 | Invite-only sign-up (#67, `SIGNUP_MODE=invite`): an `ADMIN_EMAILS` account can bootstrap; strangers see "Sign-up is by invitation" and get 403 from the API; an invited email signs up through the invite link and lands in the team | `19-signup.invite.spec.ts` | ✅ |
| 21 | Comment threads (#28/#55/#62): select text → bubble menu Comment → highlight; another member sees it live and replies; resolve hides it under "Show 1 resolved" (live for others); reopen ; @mention in a comment notifies the person (#29, inbox API) | `21-comments.spec.ts` | ✅ / bell in header: fixme (`NotificationBell` not mounted yet) |
| 22 | User templates: page menu → Save as template… (workspace-visible, tasks and attachments captured); a new empty page lists it under the built-ins; inserting it creates a NEW task (different id, original untouched, completing the copy leaves the original open) and a copied attachment; rename and delete from the picker; pages made from it keep working after the template is deleted | `22-user-templates.spec.ts` | ✅ |
| 24 | Delete account (Settings → Profile): the card lists workspaces handed over and deleted; Delete is disabled without a password; a wrong password shows "Incorrect password" and deletes nothing; the right one signs out to the login page, the account can't sign in, the admin became owner of the handed-over workspace and the plain-members workspace is gone. Server side in `tests/account-deletion.test.ts` | `24-delete-account.spec.ts` | ✅ |
| 23 | Email verification (`verify-email` project, test-only mail outbox): sign up → "Check your email" (address shown, app unreachable) → Resend with cooldown, older link dead (Link not valid) → confirm link in the signed-in browser opens the app; the link is single use; "I've verified, continue" says "Not confirmed yet" until confirmed from another client; signed-out link → login; unverified sign-in shows the screen even on deep links; Sign out | `23-email-verification.verify.spec.ts` | ✅ |
| 24 | Public `/privacy` and `/terms` (rendered from `legal/*.md`) open signed out with headings and the contact address; the login screen links to both; sign-up says "By creating an account you agree to the Terms and Privacy Policy" | `24-legal-pages.spec.ts` | ✅ |
| 25 | Client error reporting: an uncaught error in the page makes exactly one `POST /api/client-errors` (204) with message, stack, version and the page URL without query/fragment; the same error again, ResizeObserver noise and aborts are not reported; signed in the request carries the bearer token; nothing is sent while offline | `24-client-errors.spec.ts` | ✅ |
| 26 | Send feedback (`verify-email` project, which runs with `ADMIN_EMAILS=feedback-admin@e2e.test`): ⌘K → "Send feedback" → Send is disabled until there is text, counter, success toast, and the admin mail in the outbox (subject, Reply-To = the user, id, path with query/hash stripped, HTML escaped). A failed send (500 stubbed) keeps the draft; the `?` overlay also opens the dialog. Server side in `tests/feedback.test.ts` | `24-feedback.verify.spec.ts` | ✅ |
| 27 | Editor extras (#21): page icon (page, sidebar, saved), ⌘K on a selection adds a link (kept after reload), ⌘K without a selection opens the palette; attachment renders as a file card with size and a working download | `27-editor-extras.spec.ts` | ✅ |
| 28 | Verification × invites (`verify-email`): an invited person who signs up unverified isn't a member yet (invite still pending, the team URL shows "Check your email"); confirming applies the invite and they land in the team | `28-verify-invites.verify.spec.ts` | ✅ |
| 29 | Template privacy: a page in a private notebook (with a task) is saved as a private template (dialog says so, other members don't get it); a shared-notebook page is a workspace template other members see | `29-template-privacy.spec.ts` | ✅ |
| 30 | Page panel (#99) live: adding a task bumps the toolbar count without opening the panel; another member completing it lowers the count live; a member's new comment shows "Comments (1 open)" live; starting a comment opens the Comments tab; the badge opens it | `30-page-panel-live.spec.ts` | ✅ |

## Open bugs

### BUG-6 (high): on a slow connection, a quickly entered task loses its title, and Enter-Enter leaves a stray task
- **Area / owner:** Tasks + Editor (`src/store/tasks.ts` optimistic create/update/delete and `src/editor/TaskRef.tsx`). Title updates and the delete of the empty task are sent while the task's `POST /workspaces/:id/tasks` is still in flight; the server applies them before or without the create, so they're lost.
- **Found on:** main @ 0c59452, 2026-11-06. Deterministic with 300 ms or more on the create request (phones on mobile data easily see 1–2 s). Also seen without any added latency in about 1 of 4 runs as a client-only phantom "Untitled task".
- **Steps:** 1. Throttle the network (DevTools → Slow 3G). 2. In a page, "Add a task to this page" (or `/task`). 3. Type a title and press Enter, then Enter again on the new empty task to leave task mode.
- **Expected:** one task with that title on the page.
- **Actual:** the task on the page is **untitled** (the title is gone from the note, dashboard and server), and a second **untitled standalone task** remains (the "deleted" empty one). With Escape instead of Enter, the title is lost too. With no throttling, the client sometimes shows a phantom "Untitled task" in My Tasks and +1 on the page badge/sidebar count until a reload.
- **Suggested direction:** queue a task's PATCH/DELETE behind its pending create (or send the final title in the create when it hasn't gone out yet), and don't re-insert a task the user already deleted when its create answers.
- **Test:** `tests/e2e/10-notes-edge.spec.ts` › "on a slow connection, a task typed and left quickly keeps its title and leaves no stray task" (`test.fixme`; deterministic: it delays the create by 1.5 s)

## Observations (not filed as bugs)

- **Keyboard selection reaches the editor asynchronously** (ProseMirror reads it on `selectionchange`). Keys pressed within a few ms of a selection change act on the old selection: ⌘K right after Shift+Home opens the palette instead of the link editor, and Enter right after End can replace still-selected text. Humans are too slow to notice; tests wait for the bubble menu to appear or disappear. If it ever shows up in real use, the ⌘K handler could read the DOM selection directly. (2026-11-05, Editor & Notes)

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

- **BUG-5** (Editor & Notes): a new task left with Escape kept the quick-add words in its title. Fixed by #111; test `10-notes-edge` › "a new task left with Escape gets the same cleaned-up title as with Enter" enabled.
- **BUG-4** (Collaboration): a change made while the app was still opening its first live-events connection was never shown until a reload. Fixed by #76 (reload once the first hello arrives); test `17-sync-history-account` › "a change made while the app is still connecting its live events is not lost" enabled.
- **BUG-3** (Editor & Notes): a page title typed just before navigating away was lost (debounced save cancelled on unmount). Fixed by #66; test `10-notes-edge` › "a page title typed just before navigating away is still saved" enabled.
- **BUG-1** (Foundation, offline/PWA): reloading while offline showed the login screen, so cached notes couldn't open. Fixed by #35 (precached shell, offline cold start, read-only data cache); test `08-offline` › "…still opens after a reload while offline" enabled.
- **BUG-2a** (Collaboration, server): a member demoted to viewer could keep editing an already-open page, and the edits were persisted. Fixed by #12 (socket access revalidation). Test `11-live-access` › "edits from a member demoted … are not saved (BUG-2a, fixed in #12)" is enabled.
- **BUG-2b** (Collaboration, client): after being demoted to viewer, an already-open page stayed editable (no "View only") until reload. Fixed by #41 (re-checks page edit rights when your role changes); its test is enabled.
