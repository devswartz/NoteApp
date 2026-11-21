// The editor suite's document notation (tests/editor/README.md): a box's content as compact XML-like
// text with the selection marked in it, e.g. `<paragraph>Hel|lo <bold>world</bold></paragraph>`.
//
// Element names are ProseMirror node and mark names (the same names the page's Yjs XML uses); a name
// that is a mark in the schema wraps text in that mark. Attributes are `key=value` with JSON values
// (`level=2`, `checked=true`, `href="https://x"`); attributes at their default are left out when
// serialising. `<name/>` is a leaf (an empty or atom node). Selection markers in text or between
// nodes: `|` is a caret, `[` the anchor and `]` the head of a range, `^` right before a node selects
// that node (a node selection). `\` escapes `< > | [ ] ^ \`.
// Whitespace-only text that contains a line break is ignored, so expectations can be indented.
//
// The Rust runner (crates/nv-editor/tests) implements the same notation; keep them in step.
import type { Mark as PMMark, Node as PMNode, Schema } from '@tiptap/pm/model';

export interface Parsed {
  /** ProseMirror JSON of the doc (`{ type: 'doc', content }`). */
  json: { type: string; content?: unknown[] };
  anchor: number | null;
  head: number | null;
  /** Set for a node selection: the position before the selected node (anchor and head are null). */
  node: number | null;
}

type Tok =
  | { t: 'open'; name: string; attrs: Record<string, unknown>; selfClose: boolean }
  | { t: 'close'; name: string }
  | { t: 'text'; text: string }
  | { t: 'mark'; m: '|' | '[' | ']' | '^' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let text = '';
  const flush = () => {
    if (text && !(/^\s*$/.test(text) && /\n/.test(text))) out.push({ t: 'text', text });
    text = '';
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      text += src[i + 1] ?? '';
      i += 2;
    } else if (c === '|' || c === '[' || c === ']' || c === '^') {
      flush();
      out.push({ t: 'mark', m: c });
      i++;
    } else if (c === '<') {
      flush();
      const end = findTagEnd(src, i);
      const body = src.slice(i + 1, end).trim();
      i = end + 1;
      if (body.startsWith('/')) {
        out.push({ t: 'close', name: body.slice(1).trim() });
        continue;
      }
      const selfClose = body.endsWith('/');
      const inner = selfClose ? body.slice(0, -1).trim() : body;
      const m = /^([A-Za-z][\w-]*)/.exec(inner);
      if (!m) throw new Error(`bad tag <${body}>`);
      out.push({ t: 'open', name: m[1], attrs: parseAttrs(inner.slice(m[1].length)), selfClose });
    } else {
      text += c;
      i++;
    }
  }
  flush();
  return out;
}

function findTagEnd(src: string, start: number): number {
  let q = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === '"') q = false;
    } else if (c === '"') q = true;
    else if (c === '>') return i;
  }
  throw new Error('unclosed tag');
}

function parseAttrs(s: string): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const re = /\s*([\w-]+)=("(?:[^"\\]|\\.)*"|[^\s"]+)/y;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = re.exec(s))) {
    attrs[m[1]] = JSON.parse(m[2]);
    end = re.lastIndex;
  }
  if (s.slice(end).trim()) throw new Error(`bad attributes: ${s}`);
  return attrs;
}

/** Parse notation into ProseMirror JSON and the selection's positions. */
export function parse(src: string, schema: Schema): Parsed {
  const toks = tokenize(src);
  let i = 0;
  let pos = 0;
  let anchor: number | null = null;
  let head: number | null = null;
  let nodeSel: number | null = null;
  const isMark = (n: string) => !!schema.marks[n];
  // Parse children until </until>; marks are an inherited stack.
  const children = (until: string | null, marks: { type: string; attrs?: Record<string, unknown> }[]): unknown[] => {
    const out: unknown[] = [];
    while (i < toks.length) {
      const tk = toks[i++];
      if (tk.t === 'close') {
        if (tk.name !== until) throw new Error(`</${tk.name}> closes <${until}>`);
        return out;
      }
      if (tk.t === 'mark') {
        if (tk.m === '|') anchor = head = pos;
        else if (tk.m === '[') anchor = pos;
        else if (tk.m === '^') nodeSel = pos;
        else head = pos;
      } else if (tk.t === 'text') {
        out.push(marks.length ? { type: 'text', text: tk.text, marks: [...marks] } : { type: 'text', text: tk.text });
        pos += tk.text.length;
      } else if (isMark(tk.name)) {
        const m = Object.keys(tk.attrs).length ? { type: tk.name, attrs: tk.attrs } : { type: tk.name };
        if (!tk.selfClose) out.push(...children(tk.name, [...marks, m]));
      } else {
        const type = schema.nodes[tk.name];
        if (!type) throw new Error(`unknown node <${tk.name}>`);
        const node: Record<string, unknown> = { type: tk.name };
        if (Object.keys(tk.attrs).length) node.attrs = tk.attrs;
        if (type.isLeaf) {
          pos += 1;
          if (!tk.selfClose) children(tk.name, marks);
        } else {
          pos += 1;
          const kids = tk.selfClose ? [] : children(tk.name, type.isTextblock ? marks : []);
          if (kids.length) node.content = kids;
          pos += 1;
        }
        out.push(node);
      }
    }
    if (until) throw new Error(`<${until}> not closed`);
    return out;
  };
  const content = children(null, []);
  return { json: { type: 'doc', content }, anchor, head, node: nodeSel };
}

