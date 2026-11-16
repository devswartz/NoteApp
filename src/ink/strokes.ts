// Writing strokes to a page's `ink` map (shared/pageDoc.ts, docs/PLAN_INK.md "Storage"). Strokes
// are immutable: a finished stroke is added in one transaction, and an erase deletes strokes and
// adds what is left of them as new strokes, also in one transaction. Every write uses INK_ORIGIN,
// which the canvas undo tracks (src/editor/CanvasEditor.tsx), so only your own strokes are undone.
// No DOM and no WASM here: unit-tested in tests/inkStrokes.test.ts.
import * as Y from 'yjs';
import { INK_KEY } from '../../shared/pageDoc.ts';

/** Transaction origin of this client's ink changes. */
export const INK_ORIGIN = { canvas: 'ink' };

/** A random stroke id (12 base-36 characters). */
export function newStrokeId(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((n) => n.toString(36).padStart(2, '0').slice(-2)).join('').slice(0, 12);
}

/** Add a finished stroke; returns its id. */
export function commitStroke(doc: Y.Doc, blob: Uint8Array, origin: unknown = INK_ORIGIN): string {
  const id = newStrokeId();
  doc.transact(() => doc.getMap<unknown>(INK_KEY).set(id, blob), origin);
  return id;
}

/**
 * An erase gesture's outcome in one transaction: `removed` strokes go, `added` pieces (what the
 * partial eraser left) come in with new ids. Strokes someone else already deleted are skipped.
 * Returns the new ids.
 */
export function commitErase(doc: Y.Doc, removed: Iterable<string>, added: Iterable<Uint8Array>, origin: unknown = INK_ORIGIN): string[] {
  const ink = doc.getMap<unknown>(INK_KEY);
  const ids: string[] = [];
  doc.transact(() => {
    for (const id of removed) if (ink.has(id)) ink.delete(id);
    for (const blob of added) {
      const id = newStrokeId();
      ink.set(id, blob);
      ids.push(id);
    }
  }, origin);
  return ids;
}

/**
 * The strokes an erase gesture is working on: what it has removed from the page so far and the
 * pieces it has made (which it may cut again before the gesture ends). Nothing is written until
 * commit(), so the whole gesture is one change (and one undo step).
 */
export class EraseSession {
  /** Page strokes the eraser has removed. */
  readonly removed = new Set<string>();
  /** Pieces made during the gesture, by a temporary id. */
  readonly added = new Map<string, Uint8Array>();
  private seq = 0;

  /** The strokes the eraser can see: the page's, minus removed ones, plus pieces. */
  visible(page: Iterable<[string, Uint8Array]>): [string, Uint8Array][] {
    const out: [string, Uint8Array][] = [];
    for (const [id, blob] of page) if (!this.removed.has(id)) out.push([id, blob]);
    for (const e of this.added) out.push(e);
    return out;
  }

  /** The eraser took `id` away, leaving `pieces` (none for the stroke eraser). */
  replace(id: string, pieces: Uint8Array[] = []) {
    if (this.added.has(id)) this.added.delete(id);
    else this.removed.add(id);
    for (const p of pieces) this.added.set(`~${this.seq++}`, p);
  }

  get changed(): boolean {
    return this.removed.size > 0 || this.added.size > 0;
  }

  /** Write the gesture's outcome (nothing when it touched nothing). */
  commit(doc: Y.Doc, origin: unknown = INK_ORIGIN): string[] {
    if (!this.changed) return [];
    return commitErase(doc, this.removed, this.added.values(), origin);
  }
}

// ───────────── z order (fractional index keys) ─────────────
// A stroke's z key orders it among the others (string order, then id). New strokes go on top,
// so they only need a key after the highest; inserting between two (lasso "send back", PLAN_INK
// I5) can extend this. Keys are an integer part with its length in the head character ('a' = 1
// digit, 'b' = 2, …) in base 62, as in the common fractional-indexing scheme, so they stay short.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const FIRST_Z = 'a0';

/** The key after `z` (FIRST_Z after nothing). Always greater than `z` in string order. */
export function zAfter(z: string | null | undefined): string {
  if (!z) return FIRST_Z;
  const head = z.charCodeAt(0);
  const len = head - 0x61 + 1; // 'a' → 1 digit
  if (head < 0x61 || head > 0x7a || z.length !== len + 1 || [...z.slice(1)].some((c) => !DIGITS.includes(c))) {
    return z + 'V'; // not a key we made: anything with it as a prefix sorts after it
  }
  const digits = [...z.slice(1)];
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]!);
    if (d < DIGITS.length - 1) {
      digits[i] = DIGITS[d + 1]!;
      return z[0] + digits.join('');
    }
    digits[i] = '0';
  }
  // All digits were the top one: one more digit.
  if (head === 0x7a) return z + 'V';
  return String.fromCharCode(head + 1) + '1' + '0'.repeat(len);
}

/** Compare two strokes for drawing order (z key, then id). */
export function zCompare(a: { z: string; id: string }, b: { z: string; id: string }): number {
  return a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The highest z key among `keys` (null when there are none). */
export function topZ(keys: Iterable<string>): string | null {
  let top: string | null = null;
  for (const k of keys) if (top === null || k > top) top = k;
  return top;
}
