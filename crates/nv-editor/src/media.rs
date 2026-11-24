//! Images and file cards (today's `Image` and `FileAttachment` in `src/editor/blocks.tsx`).
//!
//! An `image` node has `src` (the API-relative `/uploads/<id><ext>` an upload answers), `alt`,
//! `title`, `width` and `height` (numbers, set by dragging a handle; the web's minimum is 80).
//! A `fileAttachment` has `url` (the same kind of path), `name`, `size` (bytes) and `mime`.
//! The document keeps the unsigned path; views sign it when drawing (`Core::file_url`).

use serde_json::{json, Value};

use crate::editor::{node_after, Editor};
use crate::node::Node;
use crate::schema::Attrs;
use crate::selection::Selection;

/// The smallest width the web's resize handles allow.
pub const MIN_IMAGE_WIDTH: f64 = 80.0;

impl Editor {
    /// Insert an image block at the caret (like the slash menu's Image): in place of an empty
    /// line, else after the caret's line, the caret going to the line after it. False for a
    /// `src` the editor doesn't allow (`nv_model::urls::safe_image_url`) or without a text caret.
    pub fn insert_image(
        &mut self,
        src: &str,
        alt: &str,
        width: Option<f64>,
        height: Option<f64>,
    ) -> bool {
        let src = nv_model::urls::safe_image_url(Some(src));
        if src.is_empty() {
            return false;
        }
        let mut a = Attrs::new();
        a.insert("src".into(), json!(src));
        a.insert("alt".into(), json!(alt));
        if let Some(w) = width.filter(|w| *w > 0.0) {
            a.insert("width".into(), json!(w));
        }
        if let Some(h) = height.filter(|h| *h > 0.0) {
            a.insert("height".into(), json!(h));
        }
        self.insert_block(Node::new("image", a, vec![]))
    }

    /// Insert a file card at the caret, as `insert_image` does. False for a `url` the editor
    /// doesn't allow (`nv_model::urls::safe_file_url`) or without a text caret.
    pub fn insert_file(&mut self, url: &str, name: &str, size: u64, mime: &str) -> bool {
        let url = nv_model::urls::safe_file_url(Some(url));
        if url.is_empty() {
            return false;
        }
        let mut a = Attrs::new();
        a.insert("url".into(), json!(url));
        a.insert(
            "name".into(),
            json!(if name.is_empty() { "file" } else { name }),
        );
        a.insert("size".into(), json!(size));
        a.insert("mime".into(), json!(mime));
        self.insert_block(Node::new("fileAttachment", a, vec![]))
    }

    /// Resize an image: `pos` (the position before it) or, without one, the selected image.
    /// `width` is clamped to the web's minimum; `height` is kept only when given (an old height
    /// would distort the picture), so a missing one is cleared and the view keeps the aspect ratio.
    pub fn set_image_size(&mut self, pos: Option<usize>, width: f64, height: Option<f64>) -> bool {
        let pos = match (pos, &self.sel) {
            (Some(p), _) => p,
            (None, Selection::Node { pos }) => *pos,
            _ => return false,
        };
        if !width.is_finite() {
            return false;
        }
        if !node_after(&self.doc, pos).is_some_and(|n| n.is("image")) {
            return false;
        }
        let r = self.resolve(pos);
        let path = r.path.clone();
        let w = width.max(MIN_IMAGE_WIDTH).round();
        let h = height.filter(|h| h.is_finite() && *h > 0.0).map(f64::round);
        let n = &mut self.doc.at_mut(&path).content[r.index];
        n.attrs.insert("width".into(), json!(w));
        n.attrs
            .insert("height".into(), h.map_or(Value::Null, |h| json!(h)));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bind::Clock;
    use crate::notation::{parse, serialize};

    fn editor(src: &str) -> Editor {
        let (doc, sel) = parse(src).unwrap();
        let mut ed = Editor::new(doc, sel.unwrap_or(Selection::caret(1)));
        ed.bind(nv_model::new_doc(), "default", Clock::manual());
        ed
    }

    fn show(ed: &Editor) -> String {
        serialize(&ed.doc, Some(&ed.sel), &|_, v| v.clone())
    }

    #[test]
    fn image_and_file_card_take_an_empty_line_and_leave_a_caret_line() {
        let mut ed = editor("<paragraph>|</paragraph>");
        assert!(ed
            .command(
                "insertImage",
                &json!({ "src": "/uploads/0123456789abcdef0123456789abcdef.png", "alt": "Cat" })
            )
            .unwrap());
        ed.finish();
        let s = show(&ed);
        assert!(s.contains("<image"), "{s}");
        assert!(
            s.contains("src=\"/uploads/0123456789abcdef0123456789abcdef.png\""),
            "{s}"
        );
        assert!(s.contains("alt=\"Cat\""), "{s}");
        assert!(s.ends_with("<paragraph>|</paragraph>"), "{s}");

        assert!(ed
            .command("insertFile", &json!({ "url": "/uploads/0123456789abcdef0123456789abcdef.pdf", "name": "a.pdf", "size": 1234, "mime": "application/pdf" }))
            .unwrap());
        ed.finish();
        let s = show(&ed);
        assert!(s.contains("<fileAttachment"), "{s}");
        assert!(
            s.contains("name=\"a.pdf\"") && s.contains("size=1234"),
            "{s}"
        );
    }

    #[test]
    fn unsafe_links_are_refused() {
        let mut ed = editor("<paragraph>|</paragraph>");
        assert!(!ed
            .command("insertImage", &json!({ "src": "javascript:alert(1)" }))
            .unwrap());
        assert!(!ed
            .command(
                "insertFile",
                &json!({ "url": "data:text/html,x", "name": "x" })
            )
            .unwrap());
        assert_eq!(show(&ed), "<paragraph>|</paragraph>");
    }

    #[test]
    fn resize_sets_width_clamped_and_clears_the_old_height() {
        let mut ed = editor("<image src=\"/uploads/0123456789abcdef0123456789abcdef.png\" width=300 height=200/><paragraph>|</paragraph>");
        ed.sel = Selection::Node { pos: 0 };
        assert!(ed
            .command("setImageWidth", &json!({ "width": 40 }))
            .unwrap());
        let n = &ed.doc.content[0];
        assert_eq!(n.attr("width"), &json!(80.0));
        assert_eq!(n.attr("height"), &Value::Null);
        assert!(ed
            .command(
                "setImageWidth",
                &json!({ "pos": 0, "width": 150.4, "height": 90 })
            )
            .unwrap());
        let n = &ed.doc.content[0];
        assert_eq!(
            (n.attr("width"), n.attr("height")),
            (&json!(150.0), &json!(90.0))
        );
        // Not an image there.
        assert!(!ed
            .command("setImageWidth", &json!({ "pos": 3, "width": 150 }))
            .unwrap());
        ed.finish();
    }
}
