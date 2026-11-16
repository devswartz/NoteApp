// The canvas's undo outside box text (no editor imports, so it is unit-tested: tests/inkStrokes.test.ts).
import * as Y from 'yjs';
import { BOXES_KEY, INK_KEY } from '../../shared/pageDoc.ts';
import { INK_ORIGIN } from '../ink/strokes.ts';

/** Transaction origin of box geometry changes the canvas undo (Ctrl+Z outside a box) tracks. */
export const GEOM_ORIGIN = { canvas: 'geometry' };

/**
 * Box geometry (the boxes map; CanvasEditor adds each box's fragment to the scope, so undoing a
 * delete brings its text back) and ink, on one stack. Only this client's GEOM_ORIGIN and
 * INK_ORIGIN changes are tracked, never a collaborator's.
 */
export function canvasUndoManager(doc: Y.Doc, captureTimeout = 500): Y.UndoManager {
  return new Y.UndoManager([doc.getMap<unknown>(BOXES_KEY), doc.getMap<unknown>(INK_KEY)], { trackedOrigins: new Set<unknown>([GEOM_ORIGIN, INK_ORIGIN]), captureTimeout });
}
