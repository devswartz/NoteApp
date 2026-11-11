// Clean a page's Yjs document that came from outside (workspace import), with the
// same rules the editor uses for pasted and imported Markdown (shared/urls.ts):
//   - images with an unsafe src are removed
//   - file cards with an unsafe url are removed
//   - link marks with an unsafe href are removed (the text stays)
//   - text colour / highlight marks keep only palette names (shared/colors.ts); anything else is dropped
// While walking, it can also rewrite references (ids, upload URLs) for the caller.
// Owner: Foundation.
import * as Y from 'yjs';
import { safeFileUrl, safeImageUrl, safeLinkUrl } from '../shared/urls.ts';
import { isColorName } from '../shared/colors.ts';
import { pageFragments } from '../shared/pageDoc.ts';

export interface SanitizeOptions {
  /** Called for every element that is kept, before its children (e.g. to rewrite a taskRef's id). */
  element?: (el: Y.XmlElement) => void;
  /** Rewrites a URL that passed the safety check (element attributes and link hrefs). Return it unchanged to keep it. */
  url?: (url: string) => string;
}

/** y-prosemirror stores a mark under its name, or `name--<hash>` for marks that can overlap. */
const isLinkKey = (k: string) => k === 'link' || k.startsWith('link--');
const isMarkKey = (k: string, name: string) => k === name || k.startsWith(`${name}--`);
/** Element attributes that hold a URL, by node type. */
const URL_ATTRS: Record<string, { attr: string; safe: (u: unknown) => string }> = {
  image: { attr: 'src', safe: safeImageUrl },
  fileAttachment: { attr: 'url', safe: safeFileUrl },
};

function cleanText(t: Y.XmlText, opts: SanitizeOptions): number {
  let removed = 0;
  let pos = 0;
  for (const op of t.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    const len = typeof op.insert === 'string' ? op.insert.length : 1;
    const change: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(op.attributes ?? {})) {
      // Colours: a text colour that isn't a palette name loses its styling; a highlight falls back to the default.
      const color = (v as { color?: unknown } | null)?.color;
      if (isMarkKey(k, 'textStyle') && !isColorName(color)) change[k] = null;
      if (isMarkKey(k, 'highlight') && color != null && !isColorName(color)) change[k] = { ...(v as object), color: null };
      if (!isLinkKey(k)) continue;
      const href = (v as { href?: unknown } | null)?.href;
      const safe = safeLinkUrl(href);
      if (!safe) {
        change[k] = null;
        removed++;
      } else if (opts.url && opts.url(safe) !== href) change[k] = { ...(v as object), href: opts.url(safe) };
    }
    if (Object.keys(change).length) t.format(pos, len, change);
    pos += len;
  }
  return removed;
}

function cleanChildren(parent: Y.XmlElement | Y.XmlFragment, opts: SanitizeOptions): number {
  let removed = 0;
  const kids = parent.toArray();
  // Back to front, so deleting doesn't shift the indexes still to visit.
  for (let i = kids.length - 1; i >= 0; i--) {
    const c = kids[i];
    if (c instanceof Y.XmlText) removed += cleanText(c, opts);
    else if (c instanceof Y.XmlElement) {
      const rule = URL_ATTRS[c.nodeName];
      const safe = rule ? rule.safe(c.getAttribute(rule.attr)) : '';
      if (rule && !safe) {
        parent.delete(i, 1);
        removed++;
        continue;
      }
      if (rule && opts.url) {
        const next = opts.url(safe);
        if (next !== c.getAttribute(rule.attr)) c.setAttribute(rule.attr, next);
      }
      opts.element?.(c);
      removed += cleanChildren(c, opts);
    }
  }
  return removed;
}

/** Sanitise in place; returns how many links or nodes were removed. */
export function sanitizeYDoc(doc: Y.Doc, opts: SanitizeOptions = {}, field?: string): number {
  let removed = 0;
  doc.transact(() => {
    // Without a field: every content fragment of the page (all canvas boxes).
    for (const frag of field ? [doc.getXmlFragment(field)] : pageFragments(doc)) removed += cleanChildren(frag, opts);
  });
  return removed;
}
