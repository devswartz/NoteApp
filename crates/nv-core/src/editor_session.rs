//! Editor sessions (docs/rewrite/EDITOR.md): one text box of a page open for editing, over the
//! `nv-editor` engine. The native view sends input (text, key chords, commands, IME
//! composition, clipboard) and draws what `state()` returns: the box's tree as ProseMirror-style
//! JSON, the selection, the open suggestion menu, the marked text and other people's carets.
//! Edits are written into the session's yrs doc of the page, so they sync: send
//! `encode_update_since(their_state_vector)` to the server, and feed other people's updates to
//! `apply_update`.
//!
//! Owned by the editor stream; core owns `lib.rs`, which has `mod editor_session;` and
//! `pub use editor_session::*;` for it.

use std::sync::{Arc, Mutex};

use nv_editor::bind::Clock;
use nv_editor::suggest::{filter_slash, Trigger};
use nv_editor::{Editor, Focus, Selection, TaskHost};
use nv_model::yrs::updates::decoder::Decode;
use nv_model::yrs::{ReadTxn, StateVector, Transact};

/// Why an editor call failed.
#[derive(Debug, Clone, PartialEq, uniffi::Error)]
pub enum EditorError {
    /// The bytes aren't a page document or update this core can read.
    InvalidPage { message: String },
    /// The page has no such box (`box:<id>` needs the box's geometry, or use `default`).
    NoSuchBox { field: String },
    /// A command name the engine doesn't know.
    UnknownCommand { name: String },
    /// A command's arguments aren't a JSON object.
    InvalidArgs { message: String },
}

impl std::fmt::Display for EditorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EditorError::InvalidPage { message } => write!(f, "invalid page: {message}"),
            EditorError::NoSuchBox { field } => write!(f, "no box {field} on the page"),
            EditorError::UnknownCommand { name } => write!(f, "unknown command {name}"),
            EditorError::InvalidArgs { message } => write!(f, "invalid arguments: {message}"),
        }
    }
}
impl std::error::Error for EditorError {}

fn invalid(e: impl std::fmt::Display) -> EditorError {
    EditorError::InvalidPage {
        message: e.to_string(),
    }
}

/// The task store behind a box's task lines, implemented by the app (over the core's task
/// calls). Called on the thread that called the session, with the session locked: don't call
/// back into the session from here.
#[uniffi::export(with_foreign)]
pub trait TaskCallbacks: Send + Sync {
    /// A new task id (tasks get their ids on the client).
    fn new_id(&self) -> String;
    fn create(&self, id: String, title: String, done: bool);
    fn delete(&self, id: String);
    /// Bring back a task this session deleted (undo put its line back). False if it can't.
    fn restore(&self, id: String) -> bool;
    /// The task's title, if the task exists.
    fn title(&self, id: String) -> Option<String>;
    fn set_title(&self, id: String, title: String);
}

struct Host(Arc<dyn TaskCallbacks>);

impl TaskHost for Host {
    fn new_id(&mut self) -> String {
        self.0.new_id()
    }
    fn create(&mut self, id: &str, title: &str, done: bool) {
        self.0.create(id.into(), title.into(), done)
    }
    fn delete(&mut self, id: &str) {
        self.0.delete(id.into())
    }
    fn restore(&mut self, id: &str) -> bool {
        self.0.restore(id.into())
    }
    fn title(&self, id: &str) -> Option<String> {
        self.0.title(id.into())
    }
    fn set_title(&mut self, id: &str, title: &str) {
        self.0.set_title(id.into(), title.into())
    }
}

/// What a copy or cut puts on the clipboard (or what a paste brings).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ClipboardData {
    pub html: String,
    pub text: String,
}

/// Positions count as ProseMirror does (one per character in UTF-16 units, one for each node
/// boundary), the same as `doc_json`'s tree.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum EditorSelection {
    /// A caret (`anchor == head`) or a range of text.
    Text { anchor: u32, head: u32 },
    /// One selected node (a task line, an image, a rule): `pos` is the position before it.
    Node { pos: u32 },
    /// Everything in the box.
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SuggestionTrigger {
    /// `/`: the engine's own items (`slash_items`); pick with command `pickSlash {title}`.
    Slash,
    /// `[[`: pages from the core; pick with `pickPage {pageId}`.
    PageLink,
    /// `@`: people; pick with `pickMention {id, label}`.
    Mention,
}

