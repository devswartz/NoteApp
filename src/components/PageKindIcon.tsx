// The icon of a page without an emoji: a sheet for a document, a board for a canvas.
import { FileText, LayoutDashboard } from 'lucide-react';
import type { PageKind } from '../../shared/types.ts';

export function PageKindIcon({ kind, size = 14, className }: { kind?: PageKind; size?: number; className?: string }) {
  return kind === 'canvas' ? (
    <LayoutDashboard size={size} className={className} aria-label="Canvas page" role="img" />
  ) : (
    <FileText size={size} className={className} aria-hidden />
  );
}
