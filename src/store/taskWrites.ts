// Per-task ordering of task writes (BUG-6).
//
// The store updates tasks optimistically, so a task can be edited or deleted
// before the request that creates it has answered. Sent straight away, that
// PATCH or DELETE reaches the server first and fails with 404: the title is
// lost, or a task the user deleted comes back. TaskWrites runs each task's
// writes one after another, in call order:
//
//   - create → update → delete for one task id are sent strictly in sequence;
//     writes for different tasks still run in parallel.
//   - Patches waiting behind another write are merged into a single PATCH.
//   - A delete makes waiting patches no-ops; after a failed create, nothing
//     queued behind it is sent (the task doesn't exist).
//   - `isDeleted(id)` is true from the moment of a local delete until the task
//     is created again with the same id (undo/redo of convert-to-task does
//     that), so a late create response or a live-event echo can't bring it back.
//   - `overlay(id)` holds patch fields not yet acknowledged by the server, so an
//     echo of an older server state doesn't flash old values over local edits.
//
// It knows nothing about HTTP or the store: callers pass the request to send.
// Unit-tested in tests/taskWrites.test.ts.

export class TaskWrites<T, P extends object> {
  /** The last write queued per task; absent when nothing is pending. */
  private tails = new Map<string, Promise<void>>();
  /** A patch that hasn't started yet, so later patches can merge into it. */
  private waiting = new Map<string, { patch: P }>();
  /** Patch fields sent or queued but not yet answered, with how many calls are outstanding. */
  private unsaved = new Map<string, { patch: P; calls: number }>();
  private failedCreates = new Set<string>();
  private deleted = new Set<string>();

  private chain<R>(id: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.tails.get(id) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(id, tail);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return run;
  }

  /** Whether any write for this task is queued or in flight. */
  pending(id: string): boolean {
    return this.tails.has(id);
  }

  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  /** Patch fields not yet confirmed by the server (to lay over incoming copies of the task). */
  overlay(id: string): P | undefined {
    return this.unsaved.get(id)?.patch;
  }

  create(id: string, send: () => Promise<T>): Promise<T> {
    // Creating again (redo) revives an id deleted earlier in this session.
    this.deleted.delete(id);
    this.failedCreates.delete(id);
    return this.chain(id, async () => {
      try {
        return await send();
      } catch (e) {
        this.failedCreates.add(id);
        throw e;
      }
    });
  }

  /** Resolves with the server's task, or null when the patch was dropped (task deleted or never created). */
  update(id: string, patch: P, send: (merged: P) => Promise<T>): Promise<T | null> {
    const u = this.unsaved.get(id);
    this.unsaved.set(id, { patch: { ...u?.patch, ...patch } as P, calls: (u?.calls ?? 0) + 1 });
    const settle = () => {
      const cur = this.unsaved.get(id);
      if (cur && --cur.calls <= 0) this.unsaved.delete(id);
    };

    const waiting = this.waiting.get(id);
    if (waiting) {
      Object.assign(waiting.patch, patch);
      return this.waitingResults.get(waiting)!.finally(settle);
    }
    const entry = { patch: { ...patch } as P };
    this.waiting.set(id, entry);
    const result = this.chain(id, async () => {
      if (this.waiting.get(id) === entry) this.waiting.delete(id);
      if (this.deleted.has(id) || this.failedCreates.has(id)) return null;
      return send(entry.patch);
    });
    this.waitingResults.set(entry, result);
    return result.finally(settle);
  }

  private waitingResults = new WeakMap<{ patch: P }, Promise<T | null>>();

  /** Resolves when the task is gone on the server (or never existed there). */
  remove(id: string, send: () => Promise<void>): Promise<void> {
    this.deleted.add(id);
    this.waiting.delete(id); // later patches mustn't merge into one that will be dropped
    return this.chain(id, async () => {
      // Created again before this delete ran (undo then redo): keep it.
      if (!this.deleted.has(id)) return;
      if (this.failedCreates.has(id)) return;
      await send();
    });
  }

  /** A delete failed: the task exists after all. */
  undelete(id: string) {
    this.deleted.delete(id);
  }
}
