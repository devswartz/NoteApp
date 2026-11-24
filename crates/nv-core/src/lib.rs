//! The Core API (docs/ARCHITECTURE.md 3.3): the one typed boundary between the native apps and
//! the Rust core. Types are written here once; uniffi generates the Swift and Kotlin side
//! (`build-xcframework.sh` for Apple).
//!
//! M1: reading a page document with `nv-model` (layout, outline, searchable text, Markdown, the
//! import sanitiser). M3 (`client.rs`): a `Core` for one server: sign-in, workspaces, tree and
//! tasks over `nv-api`, and live pages over `nv-sync`. Editor sessions and the local store come
//! in later milestones (docs/rewrite/PLAN.md). Requests for changes go through
//! docs/rewrite/STATUS.md ("Requests between streams"); the **core** stream owns this file.

use std::collections::HashMap;

use nv_model::yrs::{ReadTxn, StateVector, Transact};
use nv_model::{DocKind, Page, TaskLine};

mod account;
#[cfg(target_os = "android")]
mod android;
mod boxes;
mod client;
mod content;
mod editor_session;
mod files;
mod inbox;
pub mod ink;
mod locked;
mod page_undo;
mod quickadd;
mod recurrence;
mod search;
mod sharing;
mod task_detail;
mod tasks;
mod tree_edit;
mod versions;
pub use account::*;
pub use boxes::*;
pub use client::*;
pub use content::*;
pub use editor_session::*;
pub use files::*;
pub use inbox::*;
pub use ink::{
    ink_outline_ops, ink_outline_svg, ink_outline_triangles, read_ink, InkBounds, InkEraseResult,
    InkError, InkMovedStroke, InkStrokeBuilder, InkStrokeInfo,
};
pub use locked::*;
pub use quickadd::{QuickAddKind, QuickAddResult, QuickAddToken};
pub use search::*;
pub use sharing::*;
pub use task_detail::*;
pub use tasks::*;
pub use tree_edit::*;
pub use versions::*;

uniffi::setup_scaffolding!();

/// Why a core call failed.
#[derive(Debug, Clone, PartialEq, uniffi::Error)]
pub enum CoreError {
    /// The bytes are not a page document (a Yjs update) this core can read.
    InvalidPage { message: String },
    /// The server couldn't be reached (offline, DNS, TLS, timeout).
    Network { message: String },
    /// The server answered with an error. `code` is its stable code when it has one (e.g. `email_unverified`).
    Server {
        status: u16,
        message: String,
        code: Option<String>,
    },
    /// No session, or it ended: sign in again.
    SignedOut,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoreError::InvalidPage { message } => write!(f, "invalid page: {message}"),
            CoreError::Network { message } => write!(f, "network error: {message}"),
            CoreError::Server {
                status, message, ..
            } => write!(f, "{message} ({status})"),
            CoreError::SignedOut => write!(f, "signed out"),
        }
    }
}
impl std::error::Error for CoreError {}

impl From<nv_model::Error> for CoreError {
    fn from(e: nv_model::Error) -> Self {
        CoreError::InvalidPage {
            message: e.to_string(),
        }
    }
}

/// The version of this core library.
#[uniffi::export]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The newest page format this core understands. A page with a higher `format_version` was
/// written by a newer app: show what is known and say an update is needed.
#[uniffi::export]
pub fn page_format_version() -> u32 {
    nv_model::PAGE_FORMAT_VERSION
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum PageKind {
    /// Text boxes on a canvas (every page the app makes today).
    Canvas,
    /// An old single-column page, shown as one box.
    Document,
}

/// A text box on a canvas page. Height follows the content.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageBox {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    /// Stacking order: higher is in front.
    pub z: f64,
    /// Drawn across the page's full width until someone sets its width by hand.
    pub wide: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageSettings {
    /// One of none, yellow, green, blue, purple, pink, grey.
    pub color: String,
    /// One of none, lines, grid.
    pub rules: String,
}

/// A heading for the page outline.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageHeading {
    pub box_id: String,
    /// Index among the box's non-empty headings.
    pub index: u32,
    pub level: u32,
    pub text: String,
}

