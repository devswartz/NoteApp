//! The full task model in the Core API (docs/rewrite/status/core.md, "For apple: task details"):
//! every field today's server keeps for a task, readable (`TaskDetail`) and settable
//! (`TaskChanges`, `Core::update_task`), the lists a task's fields point into (tags, teams,
//! members), a task's reminders, and quick add.
//!
//! `Task` (client.rs) stays as it is, so Swift code that builds one keeps compiling;
//! `TaskDetail` is the same task with everything.

use nv_api::{NthWeekday, Recurrence, TaskPatch};

use crate::recurrence;
use crate::{Core, CoreError};

/// "The 2nd Tuesday" of a month: `n` is 1 to 5, or -1 for the last.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TaskNthWeekday {
    pub n: i8,
    /// 0 Sunday … 6 Saturday.
    pub weekday: u8,
}

/// A repeat rule, as the server stores it (shared/types.ts `Recurrence`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TaskRecurrence {
    /// `day`, `week`, `month`, `year` or `weekday` (Monday to Friday).
    pub freq: String,
    /// Every n units, 1 to 365; none for `weekday`.
    #[uniffi(default = None)]
    pub interval: Option<u32>,
    /// `week`: the days, 0 Sunday … 6 Saturday. None: the due date's weekday.
    #[uniffi(default = None)]
    pub by_weekday: Option<Vec<u8>>,
    /// `month` (and `year`): the day of the month, 1 to 31, or -1 for the last.
    #[uniffi(default = None)]
    pub by_month_day: Option<i32>,
    /// `month`: "the 2nd Tuesday".
    #[uniffi(default = None)]
    pub by_nth_weekday: Option<TaskNthWeekday>,
    /// The last allowed date, YYYY-MM-DD, inclusive.
    #[uniffi(default = None)]
    pub until: Option<String>,
    /// Total occurrences, the first included.
    #[uniffi(default = None)]
    pub count: Option<u32>,
    /// `due` (default: the next date counts from the due date) or `completion` (from the day
    /// it was ticked).
    #[uniffi(default = None)]
    pub basis: Option<String>,
}

impl From<&Recurrence> for TaskRecurrence {
    fn from(r: &Recurrence) -> Self {
        TaskRecurrence {
            freq: r.freq.clone(),
            interval: r.interval,
            by_weekday: r.by_weekday.clone(),
            by_month_day: r.by_month_day,
            by_nth_weekday: r.by_nth_weekday.as_ref().map(|n| TaskNthWeekday {
                n: n.n,
                weekday: n.weekday,
            }),
            until: r.until.clone(),
            count: r.count,
            basis: r.basis.clone(),
        }
    }
}

impl From<&TaskRecurrence> for Recurrence {
    fn from(r: &TaskRecurrence) -> Self {
        Recurrence {
            freq: r.freq.clone(),
            interval: r.interval,
            by_weekday: r.by_weekday.clone(),
            by_month_day: r.by_month_day,
            by_nth_weekday: r.by_nth_weekday.as_ref().map(|n| NthWeekday {
                n: n.n,
                weekday: n.weekday,
            }),
            until: r.until.clone(),
            count: r.count,
            basis: r.basis.clone(),
        }
    }
}

/// A task with every field the server keeps (server/tasks.ts `rowToTask`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TaskDetail {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    /// Plain text.
    pub description: String,
    pub done: bool,
    /// 1 urgent … 4 none.
    pub priority: u8,
    /// Local date, YYYY-MM-DD (no time zone: "the 5th" means the 5th wherever you are).
    pub due_date: Option<String>,
    /// Local time, HH:mm, with `due_date`.
    pub due_time: Option<String>,
    pub recurrence: Option<TaskRecurrence>,
    /// The original single reminder: an ISO instant (UTC, `2026-12-01T08:00:00.000Z`). The
    /// reminder list is `Core::task_reminders`.
    pub reminder_at: Option<String>,
    pub assignee_id: Option<String>,
    /// Who last set the assignee; none while unassigned.
    pub assigned_by: Option<String>,
    pub created_by: String,
    /// Who ticked it.
    pub completed_by: Option<String>,
    /// The page the task is written on, if any.
    pub page_id: Option<String>,
    /// The task this is a subtask of (one level deep).
    pub parent_id: Option<String>,
    pub team_id: Option<String>,
    pub tag_ids: Vec<String>,
    /// Ticked and total items of the checklists under the task on its page.
    pub checklist_done: Option<u32>,
    pub checklist_total: Option<u32>,
    /// ISO instants (UTC).
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// On a locked page this sign-in hasn't unlocked: title and text are withheld.
    pub locked: bool,
}

