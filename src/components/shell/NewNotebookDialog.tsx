// "New notebook": a name plus a starting structure (notebookTemplates.ts).
// Open it from anywhere with openNewNotebook(); <NewNotebookHost /> is mounted
// once in the app shell. Creates the notebook, its sections and empty pages
// through the tree API, then opens the first page (where the Editor's page
// template picker takes over).
import { useState } from 'react';
import { create } from 'zustand';
import { useNavigate } from 'react-router-dom';
import { patch, post } from '../../api.ts';
import { errorToast, useStore } from '../../store.ts';
import { Button, Dialog, Input } from '../ui.tsx';
import { NOTEBOOK_TEMPLATES, notebookTemplate, type NotebookTemplate } from './notebookTemplates.ts';
import { sidebar } from './sidebarState.ts';

const useNewNotebook = create<{ open: boolean }>(() => ({ open: false }));
export const openNewNotebook = () => useNewNotebook.setState({ open: true });

/** Creates the notebook from a template; returns the first page's id. */
export async function createNotebookFromTemplate(wsId: string, name: string, t: NotebookTemplate): Promise<string | null> {
  const nb = await post<{ id: string; sectionId: string }>(`/workspaces/${wsId}/notebooks`, { name, color: t.color, visibility: 'shared' });
  let firstPage: string | null = null;
  for (const [i, sec] of t.sections.entries()) {
    let sectionId = nb.sectionId;
    if (i === 0) {
      if (sec.name !== 'General' || sec.color) await patch(`/sections/${sectionId}`, { name: sec.name, ...(sec.color ? { color: sec.color } : {}) });
    } else {
      sectionId = (await post<{ id: string }>(`/notebooks/${nb.id}/sections`, { name: sec.name, color: sec.color })).id;
    }
    for (const pg of sec.pages) {
      const { id } = await post<{ id: string }>(`/sections/${sectionId}/pages`, { title: pg.title });
      if (pg.icon) await patch(`/pages/${id}`, { icon: pg.icon });
      firstPage ??= id;
    }
  }
  sidebar.toggleNode(nb.id, false);
  return firstPage;
}

export function NewNotebookHost() {
  const open = useNewNotebook((s) => s.open);
  if (!open) return null;
  return <NewNotebookDialog />;
}

function NewNotebookDialog() {
  const wsId = useStore((s) => s.wsId)!;
  const navigate = useNavigate();
  const [templateId, setTemplateId] = useState('blank');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => useNewNotebook.setState({ open: false });
  const t = notebookTemplate(templateId);

  const choose = (id: string) => {
    setTemplateId(id);
    // Suggest the template's name until the user types their own.
    if (!touched) setName(notebookTemplate(id).notebookName);
  };

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const pageId = await createNotebookFromTemplate(wsId, name.trim(), t);
      close();
      if (pageId) navigate(`/w/${wsId}/p/${pageId}`);
    } catch (e) {
      errorToast(e);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title="New notebook"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!name.trim()} loading={busy}>
            Create
          </Button>
        </>
      }
    >
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          label="Name"
          value={name}
          placeholder="e.g. Projects"
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
            setTouched(true);
          }}
        />
        <div className="field">
          <span className="field-label" id="nb-template-label">
            Start with
          </span>
          <div className="nb-templates" role="radiogroup" aria-labelledby="nb-template-label">
            {NOTEBOOK_TEMPLATES.map((x) => (
              <button
                key={x.id}
                type="button"
                role="radio"
                aria-checked={x.id === templateId}
                className={`nb-template ${x.id === templateId ? 'is-active' : ''}`}
                onClick={() => choose(x.id)}
              >
                <span className="nb-template-icon" aria-hidden="true">
                  {x.icon}
                </span>
                <span className="nb-template-name">{x.name}</span>
                <span className="nb-template-desc">{x.description}</span>
              </button>
            ))}
          </div>
          {t.id !== 'blank' && (
            <p className="field-hint">
              Creates {t.sections.map((s) => s.name).join(', ')}. Each page offers page templates when you open it.
            </p>
          )}
        </div>
      </form>
    </Dialog>
  );
}
