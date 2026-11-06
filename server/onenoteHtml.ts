// OneNote page HTML (from Microsoft Graph) → the editor's ProseMirror JSON, and JSON → Yjs.
// Owner: Import. Used by server/onenote.ts.
//
// The HTML is untrusted. Nothing from it is ever passed through as HTML: a small tolerant parser
// builds a tree, and the converter emits ONLY node and mark types that exist in the client editor's
// schema (src/editor/NoteEditor.tsx → documentExtensions), with the content rules that schema
// enforces (list items start with a paragraph, table cells hold blocks, images and file cards are
// blocks). Scripts, styles, iframes, forms and event-handler attributes are simply never read.
// URLs are filtered again by sanitizeContent / sanitizeYDoc (shared/urls.ts) before anything is stored.
import * as Y from 'yjs';

// ───────── A tiny HTML tree parser ─────────

export interface HNode {
  tag: string; // lower-case tag name, '#text' for text
  attrs: Record<string, string>;
  children: HNode[];
  text?: string;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'object']);
/** Elements whose content is never read (raw text or active content). */
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'math', 'form', 'button', 'select', 'textarea', 'input', 'head', 'frameset', 'frame', 'canvas', 'video', 'audio']);
/** Opening one of these closes an open <p>. */
const CLOSES_P = new Set(['p', 'div', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'hr']);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', copy: '©', reg: '®', trade: '™', euro: '€' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const k = m[1].toLowerCase();
    if (!Object.hasOwn(out, k)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Parse HTML into a tree. Never throws; malformed markup gives a best-effort tree. */
export function parseHtml(html: string): HNode {
  const root: HNode = { tag: '#root', attrs: {}, children: [] };
  const stack: HNode[] = [root];
  const top = () => stack[stack.length - 1];
  const popTo = (tag: string, stopAt: string[] = []) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stopAt.includes(stack[i].tag)) return false;
      if (stack[i].tag === tag) {
        stack.length = i;
        return true;
      }
    }
    return false;
  };
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)([^>]{0,8000})>/g; // bounded, so a stray "<" can't make this quadratic
  let last = 0;
  let m: RegExpExecArray | null;
  const text = (s: string) => {
    if (s) top().children.push({ tag: '#text', attrs: {}, children: [], text: decodeEntities(s) });
  };
  while ((m = re.exec(html))) {
    text(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) {
      popTo(m[1].toLowerCase());
      continue;
    }
    if (!m[2]) continue; // comment, doctype, CDATA, processing instruction
    const tag = m[2].toLowerCase();
    let rawAttrs = m[3] ?? '';
    const selfClosing = /\/\s*$/.test(rawAttrs);
    if (selfClosing) rawAttrs = rawAttrs.replace(/\/\s*$/, '');
    if (SKIP.has(tag)) {
      // Skip everything up to the matching close tag (raw text: a "<" inside a script isn't markup).
      if (!selfClosing && !VOID.has(tag)) {
        const close = new RegExp(`</\\s*${tag}\\s*>`, 'ig');
        close.lastIndex = last;
        const c = close.exec(html);
        last = c ? close.lastIndex : html.length;
        re.lastIndex = last;
      }
      continue;
    }
    // Implied end tags.
    if (CLOSES_P.has(tag)) popTo('p', ['td', 'th', 'li', 'blockquote', 'div']);
    if (tag === 'li') popTo('li', ['ul', 'ol', 'table']);
    if (tag === 'td' || tag === 'th') popTo('td', ['tr', 'table']) || popTo('th', ['tr', 'table']);
    if (tag === 'tr') popTo('tr', ['table']);
    const node: HNode = { tag, attrs: parseAttrs(rawAttrs), children: [] };
    top().children.push(node);
    if (!selfClosing && !VOID.has(tag)) stack.push(node);
  }
  text(html.slice(last));
  return root;
}

