//! Commands by name (EDITOR.md 4): the suite's command vocabulary (`COMMANDS` in
//! `tests/editor/run-tiptap.ts`) plus the view's menu picks, so the suite runner and the Core
//! API's editor session call the same thing. The caller runs `finish()` afterwards.

use crate::editor::Editor;
use crate::node::{add_mark, remove_mark, Mark};
use crate::schema::Attrs;
use serde_json::Value;

fn one(k: &str, v: &Value) -> Attrs {
    let mut m = Attrs::new();
    m.insert(k.to_string(), v.clone());
    m
}

fn s<'a>(a: &'a Value, k: &str) -> &'a str {
    a[k].as_str().unwrap_or("")
}

impl Editor {
    /// The marks typed text gets at `pos`: the stored ones, else those of the text around it.
    fn current_marks(&self, pos: usize) -> Vec<Mark> {
        self.stored_marks
            .clone()
            .unwrap_or_else(|| self.marks_at(pos))
    }

    /// Run the command `name` with its arguments (a JSON object). Ok(whether it did anything),
    /// or Err for a name the engine doesn't know.
    pub fn command(&mut self, name: &str, a: &Value) -> Result<bool, String> {
        let done = match name {
            "toggleMark" => self.toggle_mark(s(a, "mark")),
            "toggleBulletList" => self.toggle_list("bulletList"),
            "toggleOrderedList" => self.toggle_list("orderedList"),
            "toggleChecklist" => self.toggle_list("taskList"),
            "toggleQuote" => self.toggle_wrap("blockquote"),
            "toggleCodeBlock" => self.toggle_code_block(),
            "setParagraph" => self.set_block_type("paragraph", Attrs::new()),
            "setHeading" => self.set_block_type("heading", one("level", &a["level"])),
            "toggleHeading" => self.toggle_heading(a["level"].as_u64().unwrap_or(1)),
            "setColor" | "setHighlight" | "setLink" => {
                let (kind, attr) = match name {
                    "setColor" => ("textStyle", "color"),
                    "setHighlight" => ("highlight", "color"),
                    _ => ("link", "href"),
                };
                let (f, t) = self.range();
                let mark = Mark::new(kind, one(attr, &a[attr]));
                if f == t && kind != "link" {
                    // A caret: what is typed next takes the colour (a stored mark).
                    let cur = self.current_marks(f);
                    self.stored_marks = Some(add_mark(&cur, &mark));
                } else {
                    self.add_mark_range(f, t, &mark);
                }
                true
            }
            "unsetLink" | "unsetColor" | "unsetHighlight" => {
                let kind = match name {
                    "unsetColor" => "textStyle",
                    "unsetHighlight" => "highlight",
                    _ => "link",
                };
                let (f, t) = self.range();
                if f == t && kind != "link" {
                    let cur = self.current_marks(f);
                    self.stored_marks = Some(remove_mark(&cur, kind));
                } else {
                    self.remove_mark_range(f, t, kind);
                }
                true
            }
            // The comment anchor (collabComments.ts): the selection gets the thread's mark; a thread
            // is taken off the whole document.
            "setComment" => {
                let (f, t) = self.range();
                self.add_mark_range(f, t, &Mark::new("comment", one("threadId", &a["threadId"])));
                true
            }
            "unsetComment" => {
                let id = a["threadId"].clone();
                let end = self.doc.content_size();
                self.remove_mark_where(0, end, "comment", "threadId", &id);
                true
            }
            // View state (an open toggle): nothing in the engine, the suite sends it for TipTap.
            "openToggles" => true,
            "editLink" => self.edit_link(a["text"].as_str(), s(a, "href")),
            "selectAll" => self.select_all(),
            "insertTable" => self.insert_table(
                a["rows"].as_u64().unwrap_or(3) as usize,
                a["cols"].as_u64().unwrap_or(3) as usize,
                a["header"].as_bool().unwrap_or(true),
            ),
            "addRowAfter" => self.add_row(true),
            "addRowBefore" => self.add_row(false),
            "addColumnAfter" => self.add_column_after(),
            "addColumnBefore" => self.add_column(false),
            "toggleHeaderRow" => self.toggle_header_row(),
            "deleteRow" => self.delete_row(),
            "deleteColumn" => self.delete_column(),
            "deleteTable" => self.delete_table(),
            "insertPageLink" => self.insert_page_link(s(a, "pageId")),
            "insertMention" => self.insert_mention(s(a, "id"), s(a, "label")),
            "insertTask" => self.insert_task(s(a, "title")),
            // Beyond the suite's vocabulary: what the views call from menus and the ribbon.
            "convertToTask" => self.convert_to_task(),
            "indent" => self.tab(),
            "outdent" => self.shift_tab(),
            "moveBlockUp" => self.move_block(true),
            "moveBlockDown" => self.move_block(false),
            "hardBreak" => self.hard_break(),
            "focusTitle" => {
                self.focus_title(s(a, "id"));
                true
            }
            "pickSlash" => self.pick_slash(s(a, "title")),
            "pickPage" => self.pick_page(s(a, "pageId")),
            "pickMention" => self.pick_mention(s(a, "id"), s(a, "label")),
            "dismissSuggestion" => self.dismiss_suggestion(),
            "moveHighlight" => self.move_slash_highlight(a["delta"].as_i64().unwrap_or(1)),
            "pickHighlighted" => self.pick_highlighted_slash(),
            other => return Err(format!("command {other} not supported yet")),
        };
        Ok(done)
    }
}
