// Turning deep links into in-app paths. Shells deliver links such as
//   noteapp://page/<pageId>            → a page (workspace looked up by the caller)
//   noteapp://w/<wsId>/p/<pageId>      → any in-app path
//   https://<our host>/w/<wsId>/…      → universal / app links
// The scheme is not checked, so renaming the app doesn't break old links.

export type DeepLinkTarget = { kind: 'path'; path: string } | { kind: 'page'; pageId: string } | null;

export function parseDeepLink(link: string): DeepLinkTarget {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  // For custom schemes the first segment parses as the host: noteapp://page/x → host "page", path "/x".
  const isWeb = url.protocol === 'http:' || url.protocol === 'https:';
  const parts = (isWeb ? url.pathname : `/${url.host}${url.pathname}`).split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'page' && parts[1]) return { kind: 'page', pageId: parts[1] };
  if (parts.length === 0) return { kind: 'path', path: '/' };
  if (parts[0] === 'w' || parts[0] === 'login') return { kind: 'path', path: '/' + parts.map(encodeURIComponent).join('/') + url.search };
  return null;
}
