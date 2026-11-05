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
- The user asked the manager to work independently for 12 hours (until about 2026-11-05 15:30 UTC) and to document as it goes.

## Session roster
| Agent | Session ID | Branch | Owns | State |
|---|---|---|---|---|
| Manager | session_019dirnRG6rqRQKiaYoYvd2H | claude/practical-albattani-3z93fy | coordination, docs/STATUS.md | active |
| Original builder | session_019dirnQSpFWbj8dPFQkoUjf | claude/initial-app | wrote the initial work-in-progress (now the base of `main`) | paused/idle; not used further (its session is tied to pushing `master`) |

## PR / merge log
| When (UTC) | PR | Area | Result |
|---|---|---|---|

## Log
- **2026-11-05 03:00** Found the builder session mid-build; paused it; planned with the user; wrote `PLAN.md`.
- **2026-11-05 ~03:45** Plan approved. Wrote the deploy contract, homelab brief, agent guide and this log. Created `main` from `claude/initial-app` + docs. Next: start Phase 0 (Foundation + Infra).
