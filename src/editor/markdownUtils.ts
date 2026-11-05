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