pub(crate) fn detail(t: nv_api::Task) -> TaskDetail {
    TaskDetail {
        done: t.status == "done",
        checklist_done: t.checklist.as_ref().map(|c| c.done),
        checklist_total: t.checklist.as_ref().map(|c| c.total),
        recurrence: t.recurrence.as_ref().map(TaskRecurrence::from),
        id: t.id,
        workspace_id: t.workspace_id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        due_date: t.due_date,
        due_time: t.due_time,
        reminder_at: t.reminder_at,
        assignee_id: t.assignee_id,
        assigned_by: t.assigned_by,
        created_by: t.created_by,
        completed_by: t.completed_by,
        page_id: t.page_id,
        parent_id: t.parent_id,
        team_id: t.team_id,
        tag_ids: t.tag_ids,
        completed_at: t.completed_at,
        created_at: t.created_at,
        updated_at: t.updated_at,
        locked: t.locked,
    }
}

/// What to change on a task (`Core::update_task`). A field left out (nil) is not touched. To
/// clear a field that can be cleared, set its `clear…` flag (the `…` field is then ignored
/// when it is nil; if both are given the value wins). The web sends `null` for a clear;
/// that is what the flags send.
#[derive(Debug, Clone, PartialEq, Default, uniffi::Record)]
pub struct TaskChanges {
    /// At most 1000 characters; the server trims it.
    #[uniffi(default = None)]
    pub title: Option<String>,
    /// At most 50 000 characters; "" clears it.
    #[uniffi(default = None)]
    pub description: Option<String>,
    /// Tick (true) or reopen (false). Ticking a recurring task makes the server roll its due
    /// date forward and keep it open.
    #[uniffi(default = None)]
    pub done: Option<bool>,
    /// 1 urgent … 4 none.
    #[uniffi(default = None)]
    pub priority: Option<u8>,
    /// YYYY-MM-DD.
    #[uniffi(default = None)]
    pub due_date: Option<String>,
    #[uniffi(default = false)]
    pub clear_due_date: bool,
    /// HH:mm. The web also sets the due date to today when it sets a time on a task without one.
    #[uniffi(default = None)]
    pub due_time: Option<String>,
    #[uniffi(default = false)]
    pub clear_due_time: bool,
    /// The web also sets the due date to `first_occurrence(rule, today)` when a rule is set on a
    /// task without a date.
    #[uniffi(default = None)]
    pub recurrence: Option<TaskRecurrence>,
    #[uniffi(default = false)]
    pub clear_recurrence: bool,
    /// An ISO instant, the original single reminder.
    #[uniffi(default = None)]
    pub reminder_at: Option<String>,
    #[uniffi(default = false)]
    pub clear_reminder_at: bool,
    /// A workspace member (or, on a shared page, someone that page is shared with).
    #[uniffi(default = None)]
    pub assignee_id: Option<String>,
    #[uniffi(default = false)]
    pub clear_assignee: bool,
    #[uniffi(default = None)]
    pub team_id: Option<String>,
    #[uniffi(default = false)]
    pub clear_team: bool,
    /// The whole tag list (at most 50 ids; an empty list clears it).
    #[uniffi(default = None)]
    pub tag_ids: Option<Vec<String>>,
    /// Move the task to this page.
    #[uniffi(default = None)]
    pub page_id: Option<String>,
    /// Take it off its page (it becomes a task of the workspace).
    #[uniffi(default = false)]
    pub clear_page: bool,
    /// Make it a subtask of this top-level task.
    #[uniffi(default = None)]
    pub parent_id: Option<String>,
    /// Make it a task of its own again.
    #[uniffi(default = false)]
    pub clear_parent: bool,
}

