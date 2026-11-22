//! Suggestion menus (EDITOR.md 4): `/` commands, `[[` page links and `@` mentions. The engine
//! finds the trigger and query at the caret; the view shows the menu (pages and people come from
//! the core) and calls a `pick_*` command. Slash items are the engine's own (`SLASH_ITEMS`).

use crate::editor::Editor;
use crate::node::{u16_len, Node};
use crate::schema::Attrs;
use crate::selection::Selection;
use serde_json::json;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Slash,
    PageLink,
    Mention,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub trigger: Trigger,
    /// The range to replace (the trigger characters and the query).
    pub from: usize,
    pub to: usize,
    pub query: String,
}

/// Today's slash menu (`src/editor/SlashMenu.tsx`): title and keywords, in menu order.
pub const SLASH_ITEMS: &[(&str, &str)] = &[
    ("Task", "todo task action checkbox assign"),
    ("Text", "paragraph p"),
    ("Heading 1", "h1 title"),
    ("Heading 2", "h2 subtitle"),
    ("Heading 3", "h3"),
    ("Checklist", "checkbox list todo plain"),
    (
        "Add checklist",
        "checkbox list todo plain task packing subitems",
    ),
    ("Bulleted list", "ul unordered bullet"),
    ("Numbered list", "ol ordered number"),
    ("Toggle", "toggle collapse collapsible details expand fold"),
    ("Table", "grid spreadsheet"),
    ("Image", "picture photo upload"),
    ("File attachment", "attachment upload pdf document"),
    ("Link", "url href hyperlink web"),
    ("Link to page", "page link reference backlink wiki [["),
    ("Quote", "blockquote citation"),
    ("Callout", "callout info note tip warning admonition box"),
    ("Code block", "pre snippet code ``` program"),
    ("Divider", "hr separator rule"),
];

/// Each slash item's description and icon (today's `SlashMenu.tsx`; the icon is its Lucide
/// name, for the view to map to its own symbols).
pub const SLASH_DETAILS: &[(&str, &str, &str)] = &[
    (
        "Task",
        "A real task, synced to your dashboard",
        "circle-check",
    ),
    ("Text", "Plain paragraph", "type"),
    ("Heading 1", "Large section heading", "heading-1"),
    ("Heading 2", "Medium section heading", "heading-2"),
    ("Heading 3", "Small section heading", "heading-3"),
    (
        "Checklist",
        "Simple checkboxes (not tracked as tasks)",
        "check-square",
    ),
    (
        "Add checklist",
        "A checklist at the top of this task's notes (its items are not tasks)",
        "list-plus",
    ),
    ("Bulleted list", "Simple bulleted list", "list"),
    ("Numbered list", "List with numbering", "list-ordered"),
    (
        "Toggle",
        "Collapsible section with hidden content",
        "chevron-right",
    ),
    ("Table", "Rows and columns", "table"),
    ("Image", "Upload an image", "image"),
    ("File attachment", "Upload any file", "paperclip"),
    ("Link", "Link to a web page", "link-2"),
    (
        "Link to page",
        "Link another page (or type [[)",
        "file-symlink",
    ),
    ("Quote", "Capture a quotation", "quote"),
    (
        "Callout",
        "Highlighted block with an icon",
        "message-square-quote",
    ),
    ("Code block", "Code with syntax highlighting", "code-2"),
    ("Divider", "Horizontal line", "minus"),
];

/// A slash item's (description, icon), or empty strings for an unknown title.
pub fn slash_details(title: &str) -> (&'static str, &'static str) {
    SLASH_DETAILS
        .iter()
        .find(|d| d.0 == title)
        .map_or(("", ""), |d| (d.1, d.2))
}

/// Slash items for a query: title prefix first, then a word prefix in title or keywords, then a substring.
///
/// "Add checklist" is offered only next to a task (`task_near`: on a line in a task's notes or
/// just below a task), as today's menu does; `Editor::slash_items` passes the caret's context.
pub fn filter_slash(query: &str, task_near: bool) -> Vec<&'static str> {
    let q = query.trim().to_lowercase();
    let mut scored: Vec<(usize, usize, &str)> = SLASH_ITEMS
        .iter()
        .enumerate()
        .filter(|(_, (title, _))| task_near || *title != "Add checklist")
        .filter_map(|(n, (title, kw))| {
            let t = title.to_lowercase();
            let all = format!("{t} {}", kw.to_lowercase());
            let s = if q.is_empty() || t.starts_with(&q) {
                0
            } else if all.split_whitespace().any(|w| w.starts_with(&q)) {
                1
            } else if t.contains(&q) || kw.to_lowercase().contains(&q) {
                2
            } else {
                return None;
            };
            Some((s, n, *title))
        })
        .collect();
    scored.sort();
    scored.into_iter().map(|(_, _, t)| t).collect()
}