/// An open suggestion menu at the caret.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct EditorSuggestion {
    pub trigger: SuggestionTrigger,
    pub query: String,
    /// The range a pick replaces (the trigger characters and the query).
    pub from: u32,
    pub to: u32,
    /// For `/`: the matching items, in menu order.
    pub slash_items: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct TextRange {
    pub from: u32,
    pub to: u32,
}

/// Someone else's caret or selection in this box.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RemoteCursor {
    pub user_id: String,
    pub anchor: u32,
    pub head: u32,
}

/// What to draw.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct EditorState {
    /// The box's tree as ProseMirror JSON (`{"type":"doc","content":[...]}`).
    pub doc_json: String,
    pub selection: EditorSelection,
    /// The task line whose title has the keyboard, when not the box's text.
    pub focus_task_id: Option<String>,
    pub suggestion: Option<EditorSuggestion>,
    /// The IME's marked text, while composing (draw it underlined).
    pub composing: Option<TextRange>,
    pub remote_cursors: Vec<RemoteCursor>,
}

fn pos(p: usize) -> u32 {
    p.min(u32::MAX as usize) as u32
}

/// One text box of a page, open for editing.
#[derive(uniffi::Object)]
pub struct EditorSession {
    editor: Mutex<Editor>,
}

impl EditorSession {
    fn with<R>(&self, f: impl FnOnce(&mut Editor) -> R) -> R {
        let mut ed = self.editor.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut ed)
    }

    /// Run a local edit: an open composition is committed first, and the result is written.
    fn edit<R>(&self, f: impl FnOnce(&mut Editor) -> R) -> R {
        self.with(|ed| {
            ed.end_composition();
            let r = f(ed);
            ed.finish();
            r
        })
    }
}

#[uniffi::export]
impl EditorSession {
    /// Open `field` (`box:<id>`, or `default` on an old single-column page) of a page document
    /// (a full Yjs update). Opening adds the trailing paragraph if the box lacks one: send
    /// `encode_update_since` afterwards like any edit.
    #[uniffi::constructor]
    pub fn open(
        update: Vec<u8>,
        field: String,
        tasks: Arc<dyn TaskCallbacks>,
    ) -> Result<Arc<EditorSession>, EditorError> {
        let doc = nv_model::doc_from_update(&update).map_err(invalid)?;
        if field != "default" {
            let page = nv_model::Page::read(&doc);
            let known = field
                .strip_prefix("box:")
                .is_some_and(|id| page.boxes.iter().any(|b| b.id == id));
            if !known {
                return Err(EditorError::NoSuchBox { field });
            }
        }
        let ed = Editor::open(doc, &field, Box::new(Host(tasks)), Clock::default());
        Ok(Arc::new(EditorSession {
            editor: Mutex::new(ed),
        }))
    }

    /// Typed text (runs input rules). While composing, it replaces the marked text (as an IME
    /// commit does).
    pub fn insert_text(&self, text: String) {
        self.with(|ed| {
            if ed.is_composing() {
                ed.commit_composition(&text);
            } else {
                ed.insert_text(&text);
            }
            ed.finish();
        })
    }

    /// A key chord (`Enter`, `Shift+Tab`, `Mod+b`, ...). False when the engine didn't use it
    /// (the view's: Tab to the next box, say).
    pub fn key(&self, chord: String) -> bool {
        self.edit(|ed| ed.key(&chord))
    }

