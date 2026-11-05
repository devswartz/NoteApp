# Architecture

How NoteApp is built today. Read `PLAN.md` for what we're building and `docs/AGENT_GUIDE.md` for how we work. Keep this file accurate: if you change something described here, update it in the same PR.

> **Moving parts.** Phase 0 is still restructuring the repo. PR 2 splits `server/routes.ts` and the DB migrations into per-area files, PR 3 adds the deploy contract (`DATA_DIR`, `/api/health`), PR 4 adds bearer access/refresh tokens and `src/platform/`. This file is updated with each of them.

## Stack

| Layer | Choice |
|---|---|
| Web client | React 19, Vite 8, TypeScript, React Router 7, Zustand 5, lucide-react icons, hand-written CSS (`src/styles.css`) |
| Editor | TipTap 3 (ProseMirror) with a custom `taskRef` node, bound to a Yjs doc with `@tiptap/extension-collaboration` |
| Real-time | Yjs over a custom y-websocket-protocol server (`server/collab.ts`); y-indexeddb for the local cache |
| Server | Node 22, Express 5, `ws`, run directly from TypeScript with `tsx` (no compile step) |
| Database | SQLite through `better-sqlite3` (synchronous), WAL mode, FTS5 for page search |
| Auth | Email + password (bcrypt), JWT in `Authorization: Bearer …` |
| Tests | `node:test` run through `tsx` (`npm test`), against an in-memory SQLite DB |

## Running it

```bash
npm ci
npm run dev        # API on :3001 (tsx watch) + Vite on :5173 (proxies /api, /uploads, /collab to :3001)
# open http://localhost:5173 and create an account

npm run typecheck  # tsc -b over src, server, shared, tests
npm test           # node --test tests/*.test.ts
npm run build      # typecheck + vite build → dist/
npm start          # production: one Node process serves the API, WebSockets and dist/ on PORT (default 3001)
```

Environment variables used today: `PORT` (3001), `DB_FILE` (default `data/noteapp.db`; `:memory:` for tests), `UPLOAD_DIR` (default `data/uploads`), `JWT_SECRET` (if unset, a random secret is generated once and stored in `data/.jwt-secret`). In dev the Vite proxy target can be changed with `API_URL`. PR 3 replaces these paths with `DATA_DIR` as in `docs/DEPLOY_CONTRACT.md`.

## Folder layout

```
server/          Node API + collaboration server
  index.ts       HTTP server: mounts /api, /uploads, static dist/, routes WebSocket upgrades to collab
  routes.ts      All REST routes (auth, workspaces, members, tree, pages, tasks, search, uploads) — split in PR 2
  db.ts          SQLite connection + schema migrations (tracked in PRAGMA user_version)
  auth.ts        JWT signing/verification, requireAuth middleware
  access.ts      All permission checks (workspace roles, private notebooks, task visibility SQL)
  tasks.ts       Task persistence and rules: create/update/complete/recur, syncPageTasks (note ↔ task reconcile)
  collab.ts      Yjs WebSocket rooms per page, persistence, text + taskRef extraction
  events.ts      Live event hub (server-sent events) for task/tree/member changes
  seed.ts        Onboarding content for a new user's personal workspace
shared/          Code used by both server and client
  types.ts       API and event types (the contract between client and server)
  dates.ts       Local-date helpers and recurrence (nextOccurrence)
  quickadd.ts    Natural-language task parsing ("Pay rent tomorrow p1 @sam every month")
src/             React web app
  main.tsx       Entry; registers the service worker in production
  App.tsx        Route table
  api.ts         fetch wrapper (adds the bearer token, JSON, error handling), upload helper
  store.ts       Zustand store: session, workspaces, tree, tasks, members, UI state, live-event client
  components/    App shell, sidebar, command palette, quick add, task row/detail/controls, overlays, ui primitives
  editor/        NoteEditor (TipTap + Yjs providers), TaskRef node, SlashMenu
  pages/         Route screens: Login, PageView, TasksView (all dashboard views), NotesHome, Settings
  lib/           Formatting and task-view filtering/sorting
public/          manifest.webmanifest, sw.js (offline shell), icon.svg
tests/           node:test suites (shared logic, server routes)
docs/            Plan-adjacent docs: agent guide, deploy contract, homelab brief, status log
```

