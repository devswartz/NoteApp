// Deleting from the notes tree moves the item to Trash (server/trash.ts); the toast offers Undo.
import { del, post } from '../api.ts';
import { errorToast, toast } from '../store.ts';
import type { TrashKind } from '../../shared/types.ts';

const LABEL: Record<TrashKind, string> = { page: 'Page', section: 'Section', notebook: 'Notebook' };

export async function moveToTrash(kind: TrashKind, id: string, name: string, after?: () => void): Promise<void> {
  try {
    const r = await del<{ tasks?: number }>(`/${kind}s/${id}`);
    after?.();
    const n = r.tasks ?? 0;
    void name;
    void LABEL;
    toast(`Moved to Trash.${n ? ` Its ${n} task${n === 1 ? '' : 's'} stay${n === 1 ? 's' : ''} in your task list.` : ''}`, {
      action: { label: 'Undo', run: () => void restoreFromTrash(kind, id) },
    });
  } catch (e) {
    errorToast(e);
  }
}

/** Puts an item back; says where it went when its old place is gone. */
export async function restoreFromTrash(kind: TrashKind, id: string): Promise<boolean> {
  try {
    const r = await post<{ movedTo: string }>(`/trash/${kind}/${id}/restore`);
    toast(r.movedTo ? `Restored to ${r.movedTo}` : 'Restored');
    return true;
  } catch (e) {
    errorToast(e);
    return false;
  }
}
