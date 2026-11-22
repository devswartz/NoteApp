# LOOK: today's web app, as a spec for the native UI

The native iPad / iPhone (and later Mac) UI must look like today's web app. This file is the spec;
the pictures are in `docs/rewrite/look/reference/` (index: `look/reference/index.md`), the icons in
`docs/rewrite/look/icons/` (index: `look/icons/index.md`). How to regenerate both:
`docs/rewrite/look/README.md`.

Everything here is read from the source on `rewrite/native` (e5d4095): `src/styles.css` and
`src/styles/*.css`, `src/editor/collab.css`, `src/components/sharing/inbox.css`, and the components
named in each section. Numbers are CSS px (= iOS points). Where the CSS and the screenshots
disagree, the CSS wins (the screenshots were captured with Chromium on Windows, see 0.2).

## 0. Read this first

### 0.1 Viewports and what the web app does at each

| Reference folder | Size (pt) | Web layout it gets | Why |
|---|---|---|---|
| `reference/ipad-landscape/` | 1180×820 | Tablet: ribbon (compact: no group names, no button words), rail, one sidebar panel (pages folded into the tree), sidebar open | > 760 (not phone), ≤ 1199 (folded), ≤ 1279 (compact ribbon), ≥ 900 (sidebar open on first run) |
| `reference/ipad-portrait/` | 820×1180 | Tablet: ribbon (smallest: 30 pt buttons, 16 pt icons), rail, sidebar **closed** on first run | ≤ 1023, < 900 |
| `reference/iphone/` | 390×844 (@2x PNGs) | Phone: no ribbon, no rail; top bar + bottom tab bar; sidebar is a drawer; canvas boxes stacked; menus are bottom sheets | ≤ 760 |

Both iPad emulations match `(pointer: coarse)` and `(hover: none)` (touch), as a real iPad without a
trackpad does. The web app keys almost everything on width, not on device.

### 0.2 Fonts in the screenshots

`--font` is `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif`.
On an iPad that is **SF Pro** (the system font). The reference PNGs were rendered on Windows, so their
glyphs are Segoe UI: shapes and text widths are a little off; sizes, weights, line heights, colours
and positions are right. The native app uses `UIFont.systemFont(ofSize:weight:)` (SF Pro Text/Display
by size, as Safari does). Monospace: `'SF Mono', ui-monospace, Menlo, Consolas, monospace` →
`UIFont.monospacedSystemFont`.

### 0.3 Themes

Theme preference: Light, Dark, **Hybrid (the default until the person picks one)**, System
(`src/store/ui.ts` `DEFAULT_THEME = 'hybrid'`). Hybrid = the dark palette for all chrome (ribbon,
rail, sidebar, menus) and the light palette on the note page (`.page-scroll`) and on the popovers
that belong to it (slash menu, link editor, mention popup, colour grids). Above 760 pt wide the
Hybrid page is inset 6 pt from the chrome (top, left, right; not the bottom) with 12 pt top corners
and a shadow `0 0 0 1px rgba(0,0,0,.55), 0 6px 24px rgba(0,0,0,.45)`, and its `--bg` is `#fcfcfa`
(`--bg-subtle` `#f9f9f7`). On phones the Hybrid page runs edge to edge.
Screens: `hybrid-*.png`, `dark-*.png` in `reference/ipad-landscape/` and `reference/iphone/`.

Accent colour preference: Blue (default), Purple, Teal, Green, Orange, Red, Pink, Graphite (section 1.4).

### 0.4 Things UIKit doesn't do the way CSS does (gotchas for the rebuild)

- **`color-mix()` tokens**: `--bg-active` = accent at 9 % (light) / 15 % (dark) over transparent;
  `--accent-soft` = accent at 10 % / 15 %. Compute them as the accent colour with that alpha
  (`UIColor.withAlphaComponent`), recomputed when the accent or theme changes. Same for the
  task-check priority fills (priority colour at 10 %) and tag chips (tag colour 16 % bg, text = tag
  70 % mixed into `--text`: blend in code).
- **Translucent bars**: page top bar = `--bg` at 88 % + `backdrop-filter: blur(10px)`; phone top bar
  `--bg` 92 % + `saturate(1.6) blur(14px)`; tab bar `--bg` 90 % + same. Use
  `UIVisualEffectView` (`.systemChromeMaterial` is close) or a plain 88–92 % fill; the blur radius
  is not 1:1 with iOS materials.
- **Box shadows** are often two layers (`--shadow`, `--shadow-lg`); a `CALayer` has one shadow.
  Use two layers or a shadow path, or keep the larger layer only. Shadow `blur` in CSS = 2×
  `shadowRadius` in Core Animation (CSS 16 px blur ≈ `shadowRadius 8`).
- **Focus rings** (`--focus-ring`: 2 pt `--bg` gap then 2 pt accent) only appear for keyboard focus
  (`:focus-visible`): on iPad with a hardware keyboard; use `UIFocusEffect`/a custom ring.
- **Hover-only affordances**: much is shown only on hover with a mouse. With `(hover: none)` (iPad,
  iPhone) the web app shows: empty chips (no priority / no date / no assignee) on task lines,
  "Add checklist" with its words, the task "open" button; it hides the block drag handle
  (`.block-handle`). Sidebar row actions (+, ⋯) show only on hover on iPad (not at all without a
  pointer; reached by long-press) and always on phones.
- **Long-press = context menu** on touch (500 ms, `useContextMenu`); right-click with a pointer. On
  iOS use `UIContextMenuInteraction` only if it can be styled like the web menus; otherwise a custom
  popover opened on long-press (the web menu look, section 4.9, is the target).
- **Lists**: markers come from CSS `list-style-type` by nesting depth (`1. → a. → i. → 1) → a) → i)`,
  bullets `• ◦ ▪`); the native renderer already draws core's markers right-aligned in the indent.
  Indent is 1.6 em (25.6 pt at 16 pt text); marker gap is the browser's (≈ 0.5 em).
- **Line height** is a multiplier of the font size (1.7 on page text → 27.2 pt lines at 16 pt). In
  TextKit set `minimumLineHeight = maximumLineHeight = size × 1.7` and centre the glyphs
  (`baselineOffset`), since CSS splits the extra leading above and below the text.
- **Block spacing**: `.ProseMirror > * + * { margin-top: 0.4em }` = 6.4 pt between top-level blocks
  at 16 pt; headings have their own margins (4.3). CSS margins collapse (the larger of two adjacent
  margins wins): emulate with `paragraphSpacingBefore = max(prev.after, this.before)`.
- **Rule lines / grid**: snapped layout (section 4.5.3). Text lines are exactly 28 pt with the line
  drawn on the last pixel of each 28 pt band.
- **Semi-transparent boxes**: canvas boxes have no background (overlapping boxes show through) except
  the box being edited, which gets `--bg`.
- **Sticky top bar** inside the page scroller: the page's top bar scrolls with the page container but
  sticks at its top; the ribbon never scrolls.
- **Hit areas**: phone CSS enlarges compact controls to ≥ 44×44 with invisible `::after` areas
  (`tasks.css` "Touch targets"). Native: keep the drawn size, enlarge `point(inside:)`.

## 1. Colour

### 1.1 Base tokens (`src/styles.css` `:root`)

Light = `:root`; Dark = `:root[data-theme='dark']`. Hybrid uses Dark for chrome and Light on the page.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | `#ffffff` | `#18181b` | page, inputs, main content, opaque edited box |
| `--bg-subtle` | `#f9f9fb` | `#1d1d21` | callouts, code blocks, table headers, page panel, pages panel, row hover |
| `--bg-sidebar` | `#f7f7f8` | `#141416` | ribbon, rail, sidebar |
| `--bg-hover` | `rgba(15,15,30,.05)` | `rgba(255,255,255,.06)` | hover/pressed-ish fills, inline code bg, chips, neutral badges |
| `--bg-pressed` | `rgba(15,15,30,.09)` | `rgba(255,255,255,.10)` | button :active, canvas box move bar |
| `--bg-active` | accent 9 % | accent 15 % | selected row (rail, sidebar, settings nav) |
| `--bg-elevated` | `#ffffff` | `#232328` | popovers, menus, cards, secondary buttons, modals |
| `--bg-overlay` | `rgba(10,10,20,.32)` | `rgba(0,0,0,.5)` | modal backdrop, phone drawer backdrop, sheet surround |
| `--bg-inverse` | `#1f1f23` | `#f4f4f5` | tooltips, toasts |
| `--border` | `#e7e7ea` | `#2c2c32` | all hairlines |
| `--border-strong` | `#d4d4d8` | `#3a3a42` | focused box border, quote bar, page-link underline, title placeholder |
| `--text` | `#1f1f23` | `#ececef` | body text |
| `--text-2` | `#52525b` | `#b4b4bc` | secondary text, icon buttons, crumbs |
| `--text-muted` | `#686871` | `#9d9da6` | muted text, idle icons, placeholders in content |
| `--text-placeholder` | `#75757f` | `#8e8e98` | input placeholders |
| `--text-inverse` | `#fafafa` | `#18181b` | on `--bg-inverse` |
| `--text-on-accent` | `#ffffff` | `#ffffff` | on `--accent-solid` |
| `--accent` | `#4f46e5` | `#8b95f9` | accent text/icons, active rows, links, focus |
| `--accent-hover` | `#4338ca` | `#a5b4fc` | |
| `--accent-soft` | accent 10 % | accent 15 % | selection, active chips, file-card icon bg, mention bg |
| `--accent-inverse` | `#a5b4fc` | `#4f46e5` | toast action |
| `--accent-solid` | `#4f46e5` | `#5b5bd6` | filled buttons, counts, FAB, today markers |
| `--accent-solid-hover` | `#4338ca` | `#4b4bc4` | |
| `--danger` / `-soft` | `#dc2626` / `rgba(220,38,38,.08)` | `#f87171` / `rgba(248,113,113,.12)` | delete items, overdue |
| `--success` / `-soft` | `#16a34a` / `rgba(22,163,74,.10)` | `#4ade80` / `rgba(74,222,128,.12)` | due today, live sync, progress |
| `--warn` / `-soft` | `#d97706` / `rgba(217,119,6,.10)` | `#fbbf24` / `rgba(251,191,36,.12)` | due soon (≤ 6 days), offline |
| `--p1` `--p2` `--p3` | `#dc2626` `#ea8c00` `#2563eb` | `#f87171` `#fb923c` `#60a5fa` | priority flags and rings |
| `--skeleton` / `-shine` | `rgba(15,15,30,.06)` / `.02` | `rgba(255,255,255,.06)` / `.10` | loading shimmer |
| `--page-text-muted` | `#5c5c65` | `#a3a3ac` | muted text on a tinted page |
| `--page-rule` | `rgba(70,110,180,.15)` | `rgba(150,170,220,.12)` | rule lines and grid |

