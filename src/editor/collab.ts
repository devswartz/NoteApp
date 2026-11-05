// Collaboration helpers for the editor (no DOM): who is on a page, from Yjs
// awareness. Owner: Collaboration & Access.
import type { Awareness } from 'y-protocols/awareness';

export interface PagePresence {
  id: string;
  name: string;
  color: string;
  /** False when everyone with this user id is read-only here (viewers). */
  canEdit: boolean;
  /** Number of tabs/devices this person has the page open in. */
  sessions: number;
}

interface AwarenessUser {
  id?: string;
  name?: string;
  color?: string;
  canEdit?: boolean;
}

/**
 * Everyone else on the page, one entry per person (several tabs collapse into
 * one), sorted by name. `selfUserId` is excluded entirely, so your own other
 * tabs don't show up as a collaborator.
 */
export function presenceFrom(awareness: Pick<Awareness, 'getStates' | 'clientID'>, selfUserId: string): PagePresence[] {
  const byUser = new Map<string, PagePresence>();
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const u = (state as { user?: AwarenessUser }).user;
    if (!u?.id || u.id === selfUserId) return;
    const prev = byUser.get(u.id);
    const canEdit = u.canEdit !== false;
    if (prev) {
      prev.sessions++;
      prev.canEdit ||= canEdit;
    } else {
      byUser.set(u.id, { id: u.id, name: u.name || 'Someone', color: u.color || '#888888', canEdit, sessions: 1 });
    }
  });
  return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Shallow equality for presence lists, to skip re-renders on cursor-only awareness changes. */
export function samePresence(a: PagePresence[], b: PagePresence[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.color === b[i].color && x.canEdit === b[i].canEdit && x.sessions === b[i].sessions)
  );
}
