//! Tables (TipTap's TableKit): inserting, moving between cells, adding and deleting rows and columns.

use crate::editor::{near_text, Editor};
use crate::node::Node;
use crate::pos::ResolvedPos;
use crate::selection::Selection;
use serde_json::{json, Value};

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

    // ───────────── Rows, columns and merged cells (prosemirror-tables) ─────────────
    //
    // These follow prosemirror-tables (what TipTap's table commands call): a table is a grid
    // of slots, a cell covers `colspan` x `rowspan` of them, and every command works on the
    // rectangle of the selected cell(s): the caret's cell, or the cells between two ends of a
    // text selection that lie in different cells (prosemirror's CellSelection).

    /// The table around the caret and the selected rectangle in it.
    fn table_ctx(&self) -> Option<TableCtx> {
        let (from, to) = self.range();
        let (path, start, (ri, ci)) = self.cell_index_at(from)?;
        let grid = Grid::new(self.doc.at(&path));
        let mut rect = grid.rects.get(ri)?.get(ci).copied()?;
        if to != from {
            if let Some((p2, _, (rj, cj))) = self.cell_index_at(to) {
                if p2 == path && (rj, cj) != (ri, ci) {
                    let other = grid.rects.get(rj)?.get(cj).copied()?;
                    rect = grid.expand(rect.union(other));
                }
            }
        }
        Some(TableCtx {
            path,
            start,
            grid,
            rect,
            caret: (ri, ci),
        })
    }

    /// (path to the table, the position where its content starts, (row, cell index)) for the
    /// cell around `pos`.
    fn cell_index_at(&self, pos: usize) -> Option<(Vec<usize>, usize, (usize, usize))> {
        let r = self.resolve(pos);
        let d = r.find(&self.doc, |n| n.is("tableCell") || n.is("tableHeader"))?;
        if d < 3 {
            return None;
        }
        Some((
            r.path_to(d - 2),
            r.start(d - 2),
            (r.index_at(d - 2), r.index_at(d - 1)),
        ))
    }

    /// Move a position of the old document to the new one, given what was inserted
    /// (position, size) and deleted (position, size) in old coordinates.
    fn map_through(pos: usize, inserted: &[(usize, usize)], deleted: &[(usize, usize)]) -> usize {
        let mut p = pos as isize;
        for &(at, size) in inserted {
            if at < pos {
                p += size as isize;
            }
        }
        for &(at, size) in deleted {
            if at + size <= pos {
                p -= size as isize;
            } else if at < pos {
                p -= (pos - at) as isize;
            }
        }
        p.max(0) as usize
    }

    /// Add a row after (or before) the selected cells' rows, with plain cells (header cells
    /// where the rows next to it are headers).
    pub fn add_row(&mut self, after: bool) -> bool {
        let Some(c) = self.table_ctx() else {
            return false;
        };
        let row = if after { c.rect.bottom } else { c.rect.top };
        let g = &c.grid;
        let lay = Layout::new(self.doc.at(&c.path), c.start);
        // The kind of the new cells: those of the row above, or below next to a header.
        let mut ref_row: Option<isize> = Some(if row > 0 { -1 } else { 0 });
        if g.row_is_header(
            self.doc.at(&c.path),
            (row as isize + ref_row.unwrap()) as usize,
        ) {
            ref_row = if row == 0 || row == g.height {
                None
            } else {
                Some(0)
            };
        }
        let table = self.doc.at(&c.path).clone();
        let mut grow = Vec::new();
        let mut cells = Vec::new();
        let mut col = 0;
        while col < g.width {
            let above = if row > 0 && row < g.height {
                g.slots[row][col].filter(|s| g.slots[row - 1][col] == Some(*s))
            } else {
                None
            };
            if let Some((ri, ci)) = above {
                grow.push((ri, ci));
                col += table.content[ri].content[ci].span("colspan");
            } else {
                let kind = match ref_row {
                    None => "tableCell".to_string(),
                    Some(o) => g.slots[(row as isize + o) as usize][col]
                        .map_or("tableCell".to_string(), |(ri, ci)| {
                            table.content[ri].content[ci].kind.clone()
                        }),
                };
                cells.push(Node::filled(&kind, Default::default()));
                col += 1;
            }
        }
        let new_row = Node::el("tableRow", cells);
        let at = if row < g.height {
            lay.row_pos[row]
        } else {
            lay.end
        };
        let size = new_row.node_size();
        let caret = self.sel.clone();
        let t = self.doc.at_mut(&c.path);
        for (ri, ci) in grow {
            let cell = &mut t.content[ri].content[ci];
            let n = cell.span("rowspan") + 1;
            cell.set_span("rowspan", n);
        }
        t.content.insert(row, new_row);
        self.sel = shift_by(&caret, |p| if at < p { p + size } else { p });
        true
    }

    /// Add a column after the caret's column; each row gets a cell of its row's kind.
    pub fn add_column_after(&mut self) -> bool {
        self.add_column(true)
    }

    /// Add a column after (or before) the selected cells' columns; each row gets a plain cell
    /// (a header where the columns next to it are headers); cells that span over the new column
    /// grow.
    pub fn add_column(&mut self, after: bool) -> bool {
        let Some(c) = self.table_ctx() else {
            return false;
        };
        let col = if after { c.rect.right } else { c.rect.left };
        let g = &c.grid;
        let table = self.doc.at(&c.path).clone();
        let lay = Layout::new(&table, c.start);
        let mut ref_col: Option<isize> = Some(if col > 0 { -1 } else { 0 });
        if g.column_is_header(&table, (col as isize + ref_col.unwrap()) as usize) {
            ref_col = if col == 0 || col == g.width {
                None
            } else {
                Some(0)
            };
        }
        let mut grow: Vec<(usize, usize, usize)> = Vec::new(); // (row, cell, offset in it)
        let mut inserts: Vec<(usize, usize, Node)> = Vec::new(); // (row, index in row, cell)
        let mut row = 0;
        while row < g.height {
            let inside = if col > 0 && col < g.width {
                g.slots[row][col].filter(|s| g.slots[row][col - 1] == Some(*s))
            } else {
                None
            };
            if let Some((ri, ci)) = inside {
                grow.push((ri, ci, col - g.rects[ri][ci].left));
                row += table.content[ri].content[ci].span("rowspan");
            } else {
                let kind = match ref_col {
                    None => "tableCell".to_string(),
                    Some(o) => g.slots[row][(col as isize + o) as usize]
                        .map_or("tableCell".to_string(), |(ri, ci)| {
                            table.content[ri].content[ci].kind.clone()
                        }),
                };
                let k = (0..table.content[row].content.len())
                    .filter(|&ci| g.rects[row][ci].left < col)
                    .count();
                inserts.push((row, k, Node::filled(&kind, Default::default())));
                row += 1;
            }
        }
        let caret = self.sel.clone();
        let points: Vec<(usize, usize)> = inserts
            .iter()
            .map(|(r, k, n)| (lay.cell_insert_pos(&table, *r, *k), n.node_size()))
            .collect();
        let t = self.doc.at_mut(&c.path);
        for (ri, ci, off) in grow {
            let cell = &mut t.content[ri].content[ci];
            let n = cell.span("colspan") + 1;
            cell.set_span("colspan", n);
            cell.insert_colwidth(off);
        }
        // Later cells of a row first, so earlier indexes stay put.
        for (r, k, n) in inserts.into_iter().rev() {
            t.content[r].content.insert(k, n);
        }
        self.sel = shift_by(&caret, |p| Self::map_through(p, &points, &[]));
        true
    }

    /// The first row as header cells, or back to plain cells when it already is one.
    pub fn toggle_header_row(&mut self) -> bool {
        let Some((r, d)) = self.cell_at() else {
            return false;
        };
        let table_path = r.path_to(d - 2);
        let first = &mut self.doc.at_mut(&table_path).content[0];
        let all_header = first.content.iter().all(|c| c.is("tableHeader"));
        for cell in &mut first.content {
            cell.kind = if all_header {
                "tableCell"
            } else {
                "tableHeader"
            }
            .into();
        }
        true
    }

    /// Delete the selected cells' rows (a cell that spans rows takes them all); cells that
    /// span into or out of them shrink or move down. All the rows: the table goes.
    pub fn delete_row(&mut self) -> bool {
        let Some(c) = self.table_ctx() else {
            return false;
        };
        if c.rect.top == 0 && c.rect.bottom == c.grid.height {
            return self.delete_table();
        }
        let lay = Layout::new(self.doc.at(&c.path), c.start);
        let deleted: Vec<(usize, usize)> = (c.rect.top..c.rect.bottom)
            .map(|r| (lay.row_pos[r], lay.row_size(r)))
            .collect();
        let before = lay.row_pos[c.rect.top];
        {
            let t = self.doc.at_mut(&c.path);
            for row in (c.rect.top..c.rect.bottom).rev() {
                remove_row(t, row);
            }
        }
        let at = Self::map_through(before, &[], &deleted).min(self.doc.content_size());
        self.sel = Selection::caret(near_text(&self.doc, at, -1));
        true
    }

    /// Delete the selected cells' columns (cells that span over them shrink). All the columns:
    /// the table goes.
    pub fn delete_column(&mut self) -> bool {
        let Some(c) = self.table_ctx() else {
            return false;
        };
        if c.rect.left == 0 && c.rect.right == c.grid.width {
            return self.delete_table();
        }
        let table = self.doc.at(&c.path).clone();
        let lay = Layout::new(&table, c.start);
        // The cells that go whole, in old coordinates.
        let mut deleted: Vec<(usize, usize)> = Vec::new();
        for (ri, row) in table.content.iter().enumerate() {
            for (ci, cell) in row.content.iter().enumerate() {
                let r = c.grid.rects[ri][ci];
                if r.left >= c.rect.left && r.right <= c.rect.right {
                    deleted.push((lay.cell_pos[ri][ci], cell.node_size()));
                }
            }
        }
        let before = lay.cell_pos[c.caret.0][c.caret.1];
        {
            let t = self.doc.at_mut(&c.path);
            for col in (c.rect.left..c.rect.right).rev() {
                remove_column(t, col);
            }
        }
        let at = Self::map_through(before, &[], &deleted).min(self.doc.content_size());
        self.sel = Selection::caret(near_text(&self.doc, at, -1));
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

    /// The rectangle to merge: `explicit` is (top, left, bottom, right), inclusive, in the
    /// caret's table (for a view with its own cell selection); else the selection's.
    fn merge_rect(
        &self,
        explicit: Option<(usize, usize, usize, usize)>,
    ) -> Option<(TableCtx, Rect)> {
        let c = self.table_ctx()?;
        let rect = match explicit {
            Some((t, l, b, r)) => {
                if b >= c.grid.height || r >= c.grid.width || t > b || l > r {
                    return None;
                }
                c.grid.expand(Rect {
                    top: t,
                    left: l,
                    bottom: b + 1,
                    right: r + 1,
                })
            }
            None => c.rect,
        };
        if rect.bottom - rect.top < 1 || rect.right - rect.left < 1 {
            return None;
        }
        // One cell is not a merge; a hole (a row short of cells) can't be merged over.
        let mut seen = Vec::new();
        for r in rect.top..rect.bottom {
            for col in rect.left..rect.right {
                let s = c.grid.slots[r][col]?;
                if !seen.contains(&s) {
                    seen.push(s);
                }
            }
        }
        if seen.len() < 2 {
            return None;
        }
        Some((c, rect))
    }

    /// Whether `merge_cells` would do something: the selection covers more than one cell.
    pub fn can_merge_cells(&self) -> bool {
        self.merge_rect(None).is_some()
    }

    /// Whether `split_cell` would do something: the caret's cell spans columns or rows.
    pub fn can_split_cell(&self) -> bool {
        self.table_ctx().is_some_and(|c| {
            let cell = &self.doc.at(&c.path).content[c.caret.0].content[c.caret.1];
            cell.span("colspan") > 1 || cell.span("rowspan") > 1
        })
    }

    /// Whether the caret is in a table, and whether its first row is made of header cells.
    pub fn table_state(&self) -> Option<bool> {
        let c = self.table_ctx()?;
        let first = &self.doc.at(&c.path).content[0];
        Some(first.content.iter().all(|c| c.is("tableHeader")))
    }

    /// Merge the selected cells (two or more, in a rectangle of the caret's table; a rectangle
    /// that cuts through a cell grows to take it whole) into the first one, which then spans
    /// them. The text of the others is added after its own (cells with nothing in them add
    /// nothing; an empty first cell is replaced). The caret goes to the merged cell.
    /// `explicit`: (top, left, bottom, right), inclusive grid slots, in place of the selection.
    pub fn merge_cells(&mut self, explicit: Option<(usize, usize, usize, usize)>) -> bool {
        let Some((c, rect)) = self.merge_rect(explicit) else {
            return false;
        };
        let t = self.doc.at_mut(&c.path);
        let g = &c.grid;
        let (mr, mc) = g.slots[rect.top][rect.left].expect("checked");
        let mut seen = vec![(mr, mc)];
        let mut gone: Vec<(usize, usize)> = Vec::new();
        let mut extra: Vec<Node> = Vec::new();
        let mut widths: Vec<Option<f64>> = vec![None; rect.right - rect.left];
        for r in rect.top..rect.bottom {
            for col in rect.left..rect.right {
                let s = g.slots[r][col].expect("checked");
                let cell = &t.content[s.0].content[s.1];
                if let Some(w) = cell.colwidth_at(col - g.rects[s.0][s.1].left) {
                    widths[col - rect.left] = Some(w);
                }
                if seen.contains(&s) {
                    continue;
                }
                seen.push(s);
                if !cell.is_empty_cell() {
                    extra.extend(cell.content.iter().cloned());
                }
                gone.push(s);
            }
        }
        // Cells that go, last of each row first.
        gone.sort_by(|a, b| b.cmp(a));
        for (ri, ci) in gone {
            t.content[ri].content.remove(ci);
        }
        let merged = &mut t.content[mr].content[mc];
        merged.set_span("colspan", rect.right - rect.left);
        merged.set_span("rowspan", rect.bottom - rect.top);
        merged.attrs.insert(
            "colwidth".into(),
            if widths.iter().all(|w| w.is_some()) {
                Value::Array(widths.iter().map(|w| json!(w.unwrap())).collect())
            } else {
                Value::Null
            },
        );
        if !extra.is_empty() {
            if merged.is_empty_cell() {
                merged.content = extra;
            } else {
                merged.content.extend(extra);
            }
        }
        let lay = Layout::new(self.doc.at(&c.path), c.start);
        let at = lay.cell_pos[mr][mc] + 1;
        self.sel = Selection::caret(near_text(&self.doc, at, 1));
        true
    }

    /// Split the caret's merged cell back into single cells (of its own kind, empty but for
    /// the first). The caret stays in the original cell.
    pub fn split_cell(&mut self) -> bool {
        let Some(c) = self.table_ctx() else {
            return false;
        };
        let (ri, ci) = c.caret;
        let rect = c.grid.rects[ri][ci];
        let table = self.doc.at_mut(&c.path);
        let cell = table.content[ri].content[ci].clone();
        if cell.span("colspan") == 1 && cell.span("rowspan") == 1 {
            return false;
        }
        let widths = cell.colwidth_all();
        let single = |i: usize| {
            let mut n = Node::filled(&cell.kind, Default::default());
            n.attrs = cell.attrs.clone();
            n.set_span("colspan", 1);
            n.set_span("rowspan", 1);
            let w = widths
                .as_ref()
                .and_then(|w| w.get(i))
                .copied()
                .filter(|w| *w > 0.0);
            n.attrs
                .insert("colwidth".into(), w.map_or(Value::Null, |w| json!([w])));
            n
        };
        // Rows after the first: new cells go before the first cell that starts to the right.
        for row in rect.top + 1..rect.bottom {
            let k = (0..table.content[row].content.len())
                .filter(|&j| c.grid.rects[row][j].left < rect.left)
                .count();
            for i in (0..rect.right - rect.left).rev() {
                table.content[row].content.insert(k, single(i));
            }
        }
        for i in (1..rect.right - rect.left).rev() {
            table.content[ri].content.insert(ci + 1, single(i));
        }
        table.content[ri].content[ci].attrs = single(0).attrs;
        true
    }
}

