import { createServer } from './app.ts';
import { shutdownCollab } from './collab.ts';
import { closeAllEvents } from './events.ts';
import { db } from './db.ts';
import { PORT, VERSION, DATA_DIR, SEED_DEMO } from './config.ts';
import { seedDemoIfEmpty } from './demo.ts';
import { pruneRefreshTokens } from './auth.ts';
import { startReminderScheduler } from './reminders/scheduler.ts';
import { APP_NAME } from '../shared/config.ts';

if (SEED_DEMO) seedDemoIfEmpty();
pruneRefreshTokens();
setInterval(pruneRefreshTokens, 6 * 3600_000).unref();

const { server } = createServer();
const stopReminders = startReminderScheduler();
server.listen(PORT, () => console.log(`${APP_NAME} ${VERSION} listening on http://localhost:${PORT} (data: ${DATA_DIR})`));

// Graceful shutdown (contract: exit within 10 s of SIGTERM): stop accepting
// connections, save open documents, close sockets and the database.
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => {
    console.error('Shutdown timed out; exiting');
    process.exit(1);
  }, 8000).unref();
  server.close();
  try {
    stopReminders();
    shutdownCollab();
    closeAllEvents();
    server.closeAllConnections();
    db.close();
  } catch (e) {
    console.error('Error during shutdown', e);
    process.exit(1);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
