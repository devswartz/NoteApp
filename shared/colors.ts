// The editor's fixed palette for text colour and highlight. Notes store the colour's
// NAME (data-color="red"), never a hex value: src/styles/colors.css maps each name to
// a light and a dark value so text stays readable in both themes.
// Used by the editor (src/editor/colors.ts) and the import sanitizer (server/sanitizeDoc.ts).

export const COLOR_NAMES = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'] as const;
export type ColorName = (typeof COLOR_NAMES)[number];

export const COLOR_LABELS: Record<ColorName, string> = {
  gray: 'Gray',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
};

export const isColorName = (v: unknown): v is ColorName => typeof v === 'string' && (COLOR_NAMES as readonly string[]).includes(v);
