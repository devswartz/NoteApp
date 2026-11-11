// The core app store: session, current workspace data and UI state.
// Actions live next to it in this folder, one file per area. A new area with
// its own state should create its own small zustand store in its own files
// rather than growing this one.
import { create } from 'zustand';
import { platform } from '../platform/index.ts';
import type { Member, PendingInvite, Tag, Task, Team, Tree, User, Workspace } from '../../shared/types.ts';

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
  tone?: 'error' | 'info';
  /** Stays until dismissed or its action runs. */
  sticky?: boolean;
}

export interface QuickAddDefaults {
  pageId?: string | null;
  dueDate?: string | null;
  assigneeId?: string | null;
  text?: string;
}

export interface State {
  user: User | null;
  workspaces: Workspace[];
  wsId: string | null;
  tree: Tree;
  treeLoaded: boolean;
  tasks: Record<string, Task>;
  tasksLoaded: boolean;
  members: Member[];
  invites: PendingInvite[];
  /** The workspace's task tags and teams (migration 014). */
  tags: Tag[];
  teams: Team[];
  /** Tasks completed moments ago stay visible briefly so the check-off animation is seen. */
  lingering: Record<string, true>;
  online: boolean;

  // UI
  sidebarOpen: boolean;
  paletteOpen: boolean;
  quickAdd: QuickAddDefaults | null;
  taskDetailId: string | null;
  shortcutsOpen: boolean;
  toasts: Toast[];
}

export const emptyTree: Tree = { notebooks: [], sections: [], pages: [] };

/** Desktop and tablet remember whether the side panels were hidden; phones always start with the drawer closed. */
export const SIDEBAR_KEY = 'noteapp.sidebarOpen';
function initialSidebarOpen(): boolean {
  if (typeof window === 'undefined') return true;
  if (window.innerWidth <= 760) return false;
  const saved = platform.kv.get(SIDEBAR_KEY);
  return saved === null ? window.innerWidth >= 900 : saved === '1';
}

export const useStore = create<State>(() => ({
  user: null,
  workspaces: [],
  wsId: null,
  tree: emptyTree,
  treeLoaded: false,
  tasks: {},
  tasksLoaded: false,
  members: [],
  invites: [],
  tags: [],
  teams: [],
  lingering: {},
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  sidebarOpen: initialSidebarOpen(),
  paletteOpen: false,
  quickAdd: null,
  taskDetailId: null,
  shortcutsOpen: false,
  toasts: [],
}));

export const set = useStore.setState;
export const st = useStore.getState;
