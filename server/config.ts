// Runtime configuration, read once from the environment. See docs/DEPLOY_CONTRACT.md.
import path from 'node:path';

export const IS_PROD = process.env.NODE_ENV === 'production';

/** Persistent data. The container mounts a volume at /data; local dev uses ./data. */
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? (IS_PROD ? '/data' : 'data'));
/** SQLite database. DB_FILE overrides it (tests use ':memory:'). */
export const DB_FILE = process.env.DB_FILE ?? path.join(DATA_DIR, 'noteapp.db');
/** Uploaded attachments and images. */
export const FILES_DIR = path.join(DATA_DIR, 'files');

export const PORT = Number(process.env.PORT ?? 3001);
/** Build identifier reported by /api/health: the git SHA or tag baked in at image build time. */
export const VERSION = process.env.GIT_SHA || 'dev';
/** Load demo content into an empty database on startup (staging only). */
export const SEED_DEMO = process.env.SEED_DEMO === '1';
