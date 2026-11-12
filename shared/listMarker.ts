// Ordered-list markers for plain-text exports (server Markdown, the unsynced-copy download).
/** An ordered list's marker: numbers, or the letters / roman numerals of a list typed as "a. " or "i. ". */
export function listMarker(type: unknown, n: number): string {
  if (type === 'a' || type === 'A') {
    let s = '';
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
    return type === 'A' ? s.toUpperCase() : s;
  }
  if (type === 'i' || type === 'I') {
    let s = '';
    let k = n;
    for (const [v, r] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as const)
      for (; k >= v; k -= v) s += r;
    return type === 'I' ? s.toUpperCase() : s;
  }
  return String(n);
}