// ───────────── The grid ─────────────

/// A rectangle of grid slots; `bottom` and `right` are one past the last.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    top: usize,
    left: usize,
    bottom: usize,
    right: usize,
}

impl Rect {
    fn union(self, o: Rect) -> Rect {
        Rect {
            top: self.top.min(o.top),
            left: self.left.min(o.left),
            bottom: self.bottom.max(o.bottom),
            right: self.right.max(o.right),
        }
    }
}

/// A table laid out on a grid, as prosemirror-tables' `TableMap`: `slots[row][col]` is the
/// (row index, cell index) of the cell covering it, none for a hole (a row short of cells).
struct Grid {
    width: usize,
    height: usize,
    slots: Vec<Vec<Option<(usize, usize)>>>,
    /// The slots each cell covers, by (row index, cell index).
    rects: Vec<Vec<Rect>>,
}

impl Grid {
    fn new(table: &Node) -> Grid {
        let height = table.content.len();
        let mut slots: Vec<Vec<Option<(usize, usize)>>> = vec![Vec::new(); height];
        let mut rects: Vec<Vec<Rect>> = Vec::new();
        for (ri, row) in table.content.iter().enumerate() {
            let mut col = 0;
            let mut rr = Vec::new();
            for (ci, cell) in row.content.iter().enumerate() {
                while slots[ri].get(col).is_some_and(|s| s.is_some()) {
                    col += 1;
                }
                let (cs, rs) = (cell.span("colspan"), cell.span("rowspan"));
                let rs = rs.min(height - ri);
                for line in slots.iter_mut().skip(ri).take(rs) {
                    if line.len() < col + cs {
                        line.resize(col + cs, None);
                    }
                    for s in &mut line[col..col + cs] {
                        *s = Some((ri, ci));
                    }
                }
                rr.push(Rect {
                    top: ri,
                    left: col,
                    bottom: ri + rs,
                    right: col + cs,
                });
                col += cs;
            }
            rects.push(rr);
        }
        let width = slots.iter().map(|r| r.len()).max().unwrap_or(0);
        for r in &mut slots {
            r.resize(width, None);
        }
        Grid {
            width,
            height,
            slots,
            rects,
        }
    }

