# NoteApp — manager status log

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
2. `list_pull_requests` (open, base main). For each PR whose CI has finished: a general-purpose subagent reviews it (tests in a scratch worktree, a diff read against docs/AGENT_GUIDE.md) and returns a verdict of at most 200 words. Squash-merge the good ones (`[shared]` first, with expectedHeadSha). Send follow-ups or fixes to the author with `send_message`.
3. Keep 5–6 workers busy; when one finishes, start the next from the queue below.
4. Update this file and push it. Schedule the next check-in (`send_later`, 15 min).

### Queue (not started yet)
1. **Desktop / Tauri 2 (agent 9)**: owns `apps/desktop/**` and the Tauri implementation of `src/platform/`. Start at ~07:30 or when a slot frees up.
2. **Mobile / Capacitor (agent 10)**: owns `apps/mobile/**`, the Capacitor platform implementation, APNs/FCM wiring (server side from Reminders' channel interface) and the Today widget. Start when a slot frees up after Desktop.
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
| 8 QA / E2E | session_019dirnSs9HgWLitSESbPuyD | feat/e2e | `tests/e2e/**`, playwright config, `docs/QA.md` (bug list; doesn't fix app code) | started 04:17 |
| 5 Recurrence & Reminders | session_019dirnS55cMN1UvQo2atin9 | feat/reminders | `shared/recurrence.ts`, `server/reminders/**`, web push + email, notification settings | started 04:15 |
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
| — | #12 foundation security follow-ups + new migration runner | Foundation | migration renamed to 006; runner now records applied migrations in `schema_migrations` (any order, duplicates still fail). Waiting on fixes: refresh replay `used_at`, revoke canEdit/terminate, reconnect backoff. Then a re-review of the runner. |
| — | #7 [shared] collab migration | Collab | waiting: rename to **004**, then merge |
| — | #4 [shared] reminders migration | Reminders | waiting: after #7, rename to **005** and resolve types.ts |
| 04:33 | #10 editor: ranked FTS search, uploads, move/copy | Editor | merged after a security re-review (actively attacked uploads; all held) |
| — | #11 collab invites | Collab | waiting on #7; decided: invite accept requires a matching email; signup auto-join respects expiry; PUBLIC_URL required in prod |

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
