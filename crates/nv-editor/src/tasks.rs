//! Task lines in a box (EDITOR.md 5): `taskRef` blocks, their notes, and the task store behind
//! them. Today's rules: `src/editor/taskChildren.ts`, `TaskRef.tsx`, `undoTasks.ts`.

use crate::editor::{near_text, Editor, Focus};
use crate::node::Node;
use crate::schema::Attrs;
use crate::selection::Selection;
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
    /// The task's title, if the task exists.
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

/// Task ids in the doc, in order.
pub fn task_ids(doc: &Node) -> Vec<String> {
    let mut out = Vec::new();
    doc.descendants(&mut |n, _| {
        if n.is(TASK) {
            if let Some(id) = n.attr("taskId").as_str() {
                out.push(id.to_string());
            }
        }
        true
    });
    out
}

fn task_node(id: &str, notes: Vec<Node>) -> Node {
    let mut a = Attrs::new();
    a.insert("taskId".into(), json!(id));
    Node::new(TASK, a, notes)
}

/// The position before the node at a child path.
pub fn pos_of_path(doc: &Node, path: &[usize]) -> usize {
    let mut p = 0;
    let mut n = doc;
    for (depth, &i) in path.iter().enumerate() {
        if depth > 0 {
            p += 1;
        }
        p += n.content[..i].iter().map(Node::node_size).sum::<usize>();
        n = &n.content[i];
    }
    p
}

/// The position before the task line with this id.
pub fn task_pos(doc: &Node, id: &str) -> Option<usize> {
    let mut found = None;
    doc.descendants(&mut |n, p| {
        if found.is_none() && n.is(TASK) && n.attr("taskId").as_str() == Some(id) {
            found = Some(p);
        }
        found.is_none()
    });
    found
}

impl Editor {
    /// `/task` and the ribbon's Task button: a new task line at the caret, its title focused.
    pub fn insert_task(&mut self, title: &str) -> bool {
        let id = self.tasks.new_id();
        self.tasks.create(&id, title, false);
        self.known_tasks.push(id.clone());
        if self.insert_block(task_node(&id, vec![])) {
            self.focus = Focus::TaskTitle(id);
            true
        } else {
            false
        }
    }

    /// Mod+Enter / Mod+1: the caret's line, or the selected lines, become tasks. A list item's
    /// sub-points stay under its task; a checked checklist item makes a done task.
    pub fn convert_to_task(&mut self) -> bool {
        let (from, to) = self.range();
        let single = from == to || {
            let (a, b) = (self.resolve(from), self.resolve(to));
            a.path == b.path
        };
        let to = if single { to.max(from + 1) } else { to };
        // Which lines: overlapping from..to (one line when the selection is inside it).
        let overlaps = |pos: usize, n: &Node| pos < to && pos + n.node_size() > from;
        fn rebuild(
            n: &Node,
            pos: usize,
            ov: &dyn Fn(usize, &Node) -> bool,
            make: &mut dyn FnMut(&str, bool) -> Option<String>,
        ) -> Vec<Node> {
            if !ov(pos, n) || n.is(TASK) {
                return vec![n.clone()];
            }
            if n.is_list() {
                let mut out = Vec::new();
                let mut keep: Vec<Node> = Vec::new();
                let mut converted = false;
                let flush = |keep: &mut Vec<Node>, out: &mut Vec<Node>, converted: bool| {
                    if keep.is_empty() {
                        return;
                    }
                    let mut l = n.copy(std::mem::take(keep));
                    if converted && n.is("orderedList") {
                        l = l
                            .with_attr("start", json!(1))
                            .with_attr("continued", json!(true));
                    }
                    out.push(l);
                };
                let mut p = pos + 1;
                for item in &n.content {
                    let ip = p;
                    p += item.node_size();
                    if !ov(ip, item) {
                        keep.push(item.clone());
                        continue;
                    }
                    let first = &item.content[0];
                    if first.is_textblock() && ov(ip + 1, first) {
                        let done = item.is("taskItem") && item.attr("checked") == &json!(true);
                        if let Some(id) = make(&first.text_content(), done) {
                            flush(&mut keep, &mut out, converted);
                            out.push(task_node(&id, item.content[1..].to_vec()));
                            converted = true;
                            continue;
                        }
                    }
                    keep.push(item.clone());
                }
                flush(&mut keep, &mut out, converted);
                return out;
            }
            if n.is_textblock() && !n.is("codeBlock") {
                if let Some(id) = make(&n.text_content(), false) {
                    return vec![task_node(&id, vec![])];
                }
            }
            vec![n.clone()]
        }
        // The blocks of the selection's parent that it covers.
        let rf = self.resolve(from);
        let mut d = rf.depth();
        while d > 0
            && (rf.node(&self.doc, d).is_textblock()
                || rf.node(&self.doc, d).is_list()
                || rf.node(&self.doc, d).is_list_item())
        {
            d -= 1;
        }
        let parent_path = rf.path_to(d);
        let start = rf.start(d);
        let parent = self.doc.at(&parent_path).clone();
        let mut made: Vec<(String, String, bool)> = Vec::new();
        let host = &mut self.tasks;
        let mut make = |title: &str, done: bool| -> Option<String> {
            let t = title.trim();
            if t.is_empty() && !single {
                return None;
            }
            let id = host.new_id();
            made.push((id.clone(), t.to_string(), done));
            Some(id)
        };
        let mut out = Vec::new();
        let mut p = start;
        for c in &parent.content {
            out.extend(rebuild(c, p, &overlaps, &mut make));
            p += c.node_size();
        }
        if made.is_empty() {
            return false;
        }
        self.doc.at_mut(&parent_path).content = out;
        for (id, title, done) in &made {
            self.tasks.create(id, title, *done);
            self.known_tasks.push(id.clone());
        }
        let empty = made
            .iter()
            .find(|(_, t, _)| t.is_empty())
            .map(|(id, _, _)| id.clone());
        self.finish();
        let last = &made[made.len() - 1].0;
        let end = task_pos(&self.doc, last).map_or(0, |p| {
            p + crate::editor::node_after(&self.doc, p).map_or(0, Node::node_size)
        });
        self.sel = Selection::caret(near_text(&self.doc, end, 1));
        if let Some(id) = empty {
            self.focus = Focus::TaskTitle(id);
        }
        true
    }

