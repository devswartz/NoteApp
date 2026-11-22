import NotiveloCore
import SwiftUI

/// The page's canvas (title, sub-line, boxes) on the page's colour. iPad/iPhone: the native UIKit canvas. Mac: `MacPageCanvas`
/// (Sources/macOS), a read-only placeholder until the TextKit 2 box view of M6 part 2 replaces it.
struct PageCanvas: View {
    let page: PageSnapshot
    let host: PageEditHost?
    let title: String
    let subline: String
    let palette: Palette
    var decor: [String: TaskDecor] = [:]
    var showAddIcon = false
    var stacked = false
    var notify: ((String) -> Void)?

    var body: some View {
        #if os(iOS)
        PageCanvasView(page: page, host: host, title: title, subline: subline, palette: palette,
                       decor: decor, showAddIcon: showAddIcon, stacked: stacked, notify: notify)
            .ignoresSafeArea(.container, edges: .bottom)
            .ignoresSafeArea(.keyboard)
        #else
        MacPageCanvas(page: page, host: host, title: title, subline: subline, palette: palette)
        #endif
    }
}
