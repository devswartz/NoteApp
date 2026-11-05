// Custom block nodes: callout, file attachment card, code block with a language picker.
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { CodeBlock as CodeBlockBase } from '@tiptap/extension-code-block';
import { codeHighlightPlugin } from './codeHighlight.ts';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import ImageExt from '@tiptap/extension-image';
import { createLowlight, common } from 'lowlight';
import { useState } from 'react';
import { Check, Copy, Download, File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo } from 'lucide-react';
import { fileUrl } from '../api.ts';
import { Dropdown } from '../components/ui.tsx';
import { safeFileUrl, safeImageUrl } from './urls.ts';

/** Absolute URL for exports (uploads are stored API-relative). */
export const absoluteUrl = (u: string) => {
  try {
    return new URL(fileUrl(u), location.href).href;
  } catch {
    return u;
  }
};

/** Markdown for block children, prefixed as a quote ("> "). */
function quoteMarkdown(text: string) {
  return text
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

// ───────────── Callout ─────────────

export const CALLOUT_EMOJIS = ['💡', 'ℹ️', '⚠️', '❗', '✅', '📌', '🔥', '❓', '📝', '🚀'];

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the current block(s) in a callout. */
      setCallout: (attrs?: { emoji?: string }) => ReturnType;
      toggleCallout: (attrs?: { emoji?: string }) => ReturnType;
    };
    fileAttachment: {
      insertFileAttachment: (attrs: FileAttrs, pos?: number) => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      emoji: {
        default: '💡',
        parseHTML: (el) => el.getAttribute('data-emoji') || '💡',
        renderHTML: (a) => ({ 'data-emoji': a.emoji }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout', class: 'callout' }), 0];
  },
  // Exported as a quote that starts with the emoji: "> 💡 Remember…"
  renderMarkdown(node, h) {
    const body = (node.content ?? []).map((c) => h.renderChildren([c])).join('\n\n');
    return quoteMarkdown(`${node.attrs?.emoji ?? '💡'} ${body}`);
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
  addCommands() {
    return {
      setCallout:
        (attrs = {}) =>
        ({ commands }) =>
          commands.wrapIn(this.name, attrs),
      toggleCallout:
        (attrs = {}) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, attrs),
    };
  },
  addKeyboardShortcuts() {
    return {
      // Backspace at the very start of an empty callout unwraps it.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        const depth = $from.depth - 1;
        if (depth < 1 || $from.node(depth).type.name !== this.name || $from.index(depth) !== 0) return false;
        return editor.commands.lift(this.name);
      },
    };
  },
});

function CalloutView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  return (
    <NodeViewWrapper className="callout" data-type="callout">
      <span contentEditable={false} className="callout-emoji-wrap">
        <Dropdown trigger={node.attrs.emoji as string} buttonClass="callout-emoji" title="Change icon" disabled={!editor.isEditable}>
          {(close) => (
            <div className="emoji-grid">
              {CALLOUT_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="emoji-btn"
                  onClick={() => {
                    updateAttributes({ emoji: e });
                    close();
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </Dropdown>
      </span>
      <NodeViewContent className="callout-body" />
    </NodeViewWrapper>
  );
}

// ───────────── File attachment card ─────────────

export interface FileAttrs {
  url: string;
  name: string;
  size: number;
  mime: string;
}

export function formatSize(n: number) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(mime: string, name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) return <FileImage size={20} />;
  if (mime.startsWith('video/')) return <FileVideo size={20} />;
  if (mime.startsWith('audio/')) return <FileAudio size={20} />;
  if (/zip|tar|gzip|7z|rar/.test(mime) || ['zip', 'gz', '7z', 'rar', 'tar'].includes(ext)) return <FileArchive size={20} />;
  if (/sheet|excel|csv/.test(mime) || ['xls', 'xlsx', 'csv', 'numbers'].includes(ext)) return <FileSpreadsheet size={20} />;
  if (mime.startsWith('text/') || /pdf|word|document/.test(mime)) return <FileText size={20} />;
  return <File size={20} />;
}

export const FileAttachment = Node.create({
  name: 'fileAttachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    const attr = (name: string, fallback: string | number) => ({
      default: fallback,
      parseHTML: (el: HTMLElement) => {
        const v = el.getAttribute(`data-${name}`);
        return typeof fallback === 'number' ? Number(v) || 0 : (v ?? fallback);
      },
      renderHTML: (a: Record<string, unknown>) => ({ [`data-${name}`]: a[name] }),
    });
    return {
      url: {
        default: '',
        parseHTML: (el: HTMLElement) => safeFileUrl(el.getAttribute('data-url')),
        renderHTML: (a: Record<string, unknown>) => ({ 'data-url': safeFileUrl(a.url) }),
      },
      name: attr('name', 'file'),
      size: attr('size', 0),
      mime: attr('mime', ''),
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="file"]' }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'file', class: 'file-card' }),
      ['a', { href: fileUrl(safeFileUrl(node.attrs.url)) || '#', target: '_blank', rel: 'noopener noreferrer' }, node.attrs.name as string],
    ];
  },
  renderText({ node }) {
    return `📎 ${node.attrs.name}`;
  },
  renderMarkdown(node) {
    const url = safeFileUrl(node.attrs?.url);
    const name = String(node.attrs?.name ?? 'file').replace(/[[\]]/g, '');
    return url ? `[📎 ${name}](${absoluteUrl(url)})` : `📎 ${name}`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileCardView);
  },
  addCommands() {
    return {
      insertFileAttachment:
        (attrs, pos) =>
        ({ commands }) =>
          pos === undefined
            ? commands.insertContent({ type: this.name, attrs: { ...attrs, url: safeFileUrl(attrs.url) } })
            : commands.insertContentAt(pos, { type: this.name, attrs: { ...attrs, url: safeFileUrl(attrs.url) } }),
    };
  },
});

