// Feature flags: big features ship dark and are turned on per device or per build
// (docs/ARCHITECTURE.md, section 4). A server-controlled, per-user version comes later; until
// then each flag is read from, in order:
//   1. localStorage `noteapp.flags.<name>`: "1" on, "0" off (per device; set it in the
//      browser console, e.g. localStorage.setItem('noteapp.flags.ink', '1'), then reload);
//   2. the build: VITE_FLAG_<NAME>=1 when the web app is built (e.g. a staging build);
//   3. off.
//
// Flags:
//   ink  handwriting on canvas pages (docs/PLAN_INK.md, phase I1 onwards).

export type FlagName = 'ink';

const BUILD: Record<FlagName, string | undefined> = {
  ink: import.meta.env?.VITE_FLAG_INK, // ?.: undefined outside Vite (Node tests)
};

export const flagKey = (name: FlagName) => `noteapp.flags.${name}`;

/** Whether a flag is on for this device. Read once per page load where it matters. */
export function flag(name: FlagName): boolean {
  try {
    const v = globalThis.localStorage?.getItem(flagKey(name));
    if (v === '1' || v === 'true' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'off') return false;
  } catch {
    // storage blocked: fall through to the build's value
  }
  return BUILD[name] === '1';
}
