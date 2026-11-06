# NoteApp — status

## ▶ FINAL SUMMARY (2026-11-05 12:15 UTC, end of the autonomous run)

### Your to-dos, in this order
1. **Make `main` the default branch** (GitHub → Settings → General). It is still `claude/initial-app`; the Desktop workflow can't be run by hand until this changes. Then **protect `main`**, requiring `check`, `docker` and `e2e`.
2. **Brief the homelab agent** with the ready-to-paste message in **`docs/LAUNCH_CHECKLIST.md`**. The contract changed since the original brief:
   - `TRUST_PROXY_HEADER=cf`
   - the app port must be reachable **only** through cloudflared
   - **`ADMIN_EMAILS=<you>` set before the first sign-up** (otherwise the first account becomes admin)
   - sign-up is **invite-only by default** in production (`SIGNUP_MODE`)
   - `ACCESS_TOKEN_TTL_S` left unset
   - `APNS_*`, `FCM_SERVICE_ACCOUNT_JSON`, `ANDROID_CERT_SHA256` for mobile push and app links
3. **Verify staging** with the checklist (health, sign-up refusal, SES invite, web push), then tag `v0.1.0` for prod.
4. **Signing secrets** when you're ready for native builds: Mac/Windows in `docs/DESKTOP.md` (first signed build checklist), iOS/Android in `docs/MOBILE.md`.

### What happened
- 10 worker agents ran in parallel (Foundation, Editor, Tasks, Collaboration, Reminders, UI Shell, Infra, QA, Desktop, Mobile). Every PR was reviewed by a subagent (tests, a diff read, and often a live attack or browser check), and merges went through a merge queue requiring green `check` + `docker` + `e2e`.
- **62 PRs are merged into `main`.** About 25 real bugs were caught in review before merging. Security examples: upload XSS, AUTHZ-1 (files on private pages), invite-email binding, the refresh-token chain, account lock-out denial of service, a sign-up bootstrap race, private-task leaks through recurring history, cross-user offline cache. Data-loss examples: title rename lost (BUG-3), pages not saving under continuous typing, an oversized-paste resend loop.
- ⚠️ **The usage limit was hit at about 06:25 UTC**, and everything paused until **10:20 UTC** (about 4 h lost). Afterwards I ran fewer parallel reviews.

### What's on `main` (v0.1.0 candidate)
- **Notes:** workspaces → notebooks (private/shared, per-person sharing) → sections → pages. A TipTap block editor (callouts, toggles, code, tables, images, file cards, ⌘K links, block handles), [[page links]] + backlinks, templates, version history with restore, comments on selections, live cursors, FTS search, offline cache.
- **Tasks:** inline tasks synced with the dashboard (My/Today/Upcoming/Team/All/Calendar/Completed), quick add, keyboard workflow, bulk actions, subtasks, saved views, recurrence (time-zone- and DST-correct), reminders (web push, email via SES, APNs/FCM, snooze, quiet hours, .ics feed, digest).
- **Collaboration and security:** roles and invites (email-bound), live events with catch-up, notifications + @mentions (dedup/rate-limited), invite-only sign-up, password reset, rate limiting, a strict CSP and security headers, error boundaries, request ids, structured logs, admin stats.
- **Platforms:** responsive web/PWA with a real mobile layout. Tauri desktop (menu, tray, quick capture, keychain, updater). Capacitor iOS/Android (Face ID lock, share extension, Today widget, push). CI builds both native apps.
- **Ops and docs:** Docker image → GHCR (`:staging` on every merge), deploy templates, README, USER_GUIDE, CHANGELOG, LAUNCH_CHECKLIST, ARCHITECTURE, QA (about 73 e2e tests; no open bugs except the follow-ups below).