Shadows (light / dark):

| Token | Light | Dark |
|---|---|---|
| `--shadow-xs` | `0 1px 1px rgba(0,0,0,.04)` | `0 1px 1px rgba(0,0,0,.3)` |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,.05)` | `0 1px 2px rgba(0,0,0,.3)` |
| `--shadow` | `0 4px 16px rgba(15,15,30,.08), 0 1px 3px rgba(15,15,30,.06)` | `0 4px 16px rgba(0,0,0,.4), 0 1px 3px rgba(0,0,0,.3)` |
| `--shadow-lg` | `0 24px 64px rgba(15,15,30,.18), 0 2px 8px rgba(15,15,30,.08)` | `0 24px 64px rgba(0,0,0,.55)` |
| `--focus-ring` | `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)` | same |

Other fixed colours: `mark` (search hits) `rgba(250,204,21,.35)`; task flash `rgba(250,204,21,.35)`;
mention of yourself `rgba(250,204,21,.35)`; notification badge `#ef4444` with a 2 pt `--bg` ring;
workspace logo gradient `linear-gradient(135deg, #6366f1, #8b5cf6)`; user / notebook / section
colours from `COLORS` `#6366f1 #0ea5e9 #10b981 #f59e0b #ef4444 #ec4899 #8b5cf6 #14b8a6`, and the
section/notebook colour row `#6366f1 #0ea5e9 #10b981 #f59e0b #ef4444 #ec4899 #8b5cf6 #64748b`.
Avatar initials are white or black, whichever contrasts more with the user colour
(`initialsColor`, WCAG luminance).

### 1.2 States

- Hover (pointer only): `--bg-hover` fill, text to `--text`.
- Pressed: `--bg-pressed` (ghost and secondary buttons); filled buttons also move down 0.5 pt.
- Selected row: `--bg-active` fill + `--accent` text (rail button, sidebar section/page, settings nav,
  tasks panel item). Sections: weight 600; pages: weight 500.
- Disabled: opacity 0.5 (`button:disabled`); ribbon controls opacity 0.4 (`aria-disabled`); menu
  items with a note 0.6.
- Caret: the browser's default = `--text` colour (no `caret-color` set), 1 pt wide (iOS draws its
  own caret: use `tintColor` = `--text`, not the accent). Quick-add input sets `caret-color: var(--text)`.
- Text selection: `::selection { background: var(--accent-soft) }` (accent at 10 %, light; 15 %
  dark); text colour unchanged. Screens: `edit-selection.png`. Ctrl/Cmd-picked ranges: accent 28 %.
- Focus (keyboard): 2 pt accent outline, 2 pt offset (`:focus-visible`).
- Canvas box: see 4.5.2.

### 1.3 Page colour, rule lines (`src/styles/canvas.css`, ribbon › Page)

Page colours (light / dark) replace `--bg` on the whole page including its top bar:
none (= `--bg`), yellow `#fdf8e3` / `#221f1a`, green `#eff7f0` / `#1a1f1c`, blue `#eef4fb` / `#1a1d24`,
purple `#f5f1fb` / `#1e1b24`, pink `#fcf1f5` / `#221b1f`, grey `#f4f4f5` / `#1f1f22`. On a tinted page
`--text-muted` and `--text-placeholder` become `--page-text-muted`.

Rule lines: `--rule: 28px`, `--rule-inset: 7px`. Lines: 1 pt `--page-rule` line at the bottom of
every 28 pt band. Grid: the same horizontal lines plus 1 pt vertical lines every 28 pt. The pattern
starts at the canvas surface's origin shifted down 7 pt and spans the whole page width (from the
note area's left edge, not the surface), from the surface top downward. Tables and the box being
edited are opaque (`--bg`), so lines don't run through them. Screen: `page-settings-and-ink.png`
(blue + grid).

### 1.4 Accents (`src/styles/accents.css`)

`--accent-soft` and `--bg-active` follow `--accent`. Light / dark values:

| Accent | `--accent` | `--accent-hover` | `--accent-solid` | `--accent-solid-hover` | `--accent-inverse` |
|---|---|---|---|---|---|
| Blue (default) | `#4f46e5` / `#8b95f9` | `#4338ca` / `#a5b4fc` | `#4f46e5` / `#5b5bd6` | `#4338ca` / `#4b4bc4` | `#a5b4fc` / `#4f46e5` |
| Purple | `#7e22ce` / `#c084fc` | `#6b21a8` / `#d8b4fe` | `#7e22ce` / `#9333ea` | `#6b21a8` / `#7e22ce` | `#c084fc` / `#7e22ce` |
| Teal | `#0d6d65` / `#2dd4bf` | `#115e59` / `#5eead4` | `#0d6d65` / `#0f766e` | `#115e59` / `#115e59` | `#2dd4bf` / `#0d6d65` |
| Green | `#13733a` / `#4ade80` | `#166534` / `#86efac` | `#13733a` / `#15803d` | `#166534` / `#166534` | `#4ade80` / `#13733a` |
| Orange | `#b53d0b` / `#fb923c` | `#9a3412` / `#fdba74` | `#b53d0b` / `#c2410c` | `#9a3412` / `#9a3412` | `#fb923c` / `#b53d0b` |
| Red | `#b91c1c` / `#fb8585` | `#991b1b` / `#fca5a5` | `#b91c1c` / `#b91c1c` | `#991b1b` / `#991b1b` | `#fb8585` / `#b91c1c` |
| Pink | `#be185d` / `#f472b6` | `#9d174d` / `#f9a8d4` | `#be185d` / `#be185d` | `#9d174d` / `#9d174d` | `#f472b6` / `#be185d` |
| Graphite | `#3f3f46` / `#a1a1aa` | `#27272a` / `#d4d4d8` | `#3f3f46` / `#52525b` | `#27272a` / `#3f3f46` | `#a1a1aa` / `#3f3f46` |

Settings swatches (`ACCENTS` in `src/store/ui.ts`): Blue `#4f46e5`, Purple `#9333ea`, Teal `#0d9488`,
Green `#16a34a`, Orange `#ea580c`, Red `#dc2626`, Pink `#db2777`, Graphite `#52525b`.

### 1.5 Text colours and highlights (`src/styles/colors.css`)

