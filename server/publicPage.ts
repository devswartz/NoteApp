// The read-only web page behind a share link: GET /s/<token> (server/routes/pageLinks.ts makes the links).
// Rendered on the server as plain HTML with no scripts, so it opens in any browser, for anyone, with no
// account. A canvas page reads top to bottom in reading order (like the Markdown export), which also suits
// phones.
//
// The link only works while:
//   - the page exists, isn't in Trash and isn't locked
//   - the person who made the link can still open the page (so leaving the workspace, losing access to
//     the notebook, or the notebook going private-to-someone-else ends it)
// Images are signed for the link's creator on every view (shared/fileLinks.ts), so they stop with the link.
// Links to other Notivelo pages become plain text (outsiders can't open them). Everything user-written is
// HTML-escaped, and only http(s)/mailto links are kept.
import * as Y from 'yjs';
import { Router } from 'express';
import { db } from './db.ts';
import { pageAccess } from './access.ts';
import { pageDocState } from './collab.ts';
import { fileKeyFor } from './auth.ts';
import { pageFragments } from '../shared/pageDoc.ts';
import { listMarker, listSuffix, xmlListStart } from '../shared/listMarker.ts';
import { signUploadPath, UPLOAD_PATH, type FileKey } from '../shared/fileLinks.ts';
import { APP_NAME } from '../shared/config.ts';
import { PUBLIC_URL } from './config.ts';

type Node = Y.XmlElement | Y.XmlText;

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Only web and mail links survive; anything else (javascript:, app-relative paths, data:) becomes plain text. */
export function safeHref(href: unknown): string | null {
  const s = String(href ?? '').trim();
  return /^(https?:\/\/|mailto:)/i.test(s) ? s : null;
}

interface Ctx {
  pageTitle(id: string): string;
  task(id: string): { title: string; done: boolean; due: string | null } | null;
  fileKey: FileKey;
}

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/i;

function inline(t: Y.XmlText): string {
  return (t.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[])
    .map((d) => {
      if (typeof d.insert !== 'string') return '';
      let s = esc(d.insert).replace(/\n/g, '<br>');
      const a = d.attributes ?? {};
      if (a.code) return `<code>${s}</code>`;
      if (a.bold) s = `<strong>${s}</strong>`;
      if (a.italic) s = `<em>${s}</em>`;
      if (a.underline) s = `<u>${s}</u>`;
      if (a.strike) s = `<s>${s}</s>`;
      const hl = a.highlight as { color?: string } | true | undefined;
      if (hl) {
        const c = typeof hl === 'object' && hl.color && COLOR.test(hl.color) ? ` style="background:${esc(hl.color)}"` : '';
        s = `<mark${c}>${s}</mark>`;
      }
      const ts = a.textStyle as { color?: string } | undefined;
      if (ts?.color && COLOR.test(ts.color)) s = `<span style="color:${esc(ts.color)}">${s}</span>`;
      const href = safeHref((a.link as { href?: string } | undefined)?.href);
      if (href) s = `<a href="${esc(href)}" rel="noopener noreferrer nofollow" target="_blank">${s}</a>`;
      return s;
    })
    .join('');
}

const kids = (n: Y.XmlElement | Y.XmlFragment) => n.toArray() as Node[];
const children = (n: Y.XmlElement | Y.XmlFragment, c: Ctx) => kids(n).map((k) => html(k, c)).join('');