### Still open (12 PRs; next round)
| PR | What | State |
|---|---|---|
| #44 → #53 → #58 | Editor: Markdown/PDF export+import → ToC/full width → long-page performance | approved/fixed; need main merged in, then re-verify #58 under load |
| #60 | Undo convert-to-task | **redo deletes the task**: fix pending |
| #68 / #72 | Editor accessibility (axe) / editor e2e | approved #68; both need main merged in |
| #77 | Foundation: workspace export/import + **seed.ts formatting fix** (#70 merged without it) | needs review |
| #46 / #49 | Collab: input limits (approved, conflict resolved) / authz audit (needs rows for /auth/config, /admin/*) | |
| #23 → #39, #33 | Collab: presence stack (fixed) → follow a collaborator; activity feed | need review |
**UI hook-ups needed next round** (from Collab): mount `<NotificationBell/>` in the AppShell header (UI Shell); an Activity nav item once #33 merges (UI Shell); follow-a-collaborator wiring in PageView (patch in #39; Editor); `MentionNode` registered in the editor extensions so @mentions work in page text (Editor or Collab). The "Share with people…" item is already on main via #56. #49 is now green with rows for /auth/config and /admin/*.
Known gaps: the **NotificationBell isn't mounted** in the UI yet (from #29); `platform.saveFile` is a web stopgap in the shells; Foundation's platform-gaps PR is not started.

### How to resume
Read this file, PLAN.md, docs/AGENT_GUIDE.md, DEPLOY_CONTRACT.md and LAUNCH_CHECKLIST.md. The worker sessions in the roster below are idle but resumable (`send_message`). The migration registry runs to 010 (next free 011). Rules: merge only with green e2e on a head that includes main; small PRs; reviewers verify the reviewed SHA plus merge-only changes.

---

## Manager status log (history)

**Start here when resuming.** This is the manager's running record: decisions, which sessions exist, what each one owns, what has merged, and what's next. The newest log entry is at the bottom.

## How to resume as a new manager
1. Read `PLAN.md`, `docs/AGENT_GUIDE.md`, `docs/DEPLOY_CONTRACT.md` and this file.
2. Check the session roster below with `get_session` for each ID; send work to existing sessions with `send_message` rather than starting duplicates.
3. Check open PRs into `main`. Review (keeping context light; a subagent can do the diff review), merge if CI is green, then tell the authors.
4. Keep this file updated after every meaningful action.

## Decisions (settled with the user, 2026-11-05)
- Scope and phases: see `PLAN.md` (approved).
- Platforms: web + Tauri desktop + Capacitor mobile; no native SwiftUI.
- Hosting: homelab, Proxmox LXC + Docker Compose, Cloudflare Tunnel, `notes.devswartz.com` (prod) and `notes-staging.devswartz.com` (staging).
- Deploys are pull-based: CI → GHCR images, and the homelab pulls them. Contract: `docs/DEPLOY_CONTRACT.md`.
- Email: AWS SES via SMTP. The user has an Apple Developer account (Phase 2/3).
- App name: "NoteApp" for now; it will be renamed later, so keep the name in one constant/config.
- **The manager may merge PRs into `main`** after review + green CI.
- Concurrency: **balanced, about 4–5 worker sessions at once.**
- A homelab agent is run separately by the user from `docs/HOMELAB_BRIEF.md`; it reports back through the user or with a PR adding `docs/HOMELAB.md`.
- The user asked the manager to work independently and to document as it goes. **Updated 04:10: aim to finish v1 (Phase 1) in about 4 hours, i.e. by about 08:15 UTC; agents' feature deadline is 07:30 UTC.** Check agents every 15–20 minutes. **Updated 04:17: the user is away until about 12:30 UTC — keep every worker busy (each has a stretch backlog after its main list); check in every 10 min.** After Phase 1 converges (~07:30), start Phase 2 (Tauri desktop) and Phase 3 (Capacitor mobile) agents in freed slots.

## Manager automation
- The manager checks in every ~15 minutes through a chain of `send_later` reminders (every 10 min) into the manager session; each check-in schedules the next. Workers can ping the manager with `send_message` (notifications arrive in the manager session); the manager also polls `get_session`. (The old hourly scheduled task `trig_01QRki933W6e6bsvS4Jau21s` is deleted.) A resuming manager should run `list_triggers` and keep at most one pending check-in.
- The manager commits `docs/STATUS.md` updates directly to `main`; all other changes go through PRs.

