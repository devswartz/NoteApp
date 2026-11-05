// Sets the theme before first paint so a forced light/dark theme doesn't flash
// when it differs from the OS setting. Loaded as a blocking <script src> from
// index.html (an external file, so it works under a strict CSP: script-src 'self').
// Mirrors readPref/resolve in src/store/ui.ts (storage key noteapp.theme).
try {
  var t = localStorage.getItem('noteapp.theme');
  var dark = t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch (e) {
  /* storage unavailable: the app applies the theme when it starts */
}
