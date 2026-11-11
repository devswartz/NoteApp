# Plan: first tester feedback (November 2026)

This plan covers the first round of tester feedback, except two items that are left out on purpose:

- **Text boxes placed anywhere on a page.** This would need a different kind of page. We'll ask what they need it for first; a callout or columns block may be enough.
- **"Tasks awaiting a response."** It isn't clear yet what this means. It might be a "Waiting" tag, which tags already cover.

The work is in four tracks. Tracks 1 and 4 don't touch the same files, so they can run in parallel. Track 2 needs track 1's saved views, and track 3 needs track 2's notes panels.

| Track | What | Size | Release |
|---|---|---|---|
| 1 | Tags, teams, assigned by, filters, saved views on the server | L | v0.2.0 |
| 4 | Editor toolbar at the top, text and highlight colours, one-click task | M | v0.1.6, can ship first |
| 2 | Left rail (Notes / Tasks / Calendar) with a panel for each view | L | v0.2.0 |
| 3 | Subsections and templates tied to sections | M–L | v0.2.x |

Already done, no work needed: the **light theme**, in Settings → Appearance. Track 2 also adds a theme toggle to the user menu so it's easier to find.

---

## Track 1: Tags, teams and filters

### Data (migration 014)
```sql
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES teams(id) ON DELETE CASCADE,   -- subteam; one level deep
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  position REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);
ALTER TABLE tasks ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE TABLE task_views (            -- saved views, moved from the device to the server
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared INTEGER NOT NULL DEFAULT 0, -- 1 = every member sees it
  name TEXT NOT NULL,
  query TEXT NOT NULL,               -- JSON: filters + sort + group
  position REAL NOT NULL,
  created_at TEXT NOT NULL
);
```

### Rules
- **Team and assignee are independent.** A task can have a team and no assignee ("Elders, unassigned"), an assignee and no team, or both. This is what keeps Scott's Staff tasks out of his Elders view: views filter on the task's team, not on the teams the assignee belongs to.
- **The assignee picker** lists the chosen team's members first, then everyone else. Anyone can be picked (open question 3).
- **Assigned by:** the server records it whenever `assignee_id` changes, as the person who made the change, and clears it when the task is unassigned. It's separate from `created_by`, which already exists. Existing assigned tasks are backfilled from the activity log where it has the assignment, and otherwise from `created_by`.
- **Subteams:** one level deep. A filter on a parent team has an **Include subteams** switch, on by default.
- **Tags** are shared across the workspace. Any member who can edit can create one, inline from the tag picker. Admins can rename, recolour, merge or delete tags in Settings.
- **Teams** are managed in Settings → Teams by owners and admins. Members can see the teams.

### Filters
`Filters` in `src/lib/taskViews.ts` gains these fields, and the existing ones stay:
- `tagsAny: string[]` (has any of these tags) and `tagsNone: string[]` (has none of these tags, for example hide "Waiting")
- `teamId` and `includeSubteams`
- `assignee`, which already exists (me, unassigned or someone), and `assignedBy` (me or someone)
- `notebookId`, which already exists, and `sectionId`, which also covers that section's subsections once track 3 lands

The filter bar becomes an **Add filter** button that adds one chip per condition. Chips combine with AND, and multi-select inside a chip combines with OR.

### Saved views
- They're stored in `task_views`, so they follow the user to every device. The device-only views users have now are uploaded the first time the new version loads.
- **Personal by default.** Owners and admins can mark a view **Shared** so the whole workspace sees it (open question 4).
- They're listed in the Tasks panel (track 2) and can be renamed, reordered and deleted.
- The tester's examples should all be possible:
  - **All unfinished Elders tasks:** team = Elders (with subteams), status = open.
  - **All tasks assigned to Scott across teams:** assignee = Scott.
  - **Scott's Elders tasks:** team = Elders and assignee = Scott.
  - **Tasks I assigned to others:** assigned by = me, and assignee is not me.

### Everywhere else tasks appear
- **Task detail:** Team, Tags and "Assigned by {name}" fields under Assignee.
- **Task rows:** tag chips and a team badge. Long rows truncate, and phones show at most 2 chips.
- **Quick add** gets `#tag` and `+team` tokens, in the style of the current `@person`, in `shared/quickadd.ts`, in the desktop quick capture too.
- **Team view** gains grouping by team.
- **Live sync, workspace export/import, the demo seed and the API docs** all include tags, teams and views.

### Tests
- **Unit tests:** filter logic (include and exclude tags, including subteams, assigned by) and quick-add parsing.
- **API tests:** who can manage teams and tags, setting and clearing assigned by, and saved views not leaking between users.
- **E2E:** build the four example views and check their results.

---

## Track 4: Editor toolbar and colours (can ship first)
- **Fixed toolbar at the top** of the page on desktop and tablet:
  - **Text and formatting:** block type (Text / Heading 1–3), Bold, Italic, Underline, Strike, **Text colour**, **Highlight**.
  - **Lists and inserts:** bullet, numbered and checklist lists, **Turn into task**, link, image, table.
  - **Edit:** undo and redo.
  - The toolbar stays put while you scroll. The floating toolbar over selected text stays for quick formatting. Phones keep their current toolbar above the keyboard, which also gets colours.
