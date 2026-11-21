//! Task lines in a box (EDITOR.md 5): `taskRef` blocks, their notes, and the task store behind them.

use crate::editor::{Editor, Focus};
use crate::node::Node;
use crate::schema::Attrs;
use serde_json::json;

pub const TASK: &str = "taskRef";

/// The task store, as the editor sees it (the core implements it over `nv-store`).
pub trait TaskHost {
    /// A new task id (tasks get their ids on the client, as today).
    fn new_id(&mut self) -> String;
    fn create(&mut self, id: &str, title: &str, done: bool);
    fn delete(&mut self, id: &str);
    /// Bring back a task this session deleted (undo put its line back). False if it can't.
    fn restore(&mut self, id: &str) -> bool;
    fn title(&self, id: &str) -> Option<String>;
    fn set_title(&mut self, id: &str, title: &str);
}

/// A task store that does nothing: for boxes that can't hold tasks, and tests.
#[derive(Debug, Default)]
pub struct NoTasks {
    n: usize,
}

impl TaskHost for NoTasks {
    fn new_id(&mut self) -> String {
        self.n += 1;
        format!("task-{}", self.n)
    }
    fn create(&mut self, _: &str, _: &str, _: bool) {}
    fn delete(&mut self, _: &str) {}
    fn restore(&mut self, _: &str) -> bool {
        false
    }
    fn title(&self, _: &str) -> Option<String> {
        None
    }
    fn set_title(&mut self, _: &str, _: &str) {}
}

impl Editor {
    /// `/task` and the ribbon's Task button: a new task line at the caret, its title focused.
    pub fn insert_task(&mut self, title: &str) -> bool {
        let id = self.tasks.new_id();
        self.tasks.create(&id, title, false);
        let mut a = Attrs::new();
        a.insert("taskId".into(), json!(id));
        if self.insert_block(Node::new(TASK, a, vec![])) {
            self.focus = Focus::TaskTitle(id);
            true
        } else {
            false
        }
    }
}

/// Enter on an empty last line of a task's notes: the line leaves the task (taskChildren.ts).
pub fn exit_empty_last_child(_ed: &mut Editor) -> bool {
    false
}

/// Backspace at the start of a task's first note line (TaskRef.tsx): the caret goes to the title.
pub fn backspace_at_note_start(_ed: &mut Editor) -> bool {
    false
}
