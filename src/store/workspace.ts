// Workspaces and the current workspace's tree and members.
import { emptyTree, set, st } from './state.ts';
import { loadTasks } from './tasks.ts';
import { cached } from './cache.ts';
import type { Member, PendingInvite, Tree, Workspace } from '../../shared/types.ts';
import { platform } from '../platform/index.ts';

export async function loadWorkspaces() {
  const workspaces = await cached<Workspace[]>('workspaces', '/workspaces');
  set({ workspaces });
  return workspaces;
}

export async function selectWorkspace(wsId: string) {
  if (st().wsId === wsId && st().treeLoaded) return;
  set({ wsId, tree: emptyTree, tasks: {}, members: [], treeLoaded: false, tasksLoaded: false });
  platform.kv.set('noteapp.lastWs', wsId);
  await Promise.all([loadTree(), loadTasks(), loadMembers()]);
}

export async function loadTree() {
  const wsId = st().wsId;
  if (!wsId) return;
  const tree = await cached<Tree>(`tree:${wsId}`, `/workspaces/${wsId}/tree`);
  if (st().wsId === wsId) set({ tree, treeLoaded: true });
}

export async function loadMembers() {
  const wsId = st().wsId;
  if (!wsId) return;
  const r = await cached<{ members: Member[]; invites: PendingInvite[] }>(`members:${wsId}`, `/workspaces/${wsId}/members`);
  if (st().wsId === wsId) set({ members: r.members, invites: r.invites });
}

export function memberById(id: string | null | undefined): Member | undefined {
  return id ? st().members.find((m) => m.id === id) : undefined;
}

export function canEditWorkspace(): boolean {
  const { workspaces, wsId } = st();
  const role = workspaces.find((w) => w.id === wsId)?.role;
  return role !== undefined && role !== 'viewer';
}
