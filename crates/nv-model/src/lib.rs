//! Notivelo's page format (docs/ARCHITECTURE.md 3.4), the Rust side of `shared/pageDoc.ts`,
//! `shared/listMarker.ts`, `server/markdown.ts`, `server/sanitizeDoc.ts` and the server's search
//! text. A page is a Yjs document; this crate reads it with yrs and must agree with the TS code
//! on every case of the page-format corpus (`tests/corpus/`, checked by `tests/corpus.rs`).

pub mod js;
pub mod lists;
pub mod markdown;
pub mod page;
pub mod sanitize;
pub mod text;
pub mod tree;
pub mod urls;

pub use markdown::{markdown_body, to_markdown, TaskLine};
pub use page::{
    doc_from_update, new_doc, BoxGeom, DocKind, Error, Fragment, InkStroke, Page, PageSettings,
    PAGE_FORMAT_VERSION,
};
pub use sanitize::sanitize_doc;
pub use text::{extract_page, page_headings, Extracted, PageHeading};
pub use tree::{Element, Insert, Node, Run};
pub use yrs;
