// Starting structures for a new notebook: sections and (empty) pages. Page
// content comes from the Editor's page templates: an empty page shows its
// "Start with a template" picker, so the user fills each page in one click.
// Pages are canvases like any new page (the picker offers the canvas versions);
// long-form pages such as specs are documents.
// Pure data, unit-tested in tests/notebookTemplates.test.ts.

export interface NotebookTemplate {
  id: string;
  name: string;
  /** Default notebook name (the user can change it). */
  notebookName: string;
  description: string;
  icon: string;
  color: string;
  /** The first section replaces the "General" section every notebook starts with. */
  /** Pages are canvases unless `kind` says otherwise (like "New page"). */
  sections: { name: string; color?: string; pages: { title: string; icon?: string; kind?: 'canvas' | 'document' }[] }[];
}

export const NOTEBOOK_TEMPLATES: NotebookTemplate[] = [
  {
    id: 'blank',
    name: 'Blank',
    notebookName: '',
    description: 'One section, one empty page',
    icon: '📄',
    color: '#6366f1',
    sections: [{ name: 'General', pages: [{ title: '' }] }],
  },
  {
    id: 'personal',
    name: 'Personal',
    notebookName: 'Personal',
    description: 'Journal, ideas and a reading list',
    icon: '🌱',
    color: '#10b981',
    sections: [
      { name: 'Journal', color: '#10b981', pages: [{ title: 'Journal', icon: '📓' }] },
      { name: 'Ideas', color: '#f59e0b', pages: [{ title: 'Ideas', icon: '💡' }] },
      { name: 'Reading', color: '#0ea5e9', pages: [{ title: 'Reading list', icon: '📚' }] },
    ],
  },
  {
    id: 'project',
    name: 'Team project',
    notebookName: 'Project',
    description: 'Brief, meeting notes, specs and retros',
    icon: '🚀',
    color: '#6366f1',
    sections: [
      { name: 'Planning', color: '#6366f1', pages: [{ title: 'Project brief', icon: '🎯' }, { title: 'Meeting notes', icon: '🤝' }] },
      { name: 'Docs', color: '#0ea5e9', pages: [{ title: 'Specs', icon: '📐', kind: 'document' }] },
      { name: 'Retros', color: '#ec4899', pages: [{ title: 'Retro', icon: '🔁' }] },
    ],
  },
  {
    id: 'meetings',
    name: 'Meetings',
    notebookName: 'Meetings',
    description: 'Weekly syncs and one-on-ones',
    icon: '🗓️',
    color: '#f59e0b',
    sections: [
      { name: 'Team', color: '#f59e0b', pages: [{ title: 'Weekly sync', icon: '🤝' }] },
      { name: '1:1s', color: '#8b5cf6', pages: [{ title: '1:1 notes', icon: '💬' }] },
    ],
  },
  {
    id: 'studies',
    name: 'Studies',
    notebookName: 'Studies',
    description: 'Lectures, assignments and exam prep',
    icon: '🎓',
    color: '#0ea5e9',
    sections: [
      { name: 'Lectures', color: '#0ea5e9', pages: [{ title: 'Lecture 1', icon: '📝' }] },
      { name: 'Assignments', color: '#f59e0b', pages: [{ title: 'Assignments', icon: '✅' }] },
      { name: 'Exams', color: '#ef4444', pages: [{ title: 'Exam prep', icon: '🧠' }] },
    ],
  },
];

export const notebookTemplate = (id: string) => NOTEBOOK_TEMPLATES.find((t) => t.id === id) ?? NOTEBOOK_TEMPLATES[0];
