// Text colour and highlight, from a fixed palette (shared/colors.ts).
// The marks hold a colour NAME and render it as data-color="red"; src/styles/colors.css
// turns the name into a colour for the current theme. Anything else (a hex value pasted
// from another site, a name we don't know) is dropped on paste and never rendered.
// Markdown export drops the colours (plain text stays); HTML/print keeps them.
import { Color, TextStyle } from '@tiptap/extension-text-style';
import { Highlight } from '@tiptap/extension-highlight';
import type { Editor } from '@tiptap/core';
import { COLOR_LABELS, COLOR_NAMES, isColorName, type ColorName } from '../../shared/colors.ts';

export { COLOR_LABELS, COLOR_NAMES, isColorName, type ColorName };

const nameFrom = (el: HTMLElement) => {
  const c = el.getAttribute('data-color');
  return isColorName(c) ? c : null;
};
const render = (attrs: Record<string, unknown>) => (isColorName(attrs.color) ? { 'data-color': attrs.color } : {});

/** `<span data-color="…">` only: spans with other inline styles (pasted from the web) stay plain text. */
export const NamedTextStyle = TextStyle.extend({
  parseHTML() {
    return [{ tag: 'span[data-color]', consuming: false, getAttrs: (el) => (nameFrom(el as HTMLElement) ? {} : false) }];
  },
});

export const NamedColor = Color.extend({
  addGlobalAttributes() {
    return [{ types: this.options.types, attributes: { color: { default: null, parseHTML: nameFrom, renderHTML: render } } }];
  },
});

/** A highlight without a colour (pasted `<mark>`, or `==text==` in Markdown) shows as yellow. */
export const NamedHighlight = Highlight.extend({
  addAttributes() {
    return { color: { default: null, parseHTML: nameFrom, renderHTML: render } };
  },
  // Markdown has no colours: keep the text, drop the mark.
  renderMarkdown: (node, h) => h.renderChildren(node),
}).configure({ multicolor: true });

export const colorExtensions = [NamedTextStyle, NamedColor, NamedHighlight];

export type ColorKind = 'text' | 'highlight';

/** Apply a palette colour to the selection (null = Default, which removes it). */
export function applyColor(editor: Editor, kind: ColorKind, name: ColorName | null) {
  const chain = editor.chain().focus();
  if (kind === 'text') (name ? chain.setColor(name) : chain.unsetColor()).run();
  else (name ? chain.setHighlight({ color: name }) : chain.unsetHighlight()).run();
}

/** The colour at the selection, as a palette name (null = Default). */
export function currentColor(editor: Editor, kind: ColorKind): ColorName | null {
  if (kind === 'text') {
    const c = editor.getAttributes('textStyle').color;
    return isColorName(c) ? c : null;
  }
  if (!editor.isActive('highlight')) return null;
  const c = editor.getAttributes('highlight').color;
  return isColorName(c) ? c : 'yellow';
}
