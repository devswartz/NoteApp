// The icon of a page without an emoji. Every page is a canvas now, so it's the same sheet for all;
// `kind` is still accepted from callers that pass the page's metadata.
import { FileText } from 'lucide-react';
import type { PageKind } from '../../shared/types.ts';

export function PageKindIcon({ size = 14, className }: { kind?: PageKind; size?: number; className?: string }) {
  return <FileText size={size} className={className} aria-hidden />;
}
