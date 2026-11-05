import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTEBOOK_TEMPLATES, notebookTemplate } from '../src/components/shell/notebookTemplates.ts';

test('notebook templates are well-formed', () => {
  const ids = new Set<string>();
  for (const t of NOTEBOOK_TEMPLATES) {
    assert.ok(!ids.has(t.id), `duplicate id ${t.id}`);
    ids.add(t.id);
    assert.match(t.color, /^#[0-9a-f]{6}$/, `${t.id}: colour must pass the server's validColor`);
    assert.ok(t.sections.length > 0, `${t.id}: needs a section`);
    assert.ok(t.sections[0].pages.length > 0, `${t.id}: the first section needs a page to open`);
    for (const s of t.sections) {
      assert.ok(s.name.trim() && s.name.length <= 100, `${t.id}: section name`);
      if (s.color) assert.match(s.color, /^#[0-9a-f]{6}$/);
    }
    assert.ok(t.notebookName.length <= 100);
  }
  assert.equal(NOTEBOOK_TEMPLATES[0].id, 'blank', 'blank is the default');
  assert.equal(notebookTemplate('nope').id, 'blank');
});
