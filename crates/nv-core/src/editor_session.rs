//! Editor sessions (docs/rewrite/EDITOR.md): one text box of a page open for editing, over the
//! `nv-editor` engine. The native view sends input (text, key chords, commands, IME
//! composition, clipboard) and draws what `state()` returns: the box's tree as ProseMirror-style
//! JSON, the selection, the open suggestion menu, the marked text and other people's carets.
//! Edits are written into the session's yrs doc of the page, so they sync.
//!
//! - `open_live(page, field, tasks)` opens a box of a `LivePage`: the session's edits go into the
//!   live page (and so to the server and the store) and others' changes on the live page reach
//!   the session, with no bytes through the app. The view redraws when the live page's listener
//!   says it changed (`on_change`), or whenever `revision()` moves.
//! - `open(update, field, tasks)` opens a box of a page document the app keeps in sync itself:
//!   send `encode_update_since(their_state_vector)` to the server, and feed other people's
//!   updates to `apply_update`.
//!
//! A native view draws one frame from one call, `view_render()` (EDITOR.md 10.1).
//!
//! Owned by the editor stream; core owns `lib.rs`, which has `mod editor_session;` and
//! `pub use editor_session::*;` for it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use nv_editor::bind::{Clock, REMOTE};
use nv_editor::input::ViewText;
use nv_editor::suggest::{slash_details, Trigger};
use nv_editor::{Editor, Focus, Node, Selection, TaskHost};
use nv_model::yrs::updates::decoder::Decode;
use nv_model::yrs::{Doc, Origin, ReadTxn, StateVector, Transact, Update};

use crate::LivePage;

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

/// A row of the slash menu.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SuggestionItem {
    /// What `pickSlash {title}` takes (the item's title).
    pub id: String,
    pub label: String,
    pub description: String,
    /// Today's icon, by its Lucide name (`heading-1`, `list-ordered`, ...): the view maps it to
    /// its own symbols.
    pub icon: String,
}

/// An open suggestion menu at the caret.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct EditorSuggestion {
    pub trigger: SuggestionTrigger,
    pub query: String,
    /// The range a pick replaces (the trigger characters and the query), as positions.
    pub from: u32,
    pub to: u32,
    /// The same range as offsets in `text_for_view()`: anchor the popup at `view_from`'s rect.
    pub view_from: u32,
    pub view_to: u32,
    /// For `/`: the matching items' titles, in menu order.
    pub slash_items: Vec<String>,
    /// For `/`: the matching items, in menu order.
    pub items: Vec<SuggestionItem>,
    /// For `/`: the highlighted row (an index into `items`); ArrowUp / ArrowDown move it and
    /// Enter / Tab pick it (through `key`), or `move_suggestion_highlight` and
    /// `pick_suggestion`. For `[[` and `@` the view lists pages or people and keeps its own
    /// highlight. None when nothing matches.
    pub highlighted: Option<u32>,
}

/// A range or selection as offsets in `text_for_view()` (UTF-16 units).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct ViewRange {
    pub anchor: u32,
    pub head: u32,
}

