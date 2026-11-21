//! Notivelo's editor engine (docs/rewrite/EDITOR.md): one text box's document, selection and
//! commands, checked against the editor suite in `tests/editor/` (`tests/suite.rs`).

pub mod editor;
pub mod insert;
pub mod keymap;
pub mod node;
pub mod notation;
pub mod pos;
pub mod rules;
pub mod schema;
pub mod selection;
pub mod suggest;
pub mod table;
pub mod tasks;

pub use editor::{Editor, Focus};
pub use node::{Mark, Node};
pub use selection::Selection;
pub use tasks::TaskHost;