## Data model

```
users
workspaces ──< workspace_members (role: owner | admin | member | viewer) >── users
          ──< workspace_invites (email, role; applied when that email signs up)
          ──< notebooks (visibility: shared | private; private = only its creator sees it)
                 ──< sections
                        ──< pages (ydoc BLOB = Yjs state, text = extracted plain text, kind = 'document' | 'canvas')
          ──< tasks (page_id → pages, nullable)
pages_fts (FTS5: page_id, title, text)
```

- **Hierarchy:** workspace → notebook → section → page. Ordering uses a `position REAL` column per level (insert between two items by averaging).
- **Permissions** live in `server/access.ts`. Workspace roles: viewers read, members and up edit, admins manage members, owners manage everything. A private notebook (and its pages and tasks) is visible only to its creator, except that a task's assignee and creator can always see it (`TASK_VISIBLE`).
- **Tasks are the single source of truth.** A page never stores task fields. The page document contains `taskRef` nodes holding only a `taskId`; the editor renders each one from the client task store (`src/editor/TaskRef.tsx`). So a task edited on the dashboard updates every note it appears in, and the reverse.
  - Clients create a task with a client-chosen UUID first (`POST /workspaces/:id/tasks` with `id`), then insert the `taskRef` node, so the node never points at a missing row. Retrying with the same id is idempotent.
  - `tasks.page_id` is the task's source note (the plan calls it `source_page_id`; the column is `page_id`). It is set and cleared by the server, not trusted from the document.
  - **Reconcile on save:** when the collab server persists a page (debounced 1 s after the last edit, and when the last client leaves), it walks the Yjs XML tree (`extractDoc`) to get the plain text and the set of `taskRef` ids, then `syncPageTasks(pageId, workspaceId, ids)`:
    - tasks in the set get `page_id = this page` (e.g. moved or pasted from another note);
    - tasks that had `page_id = this page` but are no longer in the doc become standalone (`page_id = NULL`). They are never deleted silently.
    - Each changed task is broadcast as a `task` event.
  - Deleting a page, section or notebook detaches its tasks (they become standalone) rather than deleting them.
  - Recurring tasks: completing one inserts a completed copy (`occurrence_of` = original) for history and rolls the original forward to the next due date (`shared/dates.ts → nextOccurrence`), shifting `reminder_at` by the same offset.

## Real-time sync

There are two channels:

1. **Collaborative editing — WebSocket `/collab/<pageId>?token=<jwt>`** (`server/collab.ts`). The client uses `y-websocket`'s `WebsocketProvider` (`src/editor/NoteEditor.tsx`). The server speaks the y-websocket protocol (sync step 1/2 + updates, and awareness for cursors and presence). There is one in-memory room (`Y.Doc` + awareness) per open page. Permission is checked when the socket connects; viewers may send sync step 1 but their updates are dropped. Rooms persist to `pages.ydoc` (debounced), update FTS, reconcile tasks and emit a `tree` event. `closeRoom(pageId)` kicks everyone (code 4403) when a page is deleted or its access changes; the client stops reconnecting on 4401/4403. On SIGINT/SIGTERM `flushAll()` saves pending rooms. Each page is also cached locally with `y-indexeddb` (`noteapp-page-<id>`), so it opens offline and merges when the socket reconnects.

