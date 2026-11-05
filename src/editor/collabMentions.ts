// @mentions in pages: an inline `mention` node (attrs: id = user id, label =
// name at the time) with an "@" suggestion popup listing workspace members.
// When a page is saved the server notifies people newly mentioned
// (server/collab.ts → server/notifications.ts). Owner: Collaboration & Access.
//
//   extensions: [..., MentionNode]
import { Node, mergeAttributes } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { useStore } from '../store.ts';
import type { Member } from '../../shared/types.ts';
import { matchMembers } from './collabMentionMatch.ts';
export { matchMembers };
import './collab.css';

export interface MentionAttrs {
  id: string;
  label: string;
}

export const MentionNode = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-id'), renderHTML: (a) => ({ 'data-id': a.id }) },
      label: { default: '', parseHTML: (el) => el.getAttribute('data-label'), renderHTML: (a) => ({ 'data-label': a.label }) },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-mention]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const me = useStore.getState().user?.id;
    return [
      'span',
      mergeAttributes({ 'data-mention': '', class: `mention${node.attrs.id === me ? ' is-me' : ''}` }, HTMLAttributes),
      `@${node.attrs.label}`,
    ];
  },
  renderText({ node }) {
    return `@${node.attrs.label}`;
  },
  addProseMirrorPlugins() {
    return [
      Suggestion<Member, MentionAttrs>({
        editor: this.editor,
        char: '@',
        pluginKey: new PluginKey('mention'),
        allowSpaces: false,
        items: ({ query }) => matchMembers(useStore.getState().members, query),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: 'mention', attrs: props },
              { type: 'text', text: ' ' },
            ])
            .run();
        },
        render: () => mentionPopup(),
      }),
    ];
  },
});

/** Minimal DOM popup for the suggestion (keyboard: ↑ ↓ Enter Tab Esc). */
function mentionPopup() {
  let el: HTMLDivElement | null = null;
  let items: Member[] = [];
  let index = 0;
  let pick: (m: Member) => void = () => {};

  const draw = (props: SuggestionProps<Member, MentionAttrs>) => {
    if (!el) return;
    items = props.items;
    pick = (m) => props.command({ id: m.id, label: m.name });
    index = Math.min(index, Math.max(0, items.length - 1));
    el.replaceChildren(
      ...(items.length
        ? items.map((m, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `mention-item${i === index ? ' is-active' : ''}`;
            const dot = document.createElement('span');
            dot.className = 'mention-dot';
            dot.style.background = m.color;
            const name = document.createElement('span');
            name.textContent = m.name;
            const email = document.createElement('span');
            email.className = 'muted small';
            email.textContent = m.email;
            b.append(dot, name, email);
            b.addEventListener('mousedown', (e) => {
              e.preventDefault();
              pick(m);
            });
            return b;
          })
        : [Object.assign(document.createElement('div'), { className: 'muted small mention-empty', textContent: 'No matching people' })]),
    );
    const rect = props.clientRect?.();
    if (rect) {
      const top = Math.min(rect.bottom + 4, window.innerHeight - el.offsetHeight - 8);
      el.style.top = `${Math.max(8, top)}px`;
      el.style.left = `${Math.min(rect.left, window.innerWidth - el.offsetWidth - 8)}px`;
    }
  };

  return {
    onStart(props: SuggestionProps<Member, MentionAttrs>) {
      el = document.createElement('div');
      el.className = 'mention-pop popover';
      el.setAttribute('role', 'listbox');
      document.body.append(el);
      index = 0;
      draw(props);
    },
    onUpdate(props: SuggestionProps<Member, MentionAttrs>) {
      draw(props);
    },
    onKeyDown({ event }: SuggestionKeyDownProps) {
      if (!el) return false;
      if (event.key === 'Escape') {
        el.remove();
        el = null;
        return true;
      }
      if (!items.length) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        index = (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        el.querySelectorAll('.mention-item').forEach((b, i) => b.classList.toggle('is-active', i === index));
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        pick(items[index]);
        return true;
      }
      return false;
    },
    onExit() {
      el?.remove();
      el = null;
    },
  };
}
