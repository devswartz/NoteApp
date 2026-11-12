// Export a page's Yjs document as plain Markdown (no DOM; unit-tested). Owner: Collaboration & Access.
import * as Y from 'yjs';
import { listMarker, listSuffix, xmlListStart } from '../../shared/listMarker.ts';

/** Plain Markdown of a page doc (headings, lists, tasks, quotes, code), for the unsynced-copy download. */
export function docToMarkdown(frag: Y.XmlFragment): string {
  const text = (n: Y.XmlElement | Y.XmlText | Y.XmlFragment): string =>
    n instanceof Y.XmlText
      ? n.toString().replace(/<[^>]+>/g, '')
      : n instanceof Y.XmlElement && n.nodeName === 'mention'
        ? `@${n.getAttribute('label') ?? ''}` // inline @mention chip: no children, the name is an attribute
        : n.toArray().map((c) => text(c as Y.XmlElement)).join('');
  const lines: string[] = [];
  const block = (n: Y.XmlElement, prefix = '') => {
    const name = n.nodeName;
    if (name === 'heading') lines.push(`${prefix}${'#'.repeat(Number(n.getAttribute('level')) || 1)} ${text(n)}`);
    else if (name === 'bulletList' || name === 'orderedList' || name === 'taskList')
      n.toArray().forEach((li, i) => {
        const marker = name === 'orderedList' ? `${listMarker(n.getAttribute('type'), xmlListStart(n) + i)}${listSuffix(n.getAttribute('paren'))} ` : name === 'taskList' ? `- [${(li as Y.XmlElement).getAttribute('checked') ? 'x' : ' '}] ` : '- ';
        const kids = (li as Y.XmlElement).toArray() as Y.XmlElement[];
        kids.forEach((k, j) => (j === 0 && !/List$/.test(k.nodeName) ? lines.push(`${prefix}${marker}${text(k)}`) : block(k, `${prefix}  `)));
      });
    else if (name === 'blockquote') (n.toArray() as Y.XmlElement[]).forEach((k) => block(k, `${prefix}> `));
    else if (name === 'codeBlock') lines.push(`${prefix}\`\`\``, text(n), `${prefix}\`\`\``);
    else if (name === 'taskRef') lines.push(`${prefix}- [task] ${n.getAttribute('taskId') ?? ''}`);
    else if (name === 'horizontalRule') lines.push(`${prefix}---`);
    else if (name === 'paragraph') lines.push(`${prefix}${text(n)}`);
    else (n.toArray() as Y.XmlElement[]).forEach((k) => (k instanceof Y.XmlElement ? block(k, prefix) : lines.push(prefix + text(k))));
    if (!prefix) lines.push('');
  };
  (frag.toArray() as Y.XmlElement[]).forEach((n) => (n instanceof Y.XmlElement ? block(n) : lines.push(text(n))));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
