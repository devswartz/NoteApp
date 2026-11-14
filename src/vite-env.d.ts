/// <reference types="vite/client" />

declare module '*.md?raw' {
  const text: string;
  export default text;
}

/** Set by vite.config.ts: GIT_SHA at build time if present, else the package version. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** API origin, e.g. https://notes.example.com. Empty = same origin as the page (web build). */
  readonly VITE_API_URL?: string;
  /** "1" for debug / internal mobile builds: hidden "Change server…" (src/platform/serverUrl.ts). */
  readonly VITE_ALLOW_SERVER_SWITCH?: string;
  /** Old host names of the production server, comma-separated (CI variable LEGACY_PROD_HOSTS). */
  readonly VITE_LEGACY_PROD_HOSTS?: string;
}