    /// Grow `rect` until no cell sticks out of it.
    fn expand(&self, mut rect: Rect) -> Rect {
        loop {
            let mut next = rect;
            for r in rect.top..rect.bottom {
                for c in rect.left..rect.right {
                    if let Some((ri, ci)) = self.slots[r][c] {
                        next = next.union(self.rects[ri][ci]);
                    }
                }
            }
            if next == rect {
                return rect;
            }
            rect = next;
        }
    }

    fn row_is_header(&self, table: &Node, row: usize) -> bool {
        row < self.height
            && (0..self.width).all(|c| {
                self.slots[row][c]
                    .is_some_and(|(ri, ci)| table.content[ri].content[ci].is("tableHeader"))
            })
    }

    fn column_is_header(&self, table: &Node, col: usize) -> bool {
        col < self.width
            && (0..self.height).all(|r| {
                self.slots[r][col]
                    .is_some_and(|(ri, ci)| table.content[ri].content[ci].is("tableHeader"))
            })
    }
}

struct TableCtx {
    /// Path to the table node.
    path: Vec<usize>,
    /// Where the table's content starts.
    start: usize,
    grid: Grid,
    /// The selected cells' rectangle.
    rect: Rect,
    /// The caret's cell: (row index, cell index).
    caret: (usize, usize),
}

