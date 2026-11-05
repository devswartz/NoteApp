# NoteApp — Project Plan

Status: **approved 2026-11-05**. Live progress is in `docs/STATUS.md`.

## 1. Product scope

A collaborative workspace that combines OneNote-style organisation (workspaces → notebooks → sections → pages), a Notion-style block editor, and Todoist / Microsoft To Do task management. **Tasks written inside any note are real tasks**: they show up in a central dashboard, stay linked to their source note, and are kept in sync everywhere they appear.

### Users
Me plus a small invited team (about 2–10 people). Invite-only, with no public sign-up, no billing and no multi-tenant scaling work.

### v1: what we'll use day to day
| Area | In v1 |
|---|---|
| Organisation | Workspaces, notebooks (private or shared), sections, pages; drag-and-drop reordering and moving; page icons |
| Editor | Headings, lists, checklists, tables, links, images, file attachments, code, quotes, dividers; slash menu; Markdown shortcuts; autosave |
| Search | Full-text search across pages and tasks, with a ⌘K command palette |
| Tasks | Inline tasks in notes, "convert to task" for existing lines, standalone tasks, assignee, due date and time, priority, completion; editable from the note or the dashboard |
| Dashboard | My Tasks, Today (including overdue), Upcoming, Team, All (filter and sort), Calendar, Completed |
| Recurrence and reminders | Recurring tasks (daily, weekdays, weekly on chosen days, monthly, yearly, every N); reminders by web push and email; mobile push in Phase 3 |
| Collaboration | Real-time co-editing with live cursors and presence; task changes pushed live to everyone; workspace roles (owner, admin, member, viewer); private vs shared notebooks; email invites |
| Offline | Notes cached locally (IndexedDB/Yjs) so they open offline and sync when back online; tasks read-only offline in v1 |

### Deferred (after v1)
Freeform canvas pages (the `kind: 'canvas'` page type is reserved for this), page version history UI, comments and @mentions, templates, Google/Apple calendar sync, AI features, public share links, page-level permissions (v1 permissions are per workspace and per notebook), and full offline editing of tasks.

## 2. Platforms

One React codebase, packaged three ways:

| Target | How | Why |
|---|---|---|
| **Web** (any browser, Android/Windows fallback) | Served from the homelab at `notes.devswartz.com`; installable as a PWA | Zero install; always the latest version |
| **macOS + Windows desktop** | **Tauri 2** shell around the web app | Real app: native menus, menu-bar icon, global quick-capture hotkey, native notifications, deep links (`noteapp://page/…`), auto-update; ~10 MB; uses Safari's engine on Mac |
| **iPhone + Android** | **Capacitor** shell around the web app | App Store/TestFlight app: real APNs/FCM push for reminders, share-sheet capture, Face ID unlock, haptics, a mobile-specific layout; a small native WidgetKit "Today" widget |

We chose not to build native SwiftUI. The editor and co-editing matter most, and those are strongest on the web (TipTap/ProseMirror + Yjs).

**Rules that keep the shells cheap to add:**
- Auth uses bearer tokens (access + refresh), not cookies tied to the browser, so the shells can store them in the system keychain.
- The API base URL is configurable (no assumption that the API lives at the same origin as the page).
- Platform features (notifications, file pickers, deep links, storage) go through a small `src/platform/` adapter with web, Tauri and Capacitor implementations. The rest of the app never calls `window.Notification` and similar APIs directly.
- The layout is responsive, with a distinct mobile layout rather than a squeezed desktop one.

## 3. Architecture

Kept from the existing foundation (`claude/initial-app`):

```
React 19 + Vite + TypeScript ── TipTap 3 editor ── Yjs (y-indexeddb offline cache)
          │  REST (JSON)            │  WebSocket (Yjs sync + awareness)   │  WebSocket/SSE (live task + tree events)
          ▼                         ▼                                      ▼
Node + Express 5 ─────────── collab server (per-page Y.Doc rooms, permission-checked)
          │
SQLite (WAL) ── pages (Yjs state + extracted text for search) · tasks · users · workspaces · invites
Attachments on disk (/data/files), served with permission checks
Reminder worker (in-process scheduler) → Web Push / email (SMTP) / APNs+FCM (Phase 3)
```