export function findAll(n: HNode, tag: string, out: HNode[] = []): HNode[] {
  for (const c of n.children) {
    if (c.tag === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}
export function textOf(n: HNode): string {
  return n.tag === '#text' ? (n.text ?? '') : n.children.map(textOf).join('');
}

// ───────── HTML tree → ProseMirror JSON ─────────

export interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: Mark[];
  content?: PMNode[];
  text?: string;
  [k: string]: unknown;
}

/** What the converter found that needs work outside it (downloads, tasks). */
export interface Resource {
  /** Placeholder key, written into the node's url/src until the file is stored. */
  key: string;
  kind: 'image' | 'file';
  url: string;
  /** Declared MIME type (data-src-type / type), untrusted. */
  type: string;
  name: string;
  alt?: string;
}
export interface Todo {
  key: string;
  title: string;
  done: boolean;
}
export interface Converted {
  title: string;
  doc: PMNode & { type: 'doc'; content: PMNode[] };
  resources: Resource[];
  todos: Todo[];
}

/** Placeholders the caller replaces: `onenote-res:<n>` (src/url) and `onenote-todo:<n>` (taskRef.taskId). */
export const RES_PREFIX = 'onenote-res:';
export const TODO_PREFIX = 'onenote-todo:';

const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'underline'];
const INLINE_MARK: Record<string, string> = { b: 'bold', strong: 'bold', i: 'italic', em: 'italic', cite: 'italic', u: 'underline', ins: 'underline', s: 'strike', strike: 'strike', del: 'strike' };
const BLOCK_CONTAINERS = new Set(['#root', 'html', 'body', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'figure', 'center', 'dl', 'dd', 'dt', 'tbody', 'thead', 'tfoot', 'caption', 'details', 'summary', 'fieldset']);
const MAX_TITLE = 500;

/** data-tag="to-do" / "to-do:completed" (OneNote allows several tags, comma-separated). */
function todoTag(n: HNode): 'open' | 'done' | null {
  const tags = (n.attrs['data-tag'] ?? '').split(',').map((t) => t.trim().toLowerCase());
  if (tags.includes('to-do:completed')) return 'done';
  if (tags.includes('to-do')) return 'open';
  return null;
}

function styleMarks(style: string | undefined): string[] {
  if (!style) return [];
  const s = style.toLowerCase().replace(/\s+/g, '');
  const out: string[] = [];
  if (/font-weight:(bold|[6-9]00)/.test(s)) out.push('bold');
  if (/font-style:italic/.test(s)) out.push('italic');
  if (/text-decoration[^;]*underline/.test(s)) out.push('underline');
  if (/text-decoration[^;]*line-through/.test(s)) out.push('strike');
  return out;
}

const addMark = (marks: Mark[], m: Mark): Mark[] => {
  const rest = marks.filter((x) => x.type !== m.type);
  return [...rest, m].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
};

class Converter {
  resources: Resource[] = [];
  todos: Todo[] = [];

  private resource(kind: Resource['kind'], url: string, type: string, name: string, alt?: string): string {
    const key = `${RES_PREFIX}${this.resources.length}`;
    this.resources.push({ key, kind, url, type, name, alt });
    return key;
  }

  /** Block content of a container element's children. */
  blocks(children: HNode[]): PMNode[] {
    const out: PMNode[] = [];
    let inline: PMNode[] = [];
    const flush = () => {
      const content = trimInline(inline);
      inline = [];
      if (content.length) out.push({ type: 'paragraph', content });
    };
    for (const c of children) {
      if (this.isBlock(c)) {
        flush();
        out.push(...this.block(c));
      } else {
        // Whitespace between blocks isn't a paragraph.
        if (c.tag === '#text' && !inline.length && !/\S/.test(c.text ?? '')) continue;
        this.inline(c, [], inline, (b) => {
          flush();
          out.push(b);
        });
      }
    }
    flush();
    return out;
  }

