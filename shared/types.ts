// Types shared between the server and the web client.
import type { FileKey } from './fileLinks.ts';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Visibility = 'shared' | 'private';
export type Priority = 1 | 2 | 3 | 4; // 1 = urgent, 4 = none (Todoist-style)
export type TaskStatus = 'open' | 'done';

/** Day of week, 0 = Sunday … 6 = Saturday (same as Date#getDay). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Optional refinements of a recurrence rule. All fields are optional, so the
 * original small rules ({ freq: 'day', interval: 1 }, { freq: 'weekday' }) are
 * still valid and mean what they always meant. Math lives in shared/recurrence.ts.
 */
export interface RecurrenceOptions {
  /** freq 'week': repeat on these days (e.g. [1, 4] = Mon and Thu). Default: the due date's weekday. */
  byWeekday?: Weekday[];
  /** freq 'month': day of the month 1–31 (clamped to short months), or -1 for the last day. */
  byMonthDay?: number;
  /** freq 'month': the nth weekday of the month, e.g. { n: 2, weekday: 2 } = 2nd Tuesday; n = -1 is the last. */
  byNthWeekday?: { n: 1 | 2 | 3 | 4 | 5 | -1; weekday: Weekday };
  /** Last allowed occurrence date, YYYY-MM-DD (inclusive). */
  until?: string;
  /** Total number of occurrences in the series (including the first). */
  count?: number;
  /** 'due' (default): next date counts from the current due date. 'completion': from the day it was completed. */
  basis?: 'due' | 'completion';
}

/**
 * Recurrence rule. Kept small and serialisable:
 *   { freq: 'day' | 'week' | 'month' | 'year', interval: n, ...options }
 *   { freq: 'weekday', ...options }  (Mon–Fri)
 */
export type Recurrence =
  | ({ freq: 'day' | 'week' | 'month' | 'year'; interval: number } & RecurrenceOptions)
  | ({ freq: 'weekday' } & RecurrenceOptions);

/** GET /auth/account/deletion-preview: what deleting the signed-in account would do to workspaces. */
export interface AccountDeletionPreview {
  /** Owned, with no other owner or admin to hand over to: deleted for everyone. */
  deletedWorkspaces: { id: string; name: string }[];
  /** Owned, no other owner: the longest-standing admin becomes owner. */
  transferredWorkspaces: { id: string; name: string; newOwnerName: string }[];
  /** Owned together with another owner: that owner carries on. */
  sharedOwnership: { id: string; name: string }[];
  /** Workspaces owned by someone else (as admin, member or viewer): you are removed from them. */
  leftWorkspaces: { id: string; name: string }[];
  /** Private notebooks you created, deleted with everything in them. */
  privateNotebooks: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  color: string;
  /** False until the address is confirmed by email; unverified users only get the "check your email" screen. */
  emailVerified: boolean;
}

/** Returned by /auth/register, /auth/login and /auth/refresh. */
export interface AuthSession {
  /** Short-lived JWT for `Authorization: Bearer …` and WebSocket auth. */
  accessToken: string;
  /** Lifetime of the access token in seconds. */
  expiresIn: number;
  /** Opaque, single-use token for POST /auth/refresh. Store it securely. */
  refreshToken: string;
  /** Signs upload links (shared/fileLinks.ts). Optional so older servers still work. */
  fileKey?: FileKey;
  user: User;
}

export interface Workspace {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
}

/** A workspace member as other members see them (verification status is private to the account). */
export interface Member extends Omit<User, 'emailVerified'> {
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
  /** Set for an invite to a single page (#98): accepting shares that page, it doesn't add a membership. */
  page?: { id: string; title: string; canEdit: boolean };
}

/** GET /shared-pages: a page someone shared with me (page_shares). */
export interface SharedPage {
  id: string;
  title: string;
  icon: string | null;
  workspaceId: string;
  workspaceName: string;
  /** Am I a member of the page's workspace? (If not, the page is all I can see there.) */
  member: boolean;
  canEdit: boolean;
  sharedByName: string | null;
  sharedAt: string;
}

/** One person a page is shared with (GET /pages/:id/shares). */
export interface PageShare {
  userId: string;
  name: string;
  email: string;
  color: string;
  /** What the share grants. For a workspace member, their role still caps it (a viewer only views). */
  canEdit: boolean;
  member: boolean;
}