impl Editor {
    /// The suggestion menu that should be open at the caret, if any.
    pub fn suggestion(&self) -> Option<Suggestion> {
        let pos = self.sel.head()?;
        if !self.sel.is_empty() {
            return None;
        }
        let r = self.resolve(pos);
        let parent = r.parent(&self.doc);
        if !parent.is_textblock() || parent.is("codeBlock") {
            return None;
        }
        // The text of the line up to the caret (inline atoms end a query).
        let mut text = String::new();
        let mut p = 0;
        for c in &parent.content {
            if p >= r.parent_offset {
                break;
            }
            if c.is_text() {
                let take = (r.parent_offset - p).min(c.node_size());
                text.push_str(&c.text[..crate::node::byte_at(&c.text, take)]);
            } else {
                text.clear();
            }
            p += c.node_size();
        }
        let line_start = pos - u16_len(&text);
        let found = [
            ("[[", Trigger::PageLink, true, true),
            ("/", Trigger::Slash, false, false),
            ("@", Trigger::Mention, false, false),
        ]
        .into_iter()
        .filter_map(|(ch, trig, spaces, any_prefix)| {
            let at = text.rfind(ch)?;
            let query = &text[at + ch.len()..];
            if !spaces && query.contains(char::is_whitespace) {
                return None;
            }
            let prefix_ok = any_prefix || at == 0 || text[..at].ends_with(char::is_whitespace);
            if !prefix_ok {
                return None;
            }
            Some((at, ch, trig, query.to_string()))
        })
        .max_by_key(|(at, ..)| *at)?;
        let (at, ch, trigger, query) = found;
        let from = line_start + u16_len(&text[..at]);
        if self.dismissed == Some(from) {
            return None;
        }
        let _ = ch;
        Some(Suggestion {
            trigger,
            from,
            to: pos,
            query,
        })
    }

