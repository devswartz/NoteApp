// Ordered-list markers for plain-text exports (server Markdown, the unsynced-copy download).
/** An ordered list's marker: numbers, or the letters / roman numerals of a list typed as "a. " or "i. ". */
export function listMarker(type: unknown, n: number): string {
  if (type === 'a' || type === 'A') {
    let s = '';
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
    return type === 'A' ? s.toUpperCase() : s;
  }
  if (type === 'i' || type === 'I') {
    let s = '';
    let k = n;
    for (const [v, r] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as const)
      for (; k >= v; k -= v) s += r;
    return type === 'I' ? s.toUpperCase() : s;
  }
  return String(n);
}

export interface ListInfo {
  ordered: boolean;
  start: number;
  /** Carries on from the numbered list before it (split by Enter in the editor). */
  continued: boolean;
  items: number;
}

/** The first number of each ordered list among sibling blocks, following `continued` lists on from the one before. */
export function listStarts(siblings: ListInfo[]): (number | undefined)[] {
  let next = 1;
  return siblings.map((b) => {
    if (!b.ordered) return undefined;
    const start = b.continued ? next : b.start || 1;
    next = start + b.items;
    return start;
  });
}

interface JsonNodeLike {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNodeLike[];
}

/** Editor JSON with each `continued` list given its real start number (for serialisers that only know `start`). */
export function resolveListStarts<T extends JsonNodeLike>(node: T): T {
  if (!node.content) return node;
  const content = node.content.map((c) => resolveListStarts(c));
  const starts = listStarts(
    content.map((c) => ({
      ordered: c.type === 'orderedList',
      start: Number(c.attrs?.start) || 1,
      continued: !!c.attrs?.continued,
      items: c.content?.length ?? 0,
    })),
  );
  return { ...node, content: content.map((c, i) => (c.attrs?.continued ? { ...c, attrs: { ...c.attrs, start: starts[i], continued: false } } : c)) };
}

/** The bits of a Yjs XML node the exports need (structural, so this file needs no yjs import). */
interface XmlNodeLike {
  nodeName?: string;
  length: number;
  prevSibling: XmlNodeLike | null;
  getAttribute?: (k: string) => unknown;
}

/** The first number of a Yjs ordered list, following a `continued` list on from the lists before it. */
export function xmlListStart(list: XmlNodeLike): number {
  const sibs: XmlNodeLike[] = [];
  for (let s: XmlNodeLike | null = list; s; s = s.prevSibling) sibs.unshift(s);
  const starts = listStarts(
    sibs.map((s) => ({
      ordered: s.nodeName === 'orderedList',
      start: Number(s.getAttribute?.('start')) || 1,
      continued: !!s.getAttribute?.('continued'),
      items: s.length,
    })),
  );
  return starts[starts.length - 1] ?? 1;
}

/** "." or, for a list typed as "1) ", ")". */
export const listSuffix = (paren: unknown) => (paren ? ')' : '.');