function FileCardView({ node, selected }: ReactNodeViewProps) {
  const a = node.attrs as FileAttrs;
  // Validated again here: the attribute may have arrived from a collaborator's (or an older) document.
  const safe = safeFileUrl(a.url);
  const href = safe ? fileUrl(safe) : undefined;
  return (
    <NodeViewWrapper className={`file-card ${selected ? 'is-selected' : ''}`} data-type="file" data-drag-handle>
      <div className="file-card-inner" contentEditable={false}>
        <span className="file-card-icon">{fileIcon(a.mime, a.name)}</span>
        {href ? (
          <a className="file-card-name" href={href} target="_blank" rel="noopener noreferrer" title={`Open ${a.name}`}>
            {a.name}
          </a>
        ) : (
          <span className="file-card-name" title="This file link is not valid">
            {a.name}
          </span>
        )}
        <span className="file-card-size">{formatSize(a.size)}</span>
        {href && (
          <a className="icon-btn btn-ghost file-card-dl" href={href} download={a.name} target="_blank" rel="noopener noreferrer" title="Download">
            <Download size={15} />
          </a>
        )}
      </div>
    </NodeViewWrapper>
  );
}

// ───────────── Images ─────────────

/** Images keep the API-relative src ("/uploads/…") in the doc and resolve it on render; resizable by dragging. */
export const Image = ImageExt.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      src: {
        default: null,
        // Only our uploads and http(s) images: never javascript:/data: from pasted HTML or imports.
        parseHTML: (el: HTMLElement) => safeImageUrl(el.getAttribute('src')) || null,
        renderHTML: (a: Record<string, unknown>) => {
          const src = safeImageUrl(a.src);
          return { src: src ? fileUrl(src) : null };
        },
      },
    };
  },
  renderMarkdown(node) {
    const safe = safeImageUrl(node.attrs?.src);
    const src = safe ? absoluteUrl(safe) : '';
    const alt = String(node.attrs?.alt ?? '').replace(/[[\]]/g, '');
    return `![${alt}](${src})`;
  },
}).configure({
  allowBase64: false,
  resize: { enabled: true, directions: ['left', 'right', 'bottom-left', 'bottom-right'], minWidth: 80, alwaysPreserveAspectRatio: true },
});

// ───────────── Toggle (details) ─────────────

/** Toggles export as HTML <details>, which GitHub, Obsidian and most Markdown renderers show as collapsible. */
export const Toggle = Details.extend({
  renderMarkdown(node, h) {
    const [summary, content] = node.content ?? [];
    const title = summary ? h.renderChildren(summary.content ?? []) : '';
    const body = content ? (content.content ?? []).map((c) => h.renderChildren([c])).join('\n\n') : '';
    return `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;
  },
}).configure({ persist: false, HTMLAttributes: { class: 'toggle' } });
export const ToggleSummary = DetailsSummary;
export const ToggleContent = DetailsContent;

// ───────────── Code block ─────────────

export const lowlight = createLowlight(common);

export const CODE_LANGUAGES: { id: string; label: string }[] = [
  { id: '', label: 'Plain text' },
  { id: 'bash', label: 'Bash' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'css', label: 'CSS' },
  { id: 'diff', label: 'Diff' },
  { id: 'go', label: 'Go' },
  { id: 'graphql', label: 'GraphQL' },
  { id: 'xml', label: 'HTML / XML' },
  { id: 'java', label: 'Java' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'json', label: 'JSON' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'php', label: 'PHP' },
  { id: 'python', label: 'Python' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'rust', label: 'Rust' },
  { id: 'sql', label: 'SQL' },
  { id: 'swift', label: 'Swift' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'yaml', label: 'YAML' },
];

export const CodeBlock = CodeBlockBase.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
  addProseMirrorPlugins() {
    // Incremental highlighting (see codeHighlight.ts) instead of code-block-lowlight's whole-doc rescans.
    return [...(this.parent?.() ?? []), codeHighlightPlugin({ name: this.name, lowlight, defaultLanguage: null })];
  },
}).configure({ enableTabIndentation: true });

function CodeBlockView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const [copied, setCopied] = useState(false);
  const lang = (node.attrs.language as string | null) ?? '';
  const known = CODE_LANGUAGES.some((l) => l.id === lang);
  return (
    <NodeViewWrapper className="code-block">
      <div className="code-block-bar" contentEditable={false}>
        <select
          className="code-lang"
          value={lang}
          disabled={!editor.isEditable}
          onChange={(e) => updateAttributes({ language: e.target.value || null })}
          aria-label="Code language"
        >
          {!known && <option value={lang}>{lang}</option>}
          {CODE_LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-ghost btn-sm code-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(node.textContent).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <NodeViewContent<'code'> as="code" className={lang ? `language-${lang}` : undefined} />
      </pre>
    </NodeViewWrapper>
  );
}

