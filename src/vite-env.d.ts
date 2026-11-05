/// <reference types="vite/client" />

declare module '*.md?raw' {
  const text: string;
  export default text;
}

interface ImportMetaEnv {
  /** API origin, e.g. https://notes.example.com. Empty = same origin as the page (web build). */
  readonly VITE_API_URL?: string;
}