Stored as names. Light (also Hybrid's page) / dark:

| Name | Text `--tc-*` | Highlight `--hl-*` |
|---|---|---|
| gray | `#6b6b74` / `#a3a3ad` | `#e9e9ec` / `#3a3a41` |
| red | `#c42b2b` / `#f47c7c` | `#fde0de` / `#5b2727` |
| orange | `#b4500c` / `#f5a05a` | `#fde6cf` / `#563318` |
| yellow | `#8c6400` / `#e9c53a` | `#fcf0b0` / `#4f4313` |
| green | `#22783a` / `#5fcf80` | `#d9f2dc` / `#1f4529` |
| blue | `#1f62c4` / `#6ea8f7` | `#dbe8fd` / `#1e3a5c` |
| purple | `#7a3fd6` / `#b893f5` | `#ebe2fc` / `#3c2b5e` |
| pink | `#bb2a75` / `#f07fb6` | `#fbdeec` / `#552240` |

A highlight with no colour name is yellow. Highlights: radius 3, padding 0 1 pt, continue across
line breaks (`box-decoration-break: clone`). Labels: Default, Gray, Red, Orange, Yellow, Green, Blue,
Purple, Pink (`COLOR_LABELS`, `src/editor/colors.ts`).

### 1.6 Code highlighting (`src/styles/editor.css`, highlight.js classes)

Light / dark (dark applies under `prefers-color-scheme: dark`, i.e. the OS setting, not the app theme):
comment & quote `#8b8b94` italic (both); keyword, selector-tag, literal, section, link `#7c3aed` /
`#c4b5fd`; string, class title, template-tag, addition `#15803d` / `#86efac`; number, symbol, bullet,
constant `#c2410c` / `#fdba74`; title, function title, name `#2563eb` / `#93c5fd`; attr, attribute,
property, variable, template-variable `#0e7490` / `#67e8f9`; type, built_in, params `#b45309` /
`#fcd34d`; meta, regexp `#be185d` / `#f9a8d4`; deletion `#dc2626` / `#fca5a5`; strong 600.

## 2. Typography

### 2.1 Scale and base

Tokens: `--text-2xs` 10.5, `--text-xs` 11.5, `--text-sm` 12.5, `--text-base` 14, `--text-md` 15,
`--text-lg` 17, `--text-xl` 20, `--text-2xl` 24, `--text-3xl` 32. Line heights: tight 1.3, normal
1.5, loose 1.7. `--tracking-tight` −0.015 em. Body: 14 / 1.5 (21) regular, `--text`, antialiased.
**Phones (≤ 760): body 15 / 1.5.** Weights used: 400, 500, 600, 650, 700.

### 2.2 UI text

| Element | Size / line | Weight | Colour | Notes |
|---|---|---|---|---|
| Rail button label | 10.5 / 1 | 600 | `--text-muted`; active `--accent` | under a 20 pt icon, gap 3 |
| Sidebar notebook picker | 14 | 650 | `--text` | truncates |
| Sidebar group heading (SECTIONS, RECENT, FAVOURITES, VIEWS) | 11.5 | 600 | `--text-muted` | uppercase, tracking 0.04 em |
| Section row | 14 / 30 row | 400; selected 600 | `--text-2`; selected `--accent` | phone 15 / 44 row |
| Page row | 14 / 28 row | 400; active 500 | `--text-2`; active `--accent` | phone 15 / 40 row |
| Row count (`.sb-count.subtle`) | 11 | 400 | `--text-muted`, opacity 0.8 | CircleCheck 11 + n |
| Panel title ("Tasks", section name) | 15 | 650 | `--text` | |
| Tasks panel item | 14 / 32 row | 500 | `--text-2`; active `--accent` | |
| Ribbon button word (≥ 1280 pt only) | 13 | 500 | `--text-2` | |
| Ribbon group name (≥ 1280 pt only) | 10.5 / 14 | 400 | `--text-muted` | under the group |
| Ribbon block-type button | 13 | 500 | `--text` | "Normal", "Heading 1"… |
| Page top bar crumbs | 13 / 19.5 | 400 | `--text-2` | |
| Save status ("Saved") | 12 | 400 | `--text-2`; offline: warn 65 % into text | hidden words on phones |
| Menu item | 14 / 32 row | 400 | `--text`; danger `--danger` | phone 15 (sheet) |
| Menu hint (shortcut) | 12 | 400 | `--text-muted` | right side, 16 pt left margin |
| Menu label row (MY NOTEBOOKS, THEME, INSERT BLOCK) | 11.5 | 600 | `--text-muted` | uppercase, tracking 0.03 em |
| Menu group title (page menu notebooks) | 11.5 | 600 | `--text-muted` | not uppercase |
| Slash item title / description | 14 / 12 | 500 / 400 | `--text` / `--text-muted` | |
| Button (`.btn`) | 14; sm 13; lg 15 | 500 | | |
| Input | 14 (phone 16) | 400 | `--text`; placeholder `--text-placeholder` | |
| Chip | 12 (11.5 in task lines, computed) | 500 | `--text-2` | |
| Badge | 10.5 / 1 | 600 | per tone | tabular numbers |
| Tooltip | 11.5 / 1.4 | 500 | `--text-inverse` on `--bg-inverse` | |
| Toast | 13.5 | 400 | `--text-inverse` | action 600 `--accent-inverse` |
| Tasks view h1 | 26 (phone 24) | 700 | `--text` | tracking −0.02 em |
| Tasks view subtitle | 14 | 400 | `--text-muted` | |
| Task group title | 13.5 | 650 | `--text`; Overdue `--danger` | count 12/500 muted |
| Task row title | 14 / 1.4 | 400 | `--text`; done: muted + strike | |
| Task row meta chips | 12 | 400 | due tone colours | |
| Phone top bar title | 15 | 600 | `--text` | subtitle 10.5 muted |
| Phone tab label | 10.5 | 500 | `--text-muted`; active `--accent` | icons 22, active stroke 2.3 |
| Sign-in title | 22 | 700 | `--text` | tracking −0.02 em |
| Sign-in app name | 17 | 700 | | |
| Sign-in labels | 13 | 500 | | |
| Empty state heading | 15 (empty-state strong), 22 (empty section h1) | 700 | `--text` | |

### 2.3 Page and box content (`.ProseMirror`, `src/styles.css` "Page / editor", `src/styles/editor.css`)

Base: **16 / 1.7 (27.2 pt lines)**, `--text`, `overflow-wrap: break-word`. Phones: **16.5 / 1.7**.
Space between top-level blocks: 0.4 em (6.4 pt). Paragraph margins 0.

| Block | Style |
|---|---|
| Page title (above the canvas, not in a box) | 36 / 1.2, 700, tracking −0.025 em; placeholder "Untitled" in `--border-strong`. Phone 28. |
| Page sub-line ("Edited 3m ago by you") | 12.5 / 1.5, `--text-muted`; 6 pt above, 22 pt below |
| Page icon (emoji) | 56 / 1.1 (phone 44), 2 pt 4 pt padding, −4 pt left |
| h1 | 1.75 em = 28, line 1.3, margin 1.2 em top / 0.3 em bottom, tracking −0.02 em, 700 |
| h2 | 1.35 em = 21.6, line 1.35, margin 1.1 em / 0.25 em, tracking −0.01 em, 700 |
| h3 | 1.12 em = 17.9, line 1.7 (inherited), margin 1 em / 0.2 em, 700 |
| Bullet / numbered list | padding-left 1.6 em, margin 0.3 em 0; items' paragraphs margin 0. Markers by depth: ordered 1. → a. → i. → 1) → a) → i) → repeat; bullets disc → circle → square → repeat. A list typed as "a. "/"I. " keeps its type; typed "1) " etc. keeps ")" |
| Checklist (plain) | no bullet, padding-left 0.2 em; row = flex, gap 8; native checkbox 15×15 in accent colour, 0.2 em down; checked text `--text-muted` + line-through |
| Quote | 3 pt left bar `--border-strong`, padding-left 1 em, margin 0.6 em 0, `--text-2` |
| Code block | `--bg-subtle`, 1 pt `--border`, radius 8, padding 34 pt top (language bar) 14 sides 12 bottom, mono 13.5; language picker 12 `--text-2` top-left (4 pt down, 6 pt in); "Copy" 12 top-right, shown on touch |
| Inline code | mono 0.88 em, `--bg-hover`, padding 1 pt 5 pt, radius 4 |
| Link | `--accent`, underline, offset 2 pt |
| Divider | 1 pt `--border`, margin 1.4 em 0 |
| Image | max-width 100 %, radius 8, margin 0.6 em 0; selected 2 pt accent outline; resize handles 5×44 bars rgba(0,0,0,.55) with a 1.5 pt white ring, at the left/right middles |
| Table | full width, fixed layout, collapse; cells 1 pt `--border`, padding 6 10, min 60 wide, top aligned; header row `--bg-subtle`, 600, left aligned; selected cell accent-soft overlay; margin 0.8 em 0 |
| Callout | flex, gap 10, padding 12 14 12 12, margin 0.6 em 0, `--bg-subtle`, 1 pt `--border`, radius 8; emoji 19 in a 28×28 button radius 6; body blocks spaced 0.4 em |
| Toggle | 24×27 button with a 6×9 pt triangle (`--text-muted`), rotates 90° when open; summary 500; content padding-left 2, 0.2 em below; placeholder "Toggle" |
| File card | margin 0.4 em 0; row max 520 wide, padding 8 10, gap 10, 1 pt `--border`, radius 8, `--bg`; icon tile 34×34 radius 7 `--accent-soft` bg, `--accent` icon (FileText etc. per type); name 500 `--text` ellipsis; size 12 muted; download button 28×28 `--text-2` |
| Mention | padding 0 3, radius 4, `--accent-soft` bg, `--accent` text, 500, no wrap; yourself: yellow `rgba(250,204,21,.35)`, `--text` |
| Page link | inline-flex, gap 3, padding 0 3, radius 4, `--text`, 500, 1 pt bottom border `--border-strong`, no underline; page icon (emoji, or FileText) `--text-muted` 0.95 em; missing page `--text-muted` 400 |
| Highlight / text colour | section 1.5 |
| Comment anchor | text with an open comment thread: background `rgba(250,204,21,.28)` + 2 pt bottom border `rgba(234,179,8,.8)`; the active thread `rgba(250,204,21,.55)` (`CommentHighlights` in `collabCommentsPanel.tsx`). Resolved threads: no mark. Example: "Search feels slow…" in `page-meeting.png` |
| Empty-line placeholder | "Type '/' for commands…" in `--text-muted` at 70 % opacity (only in the focused editor, or a lone empty line); headings "Heading 1/2/3"; callout/toggle body "Type something…" |

### 2.4 Task lines in a page (`TaskRef.tsx`, `src/styles.css` "Embedded tasks")

- Row: flex, top-aligned, gap 8, min-height 36, padding 3 6 3 4 with a 26 pt hanging left
  margin (the circle sits in the text column; drag handle and fold arrow in the 26 pt gutter),
  radius 8. Hover `--bg-subtle`; selected `--accent-soft`. Phone: no hanging margin (padding-left 4),
  wraps.
- Circle (`.task-check`): 18×18 (phone 22), 1.6 pt ring `--text-muted`, 5 pt from the row top.
  Priority 1/2/3: ring `--p1/2/3` and a 10 % fill of it. Done: filled with the ring colour, white
  check (Check icon), the p4 ring colour is `--text-muted`. Pressed: scale 0.9.
- Title: 16 / 1.5 (24), padding 2 0, wraps (`pre-wrap`, `overflow-wrap: anywhere`); done: line-through,
  `--text-muted`. Placeholder "Task name — e.g. “Draft agenda tomorrow p2 @sam”" (muted 70 %).
- Meta (right side, gap 4, 2 pt down): checklist count chip (SquareCheck 12, "1/2", 11.5 `--text-2`,
  `--success` when complete), priority chip (Flag 13, filled in the priority colour), due chip
  (CalendarDays 13 + "30 Nov"/"Today"/"Tomorrow"/weekday, Repeat 11 if recurring; colours: overdue
  `--danger`, today `--success`, ≤ 6 days `--warn`, later `--text-2`), assignee avatar 20, "Add
  checklist" (ListPlus 13 + words, 11.5; words hidden on phones), open (Maximize2 13, 24×24). Chips:
  height 22, padding 0 7, radius 6, `--bg-hover`. On touch, empty chips (no priority/date/assignee)
  show as outlined/blank chips; with a mouse they appear on hover only. Phones: only checklist
  count + due chip + add checklist + open.
- Notes under a task: indented 26 pt, 10 pt padding, 2 pt `--border` guide line on the left (dashed
  when done); fold arrow (ChevronDown/Right in 22×22) left of the circle; collapsed shows a count
  chip.
- Missing task: FileX2 15 muted + "This task was deleted or is not visible to you." (12.5 muted) and a
  ghost "Remove from page" button.

## 3. Layout

### 3.1 Shell (tablet, > 760 pt)

```
┌──────────────────────────── Ribbon (full width, never scrolls) ───────────────────────────┐
├──────┬───────────────┬────────────────────────────────────────────────┬──────────────────┤
│ Rail │ Sidebar panel │ Main: route (page / tasks / notes / settings)  │ Page panel (opt.)│
│ 64   │ 216 (180–420) │ page: sticky top bar 48 + scrolling article    │ 320              │
└──────┴───────────────┴────────────────────────────────────────────────┴──────────────────┘
```

- `.app` adds `padding-top: env(safe-area-inset-top)` on tablets (the ribbon starts under the status
  bar). Phones pad their own top bar.
- Rail 64 wide, `--bg-sidebar`, 1 pt right border, padding 10 0; views at the top (gap 4), tools at
  the bottom.
- Sidebar: default width **216** (`SIDEBAR_DEFAULT`, `sidebarState.ts`; the JS sets `--sidebar-w`, the
  CSS fallback 264 is not used), min 180, max 420, resizable (6 pt grabber on its right edge, accent
  2 pt line on hover/drag). `--bg-sidebar`, 1 pt right border. A second "pages" panel (200 wide,
  160–380, `--bg-subtle`, 1 pt left border) exists only ≥ 1200 pt wide; below that the pages are listed
  under each section in the tree (folded). Both iPad sizes are folded.
- Sidebar open/closed (rail button "Hide sidebar"/"Show sidebar", Cmd+\\) is remembered; first run:
  open if the window is ≥ 900 wide, closed otherwise (iPad portrait starts closed:
  `ipad-portrait/page-canvas-boxes.png` vs `page-canvas-boxes-sidebar-open.png`).
- Page side panel (Tasks on this page / Comments): 320 wide, `--bg-subtle`, 1 pt left border.

### 3.2 Phone (≤ 760 pt)

- Top bar (`MobileTopBar`): 48 + safe-top, padding 0 4 pt, bottom 1 pt `--border`, translucent `--bg`
  92 % + blur 14. Left: 44×44 Menu (21) or Back (ChevronLeft 22) on a page; centre title 15/600 with a
  10.5 muted subtitle (the workspace) once the screen's own heading scrolls away, otherwise the
  workspace name alone; right: bell + Search (20) 44×44.
- Tab bar: fixed bottom, 60 + safe-bottom, top 1 pt `--border`, `--bg` 90 % + blur 14; four equal tabs
  Notes / Tasks / Calendar / Search (icons 22, label 10.5/500, gap 3, active `--accent` and stroke
  2.3). FAB "Add task": 56×56 circle `--accent-solid`, Plus 26 stroke 2.25, 16 pt above the tab bar,
  16 pt from the right, shadow `0 8px 24px accent-solid 45 %` + `--shadow`; not on pages or Settings.
- Drawer (the sidebar): fixed left, width min(86 vw, 320) (320 on a 390 pt phone), slides in (`translateX(-102%)` → 0, 180 ms ease-out), `--shadow-lg` when open, backdrop
  `--bg-overlay`; top: workspace switcher (36 high), then the notes panel, bottom: the user row (avatar
  22 + name) above a 1 pt border. Swipe from the left 24 pt edge opens it; swiping it left closes.
  Rows 44 high, font 15; row actions (+, ⋯) always visible (36×36 hit).
- Page on a phone: page top bar 44 high, padding 0 8 0 16, no crumbs, Undo/Redo shown in it; article
  padding 12 20 40vh; title 28; text 16.5; canvas boxes **stacked** in reading order, full width,
  padding 12 0, 1 pt `--border` between boxes, no drag/resize; a lone box is just the page's text
  (padding 4 0 0); "Add a text box" and "Add a task to this page" at the end.
- Menus open as bottom sheets when `(max-width: 760px) and (pointer: coarse)`: 8 pt from the sides and
  bottom (+ safe-bottom), padding 8, radius 16, the rest of the screen dimmed by `--bg-overlay`,
  items ≥ 44 high, 15 pt. Modals become bottom sheets (radius 16 16 0 0); the task detail sheet is
  92 vh high.

### 3.3 Breakpoints (from the CSS media queries and `useMediaQuery`)

| Condition | What changes |
|---|---|
| `max-width: 760px` (`useIsMobile`) | Phone shell (3.2): no ribbon, no rail, drawer sidebar, tab bar, top bar, stacked boxes, page panel as a bottom sheet (max 55 vh, radius 16 16 0 0), body 15, inputs 40 high / 16 pt, buttons 40 high, sidebar rows 44, settings as grouped lists, task rows padding 12 4 and circles 22, tasks padding 20 16 40 |
| `(max-width: 760px) and (pointer: coarse)` | context menus as bottom sheets |
| `pointer: coarse` or ≤ 760 | 44 pt hit areas, MiniCalendar cells 40, filter chips 36 high |
| `hover: none` | empty task chips, "Add checklist" words and the open button always shown; block drag handle hidden |
| `hover: none` and ≤ 600 | "Add checklist" words hidden again |
| ≤ 1023 | Ribbon smallest: buttons 30 high, min 25 wide, padding 0 3, icons 16, block-type button 84 wide, separators margin 0 2, ribbon padding-left 6 right 4, gap 0 |
| ≤ 1199 | Pages folded into the sections tree (one sidebar panel) |
| ≤ 1279 | Ribbon compact: no group names, no button words, padding 5 top/bottom, separators 22 high centred |
| < 900 (first run only) | Sidebar starts closed |
| ≥ 1280 | Ribbon full: min-height 70, padding 6 10 3 12, group names under groups, words on key buttons |
| container ≤ 700 (page scroller width) | Outline rail hidden |
| ≥ 761, Hybrid | page inset 6 pt with rounded top corners and shadow |

## 4. Components

### 4.1 Ribbon (`src/editor/Toolbar.tsx` `Ribbon`/`RibbonFrame`, `src/components/shell/SectionRibbons.tsx`, `src/styles/toolbar.css`)

One ribbon per screen; **there are no ribbon tabs** (it is OneNote's Home tab only). Which ribbon
depends on the route: page → note ribbon; Tasks views → Tasks ribbon; Calendar → Calendar ribbon;
Notes overview / empty section → Notes ribbon; Settings → Settings ribbon. Phones have no ribbon
(they use the floating toolbar over selected text and the keyboard bar).

Frame: full window width, `--bg-sidebar`, 1 pt bottom `--border`, one row, never wraps, items
centred vertically; gap 2; group = column of items (gap 2) + group name; separators 1 pt
`--border` (full height minus 2/4 pt at ≥ 1280; 22 high centred below). A flexible spacer pushes
the last group (History) and the collapse chevron (ChevronUp 16, 28×28) to the right.
Measured heights: 47 at 1180 wide, 41 at 820 wide, ≥ 70 at ≥ 1280.

Buttons (`.bm-btn.rb-btn`): 36 high, min 36 wide, padding 0 8, radius 6, icon 18 (`svg` set by CSS,
stroke 2 → 1.5 pt lines), colour `--text-2`; hover `--bg-hover` + `--text`; active (pressed toggle,
e.g. Bold on) `--accent` on `--accent-soft`; disabled opacity 0.4. With words (≥ 1280): gap 6, 13/500.
Menu buttons add ChevronDown 12 at 70 % opacity, −2 pt left margin. Count badge (Tasks filters):
16 high, min 16, radius 8, `--accent-solid`, 11/600 white. Block-type button: min 124 wide (84 at
≤ 1023), 36 high, `--bg` fill, 1 pt `--border`, radius 6, label 13/500 `--text` + ChevronDown 14.
Collapsed ribbon: 30 high strip, padding 0 10 0 16, group names joined by " · " in 11.5 muted on the
left, "Show ribbon" + ChevronDown 14 (12.5/500, 26 high) on the right. Screens:
`ribbon-page-idle.png`, `ribbon-page-active.png`, `ribbon-collapsed.png`.

Note ribbon groups (icons in order; `title` tooltips in parentheses):

| Group | Controls |
|---|---|
| Text | Block type menu (Normal ¶ Pilcrow, Heading 1, Heading 2, Heading 3, Quote, Code; items 6 10 padding, 14 pt; H1 18/700, H2 16/650, H3 14.5/600, Quote italic with a 3 pt left bar, Code mono 13; shortcut on the right 11.5 muted: Ctrl/⌘+Alt/⌥+0/1/2/3/C) · Bold · Italic · Underline · Strikethrough · Text colour (Baseline 16 with a 3 pt colour bar under it) · Highlight (Highlighter 16 + bar) · Clear formatting (RemoveFormatting) |
| Lists | Bulleted list (List) · Numbered list (ListOrdered) · Decrease indent (IndentDecrease) · Increase indent (IndentIncrease) · Task split button: CircleCheck + "Task" word, arrow (ChevronDown 14, 18 wide) → "Plain checkbox" (ListChecks 16) |
| Insert | Table (Table, word "Table") · Image (ImagePlus) · File attachment (Paperclip) · Link (Link2) · Link to page (FileSymlink) · Divider (Minus) |
| Table (contextual, only with the caret in a table) | tinted `--accent-soft`, 2 pt accent top border, radius 0 0 6 6, name in accent 600; Insert row above (BetweenHorizontalStart) · Row below (BetweenHorizontalEnd) · Insert column left (BetweenVerticalStart) · Column right (BetweenVerticalEnd) · Header row (PanelTop) · Merge cells (TableCellsMerge) · Split cell (TableCellsSplit) · Delete row (Rows3) · Delete column (Columns3) · Delete table (Trash2) |
| Page | Page colour (PaintBucket with a 3 pt bar in the page tint; menu: "Page colour" label + 4-column grid of 32×32 swatches radius 7, 1 pt `--border-strong`, selected 2 pt accent ring; "No colour" is a diagonal strike) · Rule lines (Rows3; menu None / Lines (Rows3) / Grid (Grid3x3)) · Print (Printer) · Print selection (only with boxes/text picked) |
| View | Outline (ListTree), pressed when the outline rail is shown |
| History (right) | Undo (Undo2) · Redo (Redo2) |

With no editor focused (`ribbon-page-idle.png`) the editing controls are disabled (0.4) with the
tooltip "Click in a page to format"; Page and View stay enabled. Colour menus: "Text colour" /
"Highlight" label (12/500 muted, padding 2 4 6) and a 3×3 grid of 32×32 tiles (radius 7, 1 pt
`--border`, `--bg-elevated`, "A" 15/600 in the colour; highlight tiles filled with the highlight,
"Default" highlight is a 18×2 muted diagonal). Ribbon dropdowns (`.tb-pop`): 6 pt below the button,
min 160 wide, padding 4, `--bg-elevated`, 1 pt `--border`, radius 10, `--shadow-lg`.
Screens: `ribbon-menu-*.png`.

Section ribbons (buttons as above):
- Tasks (`ribbon-tasks.png`): New (Plus "New task") | Show: Today (Sun), Upcoming (CalendarRange),
  My Tasks (Inbox), All tasks (ListChecks), current pressed | Organise: Group (Layers), Sort
  (ArrowUpDown) | Filter: Status (Eye), Assignee (User), Tags (Tag), Team (UsersRound), Priority
  (Flag), More filters (SlidersHorizontal), Clear filters (FilterX) | Views: Saved views (Bookmark),
  Save view (BookmarkPlus) | Print (Printer).
- Calendar (`ribbon-calendar.png`): New task | Navigate: Today (CalendarDays), Previous/Next
  (ChevronLeft/Right) | View: Week (CalendarRange), Month (CalendarDays) | Filter: Mine (User),
  Everyone (Users), Tags (Tag), Team (UsersRound).
- Notes (`ribbon-notes.png`): New: New page (FilePlus), From template (LayoutTemplate), New section
  (FolderPlus), New notebook (BookPlus) | Import (Upload) menu: "From OneNote…", "Markdown files…".
- Settings (`ribbon-settings.png`): Navigate: Back to notes (ArrowLeft).

### 4.2 Rail (`src/components/shell/Rail.tsx`)

Buttons 52 wide, column (icon 20 over label 10.5/600, gap 3), padding 7 0 6, radius 9, `--text-muted`;
hover `--bg-hover`; active `--bg-active` + `--accent` and a 3×(h−20) accent bar at the rail's left edge
(6 pt left of the button), radius 0 3 3 0. Views: Notes (BookOpen), Tasks (ListChecks), Calendar
(CalendarDays). Foot (40×40 each, icons 19): Hide/Show sidebar (PanelLeftClose/PanelLeftOpen),
Search (Search), notifications bell (Bell, red count badge), workspace switcher (28×28 logo tile,
radius 8, gradient, initial 14/700 white), account (Avatar 26). Gap 4 between buttons.

### 4.3 Sidebar (`src/components/Sidebar.tsx`, `shell/NotesPanel.tsx`, `shell/notesRows.tsx`, `shell/TasksPanel.tsx`)

Notes panel (`sidebar.png`):
- Head: 52 min-height, padding 10 8 6. Notebook picker button: 36 high, padding 0 8, radius 8, gap 8;
  notebook tile 22×22 radius 6 in the notebook colour, initial 12/700 white; name 14/650; Lock 12 if
  private; ChevronDown 14 muted at the right; then a "⋯" (MoreHorizontal 15) 24×24 "Notebook options"
  always shown.
- Scroll area padding 4 8 16. Groups: heading 26 min-height (button 22 high, padding 0 6, radius 4,
  11.5/600 uppercase muted, optional icon 12 (Clock for RECENT), ChevronDown 12 that is hidden until
  hover and rotated −90° when closed), optional "+" (Plus 15, 24×24) on the right; groups 12 apart.
  Order: FAVOURITES (only if any; empty: "Drop a page here to pin it"), RECENT (folded by default, up
  to 5), SECTIONS.
- Section row: 30 high (phone 44), padding-left 6 + 14 × depth, radius 6, gap 6: chevron (13 in a 14
  slot, muted; hidden for leaves), colour tab 4×14 radius 2, name, template badge, actions (+ "New
  page", ⋯ "Section options", 24×24) on hover. Children: margin-left 18, 1 pt `--border` line on the
  left, padding-left 4.
- Page row: 28 high (phone 40), padding-left 6 + 14 × (depth+1) + 20 (= 40 at the top level), icon 14
  (the page's emoji at 13, else FileText muted; Lock if locked), title (truncated, "Untitled"), open
  task count (CircleCheck 11 + n, 11 muted 80 %), ⋯ "Page options" on hover.
- Empty section in the tree: "+ New page" row (Plus 14, muted).
- Tasks panel (`tasks-*.png`): title "Tasks" 15/650; "+ Add task" (accent, Kbd "Q"), then Today
  (Sun), My Tasks (Inbox), Upcoming (CalendarRange), All tasks (ListChecks), Team (Users) rows (32
  high, padding 0 10, radius 7, gap 10, icon 16, 14/500 `--text-2`), counts as neutral badges (Today
  red when overdue); VIEWS group with saved views (Bookmark 15) and "+ New view".
- Calendar panel: mini month calendar (cells square, 11.5, today accent 700, selected accent-solid).

### 4.4 Page top bar (`src/pages/PageView.tsx`)

48 high (phone 44), padding 0 16 0 20 (phone 0 8 0 16), gap 12, sticky at the top of the page
scroller, `--bg` at 88 % + blur 10 (takes the page colour). Left: crumbs 13 `--text-2`: notebook dot
(8×8 in its colour) + notebook name, ChevronRight 14 muted, section path. Right (gap 6): presence
avatars (overlapping −6, 2 pt `--bg` ring), phone-only Undo/Redo, save status (Check 14 + "Saved" /
Loader "Saving…" spinning / CloudOff "Offline" / "Connecting…"), "Tasks on this page" (ListTodo 18,
32×32 ghost, count badge 16 high accent-solid 10/600 at its top right), "Comments" (MessageSquare 18,
badge), "Share" secondary small button (UserPlus 14 + "Share", 28 high), "Page options" (MoreHorizontal
18, 32×32).

### 4.5 Page surface and canvas boxes (`src/editor/CanvasEditor.tsx`, `src/styles/canvas.css`)

#### 4.5.1 Geometry

- Article padding: 32 top, 40 right, 30 vh bottom, **51 left** (phone 12 20 40vh). The 51 = 40 pt
  handle gutter + 11 pt (a box's 1 pt border + 10 pt padding), so a box at x = 0 has its text exactly
  under the title. Order: page icon row (28 min-height with "Add icon" (SmilePlus 15) when there is no
  icon; hidden until hover with a mouse, always on phones), title, sub-line, canvas, backlinks.
- Canvas viewport: margin 0 −8 0 −51, padding 14 8 0 40, scrolls sideways; the surface origin is 40 pt
  in from the note area's left edge and 14 pt below the sub-line. Surface: at least the visible area,
  grows to fit boxes + 240 right / 320 down; min-height 320.
- Box coordinates are page points (`CANVAS_SCALE = 1`): x, y from the surface origin, w as stored.
  **Wide boxes** (`wide: true`, e.g. a document's main box) are drawn as wide as the visible note area
  minus 40 pt on the right (stored w 686 is only a fallback). New box by click: 360 wide, 12 pt above
  the click; min 120, max 2400 wide. Measured at 1180 wide with the sidebar open: wide box x 321
  (window), w 819; text x 332.

#### 4.5.2 Box chrome

| State | Look |
|---|---|
| Idle | transparent background, 1 pt transparent border, radius 6, padding 6 10 |
| Hover (pointer) | border `--border` |
| Editing (focus inside) / held | border `--border-strong`, background `--bg` (opaque); move bar and width handle shown |
| Selected (Escape in a box) | border `--accent` + 2 pt `--bg-active` ring |
| Picked (Ctrl/Cmd-click, for print) | border accent, 2 pt `--accent-soft` ring, `--accent-soft` fill |
| Move bar | 12 high strip on the top edge (from −9 to +3), full width + 1 each side, radius 6 6 0 0, `--bg-pressed` while hover/editing; drag to move |
| Width handle | 9 wide hit strip on the right edge (−5); visible part 3×24 bar radius 2 `--border-strong`, vertically centred, while hover/editing |

Screens: `edit-caret.png` (box "Box c" in edit: opaque, strong border, grey move bar on top).
Phones: no chrome; the focused stacked box gets a 3 pt accent bar on its left (inset 10 pt) when
selected.

Box content: `.ProseMirror` min-height 1.7 em; a wide box not yet typed in keeps min-height 200 (room
to click). A blank page shows "Start with a template, or just type" (13 muted) with template cards
(padding 8 12, 1 pt border, radius 8, emoji 18 + name 14 `--text-2`) under the empty first box.
Under the canvas: "+ Add a task to this page" (13 muted, Plus 15, accent on hover), and on phones "+
Add a text box". Context menus (pointer: right-click): box → Cut (Scissors, Ctrl+X), Copy (Copy,
Ctrl+C), Duplicate (CopyPlus), separator, Delete (Trash2, danger) (`menu-text-box.png`); empty canvas →
Paste (ClipboardPaste, disabled when nothing copied), New text box here (Plus).

#### 4.5.3 Rule lines on (`.has-rules`)

Every line of text is 28 pt; blocks keep no margins (rounded up to whole units by the editor);
headings take two units with their text on the second (h1 padding-top 24, h2 26, h3 28; none when
first); checklists' boxes centred in a unit; callouts and code blocks draw their border as an inset
1 pt shadow with no vertical padding; tables drop cell padding top/bottom and draw cell borders as
inset shadows; task rows 28 high with the circle centred; boxes' text starts 7 pt into a unit.

#### 4.5.4 Outline rail (`src/editor/Outline.tsx`)

Right edge of the page scroller (36 wide area), sticky 72 pt from the top: a column of 16×2 bars
(`--border-strong`; current heading `--accent`), 12 pt apart, 28 wide. On hover it expands to a 240
wide card (`--bg-elevated`, border, radius 8, `--shadow`, padding 6) listing headings (12.5/1.35,
`--text-2`, 4 8 padding). Hidden when the scroller is ≤ 700 wide and on phones. Visible in
`page-*.png` at the top right.

### 4.6 Floating formatting toolbar (`FormattingMenu` in `src/editor/NoteEditor.tsx`)

Shown over a non-empty text selection (not in code blocks). `.bubble-menu`: padding 3, gap 1,
`--bg-elevated`, 1 pt `--border`, radius 10, `--shadow-lg`; flips below the selection when too close to
the top bar. Buttons 30×30 min, radius 6, `--text-2`, icons 16; active accent on accent-soft.
Separators 1×18 `--border`, margin 0 3. Order: Heading 1 · Heading 2 · Heading 3 · Quote | Bold ·
Italic · Underline · Strikethrough · Inline code (Code) · Link (Link2) · Text colour · Highlight |
"Task" (CircleCheck 16 + word, 13/500) · "Comment" (MessageSquare 16 + word). Phones: max width
100 vw − 16, wraps to two rows (`iphone/edit-selection.png`).

### 4.7 Slash menu (`src/editor/SlashMenu.tsx`)

Popover 290 wide, max 320 high (scrolls), 6 pt below the caret line (above it if no room), padding 6,
radius 12, `--bg-elevated`, `--shadow-lg`. Header "INSERT BLOCK" (menu label row style). Items: padding
6 8, radius 7, gap 10; icon tile 36×36, 1 pt `--border`, radius 8, `--bg`, `--text-2`, icon 18; title
14/500; description 12 muted. Active item `--bg-hover`. Items (title — description, icon):
Task — A real task, synced to your dashboard (CircleCheck) · Text — Plain paragraph (Type) · Heading 1
— Large section heading (Heading1) · Heading 2 — Medium section heading (Heading2) · Heading 3 — Small
section heading (Heading3) · Checklist — Simple checkboxes (not tracked as tasks) (CheckSquare) · Add
checklist — A checklist at the top of this task’s notes (its items are not tasks) (ListPlus; only under
a task) · Bulleted list — Simple bulleted list (List) · Numbered list — List with numbering
(ListOrdered) · Toggle — Collapsible section with hidden content (ChevronRight) · Table — Rows and
columns (Table) · Image — Upload an image (Image) · File attachment — Upload any file (Paperclip) · Link
— Link to a web page (or select text and press Ctrl+K) (Link2) · Link to page — Link another page (or
type [[) (FileSymlink) · Quote — Capture a quotation (Quote) · Callout — Highlighted block with an icon
(MessageSquareQuote) · Code block — Code with syntax highlighting (Code2) · Divider — Horizontal line
(Minus). Screens: `slash-menu.png`.

### 4.8 Buttons, inputs, chips, badges, avatars (`src/styles.css` "Controls", `src/components/ui.tsx`)

- `.btn`: inline-flex, gap 6, 32 high, padding 0 12, radius 8, 500. Small 28 / padding 0 10 / 13;
  large 40 / 15. Primary `--accent-solid`, white; secondary `--bg-elevated` + 1 pt `--border` +
  `--shadow-sm`; ghost `--text-2`; danger `--danger` white. Icon buttons 32×32 (sm 24×24 radius 6,
  lg 40×40). Phones: 40 high (except sm/lg), large 44.
- `.input`: 34 high, padding 0 10, 1 pt `--border`, radius 8, `--bg`; focus: accent border + 3 pt
  `--accent-soft` ring; sm 28 / 13; sign-in 40; phones 40 / 16.
- Segmented: `--bg-hover` track, padding 2, gap 2, radius 8; segments 28 high (phone 36), padding 0 12,
  12.5/500 `--text-2`; active `--bg-elevated`, `--text`, `--shadow-sm` + 1 pt `--border` ring.
- Chip 22 high, padding 0 7, 12/500 `--text-2`, `--bg-hover`, radius 6; active accent on accent-soft.
- Badge 18 high, min 18, padding 0 6, pill, 10.5/600; tones neutral (`--bg-hover`/`--text-2`), accent,
  success, warn, danger (soft bg + colour).
- Kbd: 18 high, min 18, padding 0 4, 11/500 muted, `--bg`, 1 pt border with 2 pt bottom, radius 4.
- Avatar: circle, user colour, initials 42 % of the size, 600, tracking −0.02 em; empty = 1.5 pt dashed
  `--border-strong`. Sizes: 20 task lines, 22 phone user row, 26 rail.
- Switch 40×24, knob 20 white; on = `--accent-solid`. Checkbox (native) 15×15 accent.
- Tooltip: `--bg-inverse`, padding 4 8, radius 6, 11.5/500, max 280 wide, `--shadow` (not on touch).
- Toast: bottom centre (20 + safe-bottom; phones above the tab bar), padding 10 10 10 16, gap 12,
  radius 12, `--bg-inverse`, `--shadow-lg`, 13.5; error toasts `--danger`.
- Skeleton: radius 4, shimmer 1.4 s.

### 4.9 Menus and popovers (`Popover`, `Dropdown`, `MenuItem`, `useContextMenu` in `ui.tsx`)

Popover: `--bg-elevated`, 1 pt `--border`, radius 12, `--shadow-lg`, padding 6, min 220 wide, max
100 vw − 16; opens 6 pt below its anchor (start-aligned, or end-aligned for "⋯" buttons; rail menus open
to the right, bottom-aligned), kept 8 pt inside the window; appears with a 4 pt rise + 0.98 scale in
120 ms. Menu item: 32 high, padding 0 10, radius 6, gap 10, text left; icon column 18 wide centred,
icons 15 `--text-muted` (danger items: icon and text `--danger`, hover danger 12 %); trailing hint 12
muted; checkmark Check 14 accent for the current choice. Separator: 1 pt `--border` running to the
popover's edges, 6 pt above and below. Colour row in menus: 20×20 circles, gap 6, padding 8 (phone 32×32,
gap 12). Bottom-sheet form on phones: 3.2.

Menus captured (wording in section 6): page options (`menu-page-options.png`), section
(`menu-section.png`), page row (`menu-page-row.png`), notebook options (`menu-notebook.png`), notebook
picker (`menu-notebook-picker.png`, min 260 wide, max 520 high), workspace switcher
(`menu-workspace.png`, min 240), account (`menu-account.png`, min 248: name 600 + email 12.5 muted,
THEME label, 4-way theme toggle (grid of 4, 42 high cells, icon 14 over 11.5/500 label, track
`--bg-subtle` + 1 pt border radius 8, active cell `--bg` + `--shadow-sm`)), text box
(`menu-text-box.png`).

### 4.10 Tasks view (`src/pages/TasksView.tsx`, `src/pages/tasks/*`, `src/components/TaskRow.tsx`)

- Content padding 36 40 120 (phone 20 16 40, 96 bottom for the FAB), left aligned, full width.
  Header: h1 26/700, subtitle 14 muted, 4 pt between, 20 below.
- Today has a stats card (`.prod-strip`): 1 pt border, radius 12, `--bg-elevated`, padding 14 16;
  numbers 22/700 over 12 muted labels ("done today", "left", "day streak"); a week of 10×32 bars
  (radius 3, today accent) on the right with 10.5 muted day letters; a 3 pt green progress line along
  the bottom.
- Group title: 13.5/650, padding 8 0 6, 1 pt `--border` under it, count 12/500 muted; Overdue in
  `--danger`; groups 22 apart.
- Task row: flex, top aligned, gap 10 (phone 16), padding 10 6 (touch: 12), 1 pt bottom border; hover
  `--bg-subtle`; circle 18 (phone 22) 1 pt down; title 14/1.4; meta line 3 pt below, gap 6 (touch 6 18):
  due (CalendarDays 13 + text, tone colours), priority flag (Flag 13 filled), page link (FileText +
  page title, muted), team (UsersRound + name), tags (pills 18 high, radius 9); avatar 20 on the right.
  Done: strike + muted; just-completed rows fade to 0.55.
- "+ Add task" at the end of a group: 13.5 muted, padding 8 6, Plus.
- Calendar view: 7 columns, day cells min 110 high (week view 360), 1 pt borders; today's date in an
  accent-solid pill; task chips 12, padding 2 6, radius 5, `--bg-hover`, 3 pt left border in the priority
  colour.
- Task detail (`task-detail.png`): a sheet sliding from the right, max 480 wide, full height, 1 pt left
  border, over a dim backdrop (rgba(10,10,20,.18)); head 10 12 with crumb + delete + close; body padding
  20 24: title 20/600, property rows 36 min (label column 120: icon + 13 muted; value buttons 30 high),
  description box (min 120, `--bg-subtle`, border, radius 8), Subtasks, "Created by … · 6m ago".
  Phones: bottom sheet 92 vh, radius 16 16 0 0.

### 4.11 Page side panel (`PagePanel` in `PageView.tsx`)

320 wide, `--bg-subtle`, 1 pt left border; head 48: segmented Tasks (CircleCheck) / Comments
(MessageSquare) + close (X); "0/5 done" (12.5 muted) and a 4 pt progress bar (`--success`); the page's
task rows (padding 8). Phones: bottom sheet above the tab bar, max 55 vh, `--bg-elevated`, radius 16 16
0 0, 36×4 grab handle. Screen: `page-tasks-panel.png`.

### 4.12 Search palette and quick add

- Palette (`search.png`): modal 620 max wide at 12 vh from the top (phones: top sheet), radius 14,
  `--bg-elevated`; input row 52 high, 16 pt text, Search icon; groups (11.5/600 uppercase muted); rows 38
  high (phone 44), radius 8, icon muted, label, right-aligned sub 12.5 muted; active row `--bg-hover`;
  footer 1 pt border with key hints (not on phones). Placeholder "Search pages and tasks, or type a
  command…"; no hits: "No results".
- Quick add (`quick-add.png`): modal 560 max wide (phones: bottom sheet); form padding 14 16 12;
  input 17/500 / 1.4 with recognised tokens highlighted (accent-soft, radius 3), placeholder "e.g. Call
  Sam tomorrow 3pm p1"; "Description" textarea (`--text-2`); chips 28 high, padding 0 9, 1 pt
  `--border`, `--bg` (phones 44 high, padding 0 14): "Due date" (CalendarDays), "Priority" (Flag),
  assignee ("Me" with avatar 14 / "Unassigned" UserRound), "Team" (Users), "Tags" (Tag), page
  (FileText) when on a page, repeat (Repeat) when set; footer above a 1 pt border: "Cancel" (secondary)
  and "Add task" (primary, disabled until there is a title).

### 4.13 Sign-in (`src/pages/Login.tsx`, `sign-in.png`)

Full screen, content centred, padding 24 16; background `--bg-subtle` with a radial accent-soft glow
(1200×600 ellipse at 50 % −10 %). Card: max 400 wide, `--bg-elevated`, 1 pt border, radius 16, padding
32, `--shadow`. Logo row: app icon 34×34 (radius 9, `--shadow-sm`) + "Notivelo" 17/700, gap 10. Title
22/700 tracking −0.02 em, 20 above, 4 below. Subtitle (muted). Form: grid, gap 14, 24 above 18 below;
labels 13/500 over 40-high inputs (gap 6); "Forgot password?" accent 12.5/500 link; full-width primary
large button (40 high, 15/500). Below: "New here? Create an account" (12.5, link accent 500); legal links
"Privacy · Terms · Support" (12.5 muted).

### 4.14 Empty states

| Where | Look and words | Screen |
|---|---|---|
| No page selected (tablet `/notes`) | Notes overview: h1 "Notes", "Recently edited" grid of cards (min 180 wide, padding 14, radius 12, border), then every notebook with its sections and pages | `empty-no-page.png` |
| Empty section (tablet) | centred column, gap 8: FileText 28 muted, h1 section name 22/700, "This section has no pages yet." muted, primary "New page" (FilePlus 15) | `ipad-*/empty-section.png` |
| Empty section (phone) | section screen: Back, title, "New page" secondary small button, "No pages in this section yet." | `iphone/empty-section.png` |
| No notebooks | sidebar "Notebooks" picker with "No notebooks yet. Create one" (12.5 muted + accent link); tablet main shows "Notes" only; phone list "No notebooks yet." | `empty-workspace-*.png` |
| Today, nothing due | ☀️ 34 pt, "You’re all caught up" (15/700), "Nothing due today. Enjoy it — or plan ahead in Upcoming." (muted), centred, padding 40 16 | `empty-tasks-today.png` |
| All tasks, none | "No tasks match these filters." / My Tasks "No tasks assigned to you." / Upcoming "Nothing scheduled." (muted, centred) | `empty-tasks-all.png` |
| Pages panel (≥ 1200 only) | "No pages in this section yet." + "New page"; no section: "Choose a section to see its pages." | — |
| Sections | "No sections yet. Add one" | — |
| Notifications | "You’re all caught up. Mentions, replies and shares show up here." | — |

## 5. Icons

- Library: **Lucide**, via `lucide-react` **1.68.0** (`package.json` `^1.68.0`). 164 distinct icons are
  imported in `src/`; the full list with the sizes each is drawn at and the files using it is
  `docs/rewrite/look/icons/index.md`, and each is exported as `docs/rewrite/look/icons/<name>.svg`.
- Geometry: 24×24 viewBox, stroke `currentColor`, **stroke-width 2 in viewBox units** (it scales with
  the icon: 1.5 pt at 18, 1.33 pt at 16, 1.25 pt at 15, 1.08 pt at 13), round caps and joins, no fill.
  Exceptions: `strokeWidth={3}` on small Check/X/Minus in pickers; FAB Plus 2.25; the phone tab bar's
  active icon 2.3; priority Flag icons are also filled with the priority colour.
- Sizes by place: rail 20 (foot 19); ribbon 18 (≤ 1023: 16); ribbon menu items 16; block-type chevron
  14; menus 15; slash tiles 18; floating toolbar 16; sidebar rows 13–16 (chevron 13, page 14, add 14–15);
  page top bar 18; task line chips 13 (repeat 11, checklist 12); task rows 13; phone top bar 20–22;
  phone tabs 22; FAB 26.
- `lucide-static` is **not** installed and isn't needed: `docs/rewrite/look/export-icons.mjs` builds
  the SVGs from the icon node data in `node_modules/lucide-react/dist/esm/icons/<name>.mjs`
  (`__iconData.node`). Re-run it after icons change.
- For Swift: add the SVGs to an asset catalog (Xcode 15+ takes SVG directly; or convert to single-scale
  PDF), set **Preserve Vector Data** on and **Render As: Template Image**, and tint with the text
  colour of the control. Draw them at the point size listed (e.g. `UIImage.SymbolConfiguration` does
  not apply; size the `UIImageView` 18×18). Because the stroke scales with the size, a single vector
  asset is correct at every size. Do not substitute SF Symbols: the shapes differ.
- Names used by the main screens (Lucide component name → SVG file): see `icons/index.md`; e.g.
  BookOpen `book-open`, ListChecks `list-checks`, CalendarDays `calendar-days`, PanelLeftClose
  `panel-left-close`, CircleCheck `circle-check`, MoreHorizontal `ellipsis`, Maximize2 `maximize-2`,
  ListPlus `list-plus`, SquareCheck `square-check`, FileText `file-text`, ListTodo `list-todo`,
  MessageSquare `message-square`, UserPlus `user-plus`, Pilcrow `pilcrow`, Heading1 `heading-1`,
  RemoveFormatting `remove-formatting`, PaintBucket `paint-bucket`, Rows3 `rows-3`, ListTree
  `list-tree`, Undo2 `undo-2`, Redo2 `redo-2`.

## 6. Wording (copied from the source)

Sign-in: "Welcome back" / "Create your account" / "Reset your password"; "Notes and tasks, connected —
for you and your team."; labels "Name", "Email", "Password"; "Forgot password?"; buttons "Sign in",
"Create account", "Send reset link"; "New here?" "Create an account"; "Already have an account?" /
"Remembered it?" "Sign in"; invite-only: "New here? Sign-up is by invitation: open the invite link from
your email."; reset sent: "If that email has an account, a reset link is on its way. It works for an
hour."; forgot: "Enter your email and we'll send you a link to choose a new password."

Rail and account: "Notes", "Tasks", "Calendar"; "Hide sidebar" / "Show sidebar"; "Search"; "Switch
workspace"; "Account and settings". Account menu: name, email, "Theme" (Light, Dark, Hybrid, System),
"Settings", "Keyboard shortcuts" (hint "?"), "Get the apps" (web only), "Sign out". Workspace menu:
workspaces (role as hint), "New workspace", "Workspace settings", "Activity", "Trash".

Sidebar: "Sections", "Recent", "Favourites", "Views"; notebook picker "My notebooks", "Shared with me",
"New notebook"; "Notebook options": "New section", "Rename", "Share with people…", "Make private" /
"Share with workspace", "Print…", colour row, "Delete notebook". "Section options": "New page", "New
page from template" ›, "Default template…", "New subsection", "Rename", "Duplicate", "Move to…",
"Print…", colour row, "Delete section". "Page options" (row): "Add to favourites" / "Remove from
favourites", "Copy link", "Rename", "Lock page" (disabled note: "Only pages only you can see can be
locked. Move it to a private notebook first.") / "Remove lock…", "Duplicate", "Move to…", "Delete page".
"New page" (row +); "Sort pages": "Manual order", "Title", "Last edited".

Page: top bar "Saved" / "Saving…" / "Offline" / "Connecting…", "View only", "Tasks on this page",
"Comments", "Share"; "Page options" menu: "Share…", "Lock page", "Duplicate", "Save as template…",
"Version history", "Export as Markdown", "Export as PDF…", "Print" (Ctrl/⌘+P), "Print selection", print
colour item, "Import Markdown…", "Move to" | "Copy to" tabs, notebooks and sections, "Delete page".
"Add icon", "Untitled", "Edited {time} by {you|name}", "Page not found", "It may have been deleted,
moved to a private notebook, or you don't have access.", "This page is in the Trash. It is read-only
until you restore it." + "Restore", "+ Add a task to this page", "+ Add a text box", "Start with a
template, or just type", "Templates for this section", "Other templates", "Your templates", "Linked
from" (backlinks, 12/600 uppercase muted).

Editor: placeholders in 2.3; ribbon tooltips in 4.1 ("Click in a page to format" when idle, "Collapse the
ribbon (Ctrl+F1)", "Show ribbon"); floating toolbar "Task", "Comment"; slash items in 4.7; colour menus
"Text colour", "Highlight", "Default"; "Page colour" choices "No colour", "Yellow", "Green", "Blue",
"Purple", "Pink", "Grey"; "Rule lines": "None", "Lines", "Grid"; box menu "Cut", "Copy", "Duplicate",
"Delete"; canvas menu "Paste", "New text box here"; task line "Add checklist", "Open task details",
"Show notes"/"Hide notes", "This task was deleted or is not visible to you.", "Remove from page".

Tasks: views "Today", "Upcoming", "My Tasks", "All tasks", "Team", "Calendar"; subtitles "Due today and
overdue, assigned to you.", "Everything assigned to you — from every page.", "What’s coming up over the
next two weeks.", "Who’s working on what across the workspace.", "Every task in the workspace. Filter by
status, sort and group."; "Add task", "New view", "Overdue", "Today · Sat 21 Nov" (group titles by day),
"done today", "left", "day streak"; empty texts in 4.14. Due words: "Today", "Tomorrow", "Yesterday",
weekday names within 6 days, else "30 Nov" (with year if not this year). Relative times: "just now",
"3m ago", "2h ago", "4d ago", then a short date.

Phone: tabs "Notes", "Tasks", "Calendar", "Search"; "Add task" (FAB), "Open menu", "Back"; Notes screens
"Notes", "Favourites", "My notebooks", "Shared with me", "No notebooks yet.", "No sections in this
notebook.", "No pages in this section yet.", "Back".

## 7. Screens: what each reference shows and what it uses

File names are the same in each viewport folder where the state exists (`index.md` lists them all).

| Screenshot | Components | Notes / tokens |
|---|---|---|
| `sign-in.png` (+ `dark-`, `hybrid-`) | Login | 4.13; Hybrid sign-in uses the dark palette |
| `page-canvas-boxes.png`, `-2` | AppShell, Ribbon (idle), Rail, Sidebar, PageView, CanvasEditor | boxes at their x/y; overlapping boxes see-through (4.5.2); top box at x 900 is off to the right (scroll sideways); phones stacked with hairlines |
| `page-canvas-boxes-sidebar-open.png` (portrait) | as above | sidebar pushes the note area; first-run closed below 900 wide |
| `page-blocks.png`, `-2` | callout, toggle, table, image (broken: the corpus image URL doesn't exist), file card, mentions (yourself yellow), page link | 2.3 |
| `page-lists.png`, `-2` | lists, markers by depth and type, checklists | 2.3 |
| `page-tasks.png`, `-2` | task lines: notes, checklist, subtask, done, missing tasks | 2.4 |
| `page-settings-and-ink.png` | page colour blue + grid; rule-snapped text; ink layer (strokes: corpus has one) | 1.3, 4.5.3 |
| `page-meeting.png`, `-2` | headings, lists, page link, comment anchor, quote, task lines with priority/due/assignee/recurrence | 2.3, 2.4 |
| `page-roadmap.png`, `-2` | callout, table, toggle | |
| `sidebar.png` (tablet), `sidebar-drawer.png` (phone), `notes-home.png` (phone) | NotesPanel, SectionNode, PageRow, phone drawer, NotebooksScreen | 4.3, 3.2 |
| `edit-caret.png` (+ themes) | box in edit: opaque, `--border-strong`, move bar, width handle; ribbon enabled | 4.5.2 |
| `edit-selection.png` | selection `--accent-soft`, floating toolbar | 4.6 |
| `slash-menu.png` | slash menu | 4.7 |
| `ribbon-page-idle.png`, `ribbon-page-active.png`, `ribbon-collapsed.png`, `ribbon-menu-*.png`, `ribbon-tasks.png`, `ribbon-calendar.png`, `ribbon-notes.png`, `ribbon-settings.png` (tablets) | Ribbon, section ribbons, `.tb-pop` menus | 4.1 |
| `settings.png` (tablets) | Settings: 200 wide nav (32 rows, radius 6), content max 680, cards radius 12 padding 20 | |
| `tasks-today.png`, `tasks-upcoming.png`, `tasks-my.png`, `tasks-all.png`, `tasks-calendar.png` | TasksPanel, TasksView, TaskRow, CalendarView | 4.10 |
| `task-detail.png` | TaskDetail sheet | 4.10 |
| `page-tasks-panel.png` | page side panel | 4.11 |
| `menu-*.png` | Popover/MenuItem; phones: bottom sheets | 4.9, 6 |
| `search.png`, `quick-add.png` | CommandPalette, QuickAdd | 4.12 |
| `empty-*.png` | NotesHome, TasksView empty states | 4.14 |
| `dark-*.png`, `hybrid-*.png` | the same screens in Dark and Hybrid | 0.3, 1.1 |

## 8. Not captured (and why)

- Ribbon at ≥ 1280 pt (group names and button words): no iPad is that wide in CSS points (12.9″
  landscape is 1366, which is ≥ 1280: the full ribbon applies there; not captured, the rules are in
  4.1).
- The two-panel sidebar (≥ 1200): same; 12.9″ iPad landscape gets it.
- Hover states: no pointer on the captured devices.
- Images: the corpus image points at an upload that doesn't exist, so it shows broken; the demo
  "Q4 roadmap" page has a real chart image.
- Remote cursors / presence: single user.
- `ipad-portrait/edit-caret.png` (and `edit-selection`, `slash-menu`): the box being edited ("Box c",
  x 500) lies past the right edge of the 820 pt window, so the canvas has scrolled sideways to it; that
  is the web app's behaviour, not a capture fault. The caret itself may be in its blink-off phase in
  some shots.
