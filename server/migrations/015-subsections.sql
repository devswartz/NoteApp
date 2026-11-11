-- Subsections: a section may sit inside another section of the same notebook, up to 3 levels
-- (enforced by the API, see server/tree.ts). Every section keeps its notebook_id, so access is still
-- checked at the notebook level. Deleting a section deletes its subsections (and their pages).
ALTER TABLE sections ADD COLUMN parent_id TEXT REFERENCES sections(id) ON DELETE CASCADE;
CREATE INDEX sections_parent ON sections(parent_id) WHERE parent_id IS NOT NULL;