    /// Tab on the line just after a task (or a list starting there, its first line): into the task's notes.
    pub fn indent_into_task(&mut self) -> bool {
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        if !r.parent(&self.doc).is_textblock() || r.parent(&self.doc).is("codeBlock") {
            return false;
        }
        // The block to move: the line, or its whole list when on the list's very first line.
        let mut d = r.depth();
        if d >= 3 && r.node(&self.doc, d - 1).is_list_item() {
            if r.index_at(d - 1) == 0 && r.index_at(d - 2) == 0 {
                d -= 2;
            } else {
                return false;
            }
        }
        let parent = r.path_to(d - 1);
        let i = r.index_at(d - 1);
        if i == 0 || !self.doc.at(&parent).content[i - 1].is(TASK) {
            return false;
        }
        let kids = &mut self.doc.at_mut(&parent).content;
        let block = kids.remove(i);
        kids[i - 1].content.push(block);
        self.sel = crate::editor::shift_sel(&self.sel, -1);
        true
    }

    /// Shift+Tab on a line in a task's notes: out of the task, just after it.
    pub fn lift_out_of_task(&mut self) -> bool {
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        let d = r.depth();
        if d < 2 || !r.parent(&self.doc).is_textblock() || !r.node(&self.doc, d - 1).is(TASK) {
            return false;
        }
        self.move_child_out(&r.path_to(d), 1)
    }

    /// Move the child of a task at `path` to just after the task; a caret inside it moves with it.
    fn move_child_out(&mut self, path: &[usize], _shift: isize) -> bool {
        let old_before = pos_of_path(&self.doc, path);
        let task_path = &path[..path.len() - 1];
        let i = path[path.len() - 1];
        let block = self.doc.at_mut(task_path).content.remove(i);
        let size = block.node_size();
        let outer = task_path[..task_path.len() - 1].to_vec();
        let ti = task_path[task_path.len() - 1];
        self.doc.at_mut(&outer).content.insert(ti + 1, block);
        let mut new_path = outer.clone();
        new_path.push(ti + 1);
        let new_before = pos_of_path(&self.doc, &new_path);
        if let Some(h) = self.sel.head() {
            if self.focus == Focus::Doc && h > old_before && h < old_before + size {
                self.sel = Selection::caret(h - old_before + new_before);
            }
        }
        true
    }

    /// Enter on an empty last line of a task's notes: the line leaves the task.
    pub fn exit_empty_last_child(&mut self) -> bool {
        let Some(pos) = self.sel.head() else {
            return false;
        };
        let r = self.resolve(pos);
        let d = r.depth();
        if d < 2 || !r.parent(&self.doc).content.is_empty() || !r.node(&self.doc, d - 1).is(TASK) {
            return false;
        }
        let task = r.node(&self.doc, d - 1);
        if r.index_at(d - 1) != task.content.len() - 1 {
            return false;
        }
        self.move_child_out(&r.path_to(d), 1)
    }

