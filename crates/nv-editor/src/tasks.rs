//! Task lines in a box (EDITOR.md 5): `taskRef` blocks, their notes, and the task store behind them.

use crate::editor::Editor;

pub const TASK: &str = "taskRef";

/// Enter on an empty last line of a task's notes: the line leaves the task (taskChildren.ts).
pub fn exit_empty_last_child(_ed: &mut Editor) -> bool {
    false
}

/// Backspace at the start of a task's first note line (TaskRef.tsx): the caret goes to the title.
pub fn backspace_at_note_start(_ed: &mut Editor) -> bool {
    false
}