function html(n: Node, c: Ctx): string {
  if (n instanceof Y.XmlText) return inline(n);
  const attr = (k: string) => n.getAttribute(k) as unknown;
  switch (n.nodeName) {
    case 'paragraph': {
      const body = children(n, c);
      return `<p>${body || '<br>'}</p>`;
    }
    case 'heading': {
      const level = Math.min(Math.max(Number(attr('level')) || 1, 1), 3) + 1; // the page title is the <h1>
      return `<h${level}>${children(n, c)}</h${level}>`;
    }
    case 'blockquote':
      return `<blockquote>${children(n, c)}</blockquote>`;
    case 'callout':
      return `<div class="callout"><span class="callout-emoji" aria-hidden="true">${esc(attr('emoji') ?? '💡')}</span><div>${children(n, c)}</div></div>`;
    case 'codeBlock':
      return `<pre><code>${esc(kids(n).map((k) => (k instanceof Y.XmlText ? k.toString() : '')).join(''))}</code></pre>`;
    case 'horizontalRule':
      return '<hr>';
    case 'hardBreak':
      return '<br>';
    case 'image': {
      const src = String(attr('src') ?? '');
      const url = UPLOAD_PATH.test(src) ? signUploadPath(src, c.fileKey) : safeHref(src);
      return url ? `<img src="${esc(url)}" alt="${esc(attr('alt') ?? '')}" loading="lazy">` : '';
    }
    case 'fileAttachment': {
      const url = String(attr('url') ?? '');
      const name = esc(attr('name') ?? 'File');
      return UPLOAD_PATH.test(url)
        ? `<p class="file"><a href="${esc(signUploadPath(url, c.fileKey))}" rel="noopener noreferrer nofollow">📎 ${name}</a></p>`
        : `<p class="file">📎 ${name}</p>`;
    }
    case 'pageLink':
      return `<span class="page-ref">${esc(c.pageTitle(String(attr('pageId') ?? '')))}</span>`;
    case 'mention':
      return `<span class="mention">@${esc(attr('label') ?? '')}</span>`;
    case 'bulletList':
      return `<ul>${children(n, c)}</ul>`;
    case 'orderedList': {
      const start = xmlListStart(n);
      const type = attr('type');
      const items = kids(n)
        .map((item, i) => `<li><span class="marker">${esc(listMarker(type, start + i) + listSuffix(attr('paren')))}</span><div>${item instanceof Y.XmlElement ? children(item, c) : ''}</div></li>`)
        .join('');
      return `<ol class="numbered">${items}</ol>`;
    }
    case 'taskList':
      return `<ul class="checklist">${children(n, c)}</ul>`;
    case 'taskItem': {
      const done = !!attr('checked');
      return `<li class="${done ? 'done' : ''}"><span class="box" aria-label="${done ? 'Done' : 'Not done'}">${done ? '✓' : ''}</span><div>${children(n, c)}</div></li>`;
    }
    case 'listItem':
      return `<li>${children(n, c)}</li>`;
    case 'taskRef': {
      const t = c.task(String(attr('taskId') ?? ''));
      const notes = children(n, c);
      if (!t) return notes;
      const due = t.due ? ` <span class="due">due ${esc(t.due)}</span>` : '';
      return `<div class="task${t.done ? ' done' : ''}"><span class="box" aria-label="${t.done ? 'Done' : 'Not done'}">${t.done ? '✓' : ''}</span><div><span class="task-title">${esc(t.title)}</span>${due}${notes ? `<div class="task-notes">${notes}</div>` : ''}</div></div>`;
    }
    case 'table':
      return `<div class="table-wrap"><table><tbody>${children(n, c)}</tbody></table></div>`;
    case 'tableRow':
      return `<tr>${children(n, c)}</tr>`;
    case 'tableHeader':
      return `<th>${children(n, c)}</th>`;
    case 'tableCell':
      return `<td>${children(n, c)}</td>`;
    case 'details':
      return `<details open>${children(n, c)}</details>`;
    case 'detailsSummary':
      return `<summary>${children(n, c)}</summary>`;
    case 'detailsContent':
      return `<div>${children(n, c)}</div>`;
    default:
      return children(n, c);
  }
}

/** A page's content as HTML (no title). Exported for tests. */
export function pageBodyHtml(doc: Y.Doc, ctx: Ctx): string {
  return pageFragments(doc)
    .map((f) => children(f, ctx))
    .filter(Boolean)
    .join('\n');
}

interface LinkRow {
  page_id: string;
  created_by: string;
  title: string;
  updated_at: string;
  deleted_at: string | null;
  locked_by: string | null;
}

/** The page behind a live link, or null if the link doesn't (or no longer may) work. */
export function linkedPage(token: string): LinkRow | null {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = db
    .prepare(
      'SELECT l.page_id, l.created_by, p.title, p.updated_at, p.deleted_at, p.locked_by FROM page_links l JOIN pages p ON p.id = l.page_id WHERE l.token = ?',
    )
    .get(token) as LinkRow | undefined;
  if (!row || row.deleted_at || row.locked_by) return null;
  const a = pageAccess(row.page_id, row.created_by);
  if (!a || a.trashed) return null;
  return row;
}

