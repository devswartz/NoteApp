// Browser harness: today's text-box editor (the extensions CanvasEditor's boxes use) on a Yjs doc,
// with the app store seeded so tasks can be made. The Node runner (../run-tiptap.ts) drives it with
// real key presses through Playwright and these hooks (window.nv).
import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { getSchema, type Extensions } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { documentExtensions } from '../../../src/editor/NoteEditor.tsx';
import { BlockMove } from '../../../src/editor/blockMove.ts';
import { BlockExit } from '../../../src/editor/blockExit.ts';
import { UndoTasks } from '../../../src/editor/undoTasks.ts';
import { SlashCommand } from '../../../src/editor/SlashMenu.tsx';
import { CommentMark } from '../../../src/editor/collabComments.ts';
import { pageUndoFor } from '../../../src/editor/pageUndo.ts';
import { useStore } from '../../../src/store.ts';
import { canonical, parse, serialize } from '../notation.ts';

const PAGE = 'page-1';
const FIELD = 'box:b1';

type TaskIn = { title?: string; status?: 'open' | 'done' };

function extensions(doc: Y.Doc, undoManager: Y.UndoManager): Extensions {
  return [
    ...documentExtensions(PAGE),
    BlockMove,
    BlockExit,
    UndoTasks,
    SlashCommand,
    CommentMark,
    Collaboration.configure({ document: doc, field: FIELD, yUndoOptions: { undoManager } }),
  ];
}

const schema = getSchema(extensions(new Y.Doc(), new Y.UndoManager(new Y.Doc().getXmlFragment('x'))));

function seedStore(tasks: Record<string, TaskIn>) {
  const now = new Date().toISOString();
  const all = Object.fromEntries(
    Object.entries(tasks).map(([id, t]) => [
      id,
      { id, workspaceId: 'w1', title: t.title ?? '', description: '', status: t.status ?? 'open', priority: 4, dueDate: null, dueTime: null, recurrence: null, reminderAt: null, assigneeId: 'u1', createdBy: 'u1', pageId: PAGE, parentId: null, teamId: null, tagIds: [], createdAt: now, updatedAt: now, position: 1, completedAt: null },
    ]),
  );
  useStore.setState({
    user: { id: 'u1', name: 'Tess Tester', email: 't@example.test', color: '#4f46e5' },
    wsId: 'w1',
    workspaces: [{ id: 'w1', name: 'W', role: 'owner' }],
    members: [],
    tasks: all,
    tasksLoaded: true,
  } as never);
}

let current: { editor: Editor; doc: Y.Doc; root: ReturnType<typeof createRoot> } | null = null;

function Box({ doc, um, onReady }: { doc: Y.Doc; um: Y.UndoManager; onReady: (e: Editor) => void }) {
  const editor = useEditor({ extensions: extensions(doc, um), editorProps: { attributes: { class: 'prose', 'aria-label': 'Text box content' } } });
  useEffect(() => {
    if (editor) onReady(editor);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps
  return <EditorContent editor={editor} />;
}

/** Stable names for task ids: given ones keep theirs, new ones become t<n> in order of appearance. */
function taskNames(editor: Editor, given: string[]): (id: string) => string {
  const names = new Map<string, string>(given.map((g) => [g, g]));
  let n = 0;
  const next = () => {
    let name: string;
    do name = `t${++n}`;
    while ([...names.values()].includes(name));
    return name;
  };
  editor.state.doc.descendants((node) => {
    const id = node.attrs?.taskId as string | undefined;
    if (node.type.name === 'taskRef' && id && !names.has(id)) names.set(id, next());
  });
  for (const id of Object.keys(useStore.getState().tasks)) if (!names.has(id)) names.set(id, next());
  return (id) => names.get(id) ?? id;
}

let given: string[] = [];

const nv = {
  async load(docText: string, tasks: Record<string, TaskIn> = {}) {
    current?.editor.destroy();
    current?.root.unmount();
    seedStore(tasks);
    given = Object.keys(tasks);
    const p = parse(docText, schema);
    const doc = new Y.Doc();
    prosemirrorJSONToYXmlFragment(schema, p.json, doc.getXmlFragment(FIELD));
    const um = pageUndoFor(doc).textUndo(doc, FIELD);
    const host = document.getElementById('box')!;
    host.innerHTML = '';
    const root = createRoot(host);
    const editor = await new Promise<Editor>((resolve) => root.render(<Box doc={doc} um={um} onReady={resolve} />));
    // Let y-tiptap's first sync land before placing the selection.
    await new Promise((r) => setTimeout(r, 0));
    current = { editor, doc, root };
    editor.view.focus();
    const d = editor.state.doc;
    const sel = p.node !== null ? NodeSelection.create(d, p.node) : p.anchor !== null ? TextSelection.create(d, p.anchor, p.head ?? p.anchor) : null;
    if (sel) editor.view.dispatch(editor.state.tr.setSelection(sel).setMeta('addToHistory', false));
    um.clear();
  },

  state() {
    const e = current!.editor;
    const sel = e.state.selection;
    const name = taskNames(e, given);
    // Focus in a task line's title (its own input, not editor content): no selection in the doc.
    const active = document.activeElement as HTMLElement | null;
    const titleOf = active && active !== e.view.dom && e.view.dom.contains(active) ? (active.closest('[data-task-id]') as HTMLElement | null)?.dataset.taskId : undefined;
    const focus = titleOf ? `title:${name(titleOf)}` : active === e.view.dom ? 'editor' : 'none';
    const inDoc = focus === 'editor';
    const node = inDoc && sel instanceof NodeSelection ? sel.from : null;
    const text = serialize(e.state.doc, { anchor: inDoc ? sel.anchor : null, head: inDoc ? sel.head : null, node, attr: (k, v) => (k === 'taskId' && typeof v === 'string' ? name(v) : v) });
    const tasks = Object.fromEntries(
      Object.values(useStore.getState().tasks)
        .map((t) => [name(t.id), { title: t.title, status: t.status }] as const)
        .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })),
    );
    return { doc: text, tasks, focus };
  },

  canonical(text: string) {
    return canonical(text, schema);
  },

  /** Runs a TipTap command by name (the suite's command vocabulary maps onto these in run-tiptap.ts). */
  command(name: string, args: unknown[] = []) {
    const e = current!.editor;
    const fn = (e.commands as unknown as Record<string, (...a: unknown[]) => boolean>)[name];
    if (!fn) throw new Error(`no command ${name}`);
    return fn(...args);
  },

  paste(data: Record<string, string>) {
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(data)) dt.setData(type, value);
    current!.editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  },

  copy(cut = false) {
    const dt = new DataTransfer();
    current!.editor.view.dom.dispatchEvent(new ClipboardEvent(cut ? 'cut' : 'copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { html: dt.getData('text/html'), text: dt.getData('text/plain') };
  },
};

(window as unknown as { nv: typeof nv }).nv = nv;
document.body.dataset.ready = '1';
