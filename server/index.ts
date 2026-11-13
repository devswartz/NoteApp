import { createServer } from './app.ts';
import { shutdownCollab } from './collab.ts';
import { closeAllEvents } from './events.ts';
import { db } from './db.ts';
import { PORT, VERSION, DATA_DIR, SEED_DEMO, IS_PROD, PUBLIC_URL } from './config.ts';
import { seedDemoIfEmpty } from './demo.ts';
import { runDataMigrations } from './dataMigrations.ts';
import { pruneRefreshTokens } from './auth.ts';
import { pruneOAuth } from './oauth/store.ts';
import { pruneClients } from './oauth/clients.ts';
import { pruneEmailVerifications, pruneUnverifiedAccounts } from './verification.ts';
import { startReminderScheduler } from './reminders/scheduler.ts';
import { purgeExpired, TRASH_DAYS } from './trash.ts';
import { APP_NAME } from '../shared/config.ts';

if (IS_PROD && !PUBLIC_URL) console.warn('PUBLIC_URL is not set: links in emails (password reset, invites) will be broken');
// Content changes SQL can't make (e.g. every page becomes a canvas); idempotent, after the schema migrations.
runDataMigrations();
if (SEED_DEMO) seedDemoIfEmpty();
// Housekeeping: expired refresh tokens, expired email-confirmation tokens, and accounts never confirmed within
// UNVERIFIED_ACCOUNT_DAYS, and Trash items older than TRASH_DAYS (all idempotent, so they simply run on every 6-hourly pass).
const housekeeping = () => {
  pruneRefreshTokens();
  pruneEmailVerifications();
  try {
    pruneOAuth();
    pruneClients();
  } catch (e) {
    console.error('oauth cleanup crashed', e);
  }
  try {
    const n = purgeExpired();
    if (n) console.log(`[trash] removed ${n} item${n === 1 ? '' : 's'} older than ${TRASH_DAYS} days`);
  } catch (e) {
    console.error('trash purge crashed', e);
  }
  try {
    pruneUnverifiedAccounts();
  } catch (e) {
    console.error('unverified account cleanup crashed', e);
  }
};
housekeeping();
setInterval(housekeeping, 6 * 3600_000).unref();

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
