//! Resolved positions: where a position falls in the tree (ProseMirror's `ResolvedPos`).

use crate::node::Node;

#[derive(Debug, Clone)]
pub struct ResolvedPos {
    pub pos: usize,
    /// Child indices from the doc down to the parent (`path.len()` is the depth).
    pub path: Vec<usize>,
    /// The position where each level's content starts: `starts[d]` for depth `d` (0 for the doc).
    pub starts: Vec<usize>,
    /// The index in the parent of the child at or after the position.
    pub index: usize,
    /// Offset into the parent's content.
    pub parent_offset: usize,
}

impl ResolvedPos {
    pub fn depth(&self) -> usize {
        self.path.len()
    }

    pub fn node<'a>(&self, doc: &'a Node, depth: usize) -> &'a Node {
        doc.at(&self.path[..depth])
    }

    pub fn parent<'a>(&self, doc: &'a Node) -> &'a Node {
        doc.at(&self.path)
    }

    /// Start of the content of the node at `depth`.
    pub fn start(&self, depth: usize) -> usize {
        self.starts[depth]
    }

    /// End of the content of the node at `depth`.
    pub fn end(&self, doc: &Node, depth: usize) -> usize {
        self.starts[depth] + self.node(doc, depth).content_size()
    }

    /// Position before the node at `depth` (depth ≥ 1).
    pub fn before(&self, depth: usize) -> usize {
        self.starts[depth] - 1
    }

    /// Position after the node at `depth` (depth ≥ 1).
    pub fn after(&self, doc: &Node, depth: usize) -> usize {
        self.end(doc, depth) + 1
    }

    /// The child index at `depth` (in the node at that depth).
    pub fn index_at(&self, depth: usize) -> usize {
        if depth == self.depth() {
            self.index
        } else {
            self.path[depth]
        }
    }

    /// Path to the node at `depth`.
    pub fn path_to(&self, depth: usize) -> Vec<usize> {
        self.path[..depth].to_vec()
    }

    /// The deepest depth whose node contains both this position and `other`.
    pub fn shared_depth(&self, doc: &Node, other: usize) -> usize {
        for d in (1..=self.depth()).rev() {
            if self.start(d) <= other && self.end(doc, d) >= other {
                return d;
            }
        }
        0
    }

    pub fn at_start(&self) -> bool {
        self.parent_offset == 0
    }

    pub fn at_end(&self, doc: &Node) -> bool {
        self.parent_offset == self.parent(doc).content_size()
    }

    /// Innermost depth whose node is of `kind`.
    pub fn find(&self, doc: &Node, pred: impl Fn(&Node) -> bool) -> Option<usize> {
        (1..=self.depth()).rev().find(|&d| pred(self.node(doc, d)))
    }
}

pub fn resolve(doc: &Node, pos: usize) -> ResolvedPos {
    assert!(pos <= doc.content_size(), "position {pos} out of range");
    let mut path = Vec::new();
    let mut starts = vec![0];
    let mut node = doc;
    let mut start = 0;
    loop {
        let offset = pos - start;
        let mut p = 0;
        let mut index = node.content.len();
        let mut descend = None;
        for (i, c) in node.content.iter().enumerate() {
            let size = c.node_size();
            if offset == p {
                index = i;
                break;
            }
            if offset < p + size {
                index = i;
                if !c.is_leaf() {
                    descend = Some((i, start + p + 1));
                }
                break;
            }
            p += size;
        }
        match descend {
            Some((i, s)) => {
                path.push(i);
                starts.push(s);
                node = &node.content[i];
                start = s;
            }
            None => {
                return ResolvedPos {
                    pos,
                    path,
                    starts,
                    index,
                    parent_offset: offset,
                }
            }
        }
    }
}

/// Positions of the text blocks overlapping `from..to`, as (position before the block, path).
pub fn textblocks_between(doc: &Node, from: usize, to: usize) -> Vec<(usize, Vec<usize>)> {
    let mut out = Vec::new();
    fn walk(
        n: &Node,
        start: usize,
        path: &mut Vec<usize>,
        from: usize,
        to: usize,
        out: &mut Vec<(usize, Vec<usize>)>,
    ) {
        let mut p = start;
        for (i, c) in n.content.iter().enumerate() {
            let end = p + c.node_size();
            if !c.is_inline() && p < to.max(from + 1) && end > from {
                path.push(i);
                if c.is_textblock() {
                    // Its content is p+1 ..= end-1.
                    if p < to && end > from {
                        out.push((p, path.clone()));
                    }
                } else if !c.is_leaf() {
                    walk(c, p + 1, path, from, to, out);
                }
                path.pop();
            }
            p = end;
        }
    }
    walk(doc, 0, &mut Vec::new(), from, to, &mut out);
    out
}