    /// A command by name, with its arguments as a JSON object (`""` for none). The names are
    /// the editor suite's (`toggleMark {mark}`, `setHeading {level}`, `insertTask {title}`, ...)
    /// plus the views' (`pickSlash`, `pickPage`, `pickMention`, `focusTitle {id}`, ...);
    /// see `nv_editor::command`.
    pub fn command(&self, name: String, args_json: String) -> Result<bool, EditorError> {
        let args: serde_json::Value = if args_json.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&args_json).map_err(|e| EditorError::InvalidArgs {
                message: e.to_string(),
            })?
        };
        if !args.is_object() {
            return Err(EditorError::InvalidArgs {
                message: "not a JSON object".into(),
            });
        }
        self.edit(|ed| ed.command(&name, &args))
            .map_err(|_| EditorError::UnknownCommand { name })
    }

    /// Paste what the clipboard holds (HTML preferred, then plain text).
    pub fn paste(&self, html: String, text: String) -> bool {
        self.edit(|ed| ed.paste(&nv_editor::clipboard::Clipboard { html, text }))
    }

    pub fn copy(&self) -> ClipboardData {
        self.with(|ed| {
            ed.end_composition();
            let c = ed.copy();
            ClipboardData {
                html: c.html,
                text: c.text,
            }
        })
    }

    /// Copy, then delete the selection (task lines keep their tasks).
    pub fn cut(&self) -> ClipboardData {
        let c = self.edit(|ed| ed.cut());
        ClipboardData {
            html: c.html,
            text: c.text,
        }
    }

    /// Undo this session's newest change (others' changes aren't undone). False when the box
    /// isn't bound (never for a session).
    pub fn undo(&self) -> bool {
        self.with(|ed| ed.undo())
    }

    pub fn redo(&self) -> bool {
        self.with(|ed| ed.redo())
    }

    /// Put the caret or a text selection in the box's text (positions are clamped).
    pub fn set_selection(&self, anchor: u32, head: u32) {
        self.with(|ed| {
            ed.end_composition();
            let size = ed.doc.content_size();
            ed.sel = Selection::text((anchor as usize).min(size), (head as usize).min(size));
            ed.stored_marks = None;
            ed.focus = Focus::Doc;
        })
    }

    /// Select one node (a task line, an image, a rule) at `pos`, the position before it.
    pub fn select_node(&self, pos: u32) {
        self.with(|ed| {
            ed.end_composition();
            let p = (pos as usize).min(ed.doc.content_size());
            ed.sel = if nv_editor::editor::node_after(&ed.doc, p).is_some() {
                Selection::Node { pos: p }
            } else {
                Selection::caret(nv_editor::editor::near_text(&ed.doc, p, 1))
            };
            ed.stored_marks = None;
            ed.focus = Focus::Doc;
        })
    }

    /// The IME's marked text, replacing the selection the composition started on; `sel_start`
    /// and `sel_end` are the selection inside it (UTF-16 offsets). Nothing is written to the
    /// page until `commit_composition`.
    pub fn set_composition(&self, text: String, sel_start: u32, sel_end: u32) {
        self.with(|ed| ed.set_composition(&text, Some((sel_start as usize, sel_end as usize))))
    }

    /// End the composition with its final text: typed once (one change to the page).
    pub fn commit_composition(&self, text: String) {
        self.with(|ed| {
            ed.commit_composition(&text);
            ed.finish();
        })
    }

    /// End the composition with the marked text as it stands (`unmarkText`,
    /// `finishComposingText`, `CompositionCompleted`, losing focus).
    pub fn finish_composition(&self) {
        self.with(|ed| ed.end_composition())
    }

    /// End the composition without typing: the marked text (and the selection it replaced) go.
    pub fn cancel_composition(&self) {
        self.with(|ed| {
            ed.cancel_composition();
            ed.finish();
        })
    }

    /// Replace `from..to` (positions) with `text` without moving the selection there first:
    /// autocorrect, spell-check and dictation results. Keeps the marks of the replaced text, runs
    /// no input rules, is one undo step; the selection is mapped past it. In a task title,
    /// `from..to` are offsets in the title. False when the range isn't in text.
    pub fn replace_range(&self, from: u32, to: u32, text: String) -> bool {
        self.edit(|ed| ed.replace_range(from as usize, to as usize, &text))
    }

    /// The box's text as the platform's text input sees it: one string, a line per text block
    /// (joined by line feeds), U+FFFC for nodes without text. Offsets in it are UTF-16 units; map them
    /// with `view_offset_to_pos` and `pos_to_view_offset` (EDITOR.md 10).
    pub fn text_for_view(&self) -> String {
        self.with(|ed| ed.text_for_view().text)
    }

    pub fn view_offset_to_pos(&self, offset: u32) -> u32 {
        self.with(|ed| pos(ed.view_offset_to_pos(offset as usize)))
    }

    pub fn pos_to_view_offset(&self, pos_: u32) -> u32 {
        self.with(|ed| pos(ed.pos_to_view_offset(pos_ as usize)))
    }

    /// What to draw now.
    pub fn state(&self) -> EditorState {
        self.with(|ed| {
            let selection = match ed.sel {
                Selection::Text { anchor, head } => EditorSelection::Text {
                    anchor: pos(anchor),
                    head: pos(head),
                },
                Selection::Node { pos: p } => EditorSelection::Node { pos: pos(p) },
                Selection::All => EditorSelection::All,
            };
            let suggestion = ed.suggestion().map(|s| EditorSuggestion {
                trigger: match s.trigger {
                    Trigger::Slash => SuggestionTrigger::Slash,
                    Trigger::PageLink => SuggestionTrigger::PageLink,
                    Trigger::Mention => SuggestionTrigger::Mention,
                },
                slash_items: if s.trigger == Trigger::Slash {
                    filter_slash(&s.query)
                        .into_iter()
                        .map(String::from)
                        .collect()
                } else {
                    Vec::new()
                },
                query: s.query,
                from: pos(s.from),
                to: pos(s.to),
            });
            EditorState {
                doc_json: ed.doc.to_json().to_string(),
                selection,
                focus_task_id: match &ed.focus {
                    Focus::Doc => None,
                    Focus::TaskTitle(id) => Some(id.clone()),
                },
                suggestion,
                composing: ed.composition.as_ref().map(|c| TextRange {
                    from: pos(c.from),
                    to: pos(c.to),
                }),
                remote_cursors: remote_cursors(ed),
            }
        })
    }

    /// Apply someone else's change (a Yjs update for the page). The selection and remote
    /// cursors follow the text they were in; an open composition stays open.
    pub fn apply_update(&self, update: Vec<u8>) -> Result<(), EditorError> {
        self.with(|ed| ed.apply_update(&update)).map_err(invalid)
    }

    /// The page doc's state vector (for a peer to answer with what this session lacks).
    pub fn state_vector(&self) -> Vec<u8> {
        self.with(|ed| match &ed.binding {
            Some(b) => {
                use nv_model::yrs::updates::encoder::Encode;
                b.doc.transact().state_vector().encode_v1()
            }
            None => Vec::new(),
        })
    }

    /// What this session has that a peer with `state_vector` lacks (empty bytes: everything),
    /// as a Yjs update: the local edits to send.
    pub fn encode_update_since(&self, state_vector: Vec<u8>) -> Result<Vec<u8>, EditorError> {
        let sv = if state_vector.is_empty() {
            StateVector::default()
        } else {
            StateVector::decode_v1(&state_vector).map_err(invalid)?
        };
        Ok(self.with(|ed| match &ed.binding {
            Some(b) => b.doc.transact().encode_state_as_update_v1(&sv),
            None => Vec::new(),
        }))
    }

    /// Set the other people's carets to show in this box (positions are clamped). They are
    /// carried across remote changes until set again.
    pub fn set_remote_cursors(&self, cursors: Vec<RemoteCursor>) {
        self.with(|ed| {
            ed.set_remote_cursors(
                cursors
                    .into_iter()
                    .map(|c| nv_editor::remote::RemoteCursor {
                        user_id: c.user_id,
                        anchor: c.anchor as usize,
                        head: c.head as usize,
                    })
                    .collect(),
            )
        })
    }

    pub fn remote_cursors(&self) -> Vec<RemoteCursor> {
        self.with(|ed| remote_cursors(ed))
    }
}

fn remote_cursors(ed: &Editor) -> Vec<RemoteCursor> {
    ed.remote_cursors
        .iter()
        .map(|c| RemoteCursor {
            user_id: c.user_id.clone(),
            anchor: pos(c.anchor),
            head: pos(c.head),
        })
        .collect()
}
