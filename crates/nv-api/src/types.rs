//! The server's JSON types (shared/types.ts), as the REST API returns them. Unknown fields are
//! ignored and missing ones defaulted, so newer and older servers stay readable.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub color: String,
    /// False until the address is confirmed; unverified users can't open pages.
    #[serde(default)]
    pub email_verified: bool,
}

/// Returned by /auth/register, /auth/login and /auth/refresh.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    /// Short-lived JWT for `Authorization: Bearer …` and the collab socket.
    pub access_token: String,
    /// Lifetime of the access token in seconds.
    pub expires_in: u64,
    /// Opaque, single-use token for /auth/refresh. The app stores it in the keychain.
    pub refresh_token: String,
    pub user: User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// owner, admin, member or viewer.
    pub role: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub color: String,
    /// shared or private.
    pub visibility: String,
    pub created_by: String,
    pub position: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub notebook_id: String,
    /// The section this one is nested in, or None at the top level.
    pub parent_id: Option<String>,
    pub name: String,
    pub color: String,
    pub position: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    pub id: String,
    pub section_id: String,
    pub title: String,
    pub icon: Option<String>,
    /// document or canvas.
    pub kind: String,
    pub position: f64,
    pub updated_at: String,
    pub updated_by: Option<String>,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    pub notebooks: Vec<Notebook>,
    pub sections: Vec<Section>,
    pub pages: Vec<PageMeta>,
    /// Pages in the Trash that the caller could restore (members and up; absent from older
    /// servers): a task on one shows its page as "in Trash".
    #[serde(default)]
    pub trashed_pages: Vec<TrashedPage>,
}

/// A page in the Trash, as the tree lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrashedPage {
    pub id: String,
    pub title: String,
}

/// POST /workspaces/:id/notebooks: the notebook and the "General" section it starts with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNotebook {
    pub id: String,
    pub section_id: String,
}

/// DELETE /pages|sections|notebooks/:id: what went to the Trash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trashed {
    pub trash_id: String,
    /// Tasks that were on what went to the Trash (they stay in the task list).
    #[serde(default)]
    pub tasks: u32,
}

/// POST /pages/:id/move.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMoved {
    pub section_id: String,
    pub position: f64,
}

/// POST /sections/:id/move.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionMoved {
    pub notebook_id: String,
    pub parent_id: Option<String>,
    pub position: f64,
}

/// POST /trash/:kind/:id/restore.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    /// Where it went when its old place was gone ("" when it went back as it was).
    #[serde(default)]
    pub moved_to: String,
}

/// What a Trash entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrashKind {
    Page,
    Section,
    Notebook,
}

impl TrashKind {
    /// The word in the server's paths (`/trash/:kind/:id`).
    pub fn as_str(self) -> &'static str {
        match self {
            TrashKind::Page => "page",
            TrashKind::Section => "section",
            TrashKind::Notebook => "notebook",
        }
    }
}

/// One entry of the Trash (GET /workspaces/:id/trash): the item at the top of what was deleted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub kind: TrashKind,
    pub id: String,
    /// The page's title, or the section's or notebook's name.
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub deleted_at: String,
    #[serde(default)]
    pub deleted_by: Option<String>,
    #[serde(default)]
    pub deleted_by_name: Option<String>,
    /// When the daily job removes it for good (60 days after `deleted_at`).
    pub expires_at: String,
    pub days_left: u32,
    /// Where it was: "Notebook > Section" (empty for a notebook).
    #[serde(default)]
    pub path: String,
    /// How many pages and (sub)sections went with it.
    #[serde(default)]
    pub pages: u32,
    #[serde(default)]
    pub sections: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Checklist {
    pub done: u32,
    pub total: u32,
}

/// The nth weekday of a month ("the 2nd Tuesday"): `n` is 1 to 5, or -1 for the last.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NthWeekday {
    pub n: i8,
    /// 0 Sunday … 6 Saturday.
    pub weekday: u8,
}