  private isBlock(n: HNode): boolean {
    return n.tag !== '#text' && (BLOCK_CONTAINERS.has(n.tag) || ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'tr', 'pre', 'blockquote', 'hr'].includes(n.tag));
  }

  /** One block-level element → zero or more blocks. */
  private block(n: HNode): PMNode[] {
    const todo = todoTag(n);
    if (todo && n.tag !== 'ul' && n.tag !== 'ol' && n.tag !== 'table') return this.todo(n, todo === 'done');
    switch (n.tag) {
      case 'p':
        return this.textblock(n, { type: 'paragraph' }, true);
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return this.textblock(n, { type: 'heading', attrs: { level: Math.min(3, Number(n.tag[1])) } }, false);
      case 'ul':
      case 'ol':
        return this.list(n);
      case 'li': // a stray <li> outside a list
        return this.list({ tag: 'ul', attrs: {}, children: [n] });
      case 'table':
        return this.table(n);
      case 'tr':
        return this.table({ tag: 'table', attrs: {}, children: [n] });
      case 'pre': {
        const text = textOf(n).replace(/\r\n?/g, '\n').replace(/\n$/, '');
        return [{ type: 'codeBlock', attrs: { language: null }, ...(text ? { content: [{ type: 'text', text }] } : {}) }];
      }
      case 'blockquote': {
        const inner = this.blocks(n.children);
        return [{ type: 'blockquote', content: inner.length ? inner : [{ type: 'paragraph' }] }];
      }
      case 'hr':
        return [{ type: 'horizontalRule' }];
      default:
        return this.blocks(n.children);
    }
  }

  /** A paragraph or heading; images/attachments inside it are hoisted out as their own blocks. */
  private textblock(n: HNode, wrapper: PMNode, keepEmpty: boolean): PMNode[] {
    const out: PMNode[] = [];
    let inline: PMNode[] = [];
    let emitted = false;
    const flush = (final: boolean) => {
      const content = trimInline(inline);
      inline = [];
      if (content.length || (final && keepEmpty && !emitted)) {
        out.push({ ...wrapper, ...(content.length ? { content } : {}) });
        emitted = true;
      }
    };
    for (const c of n.children) {
      if (this.isBlock(c)) {
        flush(false);
        out.push(...this.block(c));
        emitted = true;
      } else
        this.inline(c, [], inline, (b) => {
          flush(false);
          out.push(b);
          emitted = true;
        });
    }
    flush(true);
    return out;
  }

  private inline(n: HNode, marks: Mark[], out: PMNode[], hoist: (b: PMNode) => void) {
    if (n.tag === '#text') {
      const text = (n.text ?? '').replace(/[\s ]+/g, (w) => (w.includes(' ') && !/[^\S ]/.test(w) ? w : ' '));
      if (text) out.push({ type: 'text', text, ...(marks.length ? { marks } : {}) });
      return;
    }
    if (n.tag === 'br') return void out.push({ type: 'hardBreak' });
    if (n.tag === 'img') return void this.image(n, hoist);
    if (n.tag === 'object') return void this.object(n, hoist);
    if (this.isBlock(n)) {
      for (const b of this.block(n)) hoist(b);
      return;
    }
    let next = marks;
    if (INLINE_MARK[n.tag]) next = addMark(next, { type: INLINE_MARK[n.tag] });
    for (const s of styleMarks(n.attrs.style)) next = addMark(next, { type: s });
    if (n.tag === 'a' && n.attrs.href) next = addMark(next, { type: 'link', attrs: { href: n.attrs.href, target: '_blank', rel: 'noopener noreferrer nofollow' } });
    if (todoTag(n)) {
      // A to-do tag on an inline element (rare): treat it like a to-do block.
      for (const b of this.todo(n, todoTag(n) === 'done')) hoist(b);
      return;
    }
    for (const c of n.children) this.inline(c, next, out, hoist);
  }

  private image(n: HNode, emit: (b: PMNode) => void) {
    const url = n.attrs['data-fullres-src'] || n.attrs.src || '';
    const type = (n.attrs['data-fullres-src'] ? n.attrs['data-fullres-src-type'] : n.attrs['data-src-type']) || n.attrs['data-src-type'] || '';
    if (!url) return;
    const alt = (n.attrs.alt ?? '').slice(0, 500);
    const key = this.resource('image', url, type, 'image', alt);
    emit({ type: 'image', attrs: { src: key, alt: alt || null, title: null } });
  }

  private object(n: HNode, emit: (b: PMNode) => void) {
    const url = n.attrs.data || '';
    if (!url) return;
    const name = (n.attrs['data-attachment'] || 'attachment').slice(0, 200);
    const key = this.resource('file', url, n.attrs.type ?? '', name);
    emit({ type: 'fileAttachment', attrs: { url: key, name, size: 0, mime: '' } });
  }

  /** A to-do paragraph/item → a taskRef block (the title is its text); its images and nested blocks follow it. */
  private todo(n: HNode, done: boolean): PMNode[] {
    const extra: PMNode[] = [];
    const inline: PMNode[] = [];
    for (const c of n.children) {
      if (this.isBlock(c) && (c.tag === 'ul' || c.tag === 'ol' || c.tag === 'table' || todoTag(c))) extra.push(...this.block(c));
      else this.inline(c, [], inline, (b) => extra.push(b));
    }
    const title = inline.map((x) => (x.type === 'text' ? x.text : ' ')).join('').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || 'To-do';
    const key = `${TODO_PREFIX}${this.todos.length}`;
    this.todos.push({ key, title, done });
    return [{ type: 'taskRef', attrs: { taskId: key } }, ...extra];
  }

  /** ul/ol → lists. A to-do item can't live inside a list item (taskRef isn't allowed first), so it splits the list. */
  private list(n: HNode): PMNode[] {
    const type = n.tag === 'ol' ? 'orderedList' : 'bulletList';
    const out: PMNode[] = [];
    let items: PMNode[] = [];
    const flush = () => {
      if (items.length) out.push({ type, ...(type === 'orderedList' ? { attrs: { start: 1, type: null } } : {}), content: items });
      items = [];
    };
    for (const c of n.children) {
      if (c.tag === '#text') continue;
      if (c.tag === 'ul' || c.tag === 'ol') {
        // A nested list directly in a list: attach it to the previous item.
        const nested = this.list(c);
        if (items.length) items[items.length - 1].content!.push(...nested);
        else {
          flush();
          out.push(...nested);
        }
        continue;
      }
      if (todoTag(c)) {
        flush();
        out.push(...this.todo(c, todoTag(c) === 'done'));
        continue;
      }
      const inner = c.tag === 'li' ? this.blocks(c.children) : this.blocks([c]);
      if (!inner.length && c.tag !== 'li') continue;
      if (inner[0]?.type !== 'paragraph') inner.unshift({ type: 'paragraph' });
      items.push({ type: 'listItem', content: inner });
    }
    flush();
    return out;
  }

  private table(n: HNode): PMNode[] {
    const rows: HNode[] = [];
    const collect = (x: HNode) => {
      for (const c of x.children) {
        if (c.tag === 'tr') rows.push(c);
        else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') collect(c);
      }
    };
    collect(n);
    const out: PMNode[] = [];
    for (const r of rows) {
      const cells = r.children.filter((c) => c.tag === 'td' || c.tag === 'th');
      if (!cells.length) continue;
      out.push({
        type: 'tableRow',
        content: cells.map((c) => {
          const inner = this.blocks(c.children);
          const span = (v: string | undefined) => Math.max(1, Math.min(50, Number(v) || 1));
          return { type: c.tag === 'th' ? 'tableHeader' : 'tableCell', attrs: { colspan: span(c.attrs.colspan), rowspan: span(c.attrs.rowspan), colwidth: null }, content: inner.length ? inner : [{ type: 'paragraph' }] };
        }),
      });
    }
    return out.length ? [{ type: 'table', content: out }] : [];
  }
}