/// `Some(None)` to clear, `Some(Some(v))` to set, `None` to leave.
fn field<T>(value: &Option<T>, clear: bool) -> Option<Option<T>>
where
    T: Clone,
{
    match (value, clear) {
        (Some(v), _) => Some(Some(v.clone())),
        (None, true) => Some(None),
        (None, false) => None,
    }
}

impl TaskChanges {
    pub(crate) fn to_patch(&self) -> TaskPatch {
        TaskPatch {
            title: self.title.clone(),
            description: self.description.clone(),
            status: self
                .done
                .map(|d| if d { "done" } else { "open" }.to_string()),
            priority: self.priority,
            due_date: field(&self.due_date, self.clear_due_date),
            due_time: field(&self.due_time, self.clear_due_time),
            recurrence: field(
                &self.recurrence.as_ref().map(Recurrence::from),
                self.clear_recurrence,
            ),
            reminder_at: field(&self.reminder_at, self.clear_reminder_at),
            assignee_id: field(&self.assignee_id, self.clear_assignee),
            page_id: field(&self.page_id, self.clear_page),
            parent_id: field(&self.parent_id, self.clear_parent),
            team_id: field(&self.team_id, self.clear_team),
            tag_ids: self.tag_ids.clone(),
        }
    }
}

fn invalid(message: &str) -> CoreError {
    CoreError::Server {
        status: 400,
        message: message.to_string(),
        code: None,
    }
}

/// The server's `recurrenceError` (shared/recurrence.ts): a message, or none when it's fine.
pub(crate) fn recurrence_error(r: &Recurrence) -> Option<&'static str> {
    if r.freq != "weekday" {
        if !["day", "week", "month", "year"].contains(&r.freq.as_str()) {
            return Some("Invalid recurrence frequency");
        }
        if !r.interval.is_some_and(|i| (1..=365).contains(&i)) {
            return Some("Invalid recurrence interval");
        }
    }
    if let Some(d) = &r.by_weekday {
        if d.is_empty() || d.iter().any(|&w| w > 6) {
            return Some("Invalid weekdays");
        }
    }
    if let Some(d) = r.by_month_day {
        if d != -1 && !(1..=31).contains(&d) {
            return Some("Invalid day of month");
        }
    }
    if let Some(n) = &r.by_nth_weekday {
        if ![1, 2, 3, 4, 5, -1].contains(&n.n) || n.weekday > 6 {
            return Some("Invalid nth weekday");
        }
    }
    if r.until
        .as_deref()
        .is_some_and(|u| !recurrence::is_iso_date(u))
    {
        return Some("Invalid end date");
    }
    if r.count.is_some_and(|c| !(1..=10_000).contains(&c)) {
        return Some("Invalid occurrence count");
    }
    if r.basis
        .as_deref()
        .is_some_and(|b| b != "due" && b != "completion")
    {
        return Some("Invalid recurrence basis");
    }
    None
}

fn time_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 2 || c.is_ascii_digit())
}

/// What the server would refuse (`validate` in server/tasks.ts), checked before a change is
/// sent or queued, so a bad value fails at once instead of being dropped from the offline
/// queue later. Dates are checked as real dates, a little stricter than the server.
pub(crate) fn validate(p: &TaskPatch) -> Result<(), CoreError> {
    let utf16 = |s: &str| s.encode_utf16().count();
    if p.title.as_deref().is_some_and(|t| utf16(t) > 1000) {
        return Err(invalid("Invalid title"));
    }
    if p.description.as_deref().is_some_and(|t| utf16(t) > 50_000) {
        return Err(invalid("Invalid description"));
    }
    if p.priority.is_some_and(|x| !(1..=4).contains(&x)) {
        return Err(invalid("Invalid priority"));
    }
    if p.status
        .as_deref()
        .is_some_and(|s| s != "open" && s != "done")
    {
        return Err(invalid("Invalid status"));
    }
    if let Some(Some(d)) = &p.due_date {
        if !recurrence::is_iso_date(d) {
            return Err(invalid("Invalid due date"));
        }
    }
    if let Some(Some(t)) = &p.due_time {
        if !time_ok(t) {
            return Err(invalid("Invalid due time"));
        }
    }
    if let Some(Some(r)) = &p.recurrence {
        if let Some(e) = recurrence_error(r) {
            return Err(invalid(e));
        }
    }
    if let Some(Some(r)) = &p.reminder_at {
        if !(r.len() >= 10 && r.as_bytes()[..4].iter().all(u8::is_ascii_digit)) {
            return Err(invalid("Invalid reminder"));
        }
    }
    if p.tag_ids.as_ref().is_some_and(|t| t.len() > 50) {
        return Err(invalid("Invalid tags"));
    }
    Ok(())
}

