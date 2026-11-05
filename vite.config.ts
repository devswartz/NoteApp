import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.API_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/uploads': { target: api, changeOrigin: true },
      '/collab': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
});
