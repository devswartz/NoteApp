-- Page templates keep the kind of page they were saved from ('document' or 'canvas'),
-- and using one makes a page of that kind (docs/PLAN_CANVAS.md, phase 3).
ALTER TABLE templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'document';
