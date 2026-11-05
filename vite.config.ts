import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { APP_DESCRIPTION, APP_NAME } from './shared/config.ts';

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
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
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
      const precache = ['/index.html', '/icon.svg', ...files.filter((f) => f !== 'index.html').map((f) => `/${f}`)];
      const version = createHash('sha256').update(files.sort().join('|')).update(JSON.stringify(precache)).digest('hex').slice(0, 12);
      const source = readFileSync('src/sw/sw.template.js', 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify([...new Set(precache)]));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
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
    },
  },
});
