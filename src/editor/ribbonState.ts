// What the ribbon (./Toolbar.tsx) needs beyond the active editor: the open page (its Y.Doc,
// for the Page group, and whether you may edit it), and two per-device choices kept in
// platform.kv: the ribbon collapsed to a strip, and the outline hidden.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type * as Y from 'yjs';
import { DEFAULT_PAGE_SETTINGS, observePageSettings, readPageSettings, type PageSettings } from '../../shared/pageDoc.ts';
import { platform } from '../platform/index.ts';

export interface RibbonPage {
  pageId: string;
  doc: Y.Doc;
  canEdit: boolean;
}

const COLLAPSED_KEY = 'noteapp.ribbonCollapsed';
const OUTLINE_KEY = 'noteapp.outlineHidden';

const readFlag = (key: string) => {
  try {
    return platform.kv.get(key) === '1';
  } catch {
    return false;
  }
};
const writeFlag = (key: string, on: boolean) => {
  try {
    platform.kv.set(key, on ? '1' : '0');
  } catch {
    // storage unavailable: the choice lasts for this visit only
  }
};

interface RibbonState {
  page: RibbonPage | null;
  collapsed: boolean;
  outlineHidden: boolean;
}

export const useRibbon = create<RibbonState>(() => ({ page: null, collapsed: readFlag(COLLAPSED_KEY), outlineHidden: readFlag(OUTLINE_KEY) }));

/** The page the ribbon's Page and View groups act on (PageView sets it while a page is open). */
export function setRibbonPage(page: RibbonPage | null) {
  const cur = useRibbon.getState().page;
  if (cur?.pageId === page?.pageId && cur?.doc === page?.doc && cur?.canEdit === page?.canEdit) return;
  useRibbon.setState({ page });
}

export function setRibbonCollapsed(collapsed: boolean) {
  writeFlag(COLLAPSED_KEY, collapsed);
  useRibbon.setState({ collapsed });
}

export function setOutlineHidden(hidden: boolean) {
  writeFlag(OUTLINE_KEY, hidden);
  useRibbon.setState({ outlineHidden: hidden });
}

/** Re-read after initPlatform() swaps in a shell's storage (see syncThemePref). */
export function syncRibbonPrefs() {
  useRibbon.setState({ collapsed: readFlag(COLLAPSED_KEY), outlineHidden: readFlag(OUTLINE_KEY) });
}

/** A page's settings (page colour, rule lines), live: anyone's change shows at once. */
export function usePageSettings(doc: Y.Doc | null | undefined): PageSettings {
  const [s, setS] = useState<PageSettings>(() => (doc ? readPageSettings(doc) : DEFAULT_PAGE_SETTINGS));
  useEffect(() => {
    if (!doc) {
      setS(DEFAULT_PAGE_SETTINGS);
      return;
    }
    setS(readPageSettings(doc));
    return observePageSettings(doc, setS);
  }, [doc]);
  return s;
}
