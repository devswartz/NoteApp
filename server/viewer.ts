// Who is asking: the signed-in user and sign-in (refresh-token family, `sid`) behind the current request or socket
// message, carried through async code with AsyncLocalStorage. Locked pages (server/locks.ts) open only when the
// viewer is their owner AND this sign-in has unlocked them, so content checks need the sign-in, not just a user id.
// requireAuth sets it for every /api request; the collab and event sockets set it per connection. Code that runs
// with no viewer (timers, the reminder scheduler, the AI connector at /mcp, signed /uploads links) never sees
// locked content: the gate treats "nobody" as locked.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Viewer {
  userId: string;
  sid: string | null;
}

const als = new AsyncLocalStorage<Viewer>();

export function runAsViewer<T>(v: Viewer, fn: () => T): T {
  return als.run(v, fn);
}

export function currentViewer(): Viewer | undefined {
  return als.getStore();
}
