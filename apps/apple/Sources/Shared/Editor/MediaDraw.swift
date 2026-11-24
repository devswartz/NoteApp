import Foundation
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// The resize handles of a selected image, as the web draws them (editor.css "Images (resizable)"): a pill in the middle
/// of the left and right edges and a round dot in each bottom corner. Dragging any of them changes the width and keeps
/// the picture's shape.
enum ImageHandle: CaseIterable {
    case bottomLeft, bottomRight, left, right

    /// The left handles grow the picture when dragged to the left.
    var growsLeft: Bool { self == .left || self == .bottomLeft }

    /// The drawn mark inside the image's rect.
    func mark(in r: CGRect) -> CGRect {
        let pill = min(44, max(r.height / 2, 16))
        switch self {
        case .left: return CGRect(x: r.minX + 4, y: r.midY - pill / 2, width: 5, height: pill)
        case .right: return CGRect(x: r.maxX - 9, y: r.midY - pill / 2, width: 5, height: pill)
        case .bottomLeft: return CGRect(x: r.minX + 4, y: r.maxY - 18, width: 14, height: 14)
        case .bottomRight: return CGRect(x: r.maxX - 18, y: r.maxY - 18, width: 14, height: 14)
        }
    }

    /// The area that takes a press or touch (`pad` points around the mark).
    func hit(in r: CGRect, pad: CGFloat) -> CGRect { mark(in: r).insetBy(dx: -pad, dy: -pad) }

    /// The handle at `p`, corners first.
    static func at(_ p: CGPoint, in r: CGRect, pad: CGFloat) -> ImageHandle? {
        allCases.first { $0.hit(in: r, pad: pad).contains(p) }
    }

    func draw(in r: CGRect) {
        let m = mark(in: r)
        let round = self == .bottomLeft || self == .bottomRight
        let radius: CGFloat = round ? m.width / 2 : 3
        PlatformColor(white: 1, alpha: 0.85).setFill()
        PlatformPath(roundedRect: m.insetBy(dx: -1.5, dy: -1.5), cornerRadius: radius + 1.5).fill()
        PlatformColor(white: 0, alpha: 0.6).setFill()
        PlatformPath(roundedRect: m, cornerRadius: radius).fill()
    }
}

extension BoxPainter {
    /// A selected image or file card: the accent ring (`.ProseMirror-selectednode`, `.file-card.is-selected`), and an image's
    /// resize handles. `rect` is the picture in the view's coordinates.
    func mediaSelection(_ m: BoxMedia, rect: CGRect) {
        let p = palette
        switch m.kind {
        case .image:
            p.accent.setStroke()
            let ring = PlatformPath(roundedRect: rect.insetBy(dx: -1, dy: -1), cornerRadius: 9)
            ring.lineWidth = 2
            ring.stroke()
            for h in ImageHandle.allCases { h.draw(in: rect) }
        case .file:
            p.accentSoft.setStroke()
            let soft = PlatformPath(roundedRect: rect.insetBy(dx: -1, dy: -1), cornerRadius: 9)
            soft.lineWidth = 2
            soft.stroke()
            p.accent.setStroke()
            let ring = PlatformPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 8)
            ring.lineWidth = 1
            ring.stroke()
        }
    }
}