/// A repeat rule (shared/types.ts `Recurrence`; the maths is in shared/recurrence.ts). Written
/// the way the web writes it: only the keys that are set are sent.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recurrence {
    /// `day`, `week`, `month`, `year` or `weekday` (Monday to Friday).
    #[serde(default)]
    pub freq: String,
    /// Every n units (1 to 365); absent for `weekday`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<u32>,
    /// `week`: the days (0 Sunday … 6 Saturday).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_weekday: Option<Vec<u8>>,
    /// `month` (and `year`): the day of the month, 1 to 31, or -1 for the last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_month_day: Option<i32>,
    /// `month`: "the 2nd Tuesday".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_nth_weekday: Option<NthWeekday>,
    /// The last allowed date, YYYY-MM-DD, inclusive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    /// Total occurrences in the series, the first included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// `due` (the default): the next date counts from the due date; `completion`: from the day
    /// it was completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub basis: Option<String>,
}

/// A rule this core can't read (a newer server's) reads as none rather than failing the task.
fn lenient_recurrence<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Recurrence>, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    Ok(v.and_then(|v| serde_json::from_value(v).ok()))
}

fn default_priority() -> u8 {
    4
}

fn default_status() -> String {
    "open".into()
}

/// A task as the server sends it (server/tasks.ts `rowToTask`, shared/types.ts `Task`). Every
/// field but the id and the title may be missing (older servers) and unknown ones are ignored
/// (newer servers).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    #[serde(default)]
    pub workspace_id: String,
    pub title: String,
    /// Plain text, up to 50 000 characters.
    #[serde(default)]
    pub description: String,
    /// open or done.
    #[serde(default = "default_status")]
    pub status: String,
    /// 1 urgent … 4 none.
    #[serde(default = "default_priority")]
    pub priority: u8,
    /// Local date, YYYY-MM-DD.
    #[serde(default)]
    pub due_date: Option<String>,
    /// Local time, HH:mm.
    #[serde(default)]
    pub due_time: Option<String>,
    #[serde(default, deserialize_with = "lenient_recurrence")]
    pub recurrence: Option<Recurrence>,
    /// The original single reminder (an ISO instant); the reminder list is `Client::reminders`.
    #[serde(default)]
    pub reminder_at: Option<String>,
    #[serde(default)]
    pub assignee_id: Option<String>,
    /// Who last set the assignee (set by the server); none while unassigned.
    #[serde(default)]
    pub assigned_by: Option<String>,
    #[serde(default)]
    pub created_by: String,
    #[serde(default)]
    pub page_id: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub checklist: Option<Checklist>,
    #[serde(default)]
    pub completed_at: Option<String>,
    /// Who ticked it.
    #[serde(default)]
    pub completed_by: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// On the caller's locked page that this sign-in hasn't unlocked: title and text withheld.
    #[serde(default)]
    pub locked: bool,
}

/// A new task (POST /workspaces/:id/tasks). The id is the client's (a UUID), so a retried create
/// can't duplicate it: the server returns the task it already made with that id (when the same
/// user made it in the same workspace; 409 otherwise). The web app always sends one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<Recurrence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminder_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_ids: Option<Vec<String>>,
}

/// `Some(None)` is sent as `null`, `Some(Some(v))` as `v` (`None` is skipped before this runs).
fn nullable<S: serde::Serializer, T: Serialize>(
    v: &Option<Option<T>>,
    s: S,
) -> Result<S::Ok, S::Error> {
    match v {
        Some(Some(x)) => x.serialize(s),
        _ => s.serialize_none(),
    }
}

/// A change to a task (PATCH /tasks/:id; shared/types.ts `TaskPatch`, validated by `validate`
/// in server/tasks.ts). A field left `None` is not sent and stays as it is. The fields the
/// server lets you clear are `Option<Option<_>>`: `Some(None)` sends `null`, which is what the
/// web sends to clear one (`updateTask(id, { dueDate: null })`).
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    /// At most 1000 characters; the server trims it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// At most 50 000 characters; "" clears it (null is refused).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `open` or `done`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// 1 to 4.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    /// YYYY-MM-DD.
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "nullable")]
    pub due_date: Option<Option<String>>,
    /// HH:mm.
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "nullable")]
    pub due_time: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "nullable")]
    pub recurrence: Option<Option<Recurrence>>,
    /// An ISO instant.
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "nullable")]
    pub reminder_at: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "nullable")]
    pub assignee_id: Option<Option<String>>,
    /// Move the task to a note, or (null) off its note.
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "nullable")]
    pub page_id: Option<Option<String>>,
    /// Make it a subtask of a top-level task, or (null) a task of its own.
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "nullable")]
    pub parent_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "nullable")]
    pub team_id: Option<Option<String>>,
    /// The whole tag list (at most 50); an empty list clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_ids: Option<Vec<String>>,
}