/// Positions in a table: before each row and each cell.
struct Layout {
    row_pos: Vec<usize>,
    cell_pos: Vec<Vec<usize>>,
    /// The end of the table's content.
    end: usize,
}

impl Layout {
    fn new(table: &Node, start: usize) -> Layout {
        let mut row_pos = Vec::new();
        let mut cell_pos = Vec::new();
        let mut p = start;
        for row in &table.content {
            row_pos.push(p);
            let mut q = p + 1;
            let mut cp = Vec::new();
            for cell in &row.content {
                cp.push(q);
                q += cell.node_size();
            }
            cell_pos.push(cp);
            p += row.node_size();
        }
        Layout {
            row_pos,
            cell_pos,
            end: p,
        }
    }

    fn row_size(&self, row: usize) -> usize {
        self.row_pos.get(row + 1).copied().unwrap_or(self.end) - self.row_pos[row]
    }

    /// Where a cell inserted at index `k` of row `row` goes.
    fn cell_insert_pos(&self, table: &Node, row: usize, k: usize) -> usize {
        self.cell_pos[row]
            .get(k)
            .copied()
            .unwrap_or(self.row_pos[row] + table.content[row].node_size() - 1)
    }
}

/// Delete row `row`: a cell that started above it loses a row of span; one that goes on below
/// it moves down into the next row.
fn remove_row(table: &mut Node, row: usize) {
    let g = Grid::new(table);
    let mut shrink: Vec<(usize, usize)> = Vec::new();
    let mut moved: Vec<(usize, Node)> = Vec::new(); // (column, cell)
    let mut seen: Vec<(usize, usize)> = Vec::new();
    for col in 0..g.width {
        let Some(s) = g.slots[row][col] else { continue };
        if seen.contains(&s) {
            continue;
        }
        seen.push(s);
        if row > 0 && g.slots[row - 1][col] == Some(s) {
            shrink.push(s);
        } else if row + 1 < g.height && g.slots[row + 1][col] == Some(s) {
            let mut cell = table.content[s.0].content[s.1].clone();
            let n = cell.span("rowspan") - 1;
            cell.set_span("rowspan", n);
            moved.push((g.rects[s.0][s.1].left, cell));
        }
    }
    for (ri, ci) in shrink {
        let cell = &mut table.content[ri].content[ci];
        let n = cell.span("rowspan") - 1;
        cell.set_span("rowspan", n);
    }
    // The next row's cells with where they start, the moved ones among them in column order.
    if !moved.is_empty() {
        let next = row + 1;
        let mut cells: Vec<(usize, Node)> = table.content[next]
            .content
            .iter()
            .enumerate()
            .map(|(j, n)| (g.rects[next][j].left, n.clone()))
            .collect();
        for (col, cell) in moved {
            let k = cells.iter().filter(|(l, _)| *l < col).count();
            cells.insert(k, (col, cell));
        }
        table.content[next].content = cells.into_iter().map(|(_, n)| n).collect();
    }
    table.content.remove(row);
}