    /// The items of the open slash menu, in menu order (empty when none is open): what
    /// `filter_slash` offers for its query at the caret.
    pub fn slash_items(&self) -> Vec<&'static str> {
        match self.suggestion().filter(|s| s.trigger == Trigger::Slash) {
            Some(s) => filter_slash(&s.query, self.task_near(s.from).is_some()),
            None => Vec::new(),
        }
    }

    /// The task a line belongs with, for "Add checklist" (taskChildren.ts `taskNear`): the
    /// innermost task whose notes `pos` is in, else the task just above its line. Its path.
    pub fn task_near(&self, pos: usize) -> Option<Vec<usize>> {
        let r = self.resolve(pos);
        if let Some(d) = r.find(&self.doc, |n| n.is(crate::tasks::TASK)) {
            return Some(r.path_to(d));
        }
        let d = r.depth();
        if d < 1 {
            return None;
        }
        let i = r.index_at(d - 1);
        let parent = r.path_to(d - 1);
        let prev = i.checked_sub(1)?;
        self.doc.at(&parent).content[prev]
            .is(crate::tasks::TASK)
            .then(|| [parent, vec![prev]].concat())
    }

    /// "Add checklist": an empty plain checklist at the top of the task's notes, caret in it
    /// (taskChildren.ts `addChecklistToTask`). The line typed on goes when it's now empty and
    /// sits just below the task or right in its notes.
    fn add_checklist(&mut self, at: usize) -> bool {
        let Some(task) = self.task_near(at) else {
            return false;
        };
        let r = self.resolve(at);
        let d = r.depth();
        let line = r.path_to(d);
        let (lp, li) = line.split_at(d - 1);
        let beside = lp == task.as_slice() || (li[0] > 0 && [lp, &[li[0] - 1]].concat() == task);
        let empty_para =
            r.parent(&self.doc).is("paragraph") && r.parent(&self.doc).content.is_empty();
        if beside && empty_para {
            self.doc.at_mut(lp).content.remove(li[0]);
        }
        let item = Node::el("taskItem", vec![Node::el("paragraph", vec![])]);
        self.doc
            .at_mut(&task)
            .content
            .insert(0, Node::el("taskList", vec![item]));
        let before = crate::tasks::pos_of_path(&self.doc, &task);
        self.sel = Selection::caret(before + 4);
        true
    }

    /// The highlighted item of the open slash menu (an index into `slash_items()`), or
    /// None when no slash menu is open or nothing matches.
    pub fn slash_highlight(&self) -> Option<usize> {
        let s = self.suggestion().filter(|s| s.trigger == Trigger::Slash)?;
        let n = self.slash_items().len();
        if n == 0 {
            return None;
        }
        Some(match &self.highlight {
            Some((from, q, i)) if *from == s.from && *q == s.query => (*i).min(n - 1),
            _ => 0,
        })
    }

    /// Move the slash menu's highlight by `delta` items, wrapping (ArrowDown is 1, ArrowUp -1).
    pub fn move_slash_highlight(&mut self, delta: i64) -> bool {
        let Some(i) = self.slash_highlight() else {
            return false;
        };
        let Some(s) = self.suggestion() else {
            return false;
        };
        let n = self.slash_items().len() as i64;
        let j = (i as i64 + delta).rem_euclid(n) as usize;
        self.highlight = Some((s.from, s.query, j));
        true
    }

    /// Run the highlighted slash item (Enter, Tab, a tap on the highlighted row).
    pub fn pick_highlighted_slash(&mut self) -> bool {
        let Some(i) = self.slash_highlight() else {
            return false;
        };
        let title = self.slash_items()[i];
        self.pick_slash(title)
    }

    /// Escape on an open menu: it stays closed for this trigger.
    pub fn dismiss_suggestion(&mut self) -> bool {
        match self.suggestion() {
            Some(s) => {
                self.dismissed = Some(s.from);
                true
            }
            None => false,
        }
    }

    /// Run a slash item on the suggestion's range.
    pub fn pick_slash(&mut self, title: &str) -> bool {
        let Some(s) = self.suggestion().filter(|s| s.trigger == Trigger::Slash) else {
            return false;
        };
        if title == "Add checklist" && self.task_near(s.from).is_none() {
            return false;
        }
        self.delete_range(s.from, s.to);
        self.sel = Selection::caret(s.from);
        match title {
            "Add checklist" => self.add_checklist(s.from),
            "Task" => self.insert_task(""),
            "Text" => self.set_block_type("paragraph", Attrs::new()),
            "Heading 1" | "Heading 2" | "Heading 3" => {
                let mut a = Attrs::new();
                a.insert("level".into(), json!(title[8..].parse::<u64>().unwrap()));
                self.set_block_type("heading", a)
            }
            "Checklist" => self.toggle_list("taskList"),
            "Bulleted list" => self.toggle_list("bulletList"),
            "Numbered list" => self.toggle_list("orderedList"),
            "Toggle" => self.set_details(),
            "Table" => self.insert_table(3, 3, true),
            "Link to page" => {
                self.insert_text("[[");
                true
            }
            "Quote" => self.toggle_wrap("blockquote"),
            "Callout" => self.wrap_block_in("callout"),
            "Code block" => self.toggle_code_block(),
            "Divider" => self.insert_block(Node::el("horizontalRule", vec![])),
            _ => false,
        }
    }

    /// Replace a `[[query` with a link to a page, followed by a space.
    pub fn pick_page(&mut self, page_id: &str) -> bool {
        let Some(s) = self.suggestion().filter(|s| s.trigger == Trigger::PageLink) else {
            return false;
        };
        self.delete_range(s.from, s.to);
        self.sel = Selection::caret(s.from);
        self.insert_page_link(page_id);
        self.insert_plain(" ");
        true
    }

    /// Replace an `@query` with a mention, followed by a space.
    pub fn pick_mention(&mut self, id: &str, label: &str) -> bool {
        let Some(s) = self.suggestion().filter(|s| s.trigger == Trigger::Mention) else {
            return false;
        };
        self.delete_range(s.from, s.to);
        self.sel = Selection::caret(s.from);
        self.insert_mention(id, label);
        self.insert_plain(" ");
        true
    }

    pub fn insert_page_link(&mut self, page_id: &str) -> bool {
        let mut a = Attrs::new();
        a.insert("pageId".into(), json!(page_id));
        self.insert_inline(Node::new("pageLink", a, vec![]));
        true
    }

    pub fn insert_mention(&mut self, id: &str, label: &str) -> bool {
        let mut a = Attrs::new();
        a.insert("id".into(), json!(id));
        a.insert("label".into(), json!(label));
        self.insert_inline(Node::new("mention", a, vec![]));
        true
    }
}
