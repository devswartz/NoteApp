//! Tables (TipTap's TableKit): inserting, moving between cells, adding and deleting rows and columns.

use crate::editor::{near_text, Editor};
use crate::node::Node;
use crate::pos::ResolvedPos;
use crate::selection::Selection;

impl Editor {
    pub fn insert_table(&mut self, rows: usize, cols: usize, header: bool) -> bool {
        let row = |kind: &str| {
            Node::el(
                "tableRow",
                (0..cols)
                    .map(|_| Node::filled(kind, Default::default()))
                    .collect(),
            )
        };
        let mut kids = Vec::new();
        for r in 0..rows {
            kids.push(row(if header && r == 0 {
                "tableHeader"
            } else {
                "tableCell"
            }));
        }
        let at = self.insert_block_at_caret(Node::el("table", kids));
        match at {
            Some(p) => {
                // Caret in the first cell: table, row, cell, paragraph.
                self.sel = Selection::caret(p + 4);
                true
            }
            None => false,
        }
    }

    /// (depth of the table, row index, cell index) around the caret.
    fn cell_at(&self) -> Option<(ResolvedPos, usize)> {
        let (from, _) = self.range();
        let r = self.resolve(from);
        let d = r.find(&self.doc, |n| n.is("tableCell") || n.is("tableHeader"))?;
        Some((r, d))
    }

    /// Tab / Shift+Tab in a table: the next or previous cell, its content selected. Tab in the
    /// last cell adds a row.
    pub fn go_to_cell(&mut self, forward: bool) -> bool {
        let Some((r, d)) = self.cell_at() else {
            return false;
        };
        let table_d = d - 2;
        let table_path = r.path_to(table_d);
        let (ri, ci) = (r.index_at(d - 2), r.index_at(d - 1));
        let table = self.doc.at(&table_path);
        let cols = table.content[ri].content.len();
        let rows = table.content.len();
        let flat = ri * cols + ci;
        let target = if forward {
            if flat + 1 >= rows * cols {
                self.add_row(true);
                flat + 1
            } else {
                flat + 1
            }
        } else {
            if flat == 0 {
                return true;
            }
            flat - 1
        };
        let (tr, tc) = (target / cols, target % cols);
        // Position of the target cell.
        let table = self.doc.at(&table_path);
        let mut p = r.start(table_d);
        for row in &table.content[..tr] {
            p += row.node_size();
        }
        p += 1;
        for cell in &table.content[tr].content[..tc] {
            p += cell.node_size();
        }
        let cell = &table.content[tr].content[tc];
        // Select the cell's text (from its first text block's start to its last's end).
        let from = p + 2;
        let to = p + cell.node_size() - 2;
        self.sel = if from >= to {
            Selection::caret(from)
        } else {
            Selection::text(from, to)
        };
        true
    }

    /// Add a row after (or before) the caret's row, with plain cells.
    pub fn add_row(&mut self, after: bool) -> bool {
        let Some((r, d)) = self.cell_at() else {
            return false;
        };
        let table_path = r.path_to(d - 2);
        let ri = r.index_at(d - 2);
        let table = self.doc.at_mut(&table_path);
        let cols = table.content[ri].content.len();
        let row = Node::el(
            "tableRow",
            (0..cols)
                .map(|_| Node::filled("tableCell", Default::default()))
                .collect(),
        );
        let at = if after { ri + 1 } else { ri };
        table.content.insert(at, row);
        if !after {
            let size = table.content[at].node_size() as isize;
            self.sel = crate::editor::shift_sel(&self.sel, size);
        }
        true
    }

    /// Add a column after the caret's column; each row gets a cell of its row's kind.
    pub fn add_column_after(&mut self) -> bool {
        let Some((r, d)) = self.cell_at() else {
            return false;
        };
        let table_path = r.path_to(d - 2);
        let ci = r.index_at(d - 1);
        let table = self.doc.at_mut(&table_path);
        for row in &mut table.content {
            let kind = row
                .content
                .get(ci)
                .map_or("tableCell".to_string(), |c| c.kind.clone());
            row.content
                .insert(ci + 1, Node::filled(&kind, Default::default()));
        }
        true
    }

    pub fn delete_row(&mut self) -> bool {
        let Some((r, d)) = self.cell_at() else {
            return false;
        };
        let table_d = d - 2;
        let table_path = r.path_to(table_d);
        let ri = r.index_at(table_d);
        if self.doc.at(&table_path).content.len() == 1 {
            return self.delete_table();
        }
        let row_before = r.before(d - 1);
        self.doc.at_mut(&table_path).content.remove(ri);
        self.sel = Selection::caret(near_text(&self.doc, row_before, -1));
        true
    }

    pub fn delete_column(&mut self) -> bool {
        let Some((r, d)) = self.cell_at() else {
            return false;
        };
        let table_path = r.path_to(d - 2);
        let ci = r.index_at(d - 1);
        if self.doc.at(&table_path).content[0].content.len() == 1 {
            return self.delete_table();
        }
        let cell_before = r.before(d);
        for row in &mut self.doc.at_mut(&table_path).content {
            if ci < row.content.len() {
                row.content.remove(ci);
            }
        }
        self.sel = Selection::caret(near_text(
            &self.doc,
            cell_before.min(self.doc.content_size()),
            -1,
        ));
        true
    }

    pub fn delete_table(&mut self) -> bool {
        let Some((r, d)) = self.cell_at() else {
            return false;
        };
        let table_d = d - 2;
        let before = r.before(table_d);
        let parent = r.path_to(table_d - 1);
        let i = r.index_at(table_d - 1);
        self.doc.at_mut(&parent).content.remove(i);
        if self.doc.content.is_empty() {
            self.doc.content.push(Node::el("paragraph", vec![]));
        }
        self.sel = Selection::caret(near_text(&self.doc, before.min(self.doc.content_size()), 1));
        true
    }
}
