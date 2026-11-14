# Changelog

All notable changes, by release. Pull request numbers refer to github.com/devswartz/NoteApp.

## v0.5.0

### Locked pages
- **Lock a page.** Page menu → **Lock page**, for pages only you can see (in your private notebook, or a workspace nobody else is in, and not shared with anyone). While a page is locked it can't be shared, moved into a shared notebook, or have its notebook shared, and its icon in the sidebar is a lock. Changing or resetting the locked-notes password always sends you an email. A locked page opens only for you, with a locked-notes password that is separate from your sign-in password (you create it the first time you lock something). For everyone else in the workspace, admins included, the page is gone: not in the sidebar, search, links, tasks, activity, notifications, exports or connected AI apps.
- **Unlock once, open them all.** The lock screen shows the page's title and asks for the password (at least 6 characters); unlocking opens all your locked pages on that device until they lock again: after 5 minutes without activity, when the app goes to the background, when you sign out, or with **Lock now**. After 5 wrong tries unlocking pauses for 15 minutes (doubling with each further wrong try, up to 24 hours), the lock screen says how long, and you get an email saying when and from which device.
- **Face ID / Touch ID** on iPhone and iPad (and fingerprint on Android): after the first password unlock the app offers to use it next time. It works for that sign-in on that device only, and ends after 30 days, on sign-out, and when your sign-in or locked-notes password changes or is reset. On the web and the Mac app it's the password.
- While a page is locked you still see its title in the sidebar and in title search; its text never appears in search, backlinks, version history, print or export, and its tasks show as "Locked task" with their due date only (reminders say "Reminder from a locked note"). **Export my data** asks you to unlock first. Locked pages are never kept in the offline cache: locking a page removes it from every device that had it, and links to its images and attachments only work while you have it unlocked. **Remove lock…** (with the password) makes it an ordinary page again.
- **Settings → Security → Locked notes**: create or change the password, turn biometrics on or off, and reset a forgotten password with your sign-in password and a code sent by email. A reset only sets a new password: pages are locked, not encrypted, so nothing is lost, and nothing is revealed.

### AI connectors
- **Connect ChatGPT, Claude and other AI assistants.** Notivelo can now let an AI app ask for access to your notes. The app sends you to a Notivelo page (after signing in, if needed) that names the app, says the name comes from the app itself and isn't verified, and lists what it may do in plain words: read your notes, and optionally create and edit them. Untick editing to allow reading only. Allow sends you back to the app; Deny tells it no.
- **Settings → Connected apps** lists every app you've allowed, with what it may do, when you connected it and when it last used your account. **Revoke** cuts it off straight away. Changing or resetting your password disconnects every app.
- **What a connected app can do.** Through the AI connector at `/mcp` (the Model Context Protocol), an app you connect can work with your notes as you: list your workspaces, sections and pages, search, read pages, and see your tasks. With editing allowed it can also create pages, add to a page or rewrite one of its text boxes, and create, tick off and change tasks. It can never delete anything.
- It only ever sees what you can see: private notebooks, pages shared with you and Trash follow the same rules as in the app, and pages in Trash are invisible to it. View-only access stays view-only.
- Its changes appear live for anyone with the page open, keep a version from before each change (undo it from **Version history**), and show in Activity as yours “via” the app's name. Images in its writes are dropped, and “- [ ]” lines become real tasks on the page.
- Requests and changes are rate-limited, and writes and page reads are capped in size.

