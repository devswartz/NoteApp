// Whole-canvas operations on a page's Y.Doc that need the editor schema (docs/PLAN_CANVAS.md,
// phase 3): reading a box as editor JSON (templates, Markdown export), writing boxes from JSON
// (templates, Markdown import), and a headless editor for parsing and serialising Markdown
// when no box editor is mounted. The storage format is shared/pageDoc.ts.
import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { BOXES_KEY, boxField, boxGeoms, fragmentIsEmpty, readingOrder, type BoxGeom } from '../../shared/pageDoc.ts';
import { documentExtensions } from './NoteEditor.tsx';
import { newBoxId } from './canvasGeom.ts';
import { sanitizeContent } from './urls.ts';

/** Transaction origin of box geometry changes the canvas undo (Ctrl+Z outside a box) tracks. */
export const GEOM_ORIGIN = { canvas: 'geometry' };

/** What PageView needs from an open canvas: its doc, and a way to add a box below the others. */
export interface CanvasHandle {
  pageId: string;
  doc: Y.Doc;
  /** Adds a box with these blocks under everything else; returns its id. */
  addBox: (blocks: JSONContent[]) => string;
}

/** A box as a template stores it: geometry plus its blocks. */
export interface CanvasBoxContent {
  x: number;
  y: number;
  w: number;
  z?: number;
  content: JSONContent[];
}

/** The node type of a box in a canvas template's JSON (server/templates.ts). */
export const CANVAS_BOX_NODE = 'canvasBox';

const schemas = new Map<string, Schema>();
/** The document schema (the same one every box editor uses). */
export function pageSchema(pageId: string): Schema {
  let s = schemas.get(pageId);
  if (!s) {
    s = getSchema(documentExtensions(pageId));
    schemas.clear(); // one page at a time
    schemas.set(pageId, s);
  }
  return s;
}

/** A box's content as editor JSON (a `doc` node). */
export function boxJSON(doc: Y.Doc, id: string, schema: Schema): JSONContent {
  return yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(boxField(id)), schema).toJSON() as JSONContent;
}

/** The non-empty boxes in reading order, with their geometry and content. */
export function canvasBoxes(doc: Y.Doc, schema: Schema): (BoxGeom & { json: JSONContent })[] {
  return readingOrder(boxGeoms(doc))
    .filter((b) => !fragmentIsEmpty(doc.getXmlFragment(boxField(b.id))))
    .map((b) => ({ ...b, json: boxJSON(doc, b.id, schema) }));
}

/** A canvas as template content: a doc of canvasBox nodes (attrs = geometry). */
export function canvasTemplateJSON(doc: Y.Doc, schema: Schema): JSONContent {
  return {
    type: 'doc',
    content: canvasBoxes(doc, schema).map((b) => ({ type: CANVAS_BOX_NODE, attrs: { x: b.x, y: b.y, w: b.w, z: b.z }, content: b.json.content ?? [] })),
  };
}

/** The boxes of canvas template content (the inverse of canvasTemplateJSON). */
export function templateBoxes(content: JSONContent): CanvasBoxContent[] {
  return (content.content ?? [])
    .filter((n) => n.type === CANVAS_BOX_NODE)
    .map((n) => ({ x: Number(n.attrs?.x) || 0, y: Number(n.attrs?.y) || 0, w: Number(n.attrs?.w) || 360, z: Number(n.attrs?.z) || 0, content: n.content ?? [] }));
}

/** Write boxes (geometry + blocks) into the doc in one transaction; returns their ids. */
export function writeBoxes(doc: Y.Doc, schema: Schema, boxes: CanvasBoxContent[], origin: unknown = GEOM_ORIGIN): string[] {
  const ids: string[] = [];
  doc.transact(() => {
    const top = boxGeoms(doc).reduce((m, b) => Math.max(m, b.z), 0);
    boxes.forEach((b, i) => {
      const id = newBoxId();
      const blocks = b.content.length ? b.content : [{ type: 'paragraph' }];
      prosemirrorJSONToYXmlFragment(schema, sanitizeContent({ type: 'doc', content: blocks }), doc.getXmlFragment(boxField(id)));
      const m = new Y.Map<unknown>();
      m.set('x', b.x);
      m.set('y', b.y);
      m.set('w', b.w);
      m.set('z', top + 1 + (b.z ?? i));
      doc.getMap<unknown>(BOXES_KEY).set(id, m);
      ids.push(id);
    });
  }, origin);
  return ids;
}

/** Write a document's blocks into the `default` fragment (replacing what's there). */
export function writeDocument(doc: Y.Doc, schema: Schema, content: JSONContent) {
  const frag = doc.getXmlFragment('default');
  doc.transact(() => {
    if (frag.length) frag.delete(0, frag.length);
    prosemirrorJSONToYXmlFragment(schema, sanitizeContent(content), frag);
  });
}

/** Run `fn` with an editor that has the page schema and Markdown but no view (parsing, serialising). */
export function withHeadlessEditor<T>(pageId: string, fn: (e: Editor) => T): T {
  const e = new Editor({ extensions: documentExtensions(pageId) });
  try {
    return fn(e);
  } finally {
    e.destroy();
  }
}

/** Markdown of every box in reading order, separated by blank lines. */
export function canvasMarkdownBody(pageId: string, doc: Y.Doc): string {
  return withHeadlessEditor(pageId, (e) =>
    canvasBoxes(doc, e.schema)
      .map((b) => (e.markdown ? e.markdown.serialize(sanitizeContent(b.json)) : '').trim())
      .filter(Boolean)
      .join('\n\n'),
  );
}

/** The Y.Doc an editor is bound to through its Collaboration extension. */
export function editorDoc(editor: Editor): Y.Doc | null {
  const ext = editor.extensionManager.extensions.find((x) => x.name === 'collaboration');
  const d = (ext?.options as { document?: unknown } | undefined)?.document;
  return d instanceof Y.Doc ? d : null;
}
