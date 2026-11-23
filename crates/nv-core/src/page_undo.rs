//! One undo for a whole page, like the web's `src/editor/pageUndo.ts`: `LivePage::undo` takes
//! back this client's most recent change on the page, whichever history holds it.
//!
//! - Box geometry and ink are one yrs `UndoManager` on the page (`ink.rs`, `new_ink_undo`), as
//!   the web's `canvasUndo.ts`.
//! - The text of a box is the engine's own undo of the `EditorSession` opened live on it.
//!
//! Each step of each history is stamped with a number from one page-wide counter (`PageSeq`),
//! when it is made and again when an undo or redo moves it to the other stack. Undo and redo pick
//! the history whose top step is newest. A new change anywhere makes every earlier redo step
//! stale (`PageSeq::redo_live`), so redo only offers what was undone after the last change.
//!
//! A box's text history lives in its session, so it ends with the session: when the app lets go
//! of the `EditorSession` (the box's editor closes), its text steps leave the page's undo. The
//! web keeps them on the page; here the geometry and ink steps stay, the text ones do not.

use std::sync::{Arc, Mutex, Weak};

use nv_editor::bind::PageSeq;

use crate::editor_session::EditorSession;
use crate::LivePage;

/// Why a page undo call failed.
#[derive(Debug, Clone, PartialEq, uniffi::Error)]
pub enum PageUndoError {
    /// `close()` was called on the page: edits aren't sent any more, so none are made.
    Closed,
}

impl std::fmt::Display for PageUndoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the page is closed")
    }
}
impl std::error::Error for PageUndoError {}

/// The page's stamp counter and the text sessions open live on it.
#[derive(Default)]
pub(crate) struct PageUndo {
    pub seq: Arc<PageSeq>,
    sessions: Mutex<Vec<Weak<EditorSession>>>,
}

impl PageUndo {
    pub fn register(&self, s: &Arc<EditorSession>) {
        let mut v = self.sessions.lock().unwrap();
        v.retain(|w| w.strong_count() > 0);
        v.push(Arc::downgrade(s));
    }

    fn live(&self) -> Vec<Arc<EditorSession>> {
        let mut v = self.sessions.lock().unwrap();
        v.retain(|w| w.strong_count() > 0);
        v.iter().filter_map(Weak::upgrade).collect()
    }
}

enum Pick {
    Geom,
    Text(Arc<EditorSession>),
}

impl LivePage {
    /// The history whose top undo (or redo) step is newest, with its stamp.
    fn page_pick(&self, undo: bool) -> Option<(u64, Pick)> {
        let mut best = self.ink_undo.lock().unwrap().as_ref().and_then(|m| {
            let item = if undo {
                m.undo_stack().last()
            } else {
                m.redo_stack().last()
            }?;
            let s = *item.meta();
            (undo || self.page_undo.seq.redo_live(s)).then_some((s, Pick::Geom))
        });
        for s in self.page_undo.live() {
            if let Some(seq) = s.page_top(undo) {
                if best.as_ref().is_none_or(|(b, _)| seq > *b) {
                    best = Some((seq, Pick::Text(s)));
                }
            }
        }
        best
    }

    fn page_step(&self, undo: bool) -> Result<bool, PageUndoError> {
        if self.is_closed() {
            return Err(PageUndoError::Closed);
        }
        Ok(match self.page_pick(undo) {
            None => false,
            Some((_, Pick::Text(s))) => {
                if undo {
                    s.undo()
                } else {
                    s.redo()
                }
            }
            Some((_, Pick::Geom)) => {
                let mut guard = self.ink_undo.lock().unwrap();
                match guard.as_mut() {
                    Some(m) if undo => m.undo_blocking(),
                    Some(m) => m.redo_blocking(),
                    None => false,
                }
            }
        })
    }
}

#[uniffi::export]
impl LivePage {
    /// Undo this client's most recent change on the page, whichever it was: a box created,
    /// moved, resized, brought to front or deleted (a deleted box comes back with its text), an
    /// ink gesture, or the text of a box whose `EditorSession` is open (`open_live`; the caret
    /// comes back there). Others' changes are never undone. The result is an ordinary local
    /// edit, sent like any other, and is not reported through `on_change`: re-read
    /// `ink_strokes()`, `info()` and the open sessions' `view_render()` afterwards. False when
    /// there is nothing to undo.
    pub fn undo(&self) -> Result<bool, PageUndoError> {
        self.page_step(true)
    }

    /// Redo what `undo` undid. A new change anywhere (text, ink, boxes) drops the redo steps.
    pub fn redo(&self) -> Result<bool, PageUndoError> {
        self.page_step(false)
    }

    /// Whether `undo` would change something (for the ribbon button).
    pub fn can_undo(&self) -> bool {
        !self.is_closed() && self.page_pick(true).is_some()
    }

    /// Whether `redo` would change something.
    pub fn can_redo(&self) -> bool {
        !self.is_closed() && self.page_pick(false).is_some()
    }
}