/// One line of `text_for_view()`: where it is, and what to draw it as.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ViewLine {
    /// Where the line starts in the view's string, and its length (UTF-16 units, no line feed).
    pub offset: u32,
    pub len: u32,
    /// For a text line, the position where its block's content starts; for an object line
    /// (one U+FFFC), the position before its node.
    pub pos: u32,
    /// False for an object line (a rule, an image, a task's title line).
    pub is_text: bool,
    /// The block's node type (`paragraph`, `heading`, `codeBlock`, `horizontalRule`,
    /// `image`, `taskRef`, ...).
    pub kind: String,
    /// A heading's level, 0 otherwise.
    pub level: u8,
    /// The nodes the line sits in, from the box down (`bulletList`, `listItem`, `blockquote`,
    /// `callout`, `taskRef` for a task's notes, ...): indentation, quote bars, list depth.
    pub containers: Vec<String>,
    /// On a list item's first line: a bullet, or the item's number as exports write it (`1.`).
    pub marker: Option<String>,
    /// On a checklist item's first line: whether it is ticked.
    pub checked: Option<bool>,
    /// On a task's title line: the task's id (its title comes from the task list).
    pub task_id: Option<String>,
    /// A text line's formatting. The runs cover the line's text contiguously and in order
    /// (unmarked stretches are runs with empty `marks`; an empty line has no runs). Empty on
    /// object lines. Changes only with `text_revision`.
    pub runs: Vec<ViewRun>,
    /// The inline atoms (one U+FFFC each) of a text line. Empty on object lines.
    pub atoms: Vec<ViewAtom>,
    /// On an object line (rule, image, file attachment, task reference, ...): the node's
    /// attributes as a JSON object. None on text lines.
    pub attrs_json: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ViewMarkKind {
    Bold,
    Italic,
    Underline,
    Strike,
    Code,
    Link,
    TextColor,
    Highlight,
    Comment,
    Unknown,
}

/// One mark. `value`: the href of a link; the colour name of a text colour or highlight (None
/// on a highlight: the default one); the thread id of a comment; the mark's name for
/// `Unknown`. Marks of one kind can overlap (several comments): all appear.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ViewMark {
    pub kind: ViewMarkKind,
    pub value: Option<String>,
}

/// A stretch of a line's text with one set of marks. `from` and `len` are UTF-16 units,
/// relative to the line's start. An atom (U+FFFC) in the line is covered too, with its own
/// marks.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ViewRun {
    pub from: u32,
    pub len: u32,
    pub marks: Vec<ViewMark>,
}

/// An inline atom in a text line. "Is me" for a mention and "missing" for a page link are the
/// app's to decide (it knows its user id and its page tree).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ViewAtom {
    /// Line-relative UTF-16 offset of the atom's U+FFFC.
    pub offset: u32,
    /// The node type: `mention`, `pageLink`, `image`, ...
    pub kind: String,
    /// A mention's label; a page link's title if the node stores one, else its page id; an
    /// image's alt text; otherwise the kind.
    pub label: String,
    /// The node's attributes as a JSON object (`id`/`label` of a mention, `pageId`, ...).
    pub attrs_json: String,
}

/// What is on at the selection, for a ribbon's pressed states.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ViewActive {
    /// A caret: the stored marks (a toggle waiting for the next typed text) if any, else the
    /// marks before the caret. A range: the marks present on all its text.
    pub marks: Vec<ViewMark>,
    /// The node type of the selection's block (`paragraph`, `heading`, `codeBlock`, ...; the
    /// selected node's type for a node selection).
    pub block: String,
    /// The heading's level, 0 when the block is not a heading.
    pub heading_level: u8,
    /// The innermost list around the block: `bulletList`, `orderedList` or `taskList`.
    pub list: Option<String>,
    pub in_quote: bool,
    pub in_code: bool,
}

/// The marked text while composing, as offsets in `text_for_view()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct ViewMarked {
    /// `markedTextRange`.
    pub from: u32,
    pub to: u32,
    /// The selection inside it (absolute offsets, within `from..=to`).
    pub sel_from: u32,
    pub sel_to: u32,
}

/// The box as the platform's text input and layout see it (EDITOR.md 10.1).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ViewState {
    /// `text_for_view()`: a line per block, joined by line feeds; U+FFFC for atoms and object
    /// lines.
    pub text: String,
    /// Its length in UTF-16 units.
    pub len: u32,
    pub lines: Vec<ViewLine>,
    /// `selectedTextRange`: the selection as offsets (a node selection is its U+FFFC,
    /// select-all is `0..len`).
    pub selection: ViewRange,
    pub marked: Option<ViewMarked>,
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
    /// For the view's `UndoManager` (`canUndo`, `canRedo`) and the undo buttons.
    pub can_undo: bool,
    pub can_redo: bool,
}

