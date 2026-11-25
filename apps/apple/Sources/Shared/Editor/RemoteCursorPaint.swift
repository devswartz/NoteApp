import Foundation
import NotiveloCore
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// How other people's carets are drawn in a box (the web's y-prosemirror cursor plugin, `collab-cursor` in
/// src/styles): a 2 pt line in their colour, a small name flag above it, and a soft tint over a selection. The rects are in
/// the box view's drawing space (top-left origin, as the box views draw).
enum RemoteCursorPaint {
    /// The selection tint: the person's colour at 20 %.
    static func tint(_ color: String, rects: [CGRect]) {
        PlatformColor(css: color).withAlphaComponent(0.2).setFill()
        for r in rects { platformFill(r) }
    }

    /// The caret line and the name flag. `caret` is the caret's rect (any width), `bounds` the view's bounds (the flag stays
    /// inside it: below the caret when there is no room above).
    static func caret(name: String, color: String, caret: CGRect, bounds: CGRect) {
        let c = PlatformColor(css: color)
        c.setFill()
        let line = CGRect(x: caret.minX - 1, y: caret.minY, width: 2, height: max(caret.height, 16))
        platformFill(line)
        let font = WebType.ui(10.5, 600)
        let text = NSAttributedString(string: name, attributes: [.font: font, .foregroundColor: PlatformColor.white])
        let size = text.size()
        let flag = CGSize(width: ceil(size.width) + 8, height: ceil(size.height) + 2)
        var origin = CGPoint(x: line.minX, y: line.minY - flag.height)
        if origin.y < 0 { origin.y = line.maxY }
        origin.x = min(max(origin.x, 0), max(bounds.width - flag.width, 0))
        let rect = CGRect(origin: origin, size: flag)
        c.setFill()
        PlatformPath(roundedRect: rect, cornerRadius: 3).fill()
        text.draw(at: CGPoint(x: rect.minX + 4, y: rect.minY + 1))
    }
}

/// The demo carets of the `cursors` look state: Ana's caret and Ben's selection (two boxes of the demo page).
enum LookCursors {
    static func demo(boxIds: [String]) -> [BoxCursor] {
        guard let a = boxIds.first else { return [] }
        let b = boxIds.count > 1 ? boxIds[1] : a
        return [
            BoxCursor(clientId: 1, userId: "ana", name: "Ana Silva", color: "#ec4899", boxId: a, anchor: 4, head: 4),
            BoxCursor(clientId: 2, userId: "ben", name: "Ben Okafor", color: "#0ea5e9", boxId: b, anchor: 0, head: 5),
        ]
    }
}