function ctxFor(row: LinkRow): Ctx {
  return {
    fileKey: fileKeyFor(row.created_by),
    pageTitle: (id) => {
      const p = db.prepare('SELECT title, locked_by FROM pages WHERE id = ?').get(id) as { title: string; locked_by: string | null } | undefined;
      return p && !p.locked_by ? p.title || 'Untitled' : 'another page';
    },
    task: (id) => {
      const t = db.prepare('SELECT title, status, due_date, page_id FROM tasks WHERE id = ?').get(id) as
        | { title: string; status: string; due_date: string | null; page_id: string | null }
        | undefined;
      // Only tasks that live on this page (the ones its readers see in it).
      return t && t.page_id === row.page_id ? { title: t.title, done: t.status === 'done', due: t.due_date } : null;
    },
  };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The full HTML document for a live link, or null (the route answers 404). */
export function renderPublicPage(token: string): string | null {
  const row = linkedPage(token);
  if (!row) return null;
  const state = pageDocState(row.page_id);
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  const body = pageBodyHtml(doc, ctxFor(row));
  const title = row.title || 'Untitled';
  const author = (db.prepare('SELECT name FROM users WHERE id = ?').get(row.created_by) as { name: string } | undefined)?.name ?? '';
  const home = PUBLIC_URL || '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${PUBLIC_CSS}</style>
</head>
<body>
<main class="sheet">
<header>
<h1>${esc(title)}</h1>
<p class="meta">${author ? `Shared by ${esc(author)} · ` : ''}Updated ${esc(formatDate(row.updated_at))}</p>
</header>
<article>
${body || '<p class="empty">This page is empty.</p>'}
</article>
</main>
<footer>Made with <a href="${esc(home ? home.replace(/\/\/app\./, '//') : 'https://notiveloapp.com')}" rel="noopener">${esc(APP_NAME)}</a></footer>
</body>
</html>`;
}

/** The answer for a dead or unknown link: same for both, so links can't be probed. */
export function missingPublicPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Link not available</title><style>${PUBLIC_CSS}</style></head><body><main class="sheet"><h1>This link isn't available</h1><p class="meta">It may have been turned off, or the page was moved or deleted. Ask the person who sent it for a new link.</p></main></body></html>`;
}

const PUBLIC_CSS = `
:root{--bg:#f6f6f4;--paper:#fff;--text:#1f2328;--muted:#6b7280;--border:#e5e7eb;--accent:#4f46e5;--link:#1d4ed8;--code:#f3f4f6;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--paper:#18181b;--text:#e7e7ea;--muted:#a1a1aa;--border:#2e2e33;--accent:#8b95f9;--link:#93b4ff;--code:#232328}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,'SF Pro Text','Inter','Segoe UI',Roboto,'Helvetica Neue',sans-serif}
.sheet{max-width:780px;margin:32px auto;padding:40px 56px;background:var(--paper);border:1px solid var(--border);border-radius:14px}
@media (max-width:700px){.sheet{margin:0;padding:24px 16px;border:0;border-radius:0}}
header{border-bottom:1px solid var(--border);margin-bottom:24px;padding-bottom:12px}
h1{font-size:30px;line-height:1.25;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:23px;margin:1.4em 0 .4em;line-height:1.3}h3{font-size:19px;margin:1.3em 0 .3em}h4{font-size:17px;margin:1.2em 0 .3em}
.meta{color:var(--muted);font-size:14px;margin:0}
p{margin:.45em 0}
a{color:var(--link);text-underline-offset:.15em}
ul,ol{padding-left:1.5em;margin:.4em 0}
ol.numbered{list-style:none;padding-left:0}
ol.numbered>li{display:flex;gap:.5em}ol.numbered>li>.marker{min-width:1.6em;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
ol.numbered>li>div{flex:1;min-width:0}
li>p{margin:.15em 0}
ul.checklist{list-style:none;padding-left:0}
ul.checklist>li,.task{display:flex;gap:.6em;align-items:flex-start;margin:.25em 0}
.box{flex:none;width:1.05em;height:1.05em;margin-top:.3em;border:1.5px solid var(--muted);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:.75em;line-height:1;color:#fff}
.done>.box{background:var(--accent);border-color:var(--accent)}
.done>div>p,.task.done .task-title{color:var(--muted);text-decoration:line-through}
.task-title{font-weight:500}.due{color:var(--muted);font-size:.85em;margin-left:.4em}
.task-notes{margin-top:.15em}
blockquote{margin:.8em 0;padding:.1em 1em;border-left:3px solid var(--border);color:var(--muted)}
.callout{display:flex;gap:.7em;padding:.7em 1em;margin:.8em 0;border:1px solid var(--border);border-radius:10px;background:var(--bg)}
.callout>div{min-width:0;flex:1}
pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow-x:auto;font-size:14px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:var(--code);padding:.1em .3em;border-radius:4px}
pre code{background:none;padding:0}
hr{border:0;border-top:1px solid var(--border);margin:1.4em 0}
img{max-width:100%;height:auto;border-radius:6px;margin:.4em 0}
.table-wrap{overflow-x:auto;margin:.8em 0}
table{border-collapse:collapse;min-width:50%}
td,th{border:1px solid var(--border);padding:6px 10px;vertical-align:top;text-align:left}
th{background:var(--bg);font-weight:600}
td>p,th>p{margin:0}
details{margin:.5em 0}summary{cursor:pointer;font-weight:500}
mark{background:#fde68a;color:inherit;padding:0 .1em;border-radius:2px}
.mention,.page-ref{font-weight:600}
.file a{text-decoration:none}
.empty{color:var(--muted)}
footer{text-align:center;color:var(--muted);font-size:13px;margin:16px 0 40px}
footer a{color:inherit}
@media print{body{background:#fff}.sheet{border:0;margin:0;max-width:none;padding:0}footer{display:none}}
`;

export const publicPageRoutes = Router();

publicPageRoutes.get('/:token', (req, res) => {
  const html = renderPublicPage(String(req.params.token));
  // No scripts at all; inline styles only; images from this server (signed uploads) or the web.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer'); // the link's token never leaks to sites it links to
  res.setHeader('Cache-Control', 'no-store'); // turning the link off must work at once
  res.type('html');
  if (!html) return void res.status(404).send(missingPublicPage());
  res.send(html);
});
