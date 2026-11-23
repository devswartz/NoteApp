import NotiveloCore
import SwiftUI

/// The page's canvas (title, sub-line, boxes) on the page's colour. iPad/iPhone: the native UIKit canvas. Mac: `MacPageCanvas`
/// (Sources/macOS), the TextKit 2 box canvas over the editor engine.
struct PageCanvas: View {
    let page: PageSnapshot
    let host: PageEditHost?
    let title: String
    let subline: String
    let palette: Palette
    var decor: [String: TaskDecor] = [:]
    var showAddIcon = false
    /// The page's icon (an emoji), and what a tap on the row above the title does (nil: it can't be changed).
    var icon: String?
    var onIcon: ((CGRect) -> Void)?
    var stacked = false
    var notify: ((String) -> Void)?

    var body: some View {
        #if os(iOS)
        PageCanvasView(page: page, host: host, title: title, subline: subline, palette: palette,
                       decor: decor, showAddIcon: showAddIcon, icon: icon, onIcon: onIcon, stacked: stacked, notify: notify)
            .ignoresSafeArea(.container, edges: .bottom)
            .ignoresSafeArea(.keyboard)
        #else
        MacPageCanvas(page: page, host: host, title: title, subline: subline, palette: palette, decor: decor, canEditIcon: onIcon != nil,
                      showAddIcon: showAddIcon && onIcon == nil, icon: icon, onIcon: onIcon, notify: notify)
        #endif
    }
}
