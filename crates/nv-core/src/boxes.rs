//! Box calls on a live page: create, move, resize, bring to front, delete. Each is one local
//! edit on the page's live document (`LivePage::doc()`), written by `nv_model::boxes` in the
//! web app's own format, so it goes out through LiveDoc's update observer (and the offline
//! queue) like typing does. See docs/rewrite/status/core.md, "For apple: boxes".

use std::time::SystemTime;

use nv_model::boxes as model;

use crate::LivePage;

/// Why a box call failed.
#[derive(Debug, Clone, PartialEq, uniffi::Error)]
pub enum BoxError {
    /// The page has no box with this id (it may have been deleted by someone else).
    NoSuchBox { id: String },
    /// `create_box` was given an id that is in use (`new_box_id` makes ids that aren't).
    Exists { id: String },
    /// `delete_box` on a box with content: nothing was changed. `delete_box_with_content` removes it.
    NotEmpty { id: String },
    /// A number was NaN or infinite.
    Invalid { message: String },
    /// `close()` was called on the page: edits aren't sent any more, so none are made.
    Closed,
}

impl std::fmt::Display for BoxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BoxError::NoSuchBox { id } => write!(f, "no box {id:?} on this page"),
            BoxError::Exists { id } => write!(f, "box {id:?} already exists"),
            BoxError::NotEmpty { id } => write!(f, "box {id:?} is not empty"),
            BoxError::Invalid { message } => write!(f, "invalid box value: {message}"),
            BoxError::Closed => write!(f, "the page is closed"),
        }
    }
}
impl std::error::Error for BoxError {}

impl From<model::BoxError> for BoxError {
    fn from(e: model::BoxError) -> Self {
        match e {
            model::BoxError::NoSuchBox(id) => BoxError::NoSuchBox { id },
            model::BoxError::Exists(id) => BoxError::Exists { id },
            model::BoxError::NotEmpty(id) => BoxError::NotEmpty { id },
            model::BoxError::Invalid(message) => BoxError::Invalid { message },
        }
    }
}

/// A new box id: 16 base-36 characters from 8 random bytes, as the web's `newBoxId` makes them.
#[uniffi::export]
pub fn new_box_id() -> String {
    let mut b = [0u8; 8];
    if getrandom::getrandom(&mut b).is_err() {
        // No system randomness (never seen): the standard library's randomly keyed hasher.
        use std::hash::BuildHasher;
        let h = std::collections::hash_map::RandomState::new()
            .hash_one((SystemTime::now(), std::thread::current().id()));
        b = h.to_le_bytes();
    }
    model::box_id_from(b)
}

impl LivePage {
    fn box_edit<R>(
        &self,
        f: impl FnOnce(&nv_model::yrs::Doc) -> Result<R, model::BoxError>,
    ) -> Result<R, BoxError> {
        if self.is_closed() {
            return Err(BoxError::Closed);
        }
        Ok(f(self.doc())?)
    }
}

#[uniffi::export]
impl LivePage {
    /// Add an empty text box with its top-left at (`x`, `y`), `w` wide, stacked at `z`
    /// (positions are page pixels from the page origin; whole pixels in 0..=20000 for x and y,
    /// 120..=2400 for `w`: values outside are clamped, fractions rounded, as the web does).
    /// `z` is stored as given: the web uses one above the highest z on the page. Returns the
    /// new box's id. The box exists at once, so `EditorSession::open_live(page, "box:<id>", ..)`
    /// works right after, and typing in it goes out like any edit.
    pub fn create_box(&self, x: f64, y: f64, w: f64, z: f64) -> Result<String, BoxError> {
        let id = new_box_id();
        self.create_box_with_id(id.clone(), x, y, w, z)?;
        Ok(id)
    }

    /// `create_box` with an id you chose (a retry of the same create answers `Exists`).
    pub fn create_box_with_id(
        &self,
        id: String,
        x: f64,
        y: f64,
        w: f64,
        z: f64,
    ) -> Result<(), BoxError> {
        self.box_edit(|doc| model::create_box(doc, &id, x, y, w, z))
    }

    /// Move a box's top-left to (`x`, `y`) (clamped and rounded as in `create_box`).
    pub fn move_box(&self, id: String, x: f64, y: f64) -> Result<(), BoxError> {
        self.box_edit(|doc| model::move_box(doc, &id, x, y))
    }

    /// Set a box's width (clamped and rounded as in `create_box`). A wide box (the page's main
    /// box, drawn across the page) stops being wide: it keeps the width you give it.
    pub fn resize_box(&self, id: String, w: f64) -> Result<(), BoxError> {
        self.box_edit(|doc| model::resize_box(doc, &id, w))
    }

    /// Put a box in front of every other: its z becomes one above the highest (nothing is
    /// written when it is alone at the top already). Returns the box's z afterwards.
    pub fn bring_to_front(&self, id: String) -> Result<f64, BoxError> {
        self.box_edit(|doc| model::bring_to_front(doc, &id))
    }

    /// Remove an **empty** box: its entry and its (empty) content. A box with text, tasks or
    /// anything else is refused with `NotEmpty` and left alone; the web removes only boxes the
    /// user left empty without asking, and asks (with an undo) for the others.
    pub fn delete_box(&self, id: String) -> Result<(), BoxError> {
        self.box_edit(|doc| model::delete_box(doc, &id, false))
    }

    /// Remove a box whatever it holds, as the web's Delete key does on a selected box. There is
    /// no undo in the core; the tasks on the box's task lines are not deleted (the web deletes them
    /// through the task calls; `read_page(document).task_ids` lists them first).
    pub fn delete_box_with_content(&self, id: String) -> Result<(), BoxError> {
        self.box_edit(|doc| model::delete_box(doc, &id, true))
    }
}
