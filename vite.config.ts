import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { APP_DESCRIPTION, APP_NAME } from './shared/config.ts';

const pkgVersion = (JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }).version;
const api = process.env.API_URL ?? 'http://localhost:3001';
const wsApi = api.replace(/^http/, 'ws');

/** Puts the app name (shared/config.ts) into index.html and the web app manifest. */
function appIdentity(): Plugin {
  const manifest = JSON.stringify(
    {
      name: APP_NAME,
      short_name: APP_NAME,
      description: APP_DESCRIPTION,
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#4f46e5',
      // Generated from public/icon.svg by `npm run web:icons` (scripts/web-icons.mjs).
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ],
    },
    null,
    2,
  );
  return {
    name: 'app-identity',
    transformIndexHtml: (html) => html.replaceAll('%APP_NAME%', APP_NAME),
    configureServer(server) {
      server.middlewares.use('/manifest.webmanifest', (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(manifest);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: manifest });
    },
  };
}

/** Emits dist/sw.js from src/sw/sw.template.js with the build's file list and a content-derived version. */
function serviceWorker(): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js');
      // public/ files aren't in the bundle: list the ones the shell needs offline.
      // (Only existing ones: one missing file would make the whole install fail.)
      const publicFiles = ['/icon.svg', '/theme-init.js', '/icons/favicon.ico', '/icons/favicon-32.png', '/icons/icon-192.png', '/icons/apple-touch-icon.png'].filter((f) =>
        existsSync(`public${f}`),
      );
      const precache = ['/index.html', ...publicFiles, ...files.filter((f) => f !== 'index.html').map((f) => `/${f}`)];
      const version = createHash('sha256').update(files.sort().join('|')).update(JSON.stringify(precache)).digest('hex').slice(0, 12);
      const source = readFileSync('src/sw/sw.template.js', 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify([...new Set(precache)]));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // The client's own version, sent with error reports (src/lib/errorReporting.ts); the server reports its GIT_SHA.
  define: { __APP_VERSION__: JSON.stringify(process.env.GIT_SHA || pkgVersion) },
  plugins: [react(), appIdentity(), serviceWorker()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // WebSocket entries first: /api/events would otherwise match /api.
      '/api/events': { target: wsApi, ws: true },
      '/api': { target: api, changeOrigin: true },
      '/uploads': { target: api, changeOrigin: true },
      '/collab': { target: wsApi, ws: true },
      // AI connectors (server/oauth/): the server's OAuth endpoints and metadata; /oauth/consent is an app page.
      '/oauth': { target: api, changeOrigin: true, bypass: (req) => (req.url?.startsWith('/oauth/consent') ? req.url : undefined) },
      '/.well-known': { target: api, changeOrigin: true },
      '/mcp': { target: api, changeOrigin: true },
    },
  },
});