**Decisions**
- **Database: stay on SQLite for v1.** It is plenty for about 10 users on one server, is trivially backed up, and needs no extra service. All SQL stays inside `server/db*.ts` / repository modules, so moving to Postgres later is contained. We'll revisit if we ever need more than one server process.
- **Collaboration:** keep the custom y-websocket-protocol server already built. It checks permissions on every connection and its persistence hooks extract task references. Hocuspocus is the fallback if it gets hard to maintain.
- **Embedded tasks — single source of truth:** the task row in the `tasks` table is authoritative. A note contains only a `taskRef` node holding the `taskId`, and the editor renders the live task from the client store. When a page is saved, the server reconciles which tasks the page references (sets or clears each task's `source_page_id`). This avoids two copies of a task drifting apart.
- **Search:** SQLite FTS5 over extracted page text and task titles.
- **Auth:** email + password (bcrypt), short-lived JWT access token plus a rotating refresh token, invite-only sign-up. Passkeys are a later option.
- **Real-time task/tree updates:** one event channel per workspace. Every client applies changes from it, so the dashboard and open notes update together.

## 4. Hosting (homelab)

- **Where:** a dedicated Proxmox LXC running Docker Compose with `app` (Node: API, collab server, static web build, reminder worker) and `backup` (Litestream or a nightly SQLite `.backup` plus a file-sync job).
- **Ingress:** Cloudflare Tunnel → `notes.devswartz.com` (production) and `notes-staging.devswartz.com` (staging). WebSockets go through the tunnel. The app port is never exposed to the internet directly. Cloudflare Access stays **off** for these hostnames, because the mobile and desktop apps must reach the API directly; the app does its own auth.
- **Environments:** `staging` deploys automatically from `main`; `prod` deploys from tagged releases.
- **Backups:** continuous SQLite replication with Litestream, or a nightly snapshot, plus the attachments directory, copied off the box. Restore is tested once before launch.
- **Email:** an SMTP provider for invites and reminder emails (to be decided — see §8).
- **CI:** GitHub Actions on every PR: typecheck, unit tests, build, Playwright smoke test.

## 5. Milestones

| Phase | Goal | Exit criteria |
|---|---|---|
| **0 — Foundation** | Make the existing work-in-progress a clean base on `main` | Builds, runs, seeds demo data; CI green; `ARCHITECTURE.md` + conventions written; token auth and the `src/platform/` adapter in place |
| **1 — Core v1 (web)** | Every v1 feature in §1 working on the web | Every dashboard view works; tasks stay in sync between notes and the dashboard in two browsers at once; co-editing with cursors; reminders arrive by web push and email; search works; deployed to staging |
| **2 — Desktop** | Tauri app for Mac (signed and notarised) and Windows | Installable app with menu bar, quick-capture hotkey, native notifications, deep links, auto-update |
| **3 — Mobile** | Capacitor app for iPhone (TestFlight) and Android (APK / Play internal testing) | Mobile layout, APNs/FCM reminders, share-sheet capture, Today widget |
| **4 — Hardening** | Daily use by the team | Backups verified, error monitoring, performance pass, prod launch |

## 6. Agent organisation

A **manager session** coordinates and reviews; it doesn't write feature code. Up to 10 worker sessions, each **owning a set of paths** so their branches rarely conflict.

| # | Agent | Owns | Phase |
|---|---|---|---|
| 1 | **Foundation** (the existing builder session) | Repo layout, `server/db*`, `server/auth*`, `shared/types.ts`, the `src/platform/` adapter, conventions; afterwards owns the API client, offline/PWA and fixes when merges break `main` | 0, then 1 |
| 2 | **Editor & Notes** | `src/editor/**`, page view, page tree drag-and-drop, attachments/images (`server/files*`), search (FTS) | 1 |
| 3 | **Tasks & Dashboard** | `server/tasks*`, `shared/quickadd.ts`, `src/pages/Tasks*`, calendar, filters, task detail panel | 1 |
| 4 | **Collaboration & Access** | `server/collab*`, `server/access*`, `server/events*`, presence/cursors, sharing UI, invites, roles | 1 |
| 5 | **Recurrence & Reminders** | `shared/recurrence*`, `server/reminders/**`, notification delivery (web push, email), notification settings | 1 |
| 6 | **UI Shell & Design System** | `src/styles*`, `src/components/{AppShell,Sidebar,CommandPalette,Overlays}*`, keyboard shortcuts, the mobile layout | 1 |
| 7 | **Infra & Deploy** | `deploy/**`, `Dockerfile`, `.github/workflows/**`, backup scripts, staging setup notes | 0–1 |
| 8 | **QA / E2E** | `tests/e2e/**` (Playwright); writes multi-user sync tests, reports bugs to the owning agent | 1–4 |
| 9 | **Desktop (Tauri)** | `apps/desktop/**`, Tauri implementation of the platform adapter | 2 |
| 10 | **Mobile (Capacitor)** | `apps/mobile/**`, Capacitor implementation of the platform adapter, the native widget | 3 |

Phase 1 runs agents 1–8 in parallel (8 sessions). Agents 9 and 10 start once Phase 1 has stabilised, reusing session slots as Phase 1 agents finish.

**Working rules**
- `main` is the integration branch. Each agent works on `feat/<area>` and opens PRs into `main`. Keep PRs small and frequent; rebase on `main` daily.
- Change only paths you own. If you need a change in shared code (`shared/types.ts`, the DB schema, `App.tsx` routes), make a small, separate PR for it and say so in its description. The manager merges those first.
- DB schema changes are new migrations only; never edit an existing one.
- Every PR has passing CI and a short "what changed / how I tested it" note.
- The manager reviews and merges PRs once CI is green.
- Each agent keeps a short status section in its PR description, so the manager can track progress without reading transcripts.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Tasks drift between notes and the dashboard | One authoritative task row; notes hold only references; an E2E test with two browsers |
| Yjs documents grow without limit | Periodic snapshot compaction on save |
| Reminders missed while the server is down | Store `next_fire_at`; on startup, catch up on reminders that came due in the last N hours |
| iOS limits on web push | Mobile push goes through Capacitor + APNs in Phase 3; web push is a fallback |
| Merge conflicts across 8 parallel agents | Path ownership, a shared-change PR lane run by agent 1, daily rebases |
| Homelab outage | Offline cache for reading notes; backups copied off the box; documented restore |

## 8. Decisions (settled 2026-11-05)
1. Domain: `notes.devswartz.com` (prod), `notes-staging.devswartz.com` (staging).
2. Email: AWS SES via SMTP.
3. Apple Developer account: available (Phase 2/3).
4. Name: "NoteApp" for now; it will be renamed, so keep the name in one config constant.
5. Homelab: set up by a separate homelab agent from `docs/HOMELAB_BRIEF.md`, against `docs/DEPLOY_CONTRACT.md`. Deploys are pull-based (GHCR).
6. The manager merges PRs after review + green CI. About 4–5 worker sessions at a time.
