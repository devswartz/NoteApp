# Changelog

All notable changes, by release. Pull request numbers refer to github.com/devswartz/NoteApp.

## v0.1.0 (unreleased)

The first version for day-to-day use by the team: web, desktop and mobile.

### Renamed to Notivelo
- The product is now **Notivelo** everywhere users see it (`APP_NAME` in `shared/config.ts`). Desktop: product name, identifier `com.devswartz.notivelo` and `notivelo://` links. Mobile: app id and bundle IDs `com.devswartz.notivelo` (plus `.ShareExtension` and `.TodayWidget`), app group and URL scheme. The AASA and `assetlinks.json` defaults follow.
- Deliberately not renamed: the repo, the Docker image, `/data/noteapp.db`, the systemd units, and the `noteapp.*` browser storage keys (so nobody loses local data).

### Privacy Policy and Terms
- Public `/privacy` and `/terms` pages, linked from the sign-in screen, the sign-up form and Settings → About. The text is plain Markdown in `legal/privacy.md` and `legal/terms.md` (bundled at build time; edit the files, no code change). Contact email and operator default to support@devswartz.com and devswartz.com; `LEGAL_CONTACT_EMAIL` and `LEGAL_OPERATOR_NAME` override them on the server.

### Email verification (for open sign-up)
- New accounts must confirm their email before using the app when the server can send mail: a single-use, 24-hour link ("Confirm your email for Notivelo"), resend limited to one a minute and five an hour, and a **Check your email** screen until confirmed. This is what makes `SIGNUP_MODE=open` safe to switch on; production still defaults to `invite`. See `docs/LAUNCH_CHECKLIST.md` section 5b.
- Pending workspace invites for an address are applied when its email is confirmed, not at sign-up. Existing accounts (migration 012), bootstrap accounts (the first account and `ADMIN_EMAILS`) and every account on a server without SMTP are treated as confirmed.
- Unverified users get `403 email_unverified` on every API route except `GET /me` and resend, and their WebSockets are refused (4403).

- A successful password reset also confirms the email (the link proves the mailbox): pending invites are accepted and the old confirmation link stops working.
- Accounts still unconfirmed after 7 days (`UNVERIFIED_ACCOUNT_DAYS`, default 7, minimum 1) are deleted by the 6-hourly housekeeping through the same code as Delete account, in batches of at most 100, never for `ADMIN_EMAILS` addresses, with no email sent.

### Delete account
- Settings → Profile → **Delete account**, with the password re-entered in a confirm dialog. It shows which workspaces will be handed over, deleted or left. The server (`DELETE /auth/account`, `deleteAccount()` in `server/accounts.ts`) deletes sessions, devices, notifications, reminders, private notebooks and private tasks with their files on disk, hands owned workspaces to another owner or the longest-standing admin (or deletes them when there is neither), and removes the user from the rest. Shared content stays, authored by "Deleted user". Live sockets are closed, other members' lists update live, and no email is sent. The per-table decisions are in `ARCHITECTURE.md` ("Account deletion").

### Send feedback
- **Send feedback** in the command palette (⌘K) and in the `?` shortcuts overlay / Settings → Keyboard shortcuts: a small dialog (up to 4000 characters, draft kept if sending fails). `POST /api/feedback` (verified users, 5 per hour per user plus a server-wide cap) emails every `ADMIN_EMAILS` address with the message, the sender's name, email and id, app and server versions, the in-app path (no query or hash), platform and a timestamp; Reply-To is the sender. With no SMTP or no admins it still answers success (`delivered: false`) and logs one `"event":"feedback"` JSON line. No new table.

