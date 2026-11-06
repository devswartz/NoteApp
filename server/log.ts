// Structured logging. Production writes one JSON object per line to stdout
// (easy to grep, ship or parse with jq); dev writes readable lines.
//   log.info('reminder sent', { taskId, userId });
//   log.error('mail failed', { err });
import { IS_PROD } from './config.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = ORDER[(process.env.LOG_LEVEL as Level) || (IS_PROD ? 'info' : 'debug')] ?? ORDER.info;

function serialise(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { message: v.message, name: v.name, stack: v.stack } : v;
  }
  return out;
}

function write(level: Level, msg: string, fields: LogFields = {}) {
  if (ORDER[level] < MIN) return;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (IS_PROD) {
    stream.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...serialise(fields) }) + '\n');
  } else {
    const extra = Object.keys(fields).length ? ' ' + JSON.stringify(serialise(fields)) : '';
    stream.write(`${level === 'info' ? '' : level.toUpperCase() + ' '}${msg}${extra}\n`);
  }
}

export const log = {
  debug: (msg: string, fields?: LogFields) => write('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => write('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => write('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => write('error', msg, fields),
};