/** GET /pages/:id/shares */
export interface PageShares {
  shares: PageShare[];
  invites: { email: string; canEdit: boolean; expiresAt: string | null; createdAt: string }[];
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
  /** The section this one is nested in (same notebook), or null at the top level. At most 3 levels. */
  parentId: string | null;
  name: string;
  color: string;
  position: number;
  /**
   * The section's own default template (a user template's id), or null to inherit the nearest
   * ancestor's. New pages made with New page start from the effective one (shared/sections.ts
   * effectiveDefaultTemplate).
   */
  defaultTemplateId?: string | null;
  /** "None" chosen for this section: don't inherit a parent's default. */
  noDefaultTemplate?: boolean;
}

/** Page kind: one flowing 'document', or a 'canvas' of text boxes placed anywhere (docs/PLAN_CANVAS.md). */
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
  /** Pages in the Trash (that the caller can restore): a task on one shows its page as "in Trash". Absent from older servers. */
  trashedPages?: { id: string; title: string }[];
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
  /** Parent task for a subtask (one level deep); null for top-level tasks. */
  parentId: string | null;
  /** The task's team (independent of the assignee's teams). */
  teamId: string | null;
  /** Tag ids, in no particular order. */
  tagIds: string[];
  /** Who last set the assignee; null while unassigned. Set by the server. */
  assignedBy: string | null;
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
    | 'parentId'
    | 'teamId'
    | 'tagIds'
  >
>;

/** A workspace-wide task tag (GET /workspaces/:id/tags). */
export interface Tag {
  id: string;
  workspaceId: string;
  name: string;
  /** #rrggbb */
  color: string;
  createdBy: string;
  createdAt: string;
}

/** A team or (with parentId) a subteam, one level deep (GET /workspaces/:id/teams). */
export interface Team {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  color: string;
  position: number;
  memberIds: string[];
}

/** What a saved task view stores: the All Tasks filters, sort and grouping (validated by the client). */
export interface TaskViewQuery {
  filters: Record<string, unknown>;
  sort: string;
  group: string;
}

/** A saved view of All Tasks (GET /workspaces/:id/task-views): the caller's own plus shared ones. */
export interface TaskView {
  id: string;
  workspaceId: string;
  ownerId: string;
  /** Every member sees it (only owners and admins can share). */
  shared: boolean;
  name: string;
  query: TaskViewQuery;
  position: number;
  createdAt: string;
}

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
    /** Full location, e.g. "Notebook › Section › Subsection". */
    path: string;
  }[];
  tasks: (Task & { snippet?: string })[];
}

/** A user-saved page template, as listed by GET /workspaces/:id/templates (no content). */
export interface TemplateMeta {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  /** 'private': saved from a private notebook, visible to its creator only. */
  visibility: 'workspace' | 'private';
  /** The kind of page it makes (the kind it was saved from). A canvas template's content is canvasBox nodes. */
  kind: PageKind;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
  fileCount: number;
  /** The signed-in user may rename/delete it (creator, or an owner/admin for workspace-visible ones). */
  canManage: boolean;
  /**
   * Tied to sections (template_sections): false = offered everywhere. When true it's offered only in
   * `sections` (and their subsections when includeSubsections). `sections` lists only the ones the
   * signed-in user can see, so it may be empty while `scoped` is true. See templateOffer in shared/sections.ts.
   */
  scoped: boolean;
  sections: { sectionId: string; includeSubsections: boolean }[];
}

/** What POST /templates/:id/use returns: content ready to insert through the editor, with brand-new tasks and file copies. */
export interface TemplateUse {
  title: string;
  icon: string | null;
  kind: PageKind;
  /** TipTap JSON doc: taskRef nodes point at newly created tasks, attachments at new file copies. */
  content: unknown;
  taskIds: string[];
}

