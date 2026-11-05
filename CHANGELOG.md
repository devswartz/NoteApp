# Changelog

All notable changes, by release. Pull request numbers refer to github.com/devswartz/NoteApp.

## v0.1.0 (unreleased)

The first version for day-to-day use by the team: web, desktop and mobile.

### Foundation and security
- Working core flow on a clean base: per-area layout, token auth (short-lived access JWT + rotating refresh token, no cookies), configurable API URL, the `src/platform/` adapter for native shells, and the deploy contract (#2).
- Security follow-ups:
  - refresh-token replay detection;
  - JWT secret length check;
  - WebSocket query-string tokens;
  - socket expiry and live access re-validation (#12).
- File metadata follows page access (AUTHZ-1), and notebook/section colours are validated (#52).
- Security headers: strict CSP, HSTS, framing, and referrer and permissions policies (#51).
- Offline/PWA: precached app shell with an update prompt, offline cold start, and a read-only data cache for tasks (fixes BUG-1) (#35).

### Notes and editor
- Ranked full-text search across pages and tasks, workspace file uploads, and page/section move and copy (#10; migration #5).
- Editor:
  - callouts, toggles, highlighted code blocks, resizable images and file cards;
  - ⌘K links, block drag handles and convert-to-task;
  - a page header with save status, icon and move/copy (#21).
- Page links and backlinks: `[[` links to a page or creates one, and each page has a "Linked from" panel (#25).
- Page templates: meeting notes, project, daily journal, and "Start with a template" on empty pages (#27).

### Tasks and dashboard
- Validation fixes and tests, a week view for the calendar, and the task views split into modules (#9).
- Keyboard workflow on every task list (J/K, X, D, A, 1–4, R), all through the shortcut registry (#16).
- Bulk select with a bulk action bar and single-step undo (#16).
- Inline rename, a Status filter in All Tasks, and saved views (#16).
- A productivity strip on Today: done today, left, streak, last 7 days (#16).
- Subtasks, one level deep, with progress (migration 007) (#16).
- Fast with thousands of tasks: incremental rendering and deferred filtering (#16).

### Recurrence and reminders
- Rich recurrence (every N days/weeks on chosen days, monthly by date or "2nd Tuesday", yearly, until/count, after completion), with quick-add phrases (#4).
- Reminder scheduler with catch-up after restarts and no duplicate sends (#4).
- Delivery by web push, email, APNs and FCM, with snooze, quiet hours per workspace, a daily digest, a private .ics calendar feed, and notification settings in the app (#4).

### Collaboration and access
- `server/mail.ts` for outgoing email (#3), which never logs message bodies in production (#24).
- Email invites with accept links, a pending-invites list and a members panel (#11; migration #7).
- Private notebooks shared with chosen people, live access re-checks on open pages, a two-client co-editing test and a permission matrix (#14).
- Groundwork for comments, notifications and activity: migration 008, types and route stubs (#26).
- Comment threads on text selections: API with permissions, live events, the comment mark and a side panel (#28). The panel isn't in the page view yet.
- Groundwork for page version history: the `page_versions` migration (#31).
- 10-editor load test, and a fix so pages save while people keep typing (#38).

### UI shell and design system
- Design tokens; light, dark and system themes; reduced motion (#17).
- Central command and shortcut registry, which powers ⌘K, the `?` overlay and the desktop menu (#19).
- Shared UI primitives: Button, IconButton, Tooltip, Input, Tabs, Badge, EmptyState, Skeleton, Dialog (#20).
- Sectioned Settings page (#34).
- Sidebar context menus, favourites, recent pages, resizing and a drag-and-drop tree (#40).
- Entry points: "Share with people…" in the notebook menu, and notification settings in Settings (#56).

### Desktop app (macOS, Windows)
- Tauri 2 app wrapping the web build (#32):
  - configurable server with first-run setup;
  - keychain sign-in storage;
  - native menu wired to the command registry;
  - menu-bar/tray icon with today's count and the Dock badge;
  - global quick capture (⌥⌘N);
  - deep links, single instance, saved window state;
  - auto-update;
  - CI for signed and notarised builds.
- Notification clicks open their task. Hardening: window state, and quick capture when signed out or offline. A first signed build checklist (#47).

### Mobile app (iPhone, Android)
- Capacitor app (#30):
  - Keychain/Keystore sign-in storage;
  - APNs/FCM push reminders with snooze;
  - deep links, app badge and haptics;
  - mobile CI.
- Share to NoteApp (task or note), optional Face ID app lock, and a Today home-screen widget on iOS and Android (#36).

### Infrastructure and deploy
- CI, the Docker image, GHCR publishing and homelab deploy templates (#1). Publishing only after CI passes, with `JWT_SECRET` required (#8). Publishing from `main` by manual dispatch (#13).
- Deploy contract: `TRUST_PROXY_HEADER`, the port exposure rule, the token TTL, and APNs/FCM variables.

### Quality
- Playwright end-to-end suite covering all nine v1 priorities, plus `docs/QA.md` (#15; dependency #6).
- E2E tests for notes edge cases and live access changes (#22). Fix for BUG-2 (a demoted member could keep editing), re-checking edit rights on role changes (#41).
- E2E test for token refresh mid-session (#42).
- E2E tests for invite links, sharing with people and the command registry (#54).

### Docs
- `README.md`, `docs/USER_GUIDE.md` and this changelog.