- **Colours** use TipTap's `TextStyle` + `Color` and `Highlight` (multicolor) extensions, with a fixed palette of about 8 colours plus "Default".
  - Notes store a colour *name*, not a hex value. CSS maps each name to a value for light and dark themes, so a note stays readable in both, and the contrast test is extended to check them.
  - Markdown export drops the colours. HTML/PDF export keeps them.
- **One-click task:** Turn into task goes on the fixed toolbar, plus a ✓ button that appears when you hover over a line, next to the drag handle. Ctrl+Enter and `/task` stay.

---

## Track 2: Navigation (left rail and a panel for each view)

### Layout on desktop and tablet
```
┌──┬──────────────┬───────────────┬─────────────────────────┐
│N │ Notebook ▾   │ Notes         │  toolbar                │
│T │ ▸ Section    │ • Page one    │                         │
│C │   ▸ Subsect. │ • Page two  ◀ │  editor                 │
│  │ ▸ Section  ◀ │               │                         │
│⚙ │              │               │                         │
└──┴──────────────┴───────────────┴─────────────────────────┘
 rail  panel 1       panel 2 (Notes view only)
```
- **The rail** has Notes, Tasks and Calendar at the top. Search, notifications, the workspace switcher and the user menu (with a theme toggle) are at the bottom. The current view is highlighted, and each view remembers the last place you were in it.
- **Tasks panel:** + Add task, Today, My Tasks, Upcoming, All Tasks, Team, Completed, then a **Views** heading with the saved views (track 1) and "+ New view".
- **Calendar panel:** a small month calendar, and filters for team, assignee and tags.
- **Notes panels:**
  - **Notebook panel:** a dropdown at the top lists your notebooks, then "Shared with me". Below it is the selected notebook's sections as a tree with expandable subsections.
  - **Notes panel:** lists the pages in the selected section, with new page, sort and drag to reorder.
  - Clicking a page opens it in the editor. The selected notebook, section and page are all highlighted.
- **Panels** can be resized and collapsed (Ctrl+\\), and the widths are remembered on each device. On narrow windows, panel 2 folds into panel 1.
- **Phones** keep the bottom tab bar. Notes becomes step-by-step screens: notebook, then section, then page, with Back at each step. The tab bar and the rail use the same views.
- **Moves from the current sidebar:** Favorites move to the top of the Notes panel, and "Shared with me" pages appear in the notebook dropdown.

### Work
- Split `Sidebar.tsx` (777 lines) into `Rail`, `NotesPanel`, `TasksPanel` and `CalendarPanel`. Routes stay the same, so links and the e2e tests keep working.
- Keyboard: arrow keys move through the trees, and F6 moves between rail, panels and editor.
- E2E: switching views, the selection highlight, phone step-by-step screens, and an axe accessibility check on each view.

---

## Track 3: Subsections and templates for sections

### Subsections
- Migration: `ALTER TABLE sections ADD COLUMN parent_id TEXT REFERENCES sections(id) ON DELETE CASCADE`, limited to 3 levels.
- Any section can hold both pages and subsections, which is simpler than OneNote's separate section groups.
- **Code to update:**
  - the tree API and live updates
  - Move to… (moving whole sections between levels)
  - delete (which cascades to subsections)
  - search results showing the path, like "Notebook › Section › Sub"
  - task filter by section
  - workspace export/import
- **OneNote import:** section groups become real subsections, instead of today's flattened "Group / Section" names.
- **Private notebooks:** access is still checked at the notebook level, so nothing changes there.

### Templates tied to sections
- Migration: `template_sections(template_id, section_id, include_subsections INTEGER)`.
- A template with no rows works everywhere, which is today's behaviour. With rows, it's offered in those sections and, when `include_subsections` is set, in their subsections.
- Save as template and Edit template get an **Available in** picker for choosing sections at any level, more than one allowed.
- The template picker on an empty page shows **templates for this section** first, then "Other templates".
- A possible extra is a **default template** per section, applied to every new page there (open question 6).

---

## Open questions for the tester
1. Who should manage teams and tags: only owners and admins, or anyone who can edit?
2. Is one level of subteams enough (Staff › Worship), or do you need deeper?
3. Can a task be assigned to someone outside its team, or only to its members?
4. Should saved views be personal, shared with everyone, or both (personal by default, with an option to share)?
5. Should Today and My Tasks stay in the Tasks panel alongside Upcoming and All Tasks?
6. Should a section be able to have a **default** template for every new page?
7. Text boxes anywhere on a page: what would you use them for? Would side-by-side columns or callouts do the job?
8. "Tasks awaiting a response": is that a "Waiting" tag, or something else?

## Order and releases
1. **v0.1.6:** track 4 (toolbar, colours, one-click task) plus the theme toggle in the user menu. Small, and it shows progress quickly.
2. **v0.2.0:** track 1 (tags, teams, filters, views), then track 2 (left rail and panels). They ship together, because saved views belong in the new Tasks panel.
3. **v0.2.x:** track 3 (subsections, templates tied to sections).

Each track is several PRs, data model and API first, then the UI, each with its own tests. The data changes are migrations that only add things, and older desktop and mobile versions ignore fields they don't know about.