/// `validate` for a new task's fields.
pub(crate) fn validate_new(n: &nv_api::NewTask) -> Result<(), CoreError> {
    validate(&TaskPatch {
        title: Some(n.title.clone()),
        description: n.description.clone(),
        priority: n.priority,
        due_date: n.due_date.clone().map(Some),
        due_time: n.due_time.clone().map(Some),
        recurrence: n.recurrence.clone().map(Some),
        reminder_at: n.reminder_at.clone().map(Some),
        tag_ids: n.tag_ids.clone(),
        ..Default::default()
    })
}

/// A workspace-wide tag (the web's "#waiting").
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TaskTag {
    pub id: String,
    pub name: String,
    /// #rrggbb.
    pub color: String,
}

/// A team, or (with `parent_id`) a subteam of one.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TaskTeam {
    pub id: String,
    pub name: String,
    pub color: String,
    pub parent_id: Option<String>,
    pub member_ids: Vec<String>,
}

/// A workspace member: who an assignee id is.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct WorkspaceMember {
    pub id: String,
    pub name: String,
    pub email: String,
    /// #rrggbb, the colour of their avatar.
    pub color: String,
    /// owner, admin, member or viewer.
    pub role: String,
}

/// When a reminder fires.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum ReminderSpec {
    /// A fixed instant (ISO, UTC).
    At { at: String },
    /// This many minutes (0 to 86 400) before the task is due: before its due time, or before
    /// the user's default reminder time on its due date.
    Before { minutes: u32 },
}

/// One of your reminders on a task.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TaskReminder {
    pub id: String,
    pub task_id: String,
    pub spec: ReminderSpec,
    /// When it fires next (ISO, UTC); none once fired, without a due date, or once the task is done.
    pub next_fire_at: Option<String>,
    pub last_fired_at: Option<String>,
}

fn spec_in(s: &ReminderSpec) -> nv_api::ReminderSpec {
    match s {
        ReminderSpec::At { at } => nv_api::ReminderSpec::At { at: at.clone() },
        ReminderSpec::Before { minutes } => nv_api::ReminderSpec::Before { minutes: *minutes },
    }
}

fn reminder(r: nv_api::Reminder) -> TaskReminder {
    TaskReminder {
        id: r.id,
        task_id: r.task_id,
        spec: match r.spec {
            nv_api::ReminderSpec::At { at } => ReminderSpec::At { at },
            nv_api::ReminderSpec::Before { minutes } => ReminderSpec::Before { minutes },
        },
        next_fire_at: r.next_fire_at,
        last_fired_at: r.last_fired_at,
    }
}

fn check_reminder(s: &ReminderSpec) -> Result<(), CoreError> {
    match s {
        ReminderSpec::At { at }
            if at.len() < 10 || !at.as_bytes()[..4].iter().all(u8::is_ascii_digit) =>
        {
            Err(invalid("Invalid reminder time"))
        }
        ReminderSpec::Before { minutes } if *minutes > 60 * 24 * 60 => {
            Err(invalid("Invalid reminder offset"))
        }
        _ => Ok(()),
    }
}

