// Where a page's content lives in its Y.Doc (see docs/PLAN_CANVAS.md).
//   Document pages: one fragment, `default`.
//   Canvas pages:   `boxes` (Y.Map: box id → Y.Map { x, y, w, z }) and one fragment per box,
//                   `box:<id>`. `default` stays empty.
//   Every page:     `pageSettings` (Y.Map: page colour, rule lines; see below),
//                   `ink` (Y.Map: stroke id → Uint8Array; reserved, see the end of this file) and
//                   `pageFormat` (Y.Map: { version }, written only when a format change needs it).
// Anything that reads a page's text, tasks, mentions or links goes through
// pageFragments() so it sees every box, in reading order.
import * as Y from 'yjs';

export const DEFAULT_FIELD = 'default';
export const BOXES_KEY = 'boxes';
export const BOX_PREFIX = 'box:';

export interface BoxGeom {
  id: string;
  x: number;
  y: number;
  /** Width in page pixels; the height follows the content. */
  w: number;
  /** Stacking order: higher is in front. */
  z: number;
  /**
   * The page's main text box: drawn across the page's full width (OneNote-style) until
   * someone sets its width by hand; `w` is then only a fallback for readers that don't know
   * the page width (the server, or before the page is measured).
   */
  wide?: boolean;
}

export const boxField = (id: string) => BOX_PREFIX + id;
/** Is this root type name page content (as opposed to metadata such as `boxes`)? */
export const isContentField = (name: string) => name === DEFAULT_FIELD || name.startsWith(BOX_PREFIX);

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** The boxes of a canvas page with their geometry (unknown or broken values defaulted). */
export function boxGeoms(doc: Y.Doc): BoxGeom[] {
  const out: BoxGeom[] = [];
  doc.getMap<unknown>(BOXES_KEY).forEach((v, id) => {
    const get = (k: string) => (v instanceof Y.Map ? v.get(k) : v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined);
    const g: BoxGeom = { id, x: num(get('x'), 0), y: num(get('y'), 0), w: num(get('w'), 400), z: num(get('z'), 0) };
    if (get('wide') === true) g.wide = true;
    out.push(g);
  });
  return out;
}