2. **Live events — `GET /api/events?token=<jwt>`** (`server/events.ts`), currently **server-sent events** (EventSource can't set headers, hence the query token). The server pushes `ServerEvent`s (`shared/types.ts`): `task`, `task-deleted`, `tree`, `members`, `workspaces`. Events are filtered per user: a task event goes only to members who can see the task; members who can't get `task-deleted` instead. The client (`connectEvents` in `src/store.ts`) upserts tasks (ignoring stale echoes by `updatedAt`), and refetches the tree/members (debounced) on `tree`/`members`. After a reconnect it refetches the tree and tasks to cover anything missed.

   `docs/DEPLOY_CONTRACT.md` lists `/api/events` under WebSockets. The path and port match; the transport is SSE today. PR 3 settles this (switch to WebSocket, or amend the contract).

Client-side task writes are optimistic with rollback (`createTask`, `updateTask`, `deleteTask` in `src/store.ts`); the server response and the event echo then replace the optimistic copy.

## API surface (today)

All under `/api`, JSON, bearer token except where noted:

- `POST /auth/register`, `POST /auth/login` → `{ token, user }` (no auth)
- `GET/PATCH /me`, `GET /events` (SSE)
- `GET/POST /workspaces`, `PATCH/DELETE /workspaces/:id`, members: `GET/POST /workspaces/:id/members`, `PATCH/DELETE /workspaces/:id/members/:userId`, `DELETE /workspaces/:id/invites/:email`
- Tree: `GET /workspaces/:id/tree`, `POST /workspaces/:id/notebooks`, `PATCH/DELETE /notebooks/:id`, `POST /notebooks/:id/sections`, `PATCH/DELETE /sections/:id`, `POST /sections/:id/pages`, `GET/PATCH/DELETE /pages/:id`
- Tasks: `GET /workspaces/:id/tasks` (open + completed in the last 30 days), `GET /workspaces/:id/tasks/completed?before=`, `POST /workspaces/:id/tasks`, `PATCH/DELETE /tasks/:id`
- `GET /workspaces/:id/search?q=` (FTS5 over pages, LIKE over tasks)
- `POST /uploads` (raw body, `X-Filename` header) → files served unauthenticated at `/uploads/<random name>`

## Status against `PLAN.md` §1

**Done** = works end to end in the web app today. **Stubbed** = partly there. **Not started** = nothing yet.

| Area | Done | Stubbed / partial | Not started |
|---|---|---|---|
| Organisation | Workspaces, notebooks (shared/private), sections, pages; drag-and-drop reordering/moving in the sidebar | Page icons: `pages.icon` column and `PATCH /pages/:id {icon}` exist, no picker UI | |
| Editor | Headings, bullet/numbered lists, checklists, tables, links, images, file attachments (as links), code blocks, quotes, dividers; slash menu; Markdown shortcuts; autosave via Yjs | | |
| Search | FTS5 page search + task search; ⌘K command palette | | |
| Tasks | Inline tasks (`[] `), convert line to task (⌘↵ / bubble menu), standalone tasks, quick add with natural language, assignee, due date + time, priority, completion; editable from note or dashboard | | |
| Dashboard | My Tasks, Today (incl. overdue), Upcoming, Team, All (filter/sort), Calendar, Completed | | |
| Recurrence & reminders | Recurrence: daily / weekdays / weekly / monthly / yearly / every N | Reminders fire only in an open tab (`AppShell.tsx`, browser Notification or toast); "weekly on chosen days" not supported by the `Recurrence` type | Server reminder worker, web push, email |
| Collaboration | Real-time co-editing with live cursors and presence; task changes pushed live; roles (owner/admin/member/viewer); private vs shared notebooks | Invites: pending invite applied when that email signs up, but no email is sent | Email invites |
| Offline | Notes cached in IndexedDB (y-indexeddb), sync on reconnect; service worker caches the app shell; offline indicator | Tasks offline: whatever is in memory; nothing persisted | Persisted read-only task cache |
| Platform (§2) | | Bearer token auth (single 30-day JWT in localStorage) | Refresh tokens, configurable API base URL, `src/platform/` adapter (PR 4) |
| Deploy (§4) | | `npm start` serves API + WebSockets + `dist/` on one port | `DATA_DIR`, `/api/health`, `SEED_DEMO` (PR 3); Docker/CI (Infra agent) |

Known rough edges: the app's display name is "Noteworthy" in `index.html`, the manifest, the service worker cache name and the login screen, but "NoteApp" in the plan. PR 3 moves it into one config constant. Uploaded files are served without auth (unguessable names), and the main JS bundle is about 1 MB (no code splitting yet).
