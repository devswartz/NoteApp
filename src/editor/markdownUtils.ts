// Pure helpers for Markdown export/import (unit-tested).

/** File-name-safe version of a page title. */
export function fileName(title: string, ext: string) {
  // Emoji are dropped: Chromium rejects download names containing them.
  const base = title.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').trim().replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${base || 'Untitled'}.${ext}`;
}

/**
 * Split an imported Markdown file into a title (a leading "# Heading") and the rest.
 * Pure, so it's unit-tested.
 */
export function splitTitle(md: string): { title: string | null; body: string } {
  const text = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^\s*#\s+(.+?)\s*#*\s*\n/.exec(text + '\n');
  if (!m) return { title: null, body: text };
  return { title: m[1].trim(), body: text.slice(m[0].length).replace(/^\n+/, '') };
}

interface Json {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Json[];
  [k: string]: unknown;
}

/**
 * Images are block nodes in the editor, but Markdown puts them inline ("See ![x](a.png) here").
 * Split any text block that contains images into: text before, the image, text after
 * (empty pieces dropped), at any depth (lists, quotes…).
 */
const TEXT_BLOCKS = new Set(['paragraph', 'heading']);
const ITEMS = new Set(['listItem', 'taskItem']);

export function liftInlineImages<T extends Json>(node: T): T {
  if (!node.content) return node;
  const out: Json[] = [];
  for (const child of node.content.map((c) => liftInlineImages(c))) {
    const inline = child.content ?? [];
    if (!TEXT_BLOCKS.has(child.type ?? '') || !inline.some((c) => c.type === 'image')) {
      out.push(child);
      continue;
    }
    let run: Json[] = [];
    const flush = () => {
      if (run.some((c) => c.type !== 'text' || String(c.text ?? '').trim())) out.push({ ...child, content: run });
      run = [];
    };
    for (const c of inline) {
      if (c.type === 'image') {
        flush();
        out.push(c);
      } else run.push(c);
    }
    flush();
  }
  // A list item must start with a paragraph.
  if (ITEMS.has(node.type ?? '') && out[0]?.type !== 'paragraph') out.unshift({ type: 'paragraph' });
  return { ...node, content: out };
}