fn pos(p: usize) -> u32 {
    p.min(u32::MAX as usize) as u32
}

/// Someone else's caret in this box, as offsets in the view's text.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ViewCursor {
    pub user_id: String,
    pub anchor: u32,
    pub head: u32,
}

/// Everything a native view needs for one frame, in view offsets (EDITOR.md 10.1): one call
/// per redraw. Skip the work when `revision` hasn't moved since the last frame, and the text
/// layout when `text_revision` hasn't.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ViewRender {
    /// `revision()` when this was read.
    pub revision: u64,
    /// Moves only when `text` or `lines` changed (relayout); a selection move doesn't move it.
    pub text_revision: u64,
    /// The text, its length (UTF-16 units), the line table, the selection and the marked text,
    /// as `view_state()` gives them.
    pub view: ViewState,
    /// The open suggestion menu (`view_from` / `view_to` anchor the popup).
    pub suggestion: Option<EditorSuggestion>,
    /// The task line whose title has the keyboard, when not the box's text.
    pub focus_task_id: Option<String>,
    pub remote_cursors: Vec<ViewCursor>,
    pub can_undo: bool,
    pub can_redo: bool,
    /// Marks and block type at the selection. Moves with `revision`, not `text_revision`
    /// (a caret move or a stored-mark toggle changes it with no text change).
    pub active: ViewActive,
}

fn origin_is(txn: &nv_model::yrs::TransactionMut, name: &[u8]) -> bool {
    txn.origin().map(|o| o.as_ref()) == Some(name)
}

fn locked<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The bridge between the session's doc and a live page's doc. Others' changes on the page are
/// queued by an observer (on whatever thread made them, the sync thread mostly) and merged into
/// the editor at the start of the next session call; the session's own writes are queued by an
/// observer on its doc and written into the page at the end of the call. Each side skips what
/// came from the other, so nothing echoes.
struct Live {
    page: Doc,
    doc: Doc,
    /// The observers' key, and the origin of the session's writes into the page
    /// (`nv-editor-live:<n>`, one per session: other sessions on the page take them as others'
    /// changes; nv-sync sends them like any local edit).
    key: Origin,
    inbox: Arc<Mutex<Vec<Vec<u8>>>>,
    outbox: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl Live {
    fn start(page: Doc, doc: Doc) -> Result<Live, EditorError> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let key = Origin::from(
            format!("nv-editor-live:{}", NEXT.fetch_add(1, Ordering::Relaxed)).as_str(),
        );
        let inbox: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
        let outbox: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
        {
            let (inbox, mine) = (inbox.clone(), key.clone());
            page.observe_update_v1(key.clone(), move |txn, e| {
                if !origin_is(txn, mine.as_ref()) {
                    locked(&inbox).push(e.update.clone());
                }
            })
            .map_err(invalid)?;
        }
        {
            let outbox = outbox.clone();
            let observed = doc.observe_update_v1(key.clone(), move |txn, e| {
                if !origin_is(txn, REMOTE.as_bytes()) {
                    locked(&outbox).push(e.update.clone());
                }
            });
            if let Err(e) = observed {
                let _ = page.unobserve_update_v1(key.clone());
                return Err(invalid(e));
            }
        }
        Ok(Live {
            page,
            doc,
            key,
            inbox,
            outbox,
        })
    }

    /// Others' changes since the last call, as one update.
    fn take_inbox(&self) -> Option<Vec<u8>> {
        let updates = std::mem::take(&mut *locked(&self.inbox));
        match updates.len() {
            0 => None,
            1 => updates.into_iter().next(),
            _ => nv_model::yrs::merge_updates_v1(&updates).ok(),
        }
    }

