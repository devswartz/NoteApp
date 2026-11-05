/// <reference types="vite/client" />

/** Set by vite.config.ts: GIT_SHA at build time if present, else the package version. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** API origin, e.g. https://notes.example.com. Empty = same origin as the page (web build). */
  readonly VITE_API_URL?: string;
}