/** Trim leading/trailing spaces of an inline run and merge adjacent text with the same marks. */
function trimInline(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.type === 'text' && prev?.type === 'text' && JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])) prev.text += n.text!;
    else out.push({ ...n });
  }
  // Collapse a space that follows a space across mark boundaries.
  for (let i = 1; i < out.length; i++) if (out[i].type === 'text' && out[i - 1].type === 'text' && out[i - 1].text!.endsWith(' ') && out[i].text!.startsWith(' ')) out[i].text = out[i].text!.slice(1);
  if (out[0]?.type === 'text') out[0].text = out[0].text!.replace(/^ +/, '');
  const l = out[out.length - 1];
  if (l?.type === 'text') l.text = l.text!.replace(/ +$/, '');
  return out.filter((n) => n.type !== 'text' || n.text);
}

/** Convert one OneNote page. `fallbackTitle` is used when the HTML has no <title>. */
export function convertOneNotePage(html: string, fallbackTitle = ''): Converted {
  const root = parseHtml(html);
  // <title> is inside <head>, which the parser skips, so read it directly.
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = (fallbackTitle || (t ? decodeEntities(t[1]) : '')).replace(/\s+/g, ' ').trim().slice(0, 300) || 'Untitled';
  const body = findAll(root, 'body')[0] ?? root;
  const c = new Converter();
  const content = c.blocks(body.children);
  return { title, doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }, resources: c.resources, todos: c.todos };
}

// ───────── ProseMirror JSON → Yjs (the shape y-prosemirror / @tiptap/y-tiptap uses) ─────────

/** Write a document's block content into a Y.XmlFragment: element nodeName = node type, text marks = format attributes. */
export function jsonToYFragment(doc: PMNode, frag: Y.XmlFragment) {
  const build = (nodes: PMNode[]): (Y.XmlElement | Y.XmlText)[] => {
    const out: (Y.XmlElement | Y.XmlText)[] = [];
    let text: Y.XmlText | null = null;
    let at = 0;
    for (const n of nodes) {
      if (n.type === 'text') {
        if (!n.text) continue;
        if (!text) {
          text = new Y.XmlText();
          out.push(text);
          at = 0;
        }
        const attrs: Record<string, unknown> = {};
        for (const m of n.marks ?? []) attrs[m.type] = m.attrs ?? {};
        text.insert(at, n.text, attrs);
        at += n.text.length;
        continue;
      }
      text = null;
      const el = new Y.XmlElement(n.type);
      for (const [k, v] of Object.entries(n.attrs ?? {})) if (v !== null && v !== undefined) el.setAttribute(k, v as string);
      const kids = build(n.content ?? []);
      if (kids.length) el.insert(0, kids);
      out.push(el);
    }
    return out;
  };
  const kids = build(doc.content ?? []);
  if (kids.length) frag.insert(0, kids);
}