/// What a page holds, read from its stored document.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageInfo {
    pub kind: PageKind,
    pub format_version: u32,
    /// Written by a newer app (`format_version > page_format_version()`).
    pub newer_format: bool,
    pub settings: PageSettings,
    /// The boxes in reading order (top to bottom, then left to right).
    pub boxes: Vec<PageBox>,
    pub headings: Vec<PageHeading>,
    /// The searchable text, as the server indexes it.
    pub text: String,
    /// Tasks embedded in the page, sorted.
    pub task_ids: Vec<String>,
    /// People mentioned, sorted.
    pub mention_ids: Vec<String>,
    pub has_ink: bool,
    /// What's in each content fragment: `default` (box id none) first, then the boxes in reading order.
    pub content: Vec<BoxContent>,
}

/// What the Markdown export shows for a task embedded in the page.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum TaskLineInput {
    Shown {
        title: String,
        done: bool,
        due: Option<String>,
    },
    /// Left out, with its notes.
    Hidden,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SanitizedPage {
    /// The cleaned page document (a full Yjs update).
    pub update: Vec<u8>,
    /// How many links, nodes and ink entries were removed.
    pub removed: u32,
}

fn int(f: f64) -> u32 {
    if f.is_finite() && f >= 0.0 {
        f.min(f64::from(u32::MAX)) as u32
    } else {
        0
    }
}

/// Read a stored page (`Y.encodeStateAsUpdate`).
#[uniffi::export]
pub fn read_page(update: Vec<u8>) -> Result<PageInfo, CoreError> {
    Ok(page_info(&Page::from_update(&update)?))
}

pub(crate) fn page_info(page: &Page) -> PageInfo {
    let ex = nv_model::extract_page(page);
    PageInfo {
        kind: match page.kind() {
            DocKind::Canvas => PageKind::Canvas,
            DocKind::Document => PageKind::Document,
        },
        format_version: int(page.format_version),
        newer_format: page.is_newer_format(),
        settings: PageSettings {
            color: page.settings.color.clone(),
            rules: page.settings.rules.clone(),
        },
        boxes: page
            .reading_order()
            .into_iter()
            .map(|b| PageBox {
                id: b.id,
                x: b.x,
                y: b.y,
                w: b.w,
                z: b.z,
                wide: b.wide,
            })
            .collect(),
        headings: nv_model::page_headings(page)
            .into_iter()
            .map(|h| PageHeading {
                box_id: h.box_id,
                index: h.index as u32,
                level: int(h.level),
                text: h.text,
            })
            .collect(),
        text: ex.text,
        task_ids: ex.task_ids.into_iter().collect(),
        mention_ids: ex.mention_ids.into_iter().collect(),
        has_ink: page.has_ink(),
        content: content::box_contents(&page.fragments),
    }
}

/// The content of every box of a stored page (`default` first, then the boxes in reading order).
#[uniffi::export]
pub fn page_content(update: Vec<u8>) -> Result<Vec<BoxContent>, CoreError> {
    Ok(content::box_contents(
        &Page::from_update(&update)?.fragments,
    ))
}

/// The page as Markdown (`# title`, then its boxes in reading order). `tasks` says how to show
/// each embedded task; a task not in it is shown by its notes only.
#[uniffi::export]
pub fn page_markdown(
    update: Vec<u8>,
    title: String,
    tasks: HashMap<String, TaskLineInput>,
) -> Result<String, CoreError> {
    let page = Page::from_update(&update)?;
    let lookup = |id: &str| match tasks.get(id) {
        None => TaskLine::Unknown,
        Some(TaskLineInput::Hidden) => TaskLine::Hidden,
        Some(TaskLineInput::Shown { title, done, due }) => TaskLine::Shown {
            title: title.clone(),
            done: *done,
            due: due.clone(),
        },
    };
    Ok(nv_model::to_markdown(&title, &page.fragments, &lookup))
}

/// Clean a page that came from outside (an import): unsafe links, images and file cards, colours
/// outside the palette, and ink entries that aren't strokes are removed.
#[uniffi::export]
pub fn sanitize_page(update: Vec<u8>) -> Result<SanitizedPage, CoreError> {
    let doc = nv_model::doc_from_update(&update)?;
    let removed = nv_model::sanitize_doc(&doc);
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    Ok(SanitizedPage { update, removed })
}

/// An ordered list's marker for item number `n`: `list_type` is "1" (or none), "a", "A", "i" or "I".
#[uniffi::export]
pub fn list_marker(list_type: Option<String>, n: i64) -> String {
    let kind = list_type.map(|s| nv_model::yrs::Any::String(s.into()));
    nv_model::lists::list_marker(kind.as_ref(), n as f64)
}
