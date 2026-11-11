-- Templates tied to sections. A template with no rows here is offered everywhere (as before);
-- with rows it is offered in those sections, and in their subsections when include_subsections = 1.
CREATE TABLE template_sections (
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  include_subsections INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (template_id, section_id)
);
CREATE INDEX template_sections_section ON template_sections(section_id);