const ESC = /[<>|[\]^\\]/g;
const esc = (s: string) => s.replace(ESC, (c) => `\\${c}`);

function attrText(attrs: Record<string, unknown>, defaults: Record<string, unknown>, rename?: (k: string, v: unknown) => unknown): string {
  return Object.keys(attrs)
    .sort()
    .filter((k) => JSON.stringify(attrs[k]) !== JSON.stringify(defaults[k]))
    .map((k) => ` ${k}=${JSON.stringify(rename ? rename(k, attrs[k]) : attrs[k])}`)
    .join('');
}

const nodeDefaults = (n: PMNode) => Object.fromEntries(Object.entries(n.type.spec.attrs ?? {}).map(([k, v]) => [k, (v as { default?: unknown }).default ?? null]));
const markDefaults = (m: PMMark) => Object.fromEntries(Object.entries(m.type.spec.attrs ?? {}).map(([k, v]) => [k, (v as { default?: unknown }).default ?? null]));

export interface SerializeOptions {
  anchor?: number | null;
  head?: number | null;
  /** A node selection: the position before the selected node. */
  node?: number | null;
  /** Rewrites attribute values (task ids to stable names). */
  attr?: (key: string, value: unknown) => unknown;
  /** Attributes never written (ids that differ every run). */
  skipAttrs?: string[];
}

/** Serialise a doc (its content) in the notation, one top-level block per line. */
export function serialize(doc: PMNode, opts: SerializeOptions = {}): string {
  const { anchor = null, head = null } = opts;
  const skip = new Set(opts.skipAttrs ?? []);
  const sel = (p: number) => {
    if (opts.node != null) return p === opts.node ? '^' : '';
    if (anchor === null || head === null) return '';
    if (anchor === head) return p === anchor ? '|' : '';
    return (p === anchor ? '[' : '') + (p === head ? ']' : '');
  };
  const strip = (a: Record<string, unknown>) => Object.fromEntries(Object.entries(a).filter(([k]) => !skip.has(k)));
  const node = (n: PMNode, pos: number): string => {
    // pos: position before n
    const a = attrText(strip(n.attrs), nodeDefaults(n), opts.attr);
    if (n.isLeaf) return `<${n.type.name}${a}/>`;
    if (!n.content.size) return `<${n.type.name}${a}>${sel(pos + 1)}</${n.type.name}>`;
    return `<${n.type.name}${a}>${content(n, pos + 1)}</${n.type.name}>`;
  };
  const markOpen = (m: PMMark) => `<${m.type.name}${attrText(strip(m.attrs), markDefaults(m), opts.attr)}>`;
  const content = (parent: PMNode, start: number): string => {
    let s = '';
    let open: PMMark[] = [];
    let p = start;
    parent.forEach((child) => {
      const marks = child.isInline ? child.marks : [];
      // Keep the longest prefix of open marks that the child also has.
      let keep = 0;
      while (keep < open.length && keep < marks.length && open[keep].eq(marks[keep])) keep++;
      for (let k = open.length - 1; k >= keep; k--) s += `</${open[k].type.name}>`;
      open = open.slice(0, keep);
      for (const m of marks.slice(keep)) {
        s += markOpen(m);
        open.push(m);
      }
      if (child.isText) {
        const t = child.text ?? '';
        for (let k = 0; k < t.length; k++) s += sel(p + k) + esc(t[k]);
      } else {
        s += sel(p) + node(child, p);
      }
      p += child.nodeSize;
    });
    for (let k = open.length - 1; k >= 0; k--) s += `</${open[k].type.name}>`;
    return s + sel(p);
  };
  // Top level: one block per line.
  const lines: string[] = [];
  let p = 0;
  doc.forEach((child) => {
    lines.push(sel(p) + node(child, p));
    p += child.nodeSize;
  });
  if (lines.length) lines[lines.length - 1] += sel(p);
  return lines.join('\n');
}

/** Canonical form of notation text, for comparing an expectation with a result. */
export function canonical(src: string, schema: Schema, opts: Omit<SerializeOptions, 'anchor' | 'head'> = {}): string {
  const p = parse(src, schema);
  const doc = schema.nodeFromJSON(p.json);
  return serialize(doc, { ...opts, anchor: p.anchor, head: p.head, node: p.node });
}
