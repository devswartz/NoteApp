// Global UI toggles (palette, quick add, task detail, sidebar, shortcuts help).
import { set, type QuickAddDefaults } from './state.ts';

export const ui = {
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  openQuickAdd: (d: QuickAddDefaults = {}) => set({ quickAdd: d }),
  closeQuickAdd: () => set({ quickAdd: null }),
  openTask: (id: string | null) => set({ taskDetailId: id }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebar: (open: boolean) => set({ sidebarOpen: open }),
  setShortcuts: (open: boolean) => set({ shortcutsOpen: open }),
};