    /// Write the session's new changes into the page.
    fn flush(&self) {
        let updates = std::mem::take(&mut *locked(&self.outbox));
        if updates.is_empty() {
            return;
        }
        let mut txn = self.page.transact_mut_with(self.key.clone());
        for u in updates {
            if let Ok(u) = Update::decode_v1(&u) {
                let _ = txn.apply_update(u);
            }
        }
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        let _ = self.page.unobserve_update_v1(self.key.clone());
        let _ = self.doc.unobserve_update_v1(self.key.clone());
    }
}

struct Inner {
    ed: Editor,
    live: Option<Live>,
    revision: u64,
    text_revision: u64,
    /// The last view text, the tree it was built from, and the revision it was checked at.
    view: Option<(u64, Node, Arc<ViewText>)>,
}

impl Inner {
    /// Others' changes on the live page, into the editor.
    fn pull(&mut self) {
        if let Some(update) = self.live.as_ref().and_then(Live::take_inbox) {
            let _ = self.ed.apply_update(&update);
            self.revision += 1;
        }
    }

    /// The view text, built again only when the tree changed.
    fn view(&mut self) -> Arc<ViewText> {
        if let Some((rev, tree, v)) = &mut self.view {
            if *rev == self.revision {
                return v.clone();
            }
            if *tree == self.ed.doc {
                *rev = self.revision;
                return v.clone();
            }
        }
        let v = Arc::new(self.ed.text_for_view());
        if self.view.as_ref().is_none_or(|(_, _, old)| **old != *v) {
            self.text_revision += 1;
        }
        self.view = Some((self.revision, self.ed.doc.clone(), v.clone()));
        v
    }
}

/// One text box of a page, open for editing.
#[derive(uniffi::Object)]
pub struct EditorSession {
    inner: Mutex<Inner>,
}

impl EditorSession {
    fn new(ed: Editor, live: Option<Live>) -> Arc<EditorSession> {
        let inner = Inner {
            ed,
            live,
            revision: 1,
            text_revision: 0,
            view: None,
        };
        if let Some(l) = &inner.live {
            l.flush();
        }
        Arc::new(EditorSession {
            inner: Mutex::new(inner),
        })
    }

