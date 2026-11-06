// Yjs (ProseMirror XML) → Markdown, for exports. Covers the editor's node types;
// unknown nodes fall back to their text.
import * as Y from 'yjs';

type Node = Y.XmlElement | Y.XmlText;
export type TaskLookup = (taskId: string) => { title: string; done: boolean; due?: string | null } | undefined;

function inline(t: Y.XmlText): string {
  return (t.toDelta() as { insert: unknown; attributes?: Record<string, { href?: string } | true> }[])
    .map((d) => {
      if (typeof d.insert !== 'string') return '';
      let s = d.insert;
      const a = d.attributes ?? {};
      if (a.code) return `\`${s}\``;
      if (a.bold) s = `**${s}**`;
      if (a.italic) s = `*${s}*`;
      if (a.strike) s = `~~${s}~~`;
      const link = a.link as { href?: string } | undefined;
      if (link?.href) s = `[${s}](${link.href})`;
      return s;
    })
    .join('');
}

const kids = (n: Y.XmlElement | Y.XmlFragment) => n.toArray() as Node[];
const textOf = (n: Y.XmlElement): string => kids(n).map((c) => (c instanceof Y.XmlText ? inline(c) : textOf(c))).join('');

function block(n: Node, tasks: TaskLookup, indent = ''): string[] {
  if (n instanceof Y.XmlText) return [indent + inline(n)];
  const attr = (k: string) => n.getAttribute(k) as unknown;
  switch (n.nodeName) {
    case 'paragraph':
      return [indent + textOf(n)];
    case 'heading':
      return ['#'.repeat(Number(attr('level')) || 1) + ' ' + textOf(n)];
    case 'blockquote':
      return kids(n).flatMap((c) => block(c, tasks)).map((l) => `> ${l}`);
    case 'codeBlock':
      return ['```' + ((attr('language') as string) ?? ''), textOf(n), '```'];
    case 'horizontalRule':
      return ['---'];
    case 'image':
      return [`![${(attr('alt') as string) ?? ''}](${attr('src') as string})`];
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return kids(n).flatMap((item, i) => {
        const marker =
          n.nodeName === 'orderedList' ? `${i + 1}.` : n.nodeName === 'taskList' ? `- [${(item as Y.XmlElement).getAttribute('checked') ? 'x' : ' '}]` : '-';
        const [first, ...rest] = kids(item as Y.XmlElement).flatMap((c) => block(c, tasks, indent + '  '));
        return [`${indent}${marker} ${(first ?? '').trimStart()}`, ...rest];
      });
    case 'taskRef': {
      const t = tasks(String(attr('taskId') ?? ''));
      return t ? [`${indent}- [${t.done ? 'x' : ' '}] ${t.title}${t.due ? ` (due ${t.due})` : ''}`] : [];
    }
    case 'table': {
      const rows = kids(n).map((r) => kids(r as Y.XmlElement).map((c) => textOf(c as Y.XmlElement).replace(/\|/g, '\\|')));
      if (!rows.length) return [];
      const head = rows[0];
      return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)];
    }
    default:
      return kids(n).flatMap((c) => block(c, tasks, indent));
  }
}

export function toMarkdown(title: string, frag: Y.XmlFragment, tasks: TaskLookup): string {
  const nodes = kids(frag);
  let out = '';
  nodes.forEach((n, i) => {
    const text = block(n, tasks).join('\n');
    if (!text) return;
    // Consecutive embedded tasks form one tight checklist.
    const tight = i > 0 && n instanceof Y.XmlElement && n.nodeName === 'taskRef' && (nodes[i - 1] as Y.XmlElement).nodeName === 'taskRef';
    out += (out ? (tight ? '\n' : '\n\n') : '') + text;
  });
  return `# ${title || 'Untitled'}\n\n${out.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
