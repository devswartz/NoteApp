import NotiveloCore
import SwiftUI

/// The ribbon's Table group (src/editor/Toolbar.tsx, the contextual group Office has as its Table tab): shown while the
/// caret is in a table. Row and column buttons, header row, merge and split, and a menu with the deletes.
struct TableRibbonGroup: View {
    let m: RibbonMetrics
    let state: TableState
    @Environment(Shell.self) private var shell
    let focus = EditorFocus.shared

    var body: some View {
        RibbonSeparator(m: m)
        // On a small window the group is the two most used buttons and the menu (which has the rest, with words).
        if m.small {
            RibbonButton(icon: "between-horizontal-end", m: m) { focus.run("addRowAfter") }
            RibbonButton(icon: "between-vertical-end", m: m) { focus.run("addColumnAfter") }
        } else {
            RibbonButton(icon: "between-horizontal-start", m: m) { focus.run("addRowBefore") }
            RibbonButton(icon: "between-horizontal-end", m: m) { focus.run("addRowAfter") }
            RibbonButton(icon: "between-vertical-start", m: m) { focus.run("addColumnBefore") }
            RibbonButton(icon: "between-vertical-end", m: m) { focus.run("addColumnAfter") }
            RibbonButton(icon: "panel-top", m: m, pressed: state.headerRow) { focus.run("toggleHeaderRow") }
            RibbonButton(icon: "table-cells-merge", m: m, enabled: state.canMerge) { focus.run("mergeCells") }
            RibbonButton(icon: "table-cells-split", m: m, enabled: state.canSplit) { focus.run("splitCell") }
        }
        RibbonButton(icon: "table", m: m, caret: true, anchor: "rb-table") { shell.menu = .tableMenu }
    }
}

/// The table menu: every table command with words (the ribbon's Table menu button, and the phone's Table button).
struct TableMenuCard: View {
    let palette: Palette
    let state: TableState?
    @Environment(Shell.self) private var shell
    @Environment(\.phoneLayout) private var phone
    let width: CGFloat

    private func run(_ name: String) {
        shell.menu = nil
        EditorFocus.shared.run(name)
    }

    var body: some View {
        let p = palette
        MenuCard(palette: p, width: phone ? width - 16 : 232, radius: phone ? 16 : 12, padding: phone ? 8 : 6) {
            MenuLabel(palette: p, text: "Table")
            Group {
                MenuItem(palette: p, title: "Insert row above", icon: "between-horizontal-start") { run("addRowBefore") }
                MenuItem(palette: p, title: "Insert row below", icon: "between-horizontal-end") { run("addRowAfter") }
                MenuItem(palette: p, title: "Insert column left", icon: "between-vertical-start") { run("addColumnBefore") }
                MenuItem(palette: p, title: "Insert column right", icon: "between-vertical-end") { run("addColumnAfter") }
            }
            MenuSeparator(palette: p)
            Group {
                MenuItem(palette: p, title: "Header row", icon: "panel-top", checked: state?.headerRow ?? false) { run("toggleHeaderRow") }
                MenuItem(palette: p, title: "Merge cells", icon: "table-cells-merge", disabled: !(state?.canMerge ?? false)) { run("mergeCells") }
                MenuItem(palette: p, title: "Split cell", icon: "table-cells-split", disabled: !(state?.canSplit ?? false)) { run("splitCell") }
            }
            MenuSeparator(palette: p)
            Group {
                MenuItem(palette: p, title: "Delete row", icon: "rows-3") { run("deleteRow") }
                MenuItem(palette: p, title: "Delete column", icon: "columns-3") { run("deleteColumn") }
                MenuItem(palette: p, title: "Delete table", icon: "trash", danger: true) { run("deleteTable") }
            }
        }
    }
}