### Check-in procedure
1. `get_session` for each active worker (status_detail only). Read transcripts only if a worker failed or is stuck (list_events kinds ["assistant"], limit 3).
2. **Merge rule (added 04:55): never merge a PR whose e2e hasn't run green against current main.** Branches older than a new test suite must merge main first. `list_pull_requests` (open, base main). For each PR whose CI has finished: a general-purpose subagent reviews it (tests in a scratch worktree, a diff read against docs/AGENT_GUIDE.md) and returns a verdict of at most 200 words. Squash-merge the good ones (`[shared]` first, with expectedHeadSha). Send follow-ups or fixes to the author with `send_message`.
3. Keep 5–6 workers busy; when one finishes, start the next from the queue below.
4. Update this file and push it. Schedule the next check-in (`send_later`, 15 min).

### Queue (not started yet)
1. (empty: all 10 agents have started.) Candidates if slots free up: a security/perf hardening reviewer, docs/onboarding, a second QA.
- Stretch backlogs were sent to Foundation, Tasks, Editor, Collaboration and Reminders at 04:17 (the details are in each kickoff/follow-up message; their PRs' "Status of my area" sections track progress).

## Session roster
| Agent | Session ID | Branch | Owns | State |
|---|---|---|---|---|
| Manager | session_019dirnRG6rqRQKiaYoYvd2H | claude/practical-albattani-3z93fy | coordination, docs/STATUS.md | active |
| 1 Foundation | session_019dirnRD8GTtbGrFh37NAfG | feat/foundation | auth/security follow-ups, API client, offline/PWA, keeping main green | PR #2 merged; on follow-ups |
| 7 Infra & Deploy | session_019dirnSW7khFtAuDrTTCCDN | feat/infra | `Dockerfile`, `.github/**`, `deploy/**`, `docs/RELEASING.md` | **done** (#1, #8, #13 merged); message it only if CI breaks |
| 6 UI Shell & Design System | session_019dirnQUCbwcXMNM7LcPeqU | feat/ui-shell | styles/tokens, AppShell/Sidebar(+DnD)/CommandPalette/ui primitives, shortcuts, mobile layout, Settings layout | started 04:28 |
| 3 Tasks & Dashboard | session_019dirnRfdDtEARpJKN6JxyV | feat/tasks | task server/routes, dashboard views, calendar, quick add | started 04:15 |
| 2 Editor & Notes | session_019dirnQJdPWZ1xg1q9wPn2Q | feat/editor | `src/editor/**` (not collab*), PageView/NotesHome, files, FTS search, tree moves | started 04:15 |
| 4 Collaboration & Access | session_019dirnPr6xS49fYWnMwkTgE | feat/collab | collab/access/events/workspaces, cursors/presence, invites, `server/mail.ts`, sharing UI | started 04:15 |
| 9 Desktop / Tauri 2 | session_019dirnS7qJeVB9Nazida4y7 | feat/desktop | `apps/desktop/**`, `src/platform/tauri.ts`, `.github/workflows/desktop.yml`, `docs/DESKTOP.md` | started 04:40 |
| 10 Mobile / Capacitor | session_019dirnRUobcNENy5tRL3crU | feat/mobile | `apps/mobile/**`, `src/platform/capacitor.ts`, APNs/FCM channel files in server/reminders, `docs/MOBILE.md`, `.github/workflows/mobile.yml` | started 04:47 |
| 8 QA / E2E | session_019dirnSs9HgWLitSESbPuyD | feat/e2e | `tests/e2e/**`, playwright config, `docs/QA.md` (bug list; doesn't fix app code) | started 04:17 |
| 5 Recurrence & Reminders | session_019dirnS55cMN1UvQo2atin9 | feat/reminders | `shared/recurrence.ts`, `server/reminders/**`, web push + email, notification settings | **done**; everything is in #4 (final head d9e6680) |
| Original builder | session_019dirnQSpFWbj8dPFQkoUjf | claude/initial-app | wrote the initial work-in-progress (now the base of `main`) | paused/idle; not used further (its session is tied to pushing `master`) |

## PR / merge log
| When (UTC) | PR | Area | Result |
|---|---|---|---|
| 04:13 | #1 infra: CI, Docker, GHCR publish, deploy templates, RELEASING.md | Infra | squash-merged (review: no blockers; follow-ups sent) |
| 04:13 | #2 Phase 0 foundation (core flow, area split, contract, token auth, platform adapter) | Foundation | squash-merged (27/27 tests, smoke ok; security follow-ups sent) |
| 04:30 | #8 infra: CI-gated publish, JWT_SECRET required | Infra | merged; `:staging` image confirmed in GHCR (public) |
| 04:30 | #3 server/mail.ts | Collab | merged; follow-ups sent (don't log bodies in prod; MAIL_FROM warning) |
| 04:30 | #6 [shared] Playwright dependency + test:e2e | QA | merged |
| 04:31 | #5 [shared] migration 003 (FTS + files) | Editor | merged |
| 04:33 | #9 tasks: validation, week calendar, TasksView split | Tasks | merged |
| 04:28 | #13 infra: manual publish only from main | Infra | merged |
| 05:01 | #12 foundation security follow-ups + new migration runner + e2e selector fix | Foundation | **merged** (verified; main's e2e back to green). Old row: | migration renamed to 006; runner now records applied migrations in `schema_migrations` (any order, duplicates still fail). Runner verified solid. **Blocked** (resent at 04:46): refresh replay `used_at`, revoke canEdit + terminate, reconnect backoff/401 sign-out; plus wrap the runner backfill in a transaction and use BEGIN IMMEDIATE. |
| 04:36 | #17 ui: design tokens + light/dark/system theme | UI Shell | merged (follow-ups: no-flash inline script, readPref after platform init) |
| 04:41 | #15 QA E2E suite (37 tests, about 50 s, no flakes) | QA | merged; e2e now gates PRs and publish. BUG-1 (offline reload → login) is with Foundation |
| 04:43 | #19 ui: shortcut/command registry | UI Shell | merged |
| 04:45 | #7 [shared] collab migration 004 + types | Collab | merged |
| — | #16 tasks keyboard nav + bulk actions | Tasks | changes requested: move raw window keydown listeners onto the registry; scope ⌘A |
| — | ui primitives PR | UI Shell | in review |
| — | #14 collab sharing, #18 collab events | Collab | approved; must rebase after #11. Order: #11 → #14 → #18 |
| — | #7 [shared] collab migration | Collab | waiting: rename to **004**, then merge |
| — | #4 reminders v1 (whole stack) | Reminders | approved; merging main and resolving types.ts now that #7 is in |
| 04:33 | #10 editor: ranked FTS search, uploads, move/copy | Editor | merged after a security re-review (actively attacked uploads; all held) |
| — | #11 collab invites | Collab | **blocked** (resent): invite accept requires a matching email; signup auto-join respects expiry; PUBLIC_URL required in prod (Origin fallback leaks the token) |

## Log
- **2026-11-05 03:00** Found the builder session mid-build; paused it; planned with the user; wrote `PLAN.md`.
- **2026-11-05 ~03:45** Plan approved. Wrote the deploy contract, homelab brief, agent guide and this log. Created `main` from `claude/initial-app` + docs. Next: start Phase 0 (Foundation + Infra).
- **2026-11-05 03:19** Started Foundation (agent 1) and Infra (agent 7). Phase 1 agents start once Foundation PR 1 merges. Hourly check-in scheduled.
- **2026-11-05 04:10** User asked for check-ins every 15–20 min and v1 done in about 4 hours. Hourly scheduled task deleted in favour of a 15-min chain.
- **2026-11-05 04:15** Merged #1 and #2. Sent follow-ups to Foundation and Infra. Started Tasks (3), Editor (2), Collaboration (4) and Reminders (5).
- **2026-11-05 04:17** User away for 8 hours: keep everyone busy. Sent stretch backlogs to all feature agents, started QA (agent 8), switched check-ins to every 10 min. Workers can't message the manager; the manager polls.
- **2026-11-05 04:33** Reviewed 9 PRs with 3 parallel reviewer subagents. Merged #8, #3, #6, #5, #9. Migration-number ordering: 003 editor, 004 collab, 005 reminders. #10 blocked for upload XSS. **Workers DO have send_message**: Infra pinged the manager; all workers told to ping session_019dirnRG6rqRQKiaYoYvd2H.
- **2026-11-05 04:28** Merged #13; Infra done. Started UI Shell (agent 6) in its slot. Migration numbers reserved: 004 collab, 005 reminders, 006 foundation. **Rule: a migration takes the next free number on main at rebase time; the manager assigns numbers.**
- **2026-11-05 04:34** Merged #10. #12 reviewed: migration renamed to 006, follow-ups sent. Foundation is replacing the contiguous `user_version` migration runner with a `schema_migrations` table, so numbers no longer need to land in order.
- **2026-11-05 04:40** Batch of 9 PRs sent to 4 parallel reviewer subagents. Reminders finished its stretch backlog (snooze, APNs/FCM channels, quiet hours, .ics) inside #4; given one last job (wire its pickers into TaskDetail/TaskRow/quickadd), then done. Started Desktop (agent 9) early so no slot sits idle. **#4 lists new env vars for DEPLOY_CONTRACT: APNS_KEY_ID/TEAM_ID/BUNDLE_ID/PRIVATE_KEY/ENV, FCM_SERVICE_ACCOUNT_JSON — add them to the contract when #4 merges.**
- **2026-11-05 04:46** Merged #15, #19, #7. Two agents (Collab #11, Foundation #12) hadn't applied requested follow-ups, probably because the messages crossed with their pushes; resent with a request to confirm. Lesson: ask agents to acknowledge follow-up lists.
- **2026-11-05 04:48** Merged #20 (ui primitives; a11y follow-ups sent). #21 (editor blocks + page header) in review; #11 being verified; #4's final delta + #24 in review. Reminders done; Mobile (agent 10) started in its slot. Migrations: 007 tasks subtasks, 008 collab comments. **Messages to workers arrive 20–30 min late** (delivered at end of their turns); workers are told to check PR state themselves.
- **2026-11-05 04:55** ⚠️ main's CI e2e is red since #20 merged (5 tests wait for 'New workspace'/'Sign out'); the manager merged #20 before e2e existed on its branch. UI Shell is fixing it as top priority (QA may fix selectors if that's all it is). Staging publish is blocked until it's green. New merge rule added to the procedure. #11's security fixes are verified; #11 waits on #22 (test wording). #21 needs 2 fixes (partial-selection convert; file-card URL validation).
- **2026-11-05 05:01** Merged #12: refresh-chain fixes, socket revoke/terminate, reconnect backoff, a `schema_migrations` runner (gaps and out-of-order allowed; duplicates fail; BEGIN IMMEDIATE) and the e2e selector fix for #20. main is green. Told all PR authors to merge main. Next merges in order: #22 → #11 → #14 → #18; #4 (after its e2e picker fix); #16 (rename to 007); #21 (2 fixes); #24 (approved, waiting on green e2e). Selector convention: getByRole('menuitem') for menus, button name from aria-label.
- **2026-11-05 05:07** Merged #22 (QA: role-based selectors suite-wide, BUG-2a test on) and #30 (Mobile Capacitor shell; Android and iOS simulator builds pass in CI). #4 conflicts again after #22 (e2e); Reminders is resolving it, and **#4 merges next before any other e2e-touching PR**. #32 (Desktop) approved; resolving the platform/index.ts and package.json conflict with #30 plus two small security fixes. #11's e2e running. Settings PR (UI) and #24 queued. Collab's comments migration renumbered to 008.
- **2026-11-05 05:10** A merge-queue subagent is now running: #4 → #11 → #24 → #32, each squash-merged only when check, docker and e2e are green on a head that includes main and nothing changed since review except merges. Reviews in flight: #14 delta, #26 and #36; #35 and the UI Settings PR. **Migration registry: 001–004 main, 005 reminders (#4), 006 foundation (main), 007 tasks subtasks (#16), 008 collab comments (#26), 009 editor page_versions (#31). Next free: 010.** Editor chain: #21 → #25 → #27 → #37 (+ #31 shared). Collab chain: #14 → #18 → #26 → #28/#29/#33. Mobile #36 is next.
- **2026-11-05 05:26** ⚠️ **For the user: change the repo's default branch to `main`** (Settings → General → Default branch; it's currently `claude/initial-app`). Until then the Desktop workflow can't be manually dispatched (GitHub registers dispatch-only workflows from the default branch). Reviews in flight: the UI stack (#34 delta → #40 → #45 → polish), and #36/#43/#47. Merge queue running: #11, #14, #24, #32 (merged), #34 (will skip: changed), #26, #21, #18, #41, #42. #35 verification running. Collab is on hardening (rate limits #43, input limits, authz audit, security headers).
- **2026-11-05 05:38** Security findings and routing: **AUTHZ-1** (GET /files/:id ignored page access; members could see files on private pages) → Editor fixed it in #52, now in review-and-merge. #43 rate limiting: an account lock-out DoS and CF-Connecting-IP trusted from anyone → Collab is fixing (pair-keyed limits, `TRUST_PROXY_HEADER=cf` env for the deploy contract, an LRU cap). #46: TTL clamp missing, client resend loop on 1009 → Collab. #49: the coverage check misses routers → Collab. #36: a cold-start lock bypass → Mobile. #40: viewers' drag-and-drop → UI. #35: a cross-user wipe on sign-in → fixed, queued. In the merge queue: #34, #35, #47 plus the earlier list. #4 conflicting again (Reminders re-merging); #16 in final review and may merge before #4.
- **2026-11-05 05:43** **Merged #4** (Reminders v1: recurrence, scheduler, web push/email/APNs/FCM, snooze, quiet hours, .ics, digest). Reminders agent is done. Merged so far by the queue: #11, #14, #18?, #21, #24, #26, #32, #41 (see `git log`). Queue: #52 (security, priority), #34 → #40 → #45 → #48 → #50 (UI stack), #35, #36, #38, #42, #47. Waiting on authors: #16 (merge main after #4), #43 (lock-out DoS fix), #46 (1009 loop), #49 (coverage check). In review: #16 (final), the editor chain (#25/#27/#31/#37/#44), #28 (to send), #51 (to send).
- **2026-11-05 05:48** DEPLOY_CONTRACT updated: `TRUST_PROXY_HEADER=cf` (required on staging and prod), app port reachable only via cloudflared, `ACCESS_TOKEN_TTL_S` clamp, APNs/FCM vars. **For the user: tell the homelab agent about these contract changes** (or re-run it with docs/HOMELAB_BRIEF.md plus this diff).
- **2026-11-05 06:00** Merged since 05:26: #52 (AUTHZ-1 fix), #4, #34, #40, #36, #38, #41, #42, #21, #26 (plus earlier #11, #14, #24, #32). Queue: #45 → #48 → #50 → #51, #35, #47, #54, #31, #25, #28, #16, #18. Fixing: #43 (bcrypt concurrency / guess-rate cap), #46 (data-safe 1009 handling), #49 (missing reminders routes). In verification: Editor #27/#37/#44 and UI entry-points. Decisions: tasks from deleted private pages stay private (Tasks, migration **010**); deleted-page files restricted (Editor). Desktop reassigned to docs (README, USER_GUIDE, CHANGELOG). **Migration registry: 001–009 assigned; 010 = tasks private-detach; next free 011.**
- **2026-11-05 06:15** The merge queue has landed: #11, #24, #14, #32, #26, #21, #41, #42, #52, #34, #40, #38, #36, #31, #54, #28. The manager merged #4 and #35 directly. Skipped (handled): #47 and #18 changed after approval (delta review running); the UI stack #45/#48/#50 conflicted, so it lands via #56, which contains all of it (UI Shell is confirming that it includes theme-init.js), then #51; the editor chain #25 → #27 → #37 → #44 → #53 → #58 needs retargeting to main one at a time (the manager retargeted #25). Reviews in flight: #43/#46/#49 deltas, #53, #57, #58.
- **2026-11-05 06:20** Merge-queue round 1 finished: 18 merged (incl. #56, which brought in the UI stack, and #16). Closed #45, #48 and #50 as superseded by #56. Round 2 runner started: #51 → #25 → #27 → #37 → #44. In review: the #43/#46/#49/#53/#57/#58 batch, #47/#18 deltas, the #29/#55/#59/#60 batch; still to review: #61 (password reset) and #62 (comments UI, after #55). Editor reassigned to accessibility, demo seed and e2e gaps; UI Shell to visual QA and onboarding; Tasks to the private-detach PR (migration 010) and SwipeRow.
- **2026-11-05 10:22** ⚠️ **The account hit its 5-hour usage limit at about 06:25 UTC** (reset 08:10); the manager session restarted only at 10:20, so about 4 hours were lost. Every subagent stopped mid-task; the manager resumed them (merge runner 2: #51 → #25 → #27 → #37 → #44; the reviews of #43/#46/#49/#53/#57/#58, #29/#55/#59/#60 and #47/#18) and started a review of #61–#64. Workers may also have been limited. **Lesson: run fewer parallel subagents and reviews to stay under the usage cap.**
- **2026-11-05 10:43** Merged after resuming: #51 (security headers), #25 (page links), #27 (templates), #47 (desktop hardening + signed-build checklist). #37 retargeted to main; the Editor chain continues #37 → #44 → #53 → #58. #18 is merged with main (comment and notification event rules kept on replay) and waiting on CI. Reviews in flight: #43/#46/#49/#53/#57/#58, #29/#55/#59/#60, #61/#62/#63/#64. Desktop is opening the docs PR.
- **2026-11-05 11:06** Merged since resuming: #51, #25, #27, #47, #61 (password reset + auth hardening), #18, #55, #59. Merge runner 3 is working through: #64, #66 (BUG-3 title-loss fix), #63, #37, #62, #65 (docs), #44, #46, #57. Fixing: #43 (merge main for async bcrypt + forgot/reset limits), #49 (backlinks row), #29 (mention dedup), #60 (redo), #53 (rebase), #58 (typed-text loss under load). In review: #67, #68, #69, #70. Open bugs: none apart from those fixes (BUG-3 fixed in #66).
- **2026-11-05 11:27** Merged: #64 (QA de-flakes + all fixmes on), #37 (version history), #65 (README/USER_GUIDE/CHANGELOG), #57 (mobile follow-ups). Merge runner 3 continuing: #67 (error handling/logs/admin), #68 (editor a11y + axe), #70 (demo content), #75 (LAUNCH_CHECKLIST), #69 (phone UI + contrast), then re-checking the conflicted #66/#63/#62/#46/#44 (authors merged main). New finds: **open sign-up** (PLAN says invite-only) → Foundation adding SIGNUP_MODE=invite default; **BUG-4** (first events connect misses changes) → Collab; the icon PR also fixes theme-init.js 404 offline (precache). Mobile, Desktop, Infra and Reminders are done.
- **2026-11-05 12:15** Final: merged #75 (LAUNCH_CHECKLIST). 62 PRs on main. Autonomous run ended; the summary is at the top of this file.
- **2026-11-05 13:48** (user back) Wrap-up round: merged #46, #49, #78, #44. In flight: #33, #60 (redo fix), #72, #82, #81 (QA). Authors merging main: #23, #68, #79 (bell), #80 (MentionNode); Editor retargeting #53 → #58. #77 blocked: import must sanitise the Yjs doc (export of shared-with-me notebooks accepted).
- **2026-11-05 13:50** ⏸ **PAUSED for usage.** All workers were told to push finished work and stop; no check-ins are scheduled. main is green and functional (v0.1.0 candidate). **To resume:** read the FINAL SUMMARY at the top; the remaining open PRs are #23, #33, #39, #53, #58, #60, #68, #72, #77 (import sanitising), #79 (bell), #80 (MentionNode), #81, #82 and the Tasks SwipeRow work. Merge only after verifying the reviewed SHA plus merges and a green check, docker and e2e.
- **2026-11-05 13:55** Final reviewer state: **#33** (activity) and **#60** (undo/redo) reviewed OK and only need green CI on a head including main before merging. #81 and #82 look fine on a quick read (not fully run). #77 blocked on import sanitising (server/export.ts ~L150). #23, #68, #79 and #80 need their authors to merge main. #72 and #53 not yet reviewed.
- **2026-11-05** Email verification for sign-up (this PR). Deploy contract clarified, no new required variables: `SIGNUP_MODE=open` now needs working SMTP (new accounts confirm their email; without `SMTP_HOST` every account is auto-confirmed, so don't run `open` in production without it), and `E2E_TEST_HOOKS` is a test-only variable ignored in production. Production still defaults to `invite`. Homelab owner: see `docs/LAUNCH_CHECKLIST.md` section 5b before ever switching to `open`. Migration 012.
