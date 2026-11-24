import NotiveloCore
import SwiftUI

/// The page area on the Mac: the native canvas (`MacCanvas`, Sources/macOS/Editor) on the page's colour, with View > Zoom and
/// pinch tied to `Shell.zoom`. Boxes are TextKit 2 text views over the editor engine; the focused one registers with
/// `EditorFocus`, so the ribbon and the Format menu work on it.
struct MacPageCanvas: View {
    let page: PageSnapshot
    let host: PageEditHost?
    let title: String
    let subline: String
    let palette: Palette
    var decor: [String: TaskDecor] = [:]
    /// The page's icon; whether it can be changed (the row above the title opens `onIcon`'s picker); always showing "Add icon".
    var canEditIcon = false
    var showAddIcon = false
    var icon: String?
    var onIcon: ((CGRect) -> Void)?
    var onRename: ((String, String) -> Void)?
    var notify: ((String) -> Void)?
    @Environment(Shell.self) private var shell

    var body: some View {
        MacCanvas(page: page, host: host, title: title, subline: subline, palette: palette, decor: decor,
                  zoom: shell.zoom, onZoom: { shell.zoom = $0 }, icon: icon, canEditIcon: canEditIcon, showAddIcon: showAddIcon,
                  onIcon: onIcon, onRename: onRename, notify: notify)
            .background(palette.bg.color)
    }
}
