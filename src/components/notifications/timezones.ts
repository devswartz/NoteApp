// Time-zone helpers for the settings panel.
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function allTimeZones(): string[] {
  const fn = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const list = fn ? fn('timeZone') : [];
  const set = new Set(['UTC', browserTimeZone(), ...list]);
  return [...set].sort();
}