### Tasks
- **Notes under a task.** A task in a page can now hold lines indented under it, like a OneNote To Do tag: bullets, numbered lists, paragraphs, plain checklists and subtasks. Turning a bullet into a task keeps its sub-points under it, exactly as they were (they stay notes: only the line you convert becomes a task). **Tab** on the line just below a task moves it in (a whole list when you're on its first line), **Shift+Tab** moves it back out, and **Enter** on an empty last line leaves the task. Enter at the end of a task's title starts its first note line. The notes move with the task (drag, Alt+Shift+arrows, copy and paste, undo), print and export with it, and fold away with the arrow next to the task (remembered on this device).
- **Subtasks where you write them.** Converting a line in a task's notes (or tabbing a task under another) makes it a real subtask of that task, shown where it is; moving it out makes it a task of its own again. Subtasks stay one level deep.
- **Checklists that aren't tasks.** "Add checklist" on a task (or **/Checklist under task**) puts a plain checklist under it: a 25-item packing list stays a checklist, and only its count ("12/25") shows next to the task and in the Tasks views.
- **"From the note" in the task panel** shows what's written under the task in its page, read-only. The task's own details are untouched.
- Completing a task leaves its notes as they are. Deleting a task from the Tasks views removes its line from the page but keeps its notes there. Pages written before this load exactly as they were; sub-points that already sit under a task as a separate list join it with Tab.

### Behind the scenes
- An OAuth 2.1 authorization server for remote MCP clients, following the MCP authorization spec: authorization code with PKCE (S256 only), app registration by Client ID Metadata Document or Dynamic Client Registration (public clients, rate limited, https or loopback redirect addresses only), discovery metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`, tokens bound to `/mcp`, short-lived access tokens and rotating refresh tokens (only hashes are stored; a retry within 30 seconds of rotation is honoured, later reuse of an old refresh token disconnects the app), and token revocation.

### Fixes
- **Picking a due date no longer sets one by accident.** In the desktop app on Windows, stepping to the next month in a task's due-date picker set the date and closed the menu. The due-date menu now has its own small calendar: the month arrows only change month, and a date is set only when you click a day. Today is outlined, the chosen day is filled, past days are dimmed, and the week starts on your region's first day. Keyboard: arrow keys move between days, Page Up/Page Down change month (with Shift, year), Enter picks, Escape closes. A repeating task's **Ends on date** uses the same calendar, and days before the due date can't be picked.

## v0.4.11

### Performance
- **Pages no longer grow huge after pasting.** The editor's sync library kept a hidden record of every paste and structural edit (indent, drag, list changes) inside the page and never removed it. They could become most of a page's size (one page was 4.6 MB for 240 KB of text), which made typing lag. The updated library stops writing them, and the server removes the existing ones: from every stored page at startup, when a page opens, and before each save, so older desktop and phone apps can't bring them back.

### Monitoring
- Admin metrics now time live editing: update count, size and apply time, plus save time and the largest page saved. Health checks are counted apart, so they no longer drag the request latency percentiles down.

### Reliability
- **The server can no longer be knocked over by a malformed live-editing connection.** A badly formed web address, an oversized message, or a hand-crafted edit sent to a page could stop the whole server for everyone until it restarted. Each is now refused for that one connection, and a failed save is logged and retried.
- **A page can no longer be broken for everyone by a malformed edit.** A hand-crafted edit could put content the editor cannot draw into a page, so that it crashed for everyone who opened it. The server now removes such content (and absurdly deep nesting) as soon as it arrives, and when it opens a page that already contains some.

### Fixes
- Long page titles are cut cleanly: a title that ran past the length limit in the middle of an emoji no longer ends in a replacement character.
- If you delete the only workspace you belong to, you now get a **Create a workspace** button instead of a dead-end message.
- Deleting a workspace now also deletes its uploaded images and files from the server, instead of leaving them behind and using up space.
- Search no longer shows an error for a query containing a stray invisible null character, and creating or editing a task with an empty page no longer fails.
- **Undo and redo keep a box's text.** Undoing a new box and then redoing it brings its text back (it used to come back empty), and a deleted box brought back with Undo can still have its typing undone and redone. Typing in a box that's scrolled out of view undoes and redoes too.

## v0.4.10

### Tasks
- **Status filter:** "All" and "Completed" are now one view, **All tasks**, with a **Status** choice of Open (the default), Completed or All. Status works in every task view and in printing, so you can print just open or just finished tasks. Saved views remember it, and old links to Completed still work.

### Settings
- **Workspace and personal settings are separate.** The workspace button opens Workspace settings (General, Members, Teams, Tags), Activity and Trash. Your avatar opens your own Settings (Profile, Appearance, Security, Notifications, Keyboard shortcuts, About) and Sign out.

## v0.4.9

### Fixes
- **Dragging keeps a list's numbering.** A numbered item dragged out of its list stays numbered, with its sub-items. Dropped next to a numbered list, it joins it and the numbering continues; dropped between paragraphs, it starts a new numbered list. Dropped inside a bullet list, it becomes a bullet there.

## v0.4.8

### Fixes
- **Deleting a page keeps its tasks in your task list.** While the page is in Trash, the tasks show "Page title · in Trash" and open the read-only page with Restore. After 60 days, or Delete forever, they become standalone tasks. The messages say so consistently.
- **The drag handle no longer covers text** when you move from a sub-point up to a parent, a paragraph or a heading.

## v0.4.7

### Fixes
- **Page titles can't be overwritten by mistake.** A title or icon change is refused unless the app knew the page's current title, so switching pages quickly can no longer rename or blank another page, including one shared with you.
- **Deleting a task works in the desktop and phone apps.** The task panel's and bulk bar's Delete now delete straight away, with Undo. A task deleted from the panel is also removed from its page.
- **Print Tasks:** the Tasks ribbon has Print, and Ctrl/Cmd+P prints the task view you're on.
- **No more browser pop-ups:** confirmations (deleting comments, removing members, leaving shared pages, restoring versions, deleting a workspace) use Notivelo's own dialogs, which work in every app.
- **Outline drag handle:** the ⋮⋮ handle of a nested line stays on that line as you move to it, so sub-points can be dragged.
- Tasks use "Page" consistently: Group by Page, On pages, Open page.

### Tasks
- **Assignee menus grouped by team:** Me and Unassigned at the top, then people under their teams, with subteams nested. In the filter, ticking a team picks everyone in it. Search shows each person's teams.

### Behind the scenes
- iPhone builds are signed reliably again and reach TestFlight. CI removes the development certificates it creates.

## v0.4.6

### Copy, paste and printing
- **Copy keeps formatting:** copying a box, Ctrl-picks or right-click → Copy keeps bullets, numbering, nesting, tasks, headings, bold and links when pasted into another box or page, or into apps like Word. Pasting a list onto empty canvas makes a new box that keeps the list.
- **Printing is more compact:** body text prints at 11pt, and table cells are tighter, so rows are about half as tall.
- **Print selection:** items you didn't pick no longer print as empty bullets. Numbered lists keep their numbers. The title matches a whole-page print.

### OneNote import
- Text colours and highlights come across.
- Table columns keep their widths, or fit their content when OneNote gives none.
- Bold, italic and underline set on a whole paragraph or heading come across.

### Behind the scenes
- iPhone builds sign with Apple's distribution certificate, so CI no longer creates development certificates.
- Releases check that production picked up the new version.
- App Store and GitHub artwork.

## v0.4.5

### Trash
- **Deleted notes go to Trash for 60 days.** Deleting a page, section or notebook moves it to Trash (account menu or command palette). From there you can **Restore** it to where it was, or **Delete forever**. Admins can **Empty Trash**. A trashed page opens read-only with a Restore banner.
- Deleting a page or section no longer asks first; the toast offers **Undo** and says how many tasks are hidden with it. Deleting a notebook still asks.
- Tasks on a trashed page are hidden until it's restored.

### Selecting and printing
- **Word-style multi-selection:** select normally (drag, double-click a word, triple-click a line), then hold Ctrl/Cmd for more selections: Ctrl+drag, Ctrl+double-click or Ctrl+triple-click. Earlier selections stay highlighted, within a box or across boxes. Print selection, right-click → Print selection and Ctrl/Cmd+C use exactly those pieces.
- **Printing no longer collapses the sidebar.**

### Behind the scenes
- Faster checks for each change and faster releases.

## v0.4.4

### Fixes
- **iPhone app: editing with the keyboard open.** The app made room for the keyboard twice, which pushed the note up under the toolbar and left an empty band above the keyboard. The note now fills the space above the keyboard, with the line you're typing in view.

### Printing
- **Print contents:** the section and notebook menus have **Print…**, which offers **All pages** or **Contents only**. Contents only is one sheet listing sections and pages, nested as in the sidebar. A notebook can now also print all its pages.

### Pages
- **Dragging outline items:** the ⋮⋮ handle sits beside the line you point at. Dragging it moves that line with everything nested under it, and you can drop it at any level. The handle now shows in every box.

## v0.4.3

### Pages
- **Pick separate lines:** Ctrl/Cmd+click a line, paragraph, heading, list item or task to add it to the selection, like Word, within a box or across boxes. Ctrl/Cmd+click and drag sweeps lines. Esc or a plain click clears them. To pick a whole box, Ctrl/Cmd+click its frame.
- **Copy and paste boxes:** click a box's top edge to select it, then Ctrl/Cmd+C, X and V. Right-click a box's edge for Cut, Copy, Duplicate and Delete, or empty canvas for Paste and New text box here. Plain text pasted onto the canvas becomes a new box. Desktop only.

### Printing
- **Print selection** prints exactly the picked lines and boxes, in order.
- **Right-click → Print selection** on picked lines, picked boxes or a selection longer than one word.
- **Titles:** a selection prints under the page's own title, including pages shared from another workspace. Untitled pages print with no title.

### OneNote import
- **Imported pages keep OneNote's layout:** no extra gap under the title and no shift to the right. Tables keep their column widths, and empty cells are one line tall. Re-import a page to get the new layout.

## v0.4.2

### Fixes
- **Ctrl+Z after adding a link** no longer takes back the typing before it as well. Adding a link is its own undo step.
- **Quieter offline notice:** short connection blips no longer flash a warning. After 30 seconds offline, a small pill appears at the bottom, which you can close until the next reconnect.

### Tasks
- **Filter menus show the hierarchy:** subteams under their team, with member counts, and sections nested under their notebook. Searching shows full names.
- Each filter can hold several values, with Is / Is not, Select all, Clear and search (added in v0.4.1).

## v0.4.1

A Hybrid theme and accent colours, section default templates, task view filters, and privacy work ahead of the App Store.

### Appearance
- **Hybrid theme:** dark ribbon, panels and menus around a light, paper-like page. Choose Light, Dark, Hybrid or System in Settings › Appearance or the user menu.
- **Accent colour:** eight colours in Settings › Appearance, with live previews of each theme. Saved per device.

### Templates
- **Default template per section:** the section's ⋯ menu › Default template… New pages in that section start from it, for everyone in the workspace. Subsections inherit it. A toast offers "Start blank", and Ctrl+Z undoes it too.
- **New page from template** in the ribbon's New page button and the section menu.
- **{date} and {time}** in a template fill in when it's used.
- **New pages are tidier:** "Start with a template" sits right under the first box, with no scrolling. The page header no longer clips, and long "New page" rows in nested sections stay on one line.

### Tasks
- **Saved views show their name** as the heading.
- **Ribbon filters work in every view** (Today, My Tasks, Upcoming, Team, Completed), with a line saying what's on and a Clear button.

### Privacy and security
- **Uploaded files need sign-in.** Files open only for people who can see the page they belong to, through short-lived links. Old links keep working for them.
- **Export my data** for everyone in Settings › Profile.
- **Updated Privacy Policy** and a new **Support page** at /support.
- The iPhone app includes Apple's privacy manifest.

## v0.4.0

Tester feedback: undo for moved boxes, Word-style numbered outlines, editing and tasks for people outside your workspace, Mac spellcheck, and printing just a selection.

### Editing
- **Undo moves boxes back.** Ctrl+Z, Ctrl+Y and the ribbon's Undo/Redo undo the most recent change on the page, whether you moved or resized a box or typed, wherever the cursor is.
- **Word-style numbered outlines.** Type `1.`, `a.`, `i.` or `1)` to start a numbered list. Tab and Shift+Tab indent and outdent, numbering goes 1 → a → i by level and renumbers itself, and Enter on an empty item steps out a level. Bullets go • ◦ ▪. The ribbon's Lists group has Increase/Decrease indent.
- **Spellcheck on Mac.** The Mac app now underlines misspellings; autocorrect follows your Mac's Keyboard settings.

### Sharing
- **People outside your workspace can edit.** Share a page with anyone by email and choose "Can edit"; they don't need to join your workspace and still see only that page. Existing outside shares stay view-only until you change them in Share.
- **Tasks on shared pages.** Anyone who can edit a shared page can add, tick and edit its tasks. Assign the page's tasks to the people it's shared with, and they can assign back; assigned tasks show in their My tasks.
- The Share windows have proper padding.

### Printing
- **Print selection.** Highlight text, or Ctrl/Cmd+click boxes, then Print (Ctrl/Cmd+P) offers "Print selection" with the page title on top.

### Layout
- **Two panels on more screens.** Sections and pages sit in separate panels from 1200 points wide (was 1400), so a maximised window at 150% Windows scaling gets both. Settings › Appearance has a switch to keep pages under their sections instead.

## v0.3.0

The OneNote release: every page is a canvas, with a OneNote-style ribbon, printing, and a roomier layout.

**When the server updates, it converts every existing page to a canvas** with one wide box holding its content, so pages look as they did. Each page's previous version is kept in Version history.

### Pages
- **Every page is a canvas, like OneNote.** Open a page and start typing. Click anywhere to start another text box. Drag a box by its top edge to move it and by its right edge to resize it. Boxes can sit side by side or overlap, and collaborators see them appear and move live. Ctrl+Z outside a box undoes creating, moving, resizing or deleting it.
- **Boxes are see-through.** Only the box you're typing in is opaque.
- **Every box is included.** Search, tasks, mentions, links, the outline, version history, templates and Markdown export and import cover every box. The built-in templates come laid out as boxes.
- **OneNote import keeps box positions.** Pages without positions come in as one wide box.
- **Left-aligned and full width.** Pages, task views, the calendar and the Notes overview start at the left and use the whole width. The page's main box runs to the right edge. The "Full width" option is gone.
- **Phones:** boxes are shown one under the other, with "Add a text box" at the end. A page with one box is a normal editor.

### Ribbon
- **A OneNote-style ribbon** runs across the top of the window. It has these groups: Text, Lists, Insert, Page and View. Larger buttons have labels.
- **Collapse it** with the chevron or Ctrl+F1. The setting is remembered.
- **Keyboard:** F6 reaches the ribbon.
- **Phones** keep the floating toolbar.
- **Task** is the main list button. It makes the line a tracked task, or starts a new one. A plain checkbox is in its dropdown.
- **OneNote shortcuts:** Ctrl+1 makes a task, Ctrl+. makes bullets, and Ctrl+Alt+1/2/3 make headings.
- **Tables:** with the cursor in a table, a **Table** group appears. It inserts and deletes rows and columns, toggles the header row, and merges and splits cells. Nothing covers the table any more. On phones the table menu sits above the table.
- **It changes with the section.** Tasks has new task, view, group, sort, filters and saved views. Calendar has today, back and forward, week or month, and filters. The Notes overview has new page, section and notebook, and import. The duplicate controls on those pages are gone on desktop.

### Page colour and rule lines
- **Page colour:** a soft background colour per page, with gentler tints in dark mode. It syncs live and is kept in templates and versions.
- **Rule lines or grid:** with them on, text, headings, tasks and tables snap to the lines, centred between them like ruled paper. With them off, nothing changes.

### Printing
- **Print** with Ctrl/Cmd+P, the ribbon's Print button or the page menu. Every platform opens its native print dialog, which also offers Save as PDF.
- **Laid out for paper:**
  - boxes print in reading order, as columns when they fit;
  - nothing is clipped, and page breaks avoid splitting content;
  - the title and notebook › section print at the top, with page numbers (not on Apple devices);
  - tasks print as compact checkboxes;
  - page colour prints only if you ask; rule lines never print.
- **Print section** prints every page in a section.

### Editing
- **Links:** the link editor has **Text** and **Address** fields, like OneNote.
- **Backspace leaves a block:** Backspace on an empty last line in a toggle, callout or quote moves the line out of it, Word-outline style. Enter does the same in toggles.
- **Backspace in an empty new task** leaves a normal line instead of selecting the task above.
- **Task circles** line up with the title.

### Fixes
- Desktop: checks for updates every time the app opens. It used to check at most once a day, and the check still never slows startup.

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
