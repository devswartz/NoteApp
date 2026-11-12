// Whole-canvas operations on a page's Y.Doc that need the editor schema (docs/PLAN_CANVAS.md,
// phase 3): reading a box as editor JSON (templates, Markdown export), writing boxes from JSON
// (templates, Markdown import), and a headless editor for parsing and serialising Markdown
// when no box editor is mounted. The storage format is shared/pageDoc.ts.
import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {
  BOXES_KEY,
  READABLE_BOX_W,
  boxField,
  boxGeoms,
  fragmentIsEmpty,
  newBoxMap,
  pageSettingsAttrs,
  parsePageSettings,
  readingOrder,
  setPageSettings,
  type BoxGeom,
} from '../../shared/pageDoc.ts';
import { documentExtensions } from './NoteEditor.tsx';
import { newBoxId } from './canvasGeom.ts';
import { sanitizeContent } from './urls.ts';
import { resolveListStarts } from '../../shared/listMarker.ts';

/** Transaction origin of box geometry changes the canvas undo (Ctrl+Z outside a box) tracks. */
export const GEOM_ORIGIN = { canvas: 'geometry' };

/** What PageView needs from an open canvas: its doc, and a way to add a box below the others. */
export interface CanvasHandle {
  pageId: string;
  doc: Y.Doc;
  /** Adds a box with these blocks under everything else; returns its id. */
  addBox: (blocks: JSONContent[]) => string;
  /** Put the caret in a box's `index`-th heading and scroll there (mounting the box's editor first if needed). */
  revealHeading: (boxId: string, index: number) => void;
  /** A box's element on the page (null if it isn't shown). */
  boxElement: (boxId: string) => HTMLElement | null;
}

/** A box as a template stores it: geometry plus its blocks. */
export interface CanvasBoxContent {
  x: number;
  y: number;
  w: number;
  z?: number;
  /** The page's main box, drawn at the readable width (shared/pageDoc.ts). */
  wide?: boolean;
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

/** A canvas as template content: a doc of canvasBox nodes (attrs = geometry); the doc's attrs keep the page settings. */
export function canvasTemplateJSON(doc: Y.Doc, schema: Schema): JSONContent {
  const settings = pageSettingsAttrs(doc);
  return {
    type: 'doc',
    ...(settings ? { attrs: { pageSettings: settings } } : {}),
    content: canvasBoxes(doc, schema).map((b) => ({
      type: CANVAS_BOX_NODE,
      attrs: { x: b.x, y: b.y, w: b.w, z: b.z, ...(b.wide ? { wide: true } : {}) },
      content: b.json.content ?? [],
    })),
  };
}

/** Apply the page settings a template carries (canvasTemplateJSON), if any. */
export function applyTemplateSettings(doc: Y.Doc, content: JSONContent) {
  const s = content.attrs?.pageSettings;
  if (s && typeof s === 'object') setPageSettings(doc, parsePageSettings(s));
}

/** The boxes of canvas template content (the inverse of canvasTemplateJSON). */
export function templateBoxes(content: JSONContent): CanvasBoxContent[] {
  return (content.content ?? [])
    .filter((n) => n.type === CANVAS_BOX_NODE)
    .map((n) => ({
      x: Number(n.attrs?.x) || 0,
      y: Number(n.attrs?.y) || 0,
      w: Number(n.attrs?.w) || 360,
      z: Number(n.attrs?.z) || 0,
      ...(n.attrs?.wide === true ? { wide: true } : {}),
      content: n.content ?? [],
    }));
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
      doc.getMap<unknown>(BOXES_KEY).set(id, newBoxMap({ x: b.x, y: b.y, w: b.w, z: top + 1 + (b.z ?? i), wide: b.wide }));
      ids.push(id);
    });
  }, origin);
  return ids;
}

/** Document content (a `doc` node) as the one wide box of an empty canvas. */
export function documentAsBox(content: JSONContent): CanvasBoxContent {
  return { x: 0, y: 0, w: READABLE_BOX_W, wide: true, content: content.content ?? [] };
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
      .map((b) => (e.markdown ? e.markdown.serialize(resolveListStarts(sanitizeContent(b.json))) : '').trim())
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
