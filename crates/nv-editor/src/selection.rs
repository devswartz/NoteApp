//! Selections (EDITOR.md 2).

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selection {
    /// A caret (`anchor == head`) or a range of text.
    Text { anchor: usize, head: usize },
    /// One selected node (a task line, an image, a rule); `pos` is the position before it.
    Node { pos: usize },
    /// Everything in the box.
    All,
}

impl Selection {
    pub fn caret(pos: usize) -> Selection {
        Selection::Text {
            anchor: pos,
            head: pos,
        }
    }

    pub fn text(anchor: usize, head: usize) -> Selection {
        Selection::Text { anchor, head }
    }

    /// (from, to), ordered. `doc_size` and `node_size` resolve node and all selections.
    pub fn range(&self, doc_size: usize, node_size: impl Fn(usize) -> usize) -> (usize, usize) {
        match *self {
            Selection::Text { anchor, head } => (anchor.min(head), anchor.max(head)),
            Selection::Node { pos } => (pos, pos + node_size(pos)),
            Selection::All => (0, doc_size),
        }
    }

    pub fn is_empty(&self) -> bool {
        matches!(self, Selection::Text { anchor, head } if anchor == head)
    }

    pub fn head(&self) -> Option<usize> {
        match self {
            Selection::Text { head, .. } => Some(*head),
            _ => None,
        }
    }
}