### Foundation and security
- Working core flow on a clean base: per-area layout, token auth (short-lived access JWT + rotating refresh token, no cookies), configurable API URL, the `src/platform/` adapter for native shells, and the deploy contract (#2).
- Security follow-ups:
  - refresh-token replay detection;
  - JWT secret length check;
  - WebSocket query-string tokens;
  - socket expiry and live access re-validation (#12).
- File metadata follows page access (AUTHZ-1), and notebook/section colours are validated (#52).
- Security headers: strict CSP, HSTS, framing, and referrer and permissions policies (#51).
- Password reset by email, change password, and an avatar colour. Auth hardening: constant-time checks, async bcrypt, and the 72-byte password limit (#61).
- Error handling, request IDs, structured JSON logs and admin stats (`ADMIN_EMAILS`), and **invite-only sign-up in production** (`SIGNUP_MODE`) (#67).
- Client error reporting: the app reports uncaught errors, unhandled rejections and React render errors to `POST /api/client-errors`, which is rate limited, size capped and only writes a structured `client_error` warn log line (nothing is stored). Throttled and de-duplicated on the client; query strings are never sent or logged.
- Offline/PWA: precached app shell with an update prompt, offline cold start, and a read-only data cache for tasks (fixes BUG-1) (#35).

### Notes and editor
- Ranked full-text search across pages and tasks, workspace file uploads, and page/section move and copy (#10; migration #5).
- Editor:
  - callouts, toggles, highlighted code blocks, resizable images and file cards;
  - ⌘K links, block drag handles and convert-to-task;
  - a page header with save status, icon and move/copy (#21).
- Page links and backlinks: `[[` links to a page or creates one, and each page has a "Linked from" panel (#25).
- Page version history: automatic snapshots, preview and restore (#37).
- Page templates: meeting notes, project, daily journal, and "Start with a template" on empty pages (#27).
- User templates: **Save as template…** in the page menu; workspace templates are listed under the built-ins with rename and delete. Using one creates new tasks and copies attachments (migration 011). Templates saved from a private notebook are visible only to their creator.
- `SEED_DEMO` showcase: a *Demo Team* workspace with a notebook per area, every block type, tasks with subtasks and recurrence, links, comments, versions and a private notebook (#70).

### Tasks and dashboard
- Validation fixes and tests, a week view for the calendar, and the task views split into modules (#9).
- Keyboard workflow on every task list (J/K, X, D, A, 1–4, R), all through the shortcut registry (#16).
- Bulk select with a bulk action bar and single-step undo (#16).
- Inline rename, a Status filter in All Tasks, and saved views (#16).
- A productivity strip on Today: done today, left, streak, last 7 days (#16).
- Subtasks, one level deep, with progress (migration 007) (#16).
- Tasks stay private when they leave a private notebook (migration 010) (#63).
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
- Comment threads on text selections: API with permissions, live events, the comment mark and a side panel (#28). 
- Groundwork for page version history: the `page_versions` migration (#31).
- Rate limiting on auth endpoints, per IP and per account, with 429 + Retry-After (#43).
- Reliable live events: sequence numbers with catch-up replay and resync, plus `GET /workspaces/:id/team` (#18).
- Comments hook-up on the collaboration side (#55); mounting the panel in the page view is pending in the editor.
- Comments in the editor and page view: select text to start a thread, then reply, resolve or reopen (#62).
- Notification inbox and @mentions (#29): mentions work in comments; the inbox bell isn't in the app shell yet.
- Files on deleted pages become private to their uploader (#59).
- 10-editor load test, and a fix so pages save while people keep typing (#38).

### UI shell and design system
- Design tokens; light, dark and system themes; reduced motion (#17).
- Central command and shortcut registry, which powers ⌘K, the `?` overlay and the desktop menu (#19).
- Shared UI primitives: Button, IconButton, Tooltip, Input, Tabs, Badge, EmptyState, Skeleton, Dialog (#20).
- Sectioned Settings page (#34).
- Sidebar context menus, favourites, recent pages, resizing and a drag-and-drop tree (#40).
- Entry points: "Share with people…" in the notebook menu, and notification settings in Settings (#56).
- "New notebook" with starting templates: Personal, Team project, Meetings, Studies (#71).

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
- Share to Notivelo (task or note), optional Face ID app lock, and a Today home-screen widget on iOS and Android (#36).
- Mobile visual QA: large-title top bar, and no floating add button on pages (#69).
- APNs to both sandbox and production builds, `/.well-known` app-link files, Android snooze actions, and a server picker on first launch (runtime server URL) (#57).

### Infrastructure and deploy
- CI, the Docker image, GHCR publishing and homelab deploy templates (#1). Publishing only after CI passes, with `JWT_SECRET` required (#8). Publishing from `main` by manual dispatch (#13).
- Deploy contract: `TRUST_PROXY_HEADER`, the port exposure rule, the token TTL, and APNs/FCM variables.

### Quality
- Playwright end-to-end suite covering all nine v1 priorities, plus `docs/QA.md` (#15; dependency #6).
- E2E tests for notes edge cases and live access changes (#22). Fix for BUG-2 (a demoted member could keep editing), re-checking edit rights on role changes (#41).
- E2E test for token refresh mid-session (#42).
- E2E tests for invite links, sharing with people and the command registry (#54).
- Remaining E2E fixmes enabled, with page-link and callout/toggle tests; BUG-1 fixed, BUG-3 found (#64).
- Fix BUG-3: a page title typed just before navigating away is saved (#66).

### Docs
- `README.md`, `docs/USER_GUIDE.md` and this changelog.