    /// The session, with others' changes on a live page brought in.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        let mut inner = locked(&self.inner);
        inner.pull();
        inner
    }

    /// A call that only reads.
    fn read<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> R {
        f(&mut self.lock())
    }

    /// A call that may change something: the revision moves, and a live page gets the edits.
    fn with<R>(&self, f: impl FnOnce(&mut Editor) -> R) -> R {
        let mut inner = self.lock();
        let r = f(&mut inner.ed);
        inner.revision += 1;
        if let Some(l) = &inner.live {
            l.flush();
        }
        r
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

fn check_field(doc: &Doc, field: &str) -> Result<(), EditorError> {
    if field != "default" {
        let page = nv_model::Page::read(doc);
        let known = field
            .strip_prefix("box:")
            .is_some_and(|id| page.boxes.iter().any(|b| b.id == id));
        if !known {
            return Err(EditorError::NoSuchBox {
                field: field.into(),
            });
        }
    }
    Ok(())
}

impl EditorSession {
    /// `open` with the clock undo groups by (`Clock::manual()` in tests; `open` uses the
    /// monotonic clock). Not in the foreign API.
    pub fn open_with_clock(
        update: Vec<u8>,
        field: String,
        tasks: Arc<dyn TaskCallbacks>,
        clock: Clock,
    ) -> Result<Arc<EditorSession>, EditorError> {
        let doc = nv_model::doc_from_update(&update).map_err(invalid)?;
        check_field(&doc, &field)?;
        let ed = Editor::open(doc, &field, Box::new(Host(tasks)), clock);
        Ok(EditorSession::new(ed, None))
    }

    /// `open_live` with the clock undo groups by. Not in the foreign API.
    pub fn open_live_with_clock(
        page: &LivePage,
        field: String,
        tasks: Arc<dyn TaskCallbacks>,
        clock: Clock,
    ) -> Result<Arc<EditorSession>, EditorError> {
        let page = page.doc().clone();
        // The session works on its own copy of the page, so the engine's tree never moves under
        // it mid-call: others' changes come in at its calls. Observe first, then copy: a change
        // in between is in both, and applying it twice changes nothing.
        let doc = nv_model::new_doc();
        let live = Live::start(page.clone(), doc.clone())?;
        let full = page
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let u = Update::decode_v1(&full).map_err(invalid)?;
        doc.transact_mut_with(REMOTE)
            .apply_update(u)
            .map_err(invalid)?;
        check_field(&doc, &field)?;
        let ed = Editor::open(doc, &field, Box::new(Host(tasks)), clock);
        Ok(EditorSession::new(ed, Some(live)))
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
        EditorSession::open_with_clock(update, field, tasks, Clock::default())
    }

    /// Open `field` of a page open live (`Core::open_live_page`), once the box is there (after
    /// `Synced`, or a stored copy). The session's edits go into the live page as they are made,
    /// so they are sent and kept like `LivePage::apply_update`'s, and others' changes on the
    /// live page come into the session at its next call (the selection follows its text): on
    /// the live page's `on_change`, redraw from `view_render()`. No `apply_update` or
    /// `encode_update_since` round trips. Undo takes back only this session's edits. Other
    /// sessions on the page take this one's edits as others' changes, and the other way round.
    #[uniffi::constructor]
    pub fn open_live(
        page: Arc<LivePage>,
        field: String,
        tasks: Arc<dyn TaskCallbacks>,
    ) -> Result<Arc<EditorSession>, EditorError> {
        EditorSession::open_live_with_clock(&page, field, tasks, Clock::default())
    }

    /// Moves whenever something to draw may have changed: a call that edits, moves the
    /// selection or composes, or others' changes arriving on a live page. Cheap: a view polls
    /// it, or compares `view_render().revision`, and skips the frame when it hasn't moved.
    pub fn revision(&self) -> u64 {
        self.read(|i| i.revision)
    }

    /// One frame: text, line table, selection, marked text, suggestion menu, remote carets and
    /// undo state, all in view offsets (EDITOR.md 10.1). The line table is built again only
    /// when the text changed (`text_revision`).
    pub fn view_render(&self) -> ViewRender {
        self.read(|i| {
            let v = i.view();
            let ed = &i.ed;
            ViewRender {
                revision: i.revision,
                text_revision: i.text_revision,
                view: view_state(ed, &v),
                suggestion: suggestion(ed, &v),
                focus_task_id: focus_task(ed),
                remote_cursors: ed
                    .remote_cursors
                    .iter()
                    .map(|c| ViewCursor {
                        user_id: c.user_id.clone(),
                        anchor: pos(v.to_offset(c.anchor)),
                        head: pos(v.to_offset(c.head)),
                    })
                    .collect(),
                can_undo: ed.can_undo(),
                can_redo: ed.can_redo(),
                active: view_active(ed),
            }
        })
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

    /// Whether `undo` would change something. Typing within 500 ms of the last change (on a
    /// monotonic clock) is one step with it.
    pub fn can_undo(&self) -> bool {
        self.read(|i| i.ed.can_undo())
    }

    pub fn can_redo(&self) -> bool {
        self.read(|i| i.ed.can_redo())
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
        self.read(|i| i.view().text.clone())
    }

    pub fn view_offset_to_pos(&self, offset: u32) -> u32 {
        self.read(|i| pos(i.view().to_pos(offset as usize)))
    }

    pub fn pos_to_view_offset(&self, pos_: u32) -> u32 {
        self.read(|i| pos(i.view().to_offset(pos_ as usize)))
    }

    /// The view's text with its line table, the selection and the marked text, all in view
    /// offsets: what a UITextInput / TextKit 2 view lays out and answers the input system from.
    /// Rects are the view's (its layout of these lines). `view_render()` has this and the rest
    /// of a frame.
    pub fn view_state(&self) -> ViewState {
        self.read(|i| {
            let v = i.view();
            view_state(&i.ed, &v)
        })
    }

    /// The selection as offsets in `text_for_view()` (`selectedTextRange`'s getter).
    pub fn view_selection(&self) -> ViewRange {
        self.read(|i| {
            let v = i.view();
            let (a, h) = i.ed.view_selection_in(&v);
            ViewRange {
                anchor: pos(a),
                head: pos(h),
            }
        })
    }

    /// Set the selection from offsets in `text_for_view()` (`selectedTextRange`'s setter, taps,
    /// handles). Exactly one object line's U+FFFC selects its node; the whole string is
    /// select-all; a caret on an object line goes to the nearest text. Ends a composition.
    pub fn set_view_selection(&self, anchor: u32, head: u32) {
        self.with(|ed| ed.set_view_selection(anchor as usize, head as usize))
    }

    /// `replace_range` with offsets in `text_for_view()` (`replace(_:withText:)`).
    pub fn replace_view_range(&self, from: u32, to: u32, text: String) -> bool {
        let (f, t) = self.read(|i| {
            let v = i.view();
            (v.to_pos(from as usize), v.to_pos(to as usize))
        });
        self.edit(|ed| ed.replace_range(f, t, &text))
    }

    /// Move the slash menu's highlight by `delta` rows, wrapping. False when no slash menu is
    /// open.
    pub fn move_suggestion_highlight(&self, delta: i32) -> bool {
        self.with(|ed| ed.move_slash_highlight(delta as i64))
    }

    /// Run the slash menu's highlighted item. False when no slash menu is open (for `[[` and
    /// `@`, pick with `pickPage` / `pickMention`).
    pub fn pick_suggestion(&self) -> bool {
        self.edit(|ed| ed.pick_highlighted_slash())
    }

    /// Close the open menu (Escape, a tap elsewhere); it stays closed for this trigger.
    pub fn dismiss_suggestion(&self) -> bool {
        self.with(|ed| ed.dismiss_suggestion())
    }

    /// What to draw now, in positions (`view_render()` is the same in view offsets).
    pub fn state(&self) -> EditorState {
        self.read(|i| {
            let v = i.view();
            let ed = &i.ed;
            let selection = match ed.sel {
                Selection::Text { anchor, head } => EditorSelection::Text {
                    anchor: pos(anchor),
                    head: pos(head),
                },
                Selection::Node { pos: p } => EditorSelection::Node { pos: pos(p) },
                Selection::All => EditorSelection::All,
            };
            EditorState {
                doc_json: ed.doc.to_json().to_string(),
                selection,
                focus_task_id: focus_task(ed),
                suggestion: suggestion(ed, &v),
                composing: ed.composition.as_ref().map(|c| TextRange {
                    from: pos(c.from),
                    to: pos(c.to),
                }),
                remote_cursors: remote_cursors(ed),
                can_undo: ed.can_undo(),
                can_redo: ed.can_redo(),
            }
        })
    }

    /// Apply someone else's change (a Yjs update for the page). The selection and remote
    /// cursors follow the text they were in; an open composition stays open. A session from
    /// `open_live` doesn't need it (others' changes come from the live page), and what it
    /// applies doesn't go to the live page.
    pub fn apply_update(&self, update: Vec<u8>) -> Result<(), EditorError> {
        self.with(|ed| ed.apply_update(&update)).map_err(invalid)
    }

    /// The page doc's state vector (for a peer to answer with what this session lacks).
    pub fn state_vector(&self) -> Vec<u8> {
        self.read(|i| match &i.ed.binding {
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
        Ok(self.read(|i| match &i.ed.binding {
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
        self.read(|i| remote_cursors(&i.ed))
    }
}

fn view_mark(m: &nv_editor::input::ViewMark) -> ViewMark {
    use nv_editor::input::ViewMarkKind as K;
    ViewMark {
        kind: match m.kind {
            K::Bold => ViewMarkKind::Bold,
            K::Italic => ViewMarkKind::Italic,
            K::Underline => ViewMarkKind::Underline,
            K::Strike => ViewMarkKind::Strike,
            K::Code => ViewMarkKind::Code,
            K::Link => ViewMarkKind::Link,
            K::TextColor => ViewMarkKind::TextColor,
            K::Highlight => ViewMarkKind::Highlight,
            K::Comment => ViewMarkKind::Comment,
            K::Unknown => ViewMarkKind::Unknown,
        },
        value: m.value.clone(),
    }
}

fn view_active(ed: &Editor) -> ViewActive {
    let a = ed.view_active();
    ViewActive {
        marks: a.marks.iter().map(view_mark).collect(),
        block: a.block,
        heading_level: a.heading_level,
        list: a.list,
        in_quote: a.in_quote,
        in_code: a.in_code,
    }
}

fn view_state(ed: &Editor, v: &ViewText) -> ViewState {
    let (anchor, head) = ed.view_selection_in(v);
    ViewState {
        len: pos(v.len()),
        lines: v
            .lines
            .iter()
            .map(|l| ViewLine {
                offset: pos(l.offset),
                len: pos(l.len),
                pos: pos(l.pos),
                is_text: l.text,
                kind: l.kind.clone(),
                level: l.level,
                containers: l.containers.clone(),
                marker: l.marker.clone(),
                checked: l.checked,
                task_id: l.task_id.clone(),
                runs: l
                    .runs
                    .iter()
                    .map(|r| ViewRun {
                        from: pos(r.from),
                        len: pos(r.len),
                        marks: r.marks.iter().map(view_mark).collect(),
                    })
                    .collect(),
                atoms: l
                    .atoms
                    .iter()
                    .map(|a| ViewAtom {
                        offset: pos(a.offset),
                        kind: a.kind.clone(),
                        label: a.label.clone(),
                        attrs_json: a.attrs_json.clone(),
                    })
                    .collect(),
                attrs_json: l.attrs_json.clone(),
            })
            .collect(),
        text: v.text.clone(),
        selection: ViewRange {
            anchor: pos(anchor),
            head: pos(head),
        },
        marked: ed
            .view_composition_in(v)
            .map(|((f, t), (a, b))| ViewMarked {
                from: pos(f),
                to: pos(t),
                sel_from: pos(a),
                sel_to: pos(b),
            }),
    }
}

fn suggestion(ed: &Editor, v: &ViewText) -> Option<EditorSuggestion> {
    ed.suggestion().map(|s| {
        let titles = if s.trigger == Trigger::Slash {
            ed.slash_items()
        } else {
            Vec::new()
        };
        EditorSuggestion {
            trigger: match s.trigger {
                Trigger::Slash => SuggestionTrigger::Slash,
                Trigger::PageLink => SuggestionTrigger::PageLink,
                Trigger::Mention => SuggestionTrigger::Mention,
            },
            items: titles
                .iter()
                .map(|t| {
                    let (description, icon) = slash_details(t);
                    SuggestionItem {
                        id: t.to_string(),
                        label: t.to_string(),
                        description: description.into(),
                        icon: icon.into(),
                    }
                })
                .collect(),
            slash_items: titles.into_iter().map(String::from).collect(),
            highlighted: ed.slash_highlight().map(pos),
            query: s.query,
            view_from: pos(v.to_offset(s.from)),
            view_to: pos(v.to_offset(s.to)),
            from: pos(s.from),
            to: pos(s.to),
        }
    })
}

fn focus_task(ed: &Editor) -> Option<String> {
    match &ed.focus {
        Focus::Doc => None,
        Focus::TaskTitle(id) => Some(id.clone()),
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
