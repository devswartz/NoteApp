// A tiny, safe Markdown renderer for the legal pages (legal/*.md). Supports
// headings (#, ##, ###), paragraphs, bullet and numbered lists, links,
// **bold**, *italic* and `code`. Anything else, including raw HTML, is shown as
// plain text: React escapes it, and there is no dangerouslySetInnerHTML.
// HTML comments (<!-- ... -->) are dropped first, so the owner can leave notes in the files.
import { Fragment, type ReactNode } from 'react';

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] };

/** Fills {{NAME}} placeholders; unknown names are left as they are. */
export function fillPlaceholders(md: string, values: Record<string, string>): string {
  return md.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => values[k] ?? m);
}

export function stripComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, '');
}

export function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join(' ') });
    if (list) blocks.push({ type: 'list', ...list });
    para = [];
    list = null;
  };
  for (const raw of stripComments(md).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ type: 'heading', level: h[1].length as 1 | 2 | 3, text: h[2].trim() });
      continue;
    }
    const li = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = !li[1];
      if (para.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(li[3].trim());
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ' ' + line.trim(); // wrapped list item
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** Only web links, email links and in-app paths are allowed as link targets. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^(https?:\/\/|mailto:[^\s@]+@)/i.test(h)) return h;
  if (/^\/(?!\/)/.test(h)) return h;
  return null;
}

const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|([^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,})/g;

type LinkFn = (href: string, children: ReactNode, key: number) => ReactNode;

export function renderInline(text: string, link: LinkFn): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = k++;
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined) {
      const href = safeHref(m[3]);
      out.push(href ? link(href, renderInline(m[2], link), key) : <Fragment key={key}>{m[2]}</Fragment>);
    } else if (m[4] !== undefined) out.push(<strong key={key}>{renderInline(m[4], link)}</strong>);
    else if (m[5] !== undefined) out.push(<em key={key}>{renderInline(m[5], link)}</em>);
    else out.push(link(`mailto:${m[6]}`, m[6], key));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const plainLink: LinkFn = (href, children, key) => (
  <a key={key} href={href}>
    {children}
  </a>
);

export function Markdown({ source, values = {}, link = plainLink }: { source: string; values?: Record<string, string>; link?: LinkFn }) {
  const blocks = parseBlocks(fillPlaceholders(source, values));
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const H = `h${b.level}` as 'h1' | 'h2' | 'h3';
          return <H key={i}>{renderInline(b.text, link)}</H>;
        }
        if (b.type === 'paragraph') return <p key={i}>{renderInline(b.text, link)}</p>;
        const L = b.ordered ? 'ol' : 'ul';
        return (
          <L key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{renderInline(it, link)}</li>
            ))}
          </L>
        );
      })}
    </>
  );
}