impl TaskPatch {
    /// Nothing to send.
    pub fn is_empty(&self) -> bool {
        self == &TaskPatch::default()
    }

    /// The PATCH body.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// A workspace-wide task tag (GET /workspaces/:id/tags).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    #[serde(default)]
    pub workspace_id: String,
    pub name: String,
    /// #rrggbb.
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub created_by: String,
    #[serde(default)]
    pub created_at: String,
}

/// A team, or (with `parent_id`) a subteam, one level deep (GET /workspaces/:id/teams).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub position: f64,
    #[serde(default)]
    pub member_ids: Vec<String>,
}

/// A workspace member as other members see them (GET /workspaces/:id/members).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    #[serde(default)]
    pub email: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    /// owner, admin, member or viewer.
    #[serde(default)]
    pub role: String,
}

/// When a reminder fires (shared/types.ts `ReminderSpec`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReminderSpec {
    /// A fixed instant (ISO).
    At { at: String },
    /// This many minutes (0 to 86 400) before the task is due: its due time, or the user's
    /// default reminder time on its due date.
    Before { minutes: u32 },
}

/// One of the caller's reminders on a task (GET /tasks/:id/reminders).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(flatten)]
    pub spec: ReminderSpec,
    /// When it fires next (ISO), or none once fired, without a due date, or when the task is done.
    #[serde(default)]
    pub next_fire_at: Option<String>,
    #[serde(default)]
    pub last_fired_at: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

/// A page hit in a search (GET /workspaces/:id/search; shared/types.ts `SearchResult.pages`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub icon: Option<String>,
    /// The matching text with matched terms between `«` and `»`; empty for a title-only match
    /// (and always for a locked page: its text is never indexed).
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub notebook_name: String,
    #[serde(default)]
    pub section_name: String,
    /// "Notebook › Section › Subsection".
    #[serde(default)]
    pub path: String,
}

/// A task hit in a search: the task, and a snippet only when its description matched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchTask {
    #[serde(flatten)]
    pub task: Task,
    #[serde(default)]
    pub snippet: Option<String>,
}

/// What a search finds, best match first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SearchResult {
    #[serde(default)]
    pub pages: Vec<SearchPage>,
    #[serde(default)]
    pub tasks: Vec<SearchTask>,
}

/// One comment in a thread (server/routes/comments.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    #[serde(default)]
    pub thread_id: String,
    #[serde(default)]
    pub author_id: String,
    pub body: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub edited_at: Option<String>,
}

/// A comment thread on a text selection of a page, with its comments oldest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentThread {
    pub id: String,
    #[serde(default)]
    pub page_id: String,
    #[serde(default)]
    pub workspace_id: String,
    /// The selected text when the thread was started (at most 500 characters).
    #[serde(default)]
    pub quote: String,
    #[serde(default)]
    pub created_by: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub resolved_at: Option<String>,
    #[serde(default)]
    pub resolved_by: Option<String>,
    #[serde(default)]
    pub comments: Vec<Comment>,
}

// ───────── Sharing (server/routes/workspaces.ts) ─────────

/// A pending workspace invite (GET /workspaces/:id/members, for owners and admins).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInvite {
    pub email: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub invited_by: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    /// When the emailed link stops working (an admin can resend).
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// GET /workspaces/:id/members: the members, and (owners and admins only) the pending invites.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MemberList {
    #[serde(default)]
    pub members: Vec<Member>,
    #[serde(default)]
    pub invites: Vec<PendingInvite>,
}

/// What an invite did (POST /workspaces/:id/members, `.../invites/:email/resend`): `status` is
/// `added` (an existing, verified account joined at once) or `invited` (an invite link was
/// made). `invite_url` is there for `invited`, so the caller can hand it over when the server
/// sent no mail (`emailed` false).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteResult {
    pub status: String,
    #[serde(default)]
    pub emailed: bool,
    #[serde(default)]
    pub invite_url: Option<String>,
}

