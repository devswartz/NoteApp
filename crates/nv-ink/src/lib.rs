//! nv-ink: Notivelo's ink engine (docs/PLAN_INK.md). One implementation of the stroke format and
//! stroke geometry for every platform: WASM on the web (`wasm` feature, src/ink/ in the app),
//! later a native library on iPad (uniffi) and a Node addon for the server.
//!
//! - [`blob`]: the stored stroke format (versioned, compact) and its decoder.
//! - [`smooth`]: one-euro input smoothing and the stroke builder.
//! - [`geom`]: curve fit, pressure-to-width outline, path commands, SVG, triangles.
//! - [`hit`]: point, path and lasso hit tests.
//! - [`erase`]: the partial eraser's split.

pub mod blob;
pub mod erase;
pub mod geom;
pub mod hit;
pub mod smooth;
#[cfg(feature = "wasm")]
pub mod wasm;

pub use blob::{decode, decode_header, encode, BBox, DecodeError, Header, Point, Stroke};

/// The ink bounds of a stroke for culling (the header's box; empty for a stroke without points).
pub fn ink_bounds(h: &Header) -> BBox {
    if h.count == 0 {
        return BBox::EMPTY;
    }
    h.bbox
}
