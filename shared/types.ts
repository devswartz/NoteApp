// Types shared between the server and the web client.

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Visibility = 'shared' | 'private';
export type Priority = 1 | 2 | 3 | 4; // 1 = urgent, 4 = none (Todoist-style)
export type TaskStatus = 'open' | 'done';

/**
 * Recurrence rule. Kept intentionally small and serialisable:
 *   { freq: 'day' | 'week' | 'month' | 'year', interval: n }
 *   { freq: 'weekday' }  (Mon–Fri)
 */
export type Recurrence =
  | { freq: 'day' | 'week' | 'month' | 'year'; interval: number }
  | { freq: 'weekday' };

export interface User {
  id: string;
  email: string;
  name: string;
  color: string;
}

/** Returned by /auth/register, /auth/login and /auth/refresh. */
export interface AuthSession {
  /** Short-lived JWT for `Authorization: Bearer …` and WebSocket auth. */
  accessToken: string;
  /** Lifetime of the access token in seconds. */
  expiresIn: number;
  /** Opaque, single-use token for POST /auth/refresh. Store it securely. */
  refreshToken: string;
  user: User;
}

export interface Workspace {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface Member extends User {
  role: Role;
}

export interface PendingInvite {
  email: string;
  role: Role;
  invitedBy?: string | null;
  createdAt?: string;
  /** When the emailed link stops working (the admin can resend). */
  expiresAt?: string | null;
}

/** GET /invites/:token (no auth): what the invite link is for. */
export interface InviteInfo {
  workspaceId: string;
  workspaceName: string;
  invitedByName: string;
  email: string;
  role: Role;
  expired: boolean;
}

/** GET /workspaces/:id/team: members plus their task load (for the Team view). */
export interface TeamMember extends Member {
  openTasks: number;
  overdueTasks: number;
  dueTodayTasks: number;
}

export interface Notebook {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  visibility: Visibility;
  createdBy: string;
  position: number;
  /** Private notebooks: user ids it is shared with (besides its creator). */
  sharedWith?: string[];
}

export interface Section {
  id: string;
  notebookId: string;
  name: string;
  color: string;
  position: number;
}

/** Page kind. Only 'document' exists today; 'canvas' is reserved for freeform pages. */
export type PageKind = 'document' | 'canvas';

export interface PageMeta {
  id: string;
  sectionId: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  position: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface Tree {
  notebooks: Notebook[];
  sections: Section[];
  pages: PageMeta[];
}

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  /** Local calendar date, YYYY-MM-DD. */
  dueDate: string | null;
  /** Optional local time, HH:mm. */
  dueTime: string | null;
  recurrence: Recurrence | null;
  /** ISO timestamp for a reminder notification. */
  reminderAt: string | null;
  assigneeId: string | null;
  createdBy: string;
  /** Source note. null = standalone task (or removed from its note). */
  pageId: string | null;
  completedAt: string | null;
  completedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'status'
    | 'priority'
    | 'dueDate'
    | 'dueTime'
    | 'recurrence'
    | 'reminderAt'
    | 'assigneeId'
    | 'pageId'
  >
>;

/**
 * GET /workspaces/:id/search?q=…&limit=… — best match first.
 * Snippets mark matched terms with « and » (escape nothing else; render as text).
 */
export interface SearchResult {
  pages: {
    id: string;
    title: string;
    icon?: string | null;
    snippet: string;
    notebookName: string;
    sectionName: string;
  }[];
  tasks: (Task & { snippet?: string })[];
}

/** An uploaded image or attachment (POST /workspaces/:id/files). */
export interface UploadedFile {
  id: string;
  /** Path on the API origin ("/uploads/<id><ext>"); pass it through fileUrl() on the client. */
  url: string;
  name: string;
  mime: string;
  size: number;
}

export interface Comment {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

/** A comment thread on a text selection in a page (anchored by a `comment` mark with this id). */
export interface CommentThread {
  id: string;
  pageId: string;
  workspaceId: string;
  quote: string;
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  comments: Comment[];
}

export type NotificationKind = 'mention' | 'assigned' | 'shared' | 'comment' | 'reminder' | 'invite' | 'other';

/** An in-app notification (the bell inbox). */
export interface AppNotification {
  id: string;
  kind: NotificationKind;
  workspaceId: string | null;
  actorId: string | null;
  title: string;
  body: string;
  /** In-app path to open, e.g. /w/<ws>/p/<page>. */
  link: string | null;
  data: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
}

/** One entry in a workspace's activity feed. */
export interface ActivityItem {
  id: number;
  workspaceId: string;
  actorId: string | null;
  verb: string;
  targetType: 'page' | 'notebook' | 'section' | 'task' | 'member' | 'comment' | 'workspace';
  targetId: string;
  summary: string;
  createdAt: string;
}

/** Messages pushed to clients over the /api/events WebSocket. */
export type ServerEvent =
  | { type: 'task'; task: Task }
  | { type: 'task-deleted'; id: string; workspaceId: string }
  | { type: 'tree'; workspaceId: string }
  | { type: 'members'; workspaceId: string }
  | { type: 'workspaces' }
  /** Comment threads on a page changed: refetch them if the page is open. */
  | { type: 'comments'; workspaceId: string; pageId: string }
  /** A new in-app notification for the recipient (always sent to specific users). */
  | { type: 'notification'; notification: AppNotification }
  /** New entries in the workspace activity feed. */
  | { type: 'activity'; workspaceId: string }
  /** The server can't replay what was missed: reload tree, tasks and members. */
  | { type: 'resync' };

/**
 * Envelope on the /api/events WebSocket. `seq` increases per server process;
 * a client reconnects with `?since=<boot>:<seq>` to get missed events replayed
 * (or a `resync` if they're no longer buffered). `hello` is sent on connect.
 */
export type EventMessage = (ServerEvent & { seq?: number }) | { type: 'hello'; boot: string; seq: number };
