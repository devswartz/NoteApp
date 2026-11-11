# Changelog

All notable changes, by release. Pull request numbers refer to github.com/devswartz/NoteApp.

## Unreleased

### New
- **Printing:** Ctrl/Cmd+P, **Print** in the ribbon's Page group and "Print / save as PDF" in the page menu print the open page laid out for paper: title with notebook › section and date on top, boxes in reading order (boxes side by side on the canvas print as columns when they fit, otherwise one under the other), text reflowed to the paper width so nothing is clipped, page numbers in the footer, good page breaks (not inside tasks, table rows, images, callouts or code), A4 and Letter. Tasks print as a compact checkbox line with due date, assignee and priority (done ones struck through); dark-mode colours print in their light versions; links show their address in small print; code wraps. Page colour prints only with "Print page colour" (page menu); rule lines never. **Print section** in a section's menu prints all its pages and subsections in tree order, each on a new sheet. Every platform opens its native print dialog (with Save as PDF): macOS and iOS print through WebKit's print operation, Android through PrintManager.
- **Contextual ribbon:** the ribbon now stays in every section with controls for it. Tasks: New task, Show (Today, Upcoming, My Tasks, All, Completed), Organise (Group, Sort, Show completed), Filter (Assignee, Tags, Team, Priority, More filters, Clear) and Views (Saved views, Save view); controls that don't apply to a view are disabled with a tooltip saying why, and active filters highlight their button with a count (All Tasks also lists them next to the task count). Calendar: New task, Today ◀ ▶, Week / Month, and Mine / Everyone, Tags and Team filters. Notes overview: New page, New section, New notebook and Import (OneNote, Markdown). Settings: Back to notes. Collapsing it is remembered across sections. On desktop the matching in-page controls (filter chips, sort/group selects, saved-view tabs, calendar switches) are gone; phones keep them.
- **Pages and task views are left-aligned and full width, like OneNote:** a page's title and boxes start just inside the left edge of the note area instead of in a centred column, and its main box runs to the right edge, following window and panel resizes (a box you've resized keeps its width). The "Full width" page setting is gone (it's always on); the outline is a strip in the right margin. Today, Upcoming, My Tasks, All Tasks, Completed, Calendar and the Notes overview use the same left-aligned, full-width layout. Phones are unchanged.
- **Ribbon, full width:** the ribbon now runs across the whole window at the very top, above the rail, the panels and the note, like OneNote. It's taller with larger buttons, text labels on key buttons and group names (Text, Lists, Insert, Page, View). New: Quote and Code styles, Clear formatting, File, Page link and Divider, and an Outline toggle. **To Do** replaces Checklist and Task: it makes a checkbox item, and its arrow (or Ctrl+Enter) makes it a tracked task. It's live as soon as a page opens (acting on the first box, even with the caret in the title); Tasks, Calendar and Settings show a quiet strip instead. A chevron or Ctrl+F1 collapses it to a strip with "Show ribbon" (remembered on this device). F6 reaches it first from the note. Narrow windows compact it to one row. The floating toolbar uses the same colour controls and icons.
- **OneNote shortcuts:** Ctrl+1 To Do checkbox, Ctrl+. bullets, Ctrl+Alt+1/2/3 headings; shown in the ribbon's tooltips.
- **Page colour and rule lines:** give a page a soft background colour (yellow, green, blue, purple, pink or grey; light and gentler dark variants) and faint rule lines or a grid across the page behind its boxes (not through tables or the box you're typing in), from the ribbon's Page group. Saved with the page, synced live to everyone, kept in templates, exports and version restores.
- **Ribbon:** the formatting toolbar is now a OneNote-style ribbon fixed across the top of the note area (text style, basic text, lists, insert, undo/redo). It stays put while the page scrolls, acts on the box you were last in on a canvas, shows its controls greyed out when there's nothing to edit, and is its own F6 stop with arrow keys between buttons. Phones keep the floating toolbar.
- **Ribbon:** each group has a small label underneath (Text, Basic text, Lists, Insert, History), dropped on narrower windows. The floating toolbar over a selection now always shows above the ribbon, flipping below the selection when it's right under the ribbon, including in canvas boxes near the top.
- **Canvas pages:** click anywhere on a page and type. Each text box is a full editor (headings, lists, tasks, tables, images); drag its top edge to move it and its right edge to set its width. Boxes can sit side by side or overlap, and collaborators see them appear and move live. Search, tasks, mentions, links and exports see every box. (#134, #137)
- **Every page is a canvas, like OneNote.** Open a blank page and just start typing: the first text box is ready at the top left, as wide as the old document column (the whole page with "Full width"), and is only saved once you type. Click anywhere else to start another box. Existing pages are converted automatically when the server updates: each becomes a canvas with one wide box holding its content, looking as it did, and the page as it was is kept in Version history. Document pages, "New document page" and the convert menu items are gone.
- A text box stays opaque while its floating formatting toolbar has keyboard focus.
- The "On this page" outline lists the headings of every box in reading order and jumps into the right box; task links (`?task=`) find tasks in any box. On phones a page with one box is simply one full-width editor.
- **Templates on canvases:** the built-in templates (meeting notes, project, daily journal) come laid out as boxes on a canvas, and notebook templates make canvas pages. A template saved from a document page before this release fills one wide box.
- **Undo on canvases:** Ctrl+Z outside a text box undoes creating, moving, resizing or deleting a box.
- **Canvas pages on phones** show the boxes one under the other in reading order, full width, with "Add a text box" at the end.
- Save as template, Version history (preview and restore the whole canvas), Markdown export and Markdown import (into a new box) now work on canvas pages.
- **OneNote import keeps box positions:** pages made in OneNote come in as canvases with each box where it was; pages without positions become one wide box. (#135)

### Fixes
- Desktop: checks for updates every time the app opens (was at most once a day).

## v0.2.1

### Fixes
- More room for notes: the Notes panels are narrower by default, the pages list folds into the sections tree on windows under 1400px wide, and hiding the panels (rail button or Ctrl+\) is remembered. (#133)
- Long task titles in notes wrap onto more lines instead of being cut off. (#133)

## v0.2.0

The first round of tester feedback.

### New
- **Navigation:** a slim rail on the left switches between Notes, Tasks and Calendar, each with its own panel. Notes has a notebook picker, the section tree and a separate pages list (folded into one on narrow windows and phones). On phones the tab bar is Notes / Tasks / Calendar / Search; Today and My Tasks are in the menu. (#131)
- **Subsections:** sections can nest up to three levels. Create one from a section's menu, drag sections in and out, and OneNote section groups now import as subsections. (#129)
- **Templates per section:** when saving a template you can tick the sections it belongs to; empty pages there offer it first. (#129)
- **Tags, teams and assignments:** tasks can carry tags and a team, and show who assigned them. Manage teams and tags in Settings. (#130)
- **Filters and saved views:** filter chips on All Tasks (tag, team, assignee, section and more), and saved views are now stored on the server, optionally shared with the whole workspace. (#130)
- **Editor toolbar:** a fixed formatting toolbar on desktop, text and highlight colours, and a quick button to turn a line into a task. (#128)

### Fixes
- Desktop quick capture lists workspace members correctly again. (#130)

## v0.1.5

### Fixes
- Settings on phones: the workspace name field no longer slides under the Rename button, Export and Import stay inside their card, buttons line up with the fields beside them, and the invite email field has its icon inside it. (#126)

## v0.1.4

What's new for testers since v0.1.3.

### Settings and menus
- Settings shows one section at a time, picked from the side list, each with a short description. Profile is now one card, with Save and Change password at the bottom right of their cards. (#125)
- Menus and popovers have more even padding, full-width separators, and a red highlight on Delete-type items. (#125)

### Fixes
- Desktop (Windows): reopening the app after closing its window could freeze it, and the quick-capture window could freeze on first open. (#124)
- Import from OneNote: a Microsoft account without OneNote now shows "no notebooks" instead of an error. (#122)

## v0.1.3

What's new for testers since v0.1.2.

### Share a single page
- Share one page with chosen people from the page's **Share** button, **Can view** or **Can edit**, even when it lives in a private notebook. They see only that page, under **Shared with me** in the sidebar, and can edit it live with you.
- Owners and admins can also share with someone outside the workspace by email. They always get view-only access.
- Stopping a share takes effect immediately, even if the person has the page open. Making a notebook private ends page shares inside it that someone else created.

### Import from OneNote
- Settings → Import → **Import from OneNote**: sign in with Microsoft, pick notebooks, and they're imported with their sections, pages, images, attachments and to-dos (as real tasks). Freeform layout becomes a normal page, ink may be skipped, and password-protected sections can't be read. (#117)

### Notes and editor
- The **Tasks on this page** panel no longer opens by itself. The page toolbar shows counts for open tasks and comments, and Tasks and Comments are separate tabs. On phones the panel closes with a swipe down or a tap outside it.
- **Table of contents** beside long pages, and a **Full width** option in the page menu.
- Long pages load and type noticeably faster.
- Blocks can be moved with the keyboard (Alt+Shift+↑/↓). Toggles and the formatting toolbar (Alt+F10) work without a mouse. The editor passes an automated accessibility check.
- Avatars show who else is on a page, and whether they're editing or viewing.
- Workspace **export and import** (Settings): one zip with your pages (JSON + Markdown), tasks, templates and attachments.

### Tasks
- On phones, swipe a task right to complete it, or left to move it to tomorrow (with Undo).
- Larger tap targets throughout on phones; quick add fits small screens.

### Fixes
- Adding a task in a note on a slow connection could lose its title and leave an empty task behind (BUG-6).
- Pressing Escape after typing "Buy lemons tomorrow p1" kept the whole text as the title (BUG-5).
- The shortcuts list still showed the removed `[ ] Space` task shortcut; it now shows `/task`.
- Demo accounts on staging were stuck on "Check your email".

### For the server (homelab)
- Database migration 013 (page shares) runs automatically on start. The OneNote import needs no migration.
- New optional settings: `MS_CLIENT_ID` and `MS_CLIENT_SECRET` (OneNote import). The server needs outbound HTTPS to `login.microsoftonline.com` and `graph.microsoft.com` for it. Import and export have size and rate limits; see `docs/DEPLOY_CONTRACT.md`.

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