/// Delete column `col`: a cell that spans over it shrinks, the others in it go.
fn remove_column(table: &mut Node, col: usize) {
    let g = Grid::new(table);
    let mut row = 0;
    let mut shrink: Vec<(usize, usize, usize)> = Vec::new();
    let mut gone: Vec<(usize, usize)> = Vec::new();
    while row < g.height {
        let Some((ri, ci)) = g.slots[row][col] else {
            row += 1;
            continue;
        };
        let spans_cols = (col > 0 && g.slots[row][col - 1] == Some((ri, ci)))
            || (col + 1 < g.width && g.slots[row][col + 1] == Some((ri, ci)));
        if spans_cols {
            shrink.push((ri, ci, col - g.rects[ri][ci].left));
        } else {
            gone.push((ri, ci));
        }
        row += table.content[ri].content[ci].span("rowspan");
    }
    for (ri, ci, off) in shrink {
        let cell = &mut table.content[ri].content[ci];
        let n = cell.span("colspan") - 1;
        cell.set_span("colspan", n);
        cell.remove_colwidth(off);
    }
    gone.sort_by(|a, b| b.cmp(a));
    for (ri, ci) in gone {
        table.content[ri].content.remove(ci);
    }
}

/// Map the positions of a selection.
fn shift_by(sel: &Selection, f: impl Fn(usize) -> usize) -> Selection {
    match *sel {
        Selection::Text { anchor, head } => Selection::Text {
            anchor: f(anchor),
            head: f(head),
        },
        Selection::Node { pos } => Selection::Node { pos: f(pos) },
        Selection::All => Selection::All,
    }
}

