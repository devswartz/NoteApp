-- Section default templates. A new page made in a section through the app's New page (sidebar,
-- ribbon, Ctrl+N, Notes overview) starts filled from the section's default template.
--   sections.default_template_id    the section's own default; NULL = inherit the nearest ancestor's.
--                                   Deleting the template clears it (ON DELETE SET NULL).
--   sections.no_default_template    1 = "None" chosen here: don't inherit a parent's default.
--   pages.pending_template_id       a template still to be applied to a just-created page. The
--                                   creator's client claims it once (atomically clears it) and fills
--                                   the page, so two clients never both apply it.
ALTER TABLE sections ADD COLUMN default_template_id TEXT REFERENCES templates(id) ON DELETE SET NULL;
ALTER TABLE sections ADD COLUMN no_default_template INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN pending_template_id TEXT REFERENCES templates(id) ON DELETE SET NULL;
