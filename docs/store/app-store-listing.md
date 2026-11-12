# App Store listing: Notivelo (iOS)

Copy for App Store Connect, version 0.4.4. Every limit below is Apple's; the counts are characters as App Store Connect counts them (checked by script). Screenshots are in `docs/store/ios-6.9/` (iPhone 6.9", 1320 x 2868) and `docs/store/ipad-13/` (iPad 13", 2064 x 2752), five each, in order. The GitHub social preview (`github-social-preview.png`) and link preview (`og-image.png`) are not App Store assets.

Pricing is free for now. Paid plans may come later, so nothing here promises "free forever" or "no subscriptions". Keep it that way if you edit.

## Basics

| Field | Value | Count / limit |
|---|---|---|
| Name | Notivelo | 8 / 30 |
| Subtitle | Notes and tasks, together | 25 / 30 |
| Primary category | Productivity | |
| Secondary category | Business | |
| Support URL | https://notes.devswartz.com/support | |
| Privacy Policy URL | https://notes.devswartz.com/privacy | |
| Marketing URL (optional) | https://github.com/devswartz/NoteApp | |
| Price | Free | |

Category notes: Productivity is the right home for a notes and tasks app. Business as the secondary suits the team side (shared notebooks, assigned tasks). Lifestyle or Education would also be defensible secondaries but fit worse.

## Promotional text (157 / 170)

Can be changed any time without a new version.

```
Write anywhere on the page, turn any line into a task, and share a page with anyone. Notebooks, a calendar, templates and printing, in Light, Dark or Hybrid.
```

## Keywords (99 / 100)

Comma-separated, no spaces after commas. The name, subtitle and category words are already indexed, so they are not repeated.

```
notes,tasks,todo,notebook,planner,calendar,checklist,outline,journal,meeting,project,organizer,team
```

## Description (2257 / 4000)

```
Notivelo is notes and tasks together, organised the way you think: notebooks, sections and pages, with a free-form canvas you can write on anywhere.

WRITE ANYWHERE ON THE PAGE
Tap anywhere to start a text box. Move boxes, add tables, images and files, and build Word-style numbered outlines (1, a, i) that renumber themselves. Pages keep a version history, so you can look back and restore.

TASKS THAT LIVE IN YOUR NOTES
Turn any line into a real task, with an assignee, a due date and time, a priority, tags and repeats. It shows up on your dashboard and stays linked to the page it came from, so a task is never separated from its context.
- Today, My tasks, Upcoming, Team and Completed views
- Filters and saved views
- A month and week calendar
- Reminders on your iPhone and iPad

SHARE A PAGE WITH ANYONE
Share a whole notebook with your workspace, or just one page with anyone by email, as view only or can edit. Co-edit live and see where others are on the page. Comment on a line, and add or tick tasks on shared pages. People you share one page with see only that page.

START FROM A TEMPLATE
Begin a page with Meeting notes, Project or Daily journal, or save your own. Set a default template for a section so every new page starts the way you like.

YOUR WAY: LIGHT, DARK OR HYBRID
Choose Light, Dark, Hybrid (a dark toolbar around a paper-like page) or follow the system, then pick an accent colour you like.

PRINTING
Print a page, just the lines you pick, a whole section or notebook, or a single contents sheet. Save as PDF from the same screen.

BRING YOUR NOTES WITH YOU
Import notebooks from Microsoft OneNote and keep their layout, box positions and tables.

WORKS WHEN YOU DON'T
Notes stay editable offline and sync when you reconnect. Lock the app with Face ID, and drop a task or note in from the share sheet or the Today widget.

PRIVATE BY DESIGN
No ads and no tracking. Uploaded files open only for people who can see the page they belong to, and you can export your data from Settings at any time. Read our Privacy Policy at notes.devswartz.com/privacy.

You need a Notivelo account to sign in. Notivelo also runs on the web, Windows and Mac, so your notebooks are with you on every device.

Support: notes.devswartz.com/support
```

## What's New in this version (406 / 4000)