/** POST /pages/:id/pending-template: the template a just-created page was made from, claimed once. */
export interface PendingTemplateUse extends TemplateUse {
  templateId: string;
  name: string;
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
  /** A page template was created, renamed or deleted: refetch the list. Private templates only reach their creator. */
  | { type: 'templates'; workspaceId: string }
  /** Tags or teams changed: refetch them. */
  | { type: 'tags'; workspaceId: string }
  | { type: 'teams'; workspaceId: string }
  /** Saved task views changed: refetch. Personal views only reach their owner. */
  | { type: 'task-views'; workspaceId: string }
  /** The pages shared with you (GET /shared-pages) changed: refetch. Sent only to the people affected. */
  | { type: 'shared-pages' }
  /** The server can't replay what was missed: reload tree, tasks and members. */
  | { type: 'resync' };

/**
 * Envelope on the /api/events WebSocket. `seq` increases per server process;
 * a client reconnects with `?since=<boot>:<seq>` to get missed events replayed
 * (or a `resync` if they're no longer buffered). `hello` is sent on connect.
 */
export type EventMessage = (ServerEvent & { seq?: number }) | { type: 'hello'; boot: string; seq: number };

// ── Reminders and notifications (owner: Recurrence & Reminders) ──────────────

/**
 * When a reminder fires:
 *   at     — a fixed instant (ISO timestamp)
 *   before — `minutes` before the task is due (its due time, or the user's
 *            default reminder time on the due date when it has no time).
 *            Follows the task when its due date moves or a recurring task rolls forward.
 */
export type ReminderSpec = { kind: 'at'; at: string } | { kind: 'before'; minutes: number };

export type Reminder = ReminderSpec & {
  id: string;
  taskId: string;
  /** Who gets notified. */
  userId: string;
  /** Next time it will fire (ISO), or null if it has fired / the task has no due date / it's done. */
  nextFireAt: string | null;
  lastFiredAt: string | null;
  createdAt: string;
};

export interface NotificationSettings {
  /** IANA time zone, e.g. "Europe/London". Due dates and times are interpreted in it. */
  timeZone: string;
  emailEnabled: boolean;
  /** HH:mm used for "before" reminders on tasks with a due date but no time. */
  defaultReminderTime: string;
  /** Daily email listing Today's tasks (overdue + due today). */
  digestEnabled: boolean;
  /** HH:mm local time to send the digest. */
  digestTime: string;
}

/** Quiet hours for one workspace: reminders inside the window wait until it ends. HH:mm local; start > end wraps midnight. */
export interface QuietHours {
  workspaceId: string;
  start: string;
  end: string;
}

/** Body of POST /notifications/push-subscriptions: a browser PushSubscription.toJSON(). */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** One entry of a workspace's Trash (GET /workspaces/:id/trash): a page, section or notebook that was deleted. */
export type TrashKind = 'page' | 'section' | 'notebook';

export interface TrashItem {
  kind: TrashKind;
  id: string;
  /** The page's title, or the section's or notebook's name. */
  name: string;
  icon: string | null;
  deletedAt: string;
  deletedBy: string | null;
  deletedByName: string | null;
  /** When the daily job removes it for good (60 days after deletedAt). */
  expiresAt: string;
  daysLeft: number;
  /** Where it was: "Notebook › Section" (empty for a notebook). */
  path: string;
  /** How many pages and (sub)sections went with it. */
  pages: number;
  sections: number;
}

/** AI connector permissions (server/oauth/). notes:write implies notes:read. */
export type OAuthScope = 'notes:read' | 'notes:write';

/** What the consent page shows for a pending authorization request (GET /api/oauth/requests/:id). */
export interface OAuthConsentInfo {
  client: {
    id: string;
    /** Self-reported by the app; not verified. */
    name: string;
    /** 'cimd': identified by the https URL of its metadata document (idHost is that URL's host). 'dcr': registered itself. */
    kind: 'dcr' | 'cimd';
    /** Self-reported home page, if any. */
    uri: string | null;
    idHost: string | null;
  };
  /** Where the browser goes after Allow / Deny. */
  redirectHost: string;
  scopes: OAuthScope[];
  resource: string;
  origin: string;
}

/** Settings → Connected apps (GET /api/me/connected-apps). */
export interface ConnectedApp {
  clientId: string;
  name: string;
  clientUri: string | null;
  kind: 'dcr' | 'cimd';
  scopes: OAuthScope[];
  connectedAt: string;
  lastUsedAt: string | null;
}
