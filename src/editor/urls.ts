// URL checks for content that comes from documents (pure, unit-tested).

/**
 * File-card links come from documents anyone in the workspace can edit (or paste HTML into),
 * so only our own upload paths and plain http(s) URLs are allowed. Anything else
 * (javascript:, data:, protocol-relative //host, …) becomes "".
 */
export function safeFileUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const u = url.trim();
  if (/^\/(uploads|files)\/[\w.-]+$/.test(u)) return u;
  if (/^https?:\/\/[^\s]+$/i.test(u)) return u;
  return '';
}