```
Version 0.4.4
- Fixed editing with the keyboard open: the note now fills the space above the keyboard, with the line you're typing in view, and no empty band.
- Print contents: print a section or notebook as All pages, or Contents only, one sheet listing sections and pages.
- Drag outline items by the handle beside a line. The line moves with everything nested under it, and you can drop it at any level.
```

## Header and search results

Product page artwork in `docs/store/header/`: `header-5244x2950.png` and `header-3840x1646.png` (Header slot), and `search-3840x2560.png` and `search-1920x1280.png` (Search Results, 3:2). They use the captures in `docs/screens/` and keep text and devices inside a 10% safe area, clear of the bottom-left. Any other size, one line (squarer than 1.6:1 gets the bolder search layout), then `python scripts/store-assets/flatten.py` for RGB:

```
node scripts/store-assets/header.cjs <width> <height> docs/store/header/<name>.png
```

## App Privacy and review

- The App Privacy answers are in `docs/app-store-privacy.md`.
- Age rating: no objectionable content; answer "None" throughout. Notes are user-generated, but only the user and the people they share with see them, so there is no public feed.
- Review notes need a demo sign-in. Create a reviewer account on the server and put its email and password in the "Sign-in required" fields.

## App previews (video), optional

Not made yet. If you want one later: 15 to 30 seconds, portrait, captured on a real device or the simulator at the 6.9" size (1320 x 2868, or the 886 x 1920 preview size), no audio needed, App Store Connect takes up to three per size. Show the app, not marketing slides. A good order:

1. (0 to 5 s) Open a page and tap in the middle of the canvas to start a text box. Type a short heading and a bullet list. Caption: "Write anywhere on the page".
2. (5 to 12 s) Turn a line into a task: set a due date and tag. Switch to Upcoming and show it listed with its page name. Caption: "Tasks that live in your notes".
3. (12 to 19 s) Tap Share on a page, type an email, choose "Can edit". Caption: "Share a page with anyone".
4. (19 to 25 s) New page, tap the Meeting notes template and watch it fill in.
5. (25 to 30 s) Settings, Appearance: flip Light, Hybrid, Dark, ending on the Hybrid theme.

Use the demo workspace (names like Jordan and Priya, a "Cafe Website" project) and the same text as the screenshots so the store page is consistent. Do not show real notes or contacts.

## Review account

App Review needs a working sign-in and something to look at. Create the account in the app (or on the web) the normal way, verify its email, then fill it with friendly demo content with the seed script. It uses only the public API, never creates accounts, never prints the password, and is safe to run twice (existing items are skipped by title).

```
BASE_URL=https://notes.devswartz.com REVIEW_EMAIL=reviewer@example.com REVIEW_PASSWORD='the review password' SHARE_WITH_EMAIL=second-account@example.com npx tsx scripts/seed-review-account.ts
```

On PowerShell set the variables first (`$env:BASE_URL = "..."`, and so on), then run `npx tsx scripts/seed-review-account.ts`. `SHARE_WITH_EMAIL` is optional: if it is set, the Project brief page is shared with that address (can edit), so the reviewer can see sharing in action. Use a second account you control, or leave it out.

It adds a "Projects" notebook (Planning, Design and Launch prep sections), a Kickoff meeting page laid out like the Meeting notes template, a Project brief with a table and numbered outline, a Site structure outline page, a Launch checklist, tags, and tasks with due dates. Sign in as the review account afterwards and look before submitting.

Suggested App Review notes (paste into App Store Connect, "Notes", and fill in the sign-in fields):

```
Notivelo is a notes and tasks app: notebooks, sections and pages on a free-form canvas, with tasks that live inside notes. It needs an account; sign-in details are above. The account already has a "Projects" notebook with sample pages and tasks.

To try sharing: open Notes, then Projects > Planning > Project brief, tap Share at the top of the page, and choose a person and Can edit or Can view. That page is already shared with a second sample account.

To try tasks: open the Tasks tab for Today and Upcoming, or tap a task in the Kickoff meeting page.

Account deletion: Settings > Profile > Delete account. It permanently deletes the account and its data.

Privacy policy: https://notes.devswartz.com/privacy
Support: https://notes.devswartz.com/support
```
