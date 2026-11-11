// Converting a page between a document and a canvas (docs/PLAN_CANVAS.md, phase 3). The server
// rewrites the content (in the live collab room if the page is open) and publishes a tree event,
// so every open client switches views; this client updates its own copy right away.
import { post } from '../api.ts';
import { useStore } from '../store.ts';
import type { PageKind } from '../../shared/types.ts';

export function setLocalPageKind(pageId: string, kind: PageKind) {
  useStore.setState((s) => ({ tree: { ...s.tree, pages: s.tree.pages.map((p) => (p.id === pageId ? { ...p, kind } : p)) } }));
}

export async function convertPage(pageId: string, kind: PageKind) {
  await post(`/pages/${pageId}/convert`, { kind });
  setLocalPageKind(pageId, kind);
}
