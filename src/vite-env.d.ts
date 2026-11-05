/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin, e.g. https://notes.example.com. Empty = same origin as the page (web build). */
  readonly VITE_API_URL?: string;
}
