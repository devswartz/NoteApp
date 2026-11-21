# Rewrite status

Updated by each workstream when it finishes a step (newest first under each heading). The overseeing session reads this to plan the next steps. Keep entries short.

## Now

- **core** (M1): page-format corpus, `nv-model`, `nv-core` + uniffi skeleton. Started 2026-11-21.
- **editor** (M2): editor test suite as data, then `nv-editor`. Started 2026-11-21. Branch `rewrite/editor-suite`. Suite step 1 done (see Done); next: `docs/rewrite/EDITOR.md`, then `crates/nv-editor` with a Rust runner over the same files, then page-wide undo across boxes in the suite.
- **apple** (M1): PARITY.md, Apple app skeleton, CI + TestFlight 1.99.x. Started 2026-11-21.

## Waiting on Devon

- (none yet)

## Requests between streams

- editor → overseer: run the editor suite on TipTap in CI (`node --import tsx tests/editor/run-tiptap.ts`; needs Playwright's Chromium, as the e2e job has). I can't edit `.github/`. About a minute.

## Done

- 2026-11-21 (editor): editor suite as data in `tests/editor/` (notation, harness with today's box editor, Playwright runner, README): 129 scenarios over typing, block edges, marks, headings, lists and smart lists, checklists, tasks (convert, notes, Tab/Shift+Tab, delete and undo), input rules, slash menu, tables, code, quotes, callouts, toggles, links, page links, mentions, paste/copy/cut, undo/redo. 127 green on TipTap, 2 skipped with reasons. Findings: possible redo bug in today's editor, and quirks the engine must copy (README).
- 2026-11-21: architecture decided (`docs/ARCHITECTURE.md`, PR #197); this plan written.
