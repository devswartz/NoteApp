import { createServer } from './app.ts';
import { flushAll } from './collab.ts';

const PORT = Number(process.env.PORT ?? 3001);
const { server } = createServer();

server.listen(PORT, () => console.log(`NoteApp server listening on http://localhost:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    flushAll();
    process.exit(0);
  });
}