/// `resolveMember` (src/components/TaskRow.tsx): the member an "@mention" from quick add means:
/// `me` is you; else a first name, then the start of the name without spaces, then the start of
/// the email, all ignoring case. None when nobody matches.
#[uniffi::export]
pub fn resolve_member(
    mention: String,
    members: Vec<WorkspaceMember>,
    me: String,
) -> Option<String> {
    let q = mention.to_lowercase();
    if q == "me" {
        return Some(me);
    }
    let squash = |s: &str| s.to_lowercase().split_whitespace().collect::<String>();
    members
        .iter()
        .find(|m| m.name.to_lowercase().split_whitespace().next() == Some(q.as_str()))
        .or_else(|| members.iter().find(|m| squash(&m.name).starts_with(&q)))
        .or_else(|| {
            members
                .iter()
                .find(|m| m.email.to_lowercase().starts_with(&q))
        })
        .map(|m| m.id.clone())
}

/// `resolveTeam`: the team a "+team" from quick add means: its name without spaces equals the
/// text, else starts with it (ignoring case).
#[uniffi::export]
pub fn resolve_team(text: String, teams: Vec<TaskTeam>) -> Option<String> {
    let q = text.to_lowercase();
    let key = |n: &str| n.to_lowercase().split_whitespace().collect::<String>();
    teams
        .iter()
        .find(|t| key(&t.name) == q)
        .or_else(|| teams.iter().find(|t| key(&t.name).starts_with(&q)))
        .map(|t| t.id.clone())
}

/// Read a quick-add line ("Call Sam tomorrow 3pm p1 @sam #waiting +elders every week") the way
/// the web's quick add does (`parseQuickAdd`, shared/quickadd.ts). `today` is the user's local
/// date, YYYY-MM-DD (the words "tomorrow", "friday", "in 2 weeks" count from it); a malformed
/// one counts as today in UTC. Nothing is created: pass the parts to `create_task_with`.
#[uniffi::export]
pub fn parse_quick_add(text: String, today: String) -> crate::QuickAddResult {
    crate::quickadd::parse_quick_add(&text, &today)
}

/// The first date a repeat rule falls on, on or after `from` (YYYY-MM-DD): the due date for a
/// task given a rule but no date ("every monday" on a Thursday: next Monday). Rules without a
/// pattern (every 3 days) return `from`.
#[uniffi::export]
pub fn first_occurrence(rule: TaskRecurrence, from: String) -> String {
    recurrence::first_occurrence_of(&Recurrence::from(&rule), &from)
}

/// A rule in words: "Every 2 weeks on Mon, Thu", "Every month on the 2nd Tuesday", "Every day
/// until 2026-12-31" (`describeRecurrence`, shared/recurrence.ts, the web's task detail). A
/// yearly rule says its day from `due_date`.
#[uniffi::export]
pub fn describe_recurrence(rule: TaskRecurrence, due_date: Option<String>) -> String {
    recurrence::describe(&Recurrence::from(&rule), due_date.as_deref())
}

#[uniffi::export]
impl Core {
    /// Change fields of a task (PATCH /tasks/:id). Only the fields set in `changes` are sent.
    /// Values are checked first (a bad one throws `Server` with status 400 before anything is
    /// sent or queued). With a store the stored task is updated at once and, if the server
    /// can't be reached, the change is queued like `set_task_title` (returns the task as it will
    /// be); see "For apple: task calls" for what isn't queued. Returns the task as the server
    /// has it now: ticking a recurring task returns it open with its next due date.
    pub fn update_task(
        &self,
        task_id: String,
        changes: TaskChanges,
    ) -> Result<TaskDetail, CoreError> {
        let patch = changes.to_patch();
        validate(&patch)?;
        if patch.is_empty() {
            return self
                .cached_task_detail(task_id.clone())
                .ok_or_else(|| CoreError::Network {
                    message: "the task isn't stored".into(),
                });
        }
        self.edit_task_raw(&task_id, patch.to_value()).map(detail)
    }

    /// One task with every field, as stored on this device (local, instant), queued changes
    /// included. None without a store or for a task not stored.
    pub fn cached_task_detail(&self, task_id: String) -> Option<TaskDetail> {
        self.store.as_ref()?.task(&task_id).ok()?.map(detail)
    }