/// The page an invite link is for, when it is a single-page invite.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitedPage {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub can_edit: bool,
}

/// GET /invites/:token: what an invite link is for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteInfo {
    pub workspace_id: String,
    #[serde(default)]
    pub workspace_name: String,
    #[serde(default)]
    pub invited_by_name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub expired: bool,
    #[serde(default)]
    pub page: Option<InvitedPage>,
}

/// POST /invites/:token/accept: where the invite led (`page_id` for a single-page invite).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedInvite {
    pub workspace_id: String,
    #[serde(default)]
    pub page_id: Option<String>,
}

/// GET /notebooks/:id/shares: a notebook's visibility, creator and the people it is shared with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookShares {
    #[serde(default)]
    pub visibility: String,
    #[serde(default)]
    pub created_by: String,
    #[serde(default)]
    pub user_ids: Vec<String>,
}

/// One person a page is shared with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageShare {
    pub user_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub can_edit: bool,
    /// A member of the page's workspace (their role still caps the share).
    #[serde(default)]
    pub member: bool,
}

/// A pending invite to a page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInvite {
    pub email: String,
    #[serde(default)]
    pub can_edit: bool,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

/// GET /pages/:id/shares (and the answer of every page share change).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PageShares {
    #[serde(default)]
    pub shares: Vec<PageShare>,
    #[serde(default)]
    pub invites: Vec<PageInvite>,
}

/// POST /pages/:id/shares: `status` `shared` or `invited`, and the lists as they are now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageShareResult {
    pub status: String,
    #[serde(default)]
    pub emailed: bool,
    #[serde(default)]
    pub invite_url: Option<String>,
    #[serde(flatten)]
    pub lists: PageShares,
}

/// GET /shared-pages: a page someone shared with the caller.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedPage {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub workspace_name: String,
    #[serde(default)]
    pub member: bool,
    #[serde(default)]
    pub can_edit: bool,
    #[serde(default)]
    pub shared_by_name: Option<String>,
    #[serde(default)]
    pub shared_at: String,
}

// ───────── Version history (server/versions.ts) ─────────

/// One saved version of a page (GET /pages/:id/versions, newest first).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageVersion {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub author_id: Option<String>,
    /// `auto`, `manual`, or `restore` (taken just before a restore).
    #[serde(default)]
    pub reason: String,
    /// When the content was last edited before this snapshot.
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub created_at: String,
}

// ───────── Locked pages (server/routes/locks.ts) ─────────

/// A device that can unlock with Face ID / Touch ID / biometrics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockDevice {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub expires_at: String,
}

/// GET /locked-notes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedNotes {
    #[serde(default)]
    pub has_password: bool,
    #[serde(default)]
    pub unlocked: bool,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub idle_ms: u64,
    #[serde(default)]
    pub locked_pages: u32,
    #[serde(default)]
    pub failures: u32,
    #[serde(default)]
    pub blocked_until: Option<String>,
    #[serde(default)]
    pub tries_before_lockout: u32,
    #[serde(default)]
    pub devices: Vec<LockDevice>,
}

/// POST /locked-notes/devices: a new device secret, handed out once.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewLockDevice {
    pub id: String,
    pub secret: String,
    #[serde(default)]
    pub expires_at: String,
}

impl std::fmt::Debug for NewLockDevice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewLockDevice")
            .field("id", &self.id)
            .field("secret", &"<hidden>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

// ───────── Account (server/routes/auth.ts, reminders.ts, oauth/routes.ts) ─────────

/// GET /notifications/settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    /// IANA time zone; due dates and times are read in it.
    pub time_zone: String,
    pub email_enabled: bool,
    /// HH:mm used for "before" reminders on tasks with a due date but no time.
    pub default_reminder_time: String,
    pub digest_enabled: bool,
    /// HH:mm local time of the daily digest.
    pub digest_time: String,
}

/// Body of PATCH /notifications/settings: only the fields set are sent.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_reminder_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest_time: Option<String>,
}

/// GET /me/connected-apps: an AI app the user allowed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedApp {
    pub client_id: String,
    pub name: String,
    #[serde(default)]
    pub client_uri: Option<String>,
    /// `dcr` or `cimd`: how the app registered.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub connected_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
}