    // ───────────── The task line's title (its own field) ─────────────

    /// Typing in the focused title.
    pub fn title_input(&mut self, text: &str) {
        let Focus::TaskTitle(id) = self.focus.clone() else {
            return;
        };
        let t = self.tasks.title(&id).unwrap_or_default();
        self.tasks.set_title(&id, &format!("{t}{text}"));
    }

    /// Put the caret in a task line's title.
    pub fn focus_title(&mut self, id: &str) {
        self.focus = Focus::TaskTitle(id.to_string());
    }

    /// Keys in the focused title (TaskRef.tsx onKeyDown).
    pub fn title_key(&mut self, chord: &str) -> bool {
        let Focus::TaskTitle(id) = self.focus.clone() else {
            return false;
        };
        let Some(p) = task_pos(&self.doc, &id) else {
            return false;
        };
        let title = self.tasks.title(&id).unwrap_or_default();
        let node = crate::editor::node_after(&self.doc, p).unwrap().clone();
        match chord {
            "Enter" => {
                if title.trim().is_empty() {
                    return self.make_plain_line(p);
                }
                if !node.content.is_empty() {
                    // A task with notes: a new first note line.
                    let r = self.resolve(p + 1);
                    let path = r.path.clone();
                    self.doc
                        .at_mut(&path)
                        .content
                        .insert(0, Node::el("paragraph", vec![]));
                    self.focus = Focus::Doc;
                    self.sel = Selection::caret(p + 2);
                    return true;
                }
                let new_id = self.tasks.new_id();
                self.tasks.create(&new_id, "", false);
                self.known_tasks.push(new_id.clone());
                let r = self.resolve(p);
                let parent = r.path.clone();
                self.doc
                    .at_mut(&parent)
                    .content
                    .insert(r.index + 1, task_node(&new_id, vec![]));
                self.focus = Focus::TaskTitle(new_id);
                true
            }
            "Backspace" => {
                if title.is_empty() {
                    return self.make_plain_line(p);
                }
                let mut t = title;
                t.pop();
                self.tasks.set_title(&id, &t);
                true
            }
            "Tab" | "Shift+Tab" => {
                let r = self.resolve(p);
                let parent = r.path.clone();
                let i = r.index;
                if chord == "Tab" {
                    if i == 0 || !self.doc.at(&parent).content[i - 1].is(TASK) {
                        return true;
                    }
                    let kids = &mut self.doc.at_mut(&parent).content;
                    let me = kids.remove(i);
                    kids[i - 1].content.push(me);
                } else {
                    if r.depth() == 0 || !self.doc.at(&parent).is(TASK) {
                        return true;
                    }
                    let mut path = parent.clone();
                    path.push(i);
                    self.move_child_out(&path, 0);
                }
                true
            }
            _ => false,
        }
    }

    /// An empty task's line becomes an ordinary empty line in its place; its notes stay under it.
    fn make_plain_line(&mut self, p: usize) -> bool {
        let r = self.resolve(p);
        let parent = r.path.clone();
        let i = r.index;
        let task = self.doc.at(&parent).content[i].clone();
        let mut repl = vec![Node::el("paragraph", vec![])];
        repl.extend(task.content);
        self.doc.at_mut(&parent).content.splice(i..=i, repl);
        self.focus = Focus::Doc;
        self.sel = Selection::caret(p + 1);
        true
    }

    /// After every change: a task line gone from the box deletes its task; one back (undo) restores it.
    pub fn sync_tasks(&mut self) {
        let now = task_ids(&self.doc);
        for id in &self.known_tasks {
            if !now.contains(id) {
                self.tasks.delete(id);
            }
        }
        for id in &now {
            if !self.known_tasks.contains(id) && self.tasks.title(id).is_none() {
                self.tasks.restore(id);
            }
        }
        self.known_tasks = now;
    }
}

/// Enter on an empty last line of a task's notes (keymap hook).
pub fn exit_empty_last_child(ed: &mut Editor) -> bool {
    ed.exit_empty_last_child()
}

/// Backspace at the start of a task's first note line (TaskRef.tsx): the caret goes to the title.
pub fn backspace_at_note_start(_ed: &mut Editor) -> bool {
    false
}