    /// A workspace's tasks with every field, as last stored on this device, or none.
    pub fn cached_task_details(&self, workspace_id: String) -> Option<Vec<TaskDetail>> {
        let ts = self.store.as_ref()?.tasks(&workspace_id).ok()??;
        Some(ts.into_iter().map(detail).collect())
    }

    /// `tasks()` with every field: the workspace's tasks from the server (queued changes sent
    /// first and laid over the list; offline: the stored copy).
    pub fn task_details(&self, workspace_id: String) -> Result<Vec<TaskDetail>, CoreError> {
        Ok(self
            .tasks_raw(&workspace_id)?
            .into_iter()
            .map(detail)
            .collect())
    }

    /// The notes written under a task on its page, as Markdown (the web's "From the note"):
    /// bullets, checklists (`- [ ] item`, `- [x] item`), subtasks left out. "" without notes
    /// or a page. Needs the network.
    pub fn task_notes(&self, task_id: String) -> Result<String, CoreError> {
        Ok(self.api.task_notes(&task_id)?)
    }

    /// The workspace's tags by name. Needs the network.
    pub fn tags(&self, workspace_id: String) -> Result<Vec<TaskTag>, CoreError> {
        Ok(self
            .api
            .tags(&workspace_id)?
            .into_iter()
            .map(|t| TaskTag {
                id: t.id,
                name: t.name,
                color: t.color,
            })
            .collect())
    }

    /// A tag by name, made when it doesn't exist (members and up; a name that exists in any
    /// case returns that tag; a leading # is dropped; at most 40 characters). `color`:
    /// #rrggbb, or none to let the server pick.
    pub fn create_tag(
        &self,
        workspace_id: String,
        name: String,
        color: Option<String>,
    ) -> Result<TaskTag, CoreError> {
        let t = self
            .api
            .create_tag(&workspace_id, &name, color.as_deref())?;
        Ok(TaskTag {
            id: t.id,
            name: t.name,
            color: t.color,
        })
    }

    /// The workspace's teams and subteams. Needs the network.
    pub fn teams(&self, workspace_id: String) -> Result<Vec<TaskTeam>, CoreError> {
        Ok(self
            .api
            .teams(&workspace_id)?
            .into_iter()
            .map(|t| TaskTeam {
                id: t.id,
                name: t.name,
                color: t.color,
                parent_id: t.parent_id,
                member_ids: t.member_ids,
            })
            .collect())
    }

    /// The workspace's members (who an `assignee_id`, `created_by` or `completed_by` is). Needs
    /// the network.
    pub fn members(&self, workspace_id: String) -> Result<Vec<WorkspaceMember>, CoreError> {
        Ok(self
            .api
            .members(&workspace_id)?
            .into_iter()
            .map(|m| WorkspaceMember {
                id: m.id,
                name: m.name,
                email: m.email,
                color: m.color,
                role: m.role,
            })
            .collect())
    }

    /// Your reminders on a task. Reminders are per person (others' are not shown) and are not
    /// queued offline: these four calls need the network.
    pub fn task_reminders(&self, task_id: String) -> Result<Vec<TaskReminder>, CoreError> {
        Ok(self
            .api
            .reminders(&task_id)?
            .into_iter()
            .map(reminder)
            .collect())
    }

    /// Add a reminder (at most 10 per task).
    pub fn add_reminder(
        &self,
        task_id: String,
        spec: ReminderSpec,
    ) -> Result<TaskReminder, CoreError> {
        check_reminder(&spec)?;
        Ok(reminder(self.api.add_reminder(&task_id, &spec_in(&spec))?))
    }

    /// Change a reminder's time.
    pub fn update_reminder(
        &self,
        reminder_id: String,
        spec: ReminderSpec,
    ) -> Result<TaskReminder, CoreError> {
        check_reminder(&spec)?;
        Ok(reminder(
            self.api.update_reminder(&reminder_id, &spec_in(&spec))?,
        ))
    }

    /// Remove a reminder.
    pub fn delete_reminder(&self, reminder_id: String) -> Result<(), CoreError> {
        Ok(self.api.delete_reminder(&reminder_id)?)
    }
}
