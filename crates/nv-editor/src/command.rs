//! Commands by name (EDITOR.md 4): the suite's command vocabulary (`COMMANDS` in
//! `tests/editor/run-tiptap.ts`) plus the view's menu picks, so the suite runner and the Core
//! API's editor session call the same thing. The caller runs `finish()` afterwards.

use crate::editor::Editor;
use crate::node::Mark;
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
                self.add_mark_range(f, t, &Mark::new(kind, one(attr, &a[attr])));
                true
            }
            "unsetLink" => {
                let (f, t) = self.range();
                self.remove_mark_range(f, t, "link");
                true
            }
            "selectAll" => self.select_all(),
            "insertTable" => self.insert_table(
                a["rows"].as_u64().unwrap_or(3) as usize,
                a["cols"].as_u64().unwrap_or(3) as usize,
                a["header"].as_bool().unwrap_or(true),
            ),
            "addRowAfter" => self.add_row(true),
            "addColumnAfter" => self.add_column_after(),
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
            other => return Err(format!("command {other} not supported yet")),
        };
        Ok(done)
    }
}
