// What today's TS code says about a corpus page (tests/corpus/README.md). Everything here calls
// the real implementation: shared/pageDoc.ts, shared/listMarker.ts, server/markdown.ts,
// server/sanitizeDoc.ts and the server's text extraction (server/collab.ts extractPage, which is
// what goes into search through server/locks.ts searchableText).
import * as Y from 'yjs';
import { boxGeoms, docKind, isNewerPageFormat, mainFragment, pageFormatVersion, pageFragments, pageHeadings, pageInk, readPageSettings, readingOrder, BOX_PREFIX, DEFAULT_FIELD } from '../../shared/pageDoc.ts';
import { listMarker, listSuffix, xmlListStart } from '../../shared/listMarker.ts';
import { toMarkdown, type TaskLookup } from '../../server/markdown.ts';
import { sanitizeYDoc } from '../../server/sanitizeDoc.ts';
import type { TaskInfo } from './cases.ts';

// server/collab.ts opens the database when imported; an in-memory one keeps the corpus self-contained.
process.env.DB_FILE ??= ':memory:';
const { extractPage } = await import('../../server/collab.ts');

type XmlNode = Y.XmlElement | Y.XmlText | Y.XmlFragment;

/** A fragment's nodes as plain JSON: elements with all their attributes, text as its delta (marks are attributes). */
export function nodeJson(n: unknown): unknown {
  if (n instanceof Y.XmlText)
    return {
      text: (n.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]).map((d) => ({
        ...(typeof d.insert === 'string' ? { insert: d.insert } : { embed: d.insert }),
        ...(d.attributes && Object.keys(d.attributes).length ? { attributes: d.attributes } : {}),
      })),
    };
  if (n instanceof Y.XmlElement) return { type: n.nodeName, attrs: n.getAttributes(), content: n.toArray().map(nodeJson) };
  return { other: true };
}

/** The content fragments of a page in reading order, by root name. */
function fragments(doc: Y.Doc): { name: string; content: unknown[] }[] {
  const names = [DEFAULT_FIELD, ...readingOrder(boxGeoms(doc)).map((b) => BOX_PREFIX + b.id)];
  return pageFragments(doc).map((f, i) => ({ name: names[i], content: f.toArray().map(nodeJson) }));
}

/** Each ordered list in the page (fragments in reading order, depth first), with its start and item markers. */
function orderedLists(doc: Y.Doc) {
  const out: { fragment: string; path: number[]; start: number; markers: string[] }[] = [];
  const names = [DEFAULT_FIELD, ...readingOrder(boxGeoms(doc)).map((b) => BOX_PREFIX + b.id)];
  const walk = (n: XmlNode, fragment: string, path: number[]) => {
    if (n instanceof Y.XmlText) return;
    if (n instanceof Y.XmlElement && n.nodeName === 'orderedList') {
      const start = xmlListStart(n as never);
      out.push({ fragment, path, start, markers: n.toArray().map((_, i) => `${listMarker(n.getAttribute('type'), start + i)}${listSuffix(n.getAttribute('paren'))}`) });
    }
    n.toArray().forEach((c, i) => walk(c as XmlNode, fragment, [...path, i]));
  };
  pageFragments(doc).forEach((f, i) => walk(f, names[i], []));
  return out;
}

export function lookupFor(tasks: Record<string, TaskInfo>): TaskLookup {
  return (id) => (Object.hasOwn(tasks, id) ? tasks[id] : undefined);
}

export interface Expected {
  json: Record<string, unknown>;
  markdown: string;
  text: string;
}

/** Everything the corpus records about a page, from its stored update. */
export function expectations(update: Uint8Array, title: string, tasks: Record<string, TaskInfo>): Expected {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const extracted = extractPage(doc);
  const json = {
    kind: docKind(doc),
    formatVersion: pageFormatVersion(doc),
    newerFormat: isNewerPageFormat(doc),
    pageSettings: readPageSettings(doc),
    boxes: [...boxGeoms(doc)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    readingOrder: readingOrder(boxGeoms(doc)).map((b) => b.id),
    mainFragment: mainFragment(doc) === doc.getXmlFragment(DEFAULT_FIELD) ? DEFAULT_FIELD : BOX_PREFIX + readingOrder(boxGeoms(doc))[0].id,
    fragments: fragments(doc),
    headings: pageHeadings(doc),
    ink: pageInk(doc).map((s) => ({ id: s.id, bytes: Buffer.from(s.data).toString('base64') })),
    taskIds: [...extracted.taskIds].sort(),
    mentionIds: [...extracted.mentionIds].sort(),
    orderedLists: orderedLists(doc),
    sanitized: (() => {
      const copy = new Y.Doc();
      Y.applyUpdate(copy, update);
      const removed = sanitizeYDoc(copy);
      return { removed, fragments: fragments(copy), ink: pageInk(copy).map((s) => s.id), inkKeys: [...copy.getMap('ink').keys()].sort() };
    })(),
  };
  return { json, markdown: toMarkdown(title, pageFragments(doc), lookupFor(tasks)), text: extracted.text };
}

/** listMarker() for every list type over a range of numbers (tests/corpus/list-markers.json). */
export function listMarkerTable() {
  const types = ['1', 'a', 'A', 'i', 'I', null];
  const ns = [...Array.from({ length: 30 }, (_, i) => i + 1), 40, 49, 52, 99, 400, 702, 703, 1994, 3999, 4000, 4444];
  return {
    markers: types.map((type) => ({ type, values: ns.map((n) => [n, listMarker(type, n)]) })),
    suffix: [false, true, null, 'x'].map((paren) => [paren, listSuffix(paren)]),
  };
}