impl Node {
    /// `colspan` or `rowspan` (1 when unset).
    fn span(&self, k: &str) -> usize {
        self.attr(k).as_u64().unwrap_or(1).max(1) as usize
    }

    fn set_span(&mut self, k: &str, n: usize) {
        self.attrs.insert(k.to_string(), json!(n));
    }

    /// A cell holding one empty text block.
    fn is_empty_cell(&self) -> bool {
        self.content.len() == 1
            && self.content[0].is_textblock()
            && self.content[0].content.is_empty()
    }

    /// The column widths of a cell, one per column it spans (0: not set), or none.
    fn colwidth_all(&self) -> Option<Vec<f64>> {
        self.attr("colwidth")
            .as_array()
            .map(|a| a.iter().map(|w| w.as_f64().unwrap_or(0.0)).collect())
    }

    fn colwidth_at(&self, i: usize) -> Option<f64> {
        self.colwidth_all()
            .and_then(|w| w.get(i).copied())
            .filter(|w| *w > 0.0)
    }

    /// A column was added inside this cell at offset `at`.
    fn insert_colwidth(&mut self, at: usize) {
        if let Some(mut w) = self.colwidth_all() {
            w.insert(at.min(w.len()), 0.0);
            self.attrs.insert("colwidth".into(), json!(w));
        }
    }