/** Reading order: top to bottom, then left to right (the id breaks exact ties, so the order is stable). */
export function readingOrder<T extends Pick<BoxGeom, 'id' | 'x' | 'y'>>(boxes: T[]): T[] {
  return [...boxes].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Every content fragment of a page in reading order: `default` first, then the boxes. */
export function pageFragments(doc: Y.Doc): Y.XmlFragment[] {
  return [doc.getXmlFragment(DEFAULT_FIELD), ...readingOrder(boxGeoms(doc)).map((b) => doc.getXmlFragment(boxField(b.id)))];
}

/** The fragment holding a page's main text: its first box in reading order (`default` on a page without boxes). */
export function mainFragment(doc: Y.Doc): Y.XmlFragment {
  const first = readingOrder(boxGeoms(doc))[0];
  return doc.getXmlFragment(first ? boxField(first.id) : DEFAULT_FIELD);
}

/**
 * Like observeDeep on every content fragment, including boxes added later: `fn` gets the
 * deep events of each content root that changed in a transaction.
 */
export function observePageContent(doc: Y.Doc, fn: (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => void): () => void {
  const handler = (tr: Y.Transaction) => {
    const events: Y.YEvent<Y.AbstractType<unknown>>[] = [];
    for (const [name, type] of doc.share) {
      if (!isContentField(name)) continue;
      const evs = tr.changedParentTypes.get(type as Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>);
      if (evs) events.push(...(evs as Y.YEvent<Y.AbstractType<unknown>>[]));
    }
    if (events.length) fn(events, tr);
  };
  doc.on('afterTransaction', handler);
  return () => doc.off('afterTransaction', handler);
}

/**
 * The stored width of a wide box: a document's old text column plus the box's padding and
 * border. Wide boxes are drawn at the page's width; this is only the fallback where that isn't
 * known (the server, exports, before the page is measured).
 */
export const READABLE_BOX_W = 686;
/** Width given to the one box a document becomes. */
export const CONVERTED_BOX_W = READABLE_BOX_W;
/**
 * The id of a blank page's first box. A blank canvas offers a box with this id, ready for
 * typing; it is only added to `boxes` once something is typed in it. A fixed id means two
 * people starting the same blank page at once write into one box.
 */
export const FIRST_BOX_ID = 'first';
/** Geometry of a blank page's first box: top left, wide. */
export const FIRST_BOX: BoxGeom = { id: FIRST_BOX_ID, x: 0, y: 0, w: READABLE_BOX_W, z: 1, wide: true };

/** True when a fragment holds nothing a reader would see: no nodes, or only empty paragraphs. */
export function fragmentIsEmpty(frag: Y.XmlFragment): boolean {
  return frag
    .toArray()
    .every((n) => n instanceof Y.XmlElement && n.nodeName === 'paragraph' && n.toArray().every((c) => c instanceof Y.XmlText && c.length === 0));
}

const cloneContent = (frag: Y.XmlFragment) => frag.toArray().map((n) => (n as Y.XmlElement | Y.XmlText).clone());

/** A box's geometry as stored in `boxes`. */
export function newBoxMap(g: Omit<BoxGeom, 'id'>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('x', g.x);
  m.set('y', g.y);
  m.set('w', g.w);
  m.set('z', g.z);
  if (g.wide) m.set('wide', true);
  return m;
}

/**
 * Turn a page's content into the layout of `kind`, in one transaction (lossless: nodes are
 * copied with their attributes and marks, so tasks, mentions and comments stay put):
 *   canvas:   the `default` content becomes one box at the top left, at the readable width
 *             (nothing if it's empty);
 *   document: every non-empty box, in reading order, is appended to `default`; boxes go away.
 * Returns the id of the box created (canvas), if any.
 */
export function convertPageDoc(doc: Y.Doc, kind: 'canvas' | 'document', newBoxId: () => string, origin: unknown = null): string | null {
  let created: string | null = null;
  doc.transact(() => {
    const def = doc.getXmlFragment(DEFAULT_FIELD);
    const boxes = doc.getMap<unknown>(BOXES_KEY);
    if (kind === 'canvas') {
      if (fragmentIsEmpty(def)) {
        if (def.length) def.delete(0, def.length);
        return;
      }
      const id = newBoxId();
      const z = boxGeoms(doc).reduce((m, b) => Math.max(m, b.z), 0) + 1;
      doc.getXmlFragment(boxField(id)).insert(0, cloneContent(def));
      boxes.set(id, newBoxMap({ x: 0, y: 0, w: CONVERTED_BOX_W, z, wide: true }));
      def.delete(0, def.length);
      created = id;
    } else {
      if (fragmentIsEmpty(def) && def.length) def.delete(0, def.length);
      for (const b of readingOrder(boxGeoms(doc))) {
        const frag = doc.getXmlFragment(boxField(b.id));
        if (!fragmentIsEmpty(frag)) def.insert(def.length, cloneContent(frag));
        if (frag.length) frag.delete(0, frag.length);
        boxes.delete(b.id);
      }
    }
  }, origin);
  return created;
}

/**
 * Replace all of `target`'s content (default and boxes) with a copy of `source`'s, in one
 * transaction, then lay it out as `kind` (e.g. restoring a document version on a page that
 * is a canvas now). Box ids are kept, so a restore looks the same to everyone.
 */
export function replacePageContent(target: Y.Doc, source: Y.Doc, kind: 'canvas' | 'document', newBoxId: () => string, origin: unknown = null) {
  target.transact(() => {
    const def = target.getXmlFragment(DEFAULT_FIELD);
    const boxes = target.getMap<unknown>(BOXES_KEY);
    if (def.length) def.delete(0, def.length);
    for (const b of boxGeoms(target)) {
      const f = target.getXmlFragment(boxField(b.id));
      if (f.length) f.delete(0, f.length);
      boxes.delete(b.id);
    }
    def.insert(0, cloneContent(source.getXmlFragment(DEFAULT_FIELD)));
    for (const b of boxGeoms(source)) {
      const f = target.getXmlFragment(boxField(b.id));
      if (f.length) f.delete(0, f.length);
      f.insert(0, cloneContent(source.getXmlFragment(boxField(b.id))));
      boxes.set(b.id, newBoxMap(b));
    }
    convertPageDoc(target, kind, newBoxId);
    // A version saved with page settings brings them back; one from before settings existed keeps the current ones.
    if (source.getMap(PAGE_SETTINGS_KEY).size > 0) setPageSettings(target, readPageSettings(source));
    // Handwriting is part of what a version restores (nothing to copy until there is ink).
    replaceInk(target, source);
  }, origin);
}

/** The layout a doc's content is in: canvas if it has boxes, else document. */
export const docKind = (doc: Y.Doc): 'canvas' | 'document' => (doc.getMap(BOXES_KEY).size > 0 ? 'canvas' : 'document');

/** A heading of a page, for the outline: which box it is in and which (non-empty) heading of that box it is. */
export interface PageHeading {
  boxId: string;
  /** Index among the box's non-empty headings, in document order. */
  index: number;
  level: number;
  text: string;
}

/** The text of an element as the editor shows it (marks dropped). */
function elementText(el: Y.XmlElement): string {
  return el
    .toArray()
    .map((c) =>
      c instanceof Y.XmlText
        ? (c.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('')
        : c instanceof Y.XmlElement
          ? elementText(c)
          : '',
    )
    .join('');
}

/**
 * Every non-empty heading of a canvas, box by box in reading order (headings at the top level
 * or inside containers such as callouts and toggles, like the editor's own outline).
 */
export function pageHeadings(doc: Y.Doc): PageHeading[] {
  const out: PageHeading[] = [];
  for (const b of readingOrder(boxGeoms(doc))) {
    let index = 0;
    const walk = (n: Y.XmlFragment | Y.XmlElement) => {
      for (const c of n.toArray()) {
        if (!(c instanceof Y.XmlElement)) continue;
        if (c.nodeName === 'heading') {
          const text = elementText(c).trim();
          if (text) out.push({ boxId: b.id, index: index++, level: Number(c.getAttribute('level')) || 1, text });
        } else walk(c);
      }
    };
    walk(doc.getXmlFragment(boxField(b.id)));
  }
  return out;
}

// ───────────── Page settings ─────────────
// Per-page look (page colour, rule lines) in the `pageSettings` Y.Map. It is not a content
// field, so pageFragments() and everything that reads text ignore it; it syncs live and is
// saved with the page's Y.Doc (exports, versions). Values are stored explicitly, 'none'
// included, so a version that has settings restores them (see replacePageContent).

export const PAGE_SETTINGS_KEY = 'pageSettings';
export const PAGE_COLORS = ['none', 'yellow', 'green', 'blue', 'purple', 'pink', 'grey'] as const;
export type PageColor = (typeof PAGE_COLORS)[number];
export const RULE_LINES = ['none', 'lines', 'grid'] as const;
export type RuleLines = (typeof RULE_LINES)[number];

export interface PageSettings {
  color: PageColor;
  rules: RuleLines;
}
export const DEFAULT_PAGE_SETTINGS: PageSettings = { color: 'none', rules: 'none' };

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

/** Settings from untrusted values (a Y.Map's entries, template attrs): unknown values fall back to the defaults. */
export function parsePageSettings(src: unknown): PageSettings {
  const o = src && typeof src === 'object' && !Array.isArray(src) ? (src as Record<string, unknown>) : {};
  return { color: oneOf(PAGE_COLORS, o.color, 'none'), rules: oneOf(RULE_LINES, o.rules, 'none') };
}

/** A page's settings (defaults where unset or invalid). */
export function readPageSettings(doc: Y.Doc): PageSettings {
  return parsePageSettings(doc.getMap<unknown>(PAGE_SETTINGS_KEY).toJSON());
}

/** Change some of a page's settings in one transaction (invalid values are ignored). */
export function setPageSettings(doc: Y.Doc, patch: Partial<PageSettings>, origin: unknown = null) {
  const map = doc.getMap<unknown>(PAGE_SETTINGS_KEY);
  doc.transact(() => {
    if (patch.color !== undefined && PAGE_COLORS.includes(patch.color) && map.get('color') !== patch.color) map.set('color', patch.color);
    if (patch.rules !== undefined && RULE_LINES.includes(patch.rules) && map.get('rules') !== patch.rules) map.set('rules', patch.rules);
  }, origin);
}

/** Calls `fn` with the settings whenever they change (anyone's edit); returns the unsubscribe. */
export function observePageSettings(doc: Y.Doc, fn: (s: PageSettings) => void): () => void {
  const map = doc.getMap<unknown>(PAGE_SETTINGS_KEY);
  const on = () => fn(readPageSettings(doc));
  map.observe(on);
  return () => map.unobserve(on);
}

/** The settings that differ from the defaults (kept in template JSON); null when there are none. */
export function pageSettingsAttrs(doc: Y.Doc): Partial<PageSettings> | null {
  const s = readPageSettings(doc);
  const out: Partial<PageSettings> = {};
  if (s.color !== 'none') out.color = s.color;
  if (s.rules !== 'none') out.rules = s.rules;
  return Object.keys(out).length ? out : null;
}

// ───────────── Ink (docs/PLAN_INK.md; written by src/ink/ from phase I1, behind the `ink` flag) ─────────────
// Handwriting strokes in the `ink` Y.Map: stroke id → an immutable Uint8Array blob (the
// format is defined by the ink engine, PLAN_INK "Storage"). It is not a content field, so
// pageFragments() and every text reader skip it; the hooks below are where each reader will
// learn about ink. An app that doesn't know `ink` leaves it alone: Yjs keeps root types it
// doesn't read, so older apps can't damage handwriting.

export const INK_KEY = 'ink';
/**
 * The largest stroke blob accepted (bytes). nv-ink caps a stroke at 65,536 points of at most
 * ~7 bytes; anything bigger isn't a stroke this format can produce.
 */
export const MAX_STROKE_BYTES = 512 * 1024;

/** Whether a value can be an ink entry: a byte blob of a sane size. The blob itself is checked by whoever draws it. */
export const isStrokeValue = (v: unknown): v is Uint8Array => v instanceof Uint8Array && v.byteLength > 0 && v.byteLength <= MAX_STROKE_BYTES;

export interface InkStroke {
  id: string;
  data: Uint8Array;
}

/** The page's strokes (values that aren't stroke blobs are skipped), by id; drawing order comes from each blob's z key (src/ink/strokes.ts). */
export function pageInk(doc: Y.Doc): InkStroke[] {
  const out: InkStroke[] = [];
  doc.getMap<unknown>(INK_KEY).forEach((data, id) => {
    if (isStrokeValue(data)) out.push({ id, data });
  });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Does the page have any handwriting? */
export const hasInk = (doc: Y.Doc): boolean => pageInk(doc).length > 0;

/**
 * Text recognised from the page's handwriting, for search and the AI connector. Always empty
 * for now: recognition stores its results in an `inkText` map (PLAN_INK, phase I7).
 */
export function inkSearchText(_doc: Y.Doc): string {
  return '';
}

/** Remove `ink` entries that aren't stroke blobs (from a hand-built update); returns how many. */
export function dropInvalidInk(doc: Y.Doc, origin: unknown = null): number {
  const ink = doc.getMap<unknown>(INK_KEY);
  const bad = [...ink.entries()].filter(([, v]) => !isStrokeValue(v)).map(([k]) => k);
  if (bad.length) doc.transact(() => bad.forEach((k) => ink.delete(k)), origin);
  return bad.length;
}

/** Make `target`'s strokes the same as `source`'s (a version restore). Changes nothing when both have none. */
export function replaceInk(target: Y.Doc, source: Y.Doc) {
  const to = target.getMap<unknown>(INK_KEY);
  const from = new Map(pageInk(source).map((s) => [s.id, s.data]));
  for (const id of [...to.keys()]) if (!from.has(id)) to.delete(id);
  for (const [id, data] of from) {
    const cur = to.get(id);
    if (!(cur instanceof Uint8Array) || !bytesEqual(cur, data)) to.set(id, data);
  }
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// ───────────── Page format version ─────────────
// A page's format version lives in `pageFormat` and is written only when a format change has to
// change a stored page, or when a feature first writes data an older app must know about (the
// first ink stroke will). A page without it is version 1 (boxes and page settings). An app
// seeing a version newer than PAGE_FORMAT_VERSION knows the page holds something it can't show.

export const PAGE_FORMAT_KEY = 'pageFormat';
/** 2: reserves `ink` (PLAN_INK). */
export const PAGE_FORMAT_VERSION = 2;

/** The version stored in a page (1 when none is). */
export function pageFormatVersion(doc: Y.Doc): number {
  const v = doc.getMap<unknown>(PAGE_FORMAT_KEY).get('version');
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 1;
}

/** Was the page written by a newer app, in a format this one doesn't fully understand? */
export const isNewerPageFormat = (doc: Y.Doc): boolean => pageFormatVersion(doc) > PAGE_FORMAT_VERSION;

/**
 * Upgrade steps, by the version they lead to. Each changes the doc only if it must and says
 * whether it did. 2 (ink reserved) needs nothing: a page without `ink` simply has no strokes.
 */
const UPGRADES: Record<number, (doc: Y.Doc) => boolean> = {
  2: () => false,
};

/**
 * Bring a loaded page up to PAGE_FORMAT_VERSION. Writes the version only when a step changed
 * something, so pages that need nothing are left byte-for-byte as they were. Returns whether
 * the doc changed. A page from a newer app is left alone.
 */
export function upgradePageDoc(doc: Y.Doc, origin: unknown = null): boolean {
  const from = pageFormatVersion(doc);
  if (from >= PAGE_FORMAT_VERSION) return false;
  let changed = false;
  doc.transact(() => {
    for (let v = from + 1; v <= PAGE_FORMAT_VERSION; v++) changed = (UPGRADES[v]?.(doc) ?? false) || changed;
    if (changed) doc.getMap<unknown>(PAGE_FORMAT_KEY).set('version', PAGE_FORMAT_VERSION);
  }, origin);
  return changed;
}
