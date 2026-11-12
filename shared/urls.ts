// URL checks for content that comes from documents (pure, unit-tested). Shared: the editor
// uses them when rendering, the server when importing a workspace export.
import { unsignedUploadPath } from './fileLinks.ts';

/**
 * File-card links come from documents anyone in the workspace can edit (or paste HTML into),
 * so only our own upload paths and plain http(s) URLs are allowed. Anything else
 * (javascript:, data:, protocol-relative //host, …) becomes "".
 */
export function safeFileUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  // A signed upload link (copied from a rendered page) is stored as the plain path, so it never expires.
  const u = unsignedUploadPath(url) ?? url.trim();
  if (/^\/(uploads|files)\/[\w.-]+$/.test(u)) return u;
  if (/^https?:\/\/[^\s]+$/i.test(u)) return u;
  return '';
}

/**
 * Link hrefs allowed in documents: web, mail and phone links, in-app paths and
 * deep links. Everything else (javascript:, data:, vbscript:, file:, protocol-relative //host…) → "".
 */
export function safeLinkUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  // Browsers ignore control characters and whitespace inside schemes ("java\nscript:").
  const u = url.trim();
  // Browsers treat "\" like "/" in URLs, so "/\evil.example" is protocol-relative ("//evil.example").
  const probe = u.replace(/[\u0000- \u007f-\u009f]/g, '').replace(/\\/g, '/').toLowerCase();
  if (/^(https?:|mailto:|tel:|notivelo:)/.test(probe)) return u;
  if (/^\/(?!\/)/.test(probe) || probe.startsWith('#')) return u;
  return '';
}

/** Image sources: our uploads, or plain http(s). */
export function safeImageUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const u = unsignedUploadPath(url) ?? url.trim();
  const probe = u.replace(/[\u0000- \u007f-\u009f]/g, '').replace(/\\/g, '/').toLowerCase();
  if (/^\/(uploads|files)\/[\w.-]+$/.test(u)) return u;
  if (/^https?:\/\//.test(probe) && !/\s/.test(u)) return u;
  return '';
}

interface Json {
  type?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: Json[];
  [k: string]: unknown;
}

/**
 * Clean ProseMirror JSON from outside (Markdown import, export): drop link marks with
 * unsafe hrefs, images with unsafe sources, and file cards with unsafe URLs.
 */
export function sanitizeContent<T extends Json>(node: T): T {
  const clean = (n: Json): Json | null => {
    if (n.type === 'image' && !safeImageUrl(n.attrs?.src)) return null;
    if (n.type === 'fileAttachment' && !safeFileUrl(n.attrs?.url)) return null;
    const out: Json = { ...n };
    if (n.marks) out.marks = n.marks.filter((m) => m.type !== 'link' || !!safeLinkUrl(m.attrs?.href));
    if (n.content) out.content = n.content.map(clean).filter((c): c is Json => c !== null);
    return out;
  };
  return (clean(node) ?? { ...node, content: [] }) as T;
}