    /// The column at offset `at` of this cell was deleted.
    fn remove_colwidth(&mut self, at: usize) {
        if let Some(mut w) = self.colwidth_all() {
            if at < w.len() {
                w.remove(at);
            }
            let v = if w.iter().any(|x| *x > 0.0) {
                json!(w)
            } else {
                Value::Null
            };
            self.attrs.insert("colwidth".into(), v);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::notation::{parse, serialize};
    use crate::Editor;
    use serde_json::json;

    /// Equal as documents (the expectation may use the short `<paragraph/>`).
    fn same(actual: String, expected: &str) {
        let expected = crate::notation::canonical(expected, true).unwrap();
        assert_eq!(actual, expected);
    }

    fn ed(src: &str) -> Editor {
        let (doc, sel) = parse(src).unwrap();
        Editor::new(doc, sel.unwrap())
    }

    fn show(e: &Editor) -> String {
        serialize(&e.doc, Some(&e.sel), &|_, v| v.clone())
    }

    fn run(src: &str, cmd: &str) -> String {
        let mut e = ed(src);
        assert!(e.command(cmd, &json!({})).unwrap(), "{cmd} did nothing");
        show(&e)
    }

    /// A plain cell holding `text` (which may carry the selection marks).
    fn c(text: &str) -> String {
        format!("<tableCell><paragraph>{text}</paragraph></tableCell>")
    }

    /// Strip the selection marks of a result.
    fn bare(s: String) -> String {
        s.replace(['|', '[', ']'], "")
    }

    #[test]
    fn merging_a_block_of_cells_keeps_the_text_of_all_of_them() {
        let src = format!(
            "<table><tableRow>{}{}</tableRow><tableRow>{}{}</tableRow></table><paragraph/>",
            c("[a"),
            c("b"),
            c("c"),
            c("d]")
        );
        let mut e = ed(&src);
        assert!(e.can_merge_cells());
        assert!(e.merge_cells(None));
        same(
            show(&e),
            "<table><tableRow><tableCell colspan=2 rowspan=2><paragraph>|a</paragraph><paragraph>b</paragraph><paragraph>c</paragraph><paragraph>d</paragraph></tableCell></tableRow><tableRow/></table><paragraph/>"
        );
        assert!(e.can_split_cell());
    }

    #[test]
    fn merging_leaves_out_empty_cells_and_replaces_an_empty_first_one() {
        let src = format!(
            "<table><tableRow>{}{}{}</tableRow></table><paragraph/>",
            c("["),
            c("x"),
            c("]")
        );
        same(
            run(&src, "mergeCells"),
            "<table><tableRow><tableCell colspan=3><paragraph>|x</paragraph></tableCell></tableRow></table><paragraph/>"
        );
    }

    #[test]
    fn merging_one_cell_does_nothing_unless_a_rectangle_is_given() {
        let mut e = ed(&format!(
            "<table><tableRow>{}{}</tableRow></table><paragraph/>",
            c("a|"),
            c("b")
        ));
        assert!(!e.can_merge_cells());
        assert!(!e.merge_cells(None));
        let rect = json!({ "top": 0, "left": 0, "bottom": 0, "right": 1 });
        assert!(e.command("mergeCells", &rect).unwrap());
        same(
            show(&e),
            "<table><tableRow><tableCell colspan=2><paragraph>|a</paragraph><paragraph>b</paragraph></tableCell></tableRow></table><paragraph/>"
        );
    }

    #[test]
    fn a_rectangle_that_cuts_a_merged_cell_takes_it_whole() {
        let src = "<table><tableRow><tableCell colspan=2><paragraph>[ab</paragraph></tableCell><tableCell><paragraph>c</paragraph></tableCell></tableRow>\
                   <tableRow><tableCell><paragraph>d</paragraph></tableCell><tableCell><paragraph>e]</paragraph></tableCell><tableCell><paragraph>f</paragraph></tableCell></tableRow></table><paragraph/>";
        same(
            run(src, "mergeCells"),
            "<table><tableRow><tableCell colspan=2 rowspan=2><paragraph>|ab</paragraph><paragraph>d</paragraph><paragraph>e</paragraph></tableCell><tableCell><paragraph>c</paragraph></tableCell></tableRow>\
             <tableRow><tableCell><paragraph>f</paragraph></tableCell></tableRow></table><paragraph/>"
        );
    }

    #[test]
    fn splitting_makes_single_cells_of_the_same_kind() {
        let src = "<table><tableRow><tableHeader colspan=2><paragraph>h|</paragraph></tableHeader></tableRow>\
                   <tableRow><tableCell><paragraph>a</paragraph></tableCell><tableCell><paragraph>b</paragraph></tableCell></tableRow></table><paragraph/>";
        same(
            run(src, "splitCell"),
            "<table><tableRow><tableHeader><paragraph>h|</paragraph></tableHeader><tableHeader><paragraph/></tableHeader></tableRow>\
             <tableRow><tableCell><paragraph>a</paragraph></tableCell><tableCell><paragraph>b</paragraph></tableCell></tableRow></table><paragraph/>"
        );
        let mut e = ed(&format!(
            "<table><tableRow>{}</tableRow></table><paragraph/>",
            c("a|")
        ));
        assert!(!e.can_split_cell());
        assert!(!e.split_cell());
    }

    #[test]
    fn splitting_a_cell_that_spans_rows_fills_the_rows_below() {
        let src = "<table><tableRow><tableCell rowspan=2><paragraph>a|</paragraph></tableCell><tableCell><paragraph>b</paragraph></tableCell></tableRow>\
                   <tableRow><tableCell><paragraph>c</paragraph></tableCell></tableRow></table><paragraph/>";
        same(
            run(src, "splitCell"),
            "<table><tableRow><tableCell><paragraph>a|</paragraph></tableCell><tableCell><paragraph>b</paragraph></tableCell></tableRow>\
             <tableRow><tableCell><paragraph/></tableCell><tableCell><paragraph>c</paragraph></tableCell></tableRow></table><paragraph/>"
        );
    }

    #[test]
    fn a_new_column_inside_a_wide_cell_widens_it() {
        let src = "<table><tableRow><tableCell colspan=2><paragraph>a|</paragraph></tableCell></tableRow>\
                   <tableRow><tableCell><paragraph>b</paragraph></tableCell><tableCell><paragraph>c</paragraph></tableCell></tableRow></table><paragraph/>";
        // After the wide cell's last column every row gets a cell.
        same(
            run(src, "addColumnAfter"),
            "<table><tableRow><tableCell colspan=2><paragraph>a|</paragraph></tableCell><tableCell><paragraph/></tableCell></tableRow>\
             <tableRow><tableCell><paragraph>b</paragraph></tableCell><tableCell><paragraph>c</paragraph></tableCell><tableCell><paragraph/></tableCell></tableRow></table><paragraph/>"
        );
        // Before the second column: the wide cell grows, the other row gets a cell.
        let src = "<table><tableRow><tableCell colspan=2><paragraph>a</paragraph></tableCell></tableRow>\
                   <tableRow><tableCell><paragraph>b</paragraph></tableCell><tableCell><paragraph>|c</paragraph></tableCell></tableRow></table><paragraph/>";
        same(
            run(src, "addColumnBefore"),
            "<table><tableRow><tableCell colspan=3><paragraph>a</paragraph></tableCell></tableRow>\
             <tableRow><tableCell><paragraph>b</paragraph></tableCell><tableCell><paragraph/></tableCell><tableCell><paragraph>|c</paragraph></tableCell></tableRow></table><paragraph/>"
        );
    }

    #[test]
    fn a_new_row_inside_a_tall_cell_lengthens_it() {
        let tall = |a: &str, b: &str, c: &str| {
            format!(
                "<table><tableRow><tableCell rowspan=2><paragraph>{a}</paragraph></tableCell><tableCell><paragraph>{b}</paragraph></tableCell></tableRow><tableRow><tableCell><paragraph>{c}</paragraph></tableCell></tableRow></table><paragraph/>"
            )
        };
        // After the tall cell's last row: a row at the end with a cell in each column.
        same(
            run(&tall("a|", "b", "c"), "addRowAfter"),
            "<table><tableRow><tableCell rowspan=2><paragraph>a|</paragraph></tableCell><tableCell><paragraph>b</paragraph></tableCell></tableRow><tableRow><tableCell><paragraph>c</paragraph></tableCell></tableRow><tableRow><tableCell><paragraph/></tableCell><tableCell><paragraph/></tableCell></tableRow></table><paragraph/>",
        );
        // Between the two rows (after the first row's other cell): the tall cell grows and only
        // its neighbour's column gets a cell.
        same(
            run(&tall("a", "b|", "c"), "addRowAfter"),
            "<table><tableRow><tableCell rowspan=3><paragraph>a</paragraph></tableCell><tableCell><paragraph>b|</paragraph></tableCell></tableRow><tableRow><tableCell><paragraph/></tableCell></tableRow><tableRow><tableCell><paragraph>c</paragraph></tableCell></tableRow></table><paragraph/>",
        );
        // Before the second row: the same, and the caret in c moves past the new row.
        same(
            run(&tall("a", "b", "c|"), "addRowBefore"),
            "<table><tableRow><tableCell rowspan=3><paragraph>a</paragraph></tableCell><tableCell><paragraph>b</paragraph></tableCell></tableRow><tableRow><tableCell><paragraph/></tableCell></tableRow><tableRow><tableCell><paragraph>c|</paragraph></tableCell></tableRow></table><paragraph/>",
        );
    }

    #[test]
    fn deleting_a_row_shrinks_or_moves_the_cells_that_span_it() {
        let tall = |b: &str, c: &str, a: &str| {
            format!(
                "<table><tableRow><tableCell rowspan=2><paragraph>{a}</paragraph></tableCell><tableCell><paragraph>{b}</paragraph></tableCell></tableRow>\
                 <tableRow><tableCell><paragraph>{c}</paragraph></tableCell></tableRow></table><paragraph/>"
            )
        };
        // The caret's row is the first: the tall cell moves down into the second row.
        same(
            bare(run(&tall("b|", "c", "a"), "deleteRow")),
            "<table><tableRow><tableCell><paragraph>a</paragraph></tableCell><tableCell><paragraph>c</paragraph></tableCell></tableRow></table><paragraph/>"
        );
        // The second row goes: the tall cell shrinks.
        same(
            bare(run(&tall("b", "c|", "a"), "deleteRow")),
            "<table><tableRow><tableCell><paragraph>a</paragraph></tableCell><tableCell><paragraph>b</paragraph></tableCell></tableRow></table><paragraph/>"
        );
        // A caret in the tall cell deletes both its rows: that is all of them, so the table goes.
        let out = run(&tall("b", "c", "a|"), "deleteRow");
        assert!(!out.contains("table"), "{out}");
    }

    #[test]
    fn deleting_a_column_shrinks_the_wide_cells_over_it() {
        let src = "<table><tableRow><tableCell colspan=2><paragraph>a</paragraph></tableCell><tableCell><paragraph>x</paragraph></tableCell></tableRow>\
                   <tableRow><tableCell><paragraph>b|</paragraph></tableCell><tableCell><paragraph>c</paragraph></tableCell><tableCell><paragraph>y</paragraph></tableCell></tableRow></table><paragraph/>";
        same(
            bare(run(src, "deleteColumn")),
            "<table><tableRow><tableCell><paragraph>a</paragraph></tableCell><tableCell><paragraph>x</paragraph></tableCell></tableRow>\
             <tableRow><tableCell><paragraph>c</paragraph></tableCell><tableCell><paragraph>y</paragraph></tableCell></tableRow></table><paragraph/>"
        );
    }

    #[test]
    fn a_row_next_to_a_lone_header_row_is_plain() {
        let src = "<table><tableRow><tableHeader><paragraph>h|</paragraph></tableHeader></tableRow></table><paragraph/>";
        same(
            run(src, "addRowAfter"),
            "<table><tableRow><tableHeader><paragraph>h|</paragraph></tableHeader></tableRow><tableRow><tableCell><paragraph/></tableCell></tableRow></table><paragraph/>"
        );
    }

    #[test]
    fn the_caret_keeps_its_text_when_cells_are_added_before_it() {
        // Two rows, caret in the second: a column added in both rows moves it by two cells.
        let src = format!(
            "<table><tableRow>{}{}</tableRow><tableRow>{}{}</tableRow></table><paragraph/>",
            c("a"),
            c("b"),
            c("c"),
            c("d|")
        );
        let out = run(&src, "addColumnBefore");
        assert!(out.contains("<paragraph>d|</paragraph>"), "{out}");
        let out = run(&src, "addColumnAfter");
        assert!(out.contains("<paragraph>d|</paragraph>"), "{out}");
    }
}
