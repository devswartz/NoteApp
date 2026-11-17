// Sets the theme and accent colour before first paint so a forced theme doesn't flash
// when it differs from the OS setting. Loaded as a blocking <script src> from
// index.html (an external file, so it works under a strict CSP: script-src 'self').
// Mirrors readPref/resolve and readAccent in src/store/ui.ts (storage keys noteapp.theme, noteapp.accent).
try {
  var t = localStorage.getItem('noteapp.theme');
  var root = document.documentElement;
  // Nothing stored yet: Hybrid is the default (DEFAULT_THEME in src/store/ui.ts).
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else if (t === 'system') root.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  else root.dataset.theme = 'hybrid';
  var a = localStorage.getItem('noteapp.accent');
  if (a && a !== 'blue' && /^[a-z]+$/.test(a)) root.dataset.accent = a;
} catch (e) {
  /* storage unavailable: the app applies the theme when it starts */
}
