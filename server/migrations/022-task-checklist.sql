-- The ticked / total count of the plain checklists written under a task in its page (the task's notes,
-- src/editor/taskChildren.ts), counted when the page is saved (server/taskNotes.ts). NULL = no checklist.
-- The checklist items themselves are never tasks: only this count shows in the Tasks views.
ALTER TABLE tasks ADD COLUMN checklist_done INTEGER;
ALTER TABLE tasks ADD COLUMN checklist_total INTEGER;
