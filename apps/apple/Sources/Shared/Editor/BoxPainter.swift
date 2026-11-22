import Foundation
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// A line of a box as drawn: its top, height and baseline in the view's coordinates.
struct BoxLineBox {
    let top: CGFloat
    let height: CGFloat
    let baseline: CGFloat
}

/// Draws what the renderer leaves for the view to draw around the text (BoxRendering's decorations and markers): callout,
/// code block, quote and table backgrounds, a task's note guide, list markers, checklist boxes and toggles. The same
/// drawing as the iPad's `BoxTextView`; the Mac's box view calls this. Coordinates are the view's (top-left origin).
struct BoxPainter {
    let palette: Palette

    /// A decoration over the lines from `first` to `bottom` (the bottom of its last line); `left` and `right` are the
    /// block's edges.
    func decoration(_ d: BoxDecoration, left: CGFloat, right: CGFloat, first: BoxLineBox, bottom: CGFloat) {
        let p = palette
        switch d.kind {
        case let .callout(emoji):
            let r = CGRect(x: left, y: first.top - d.topPad, width: right - left, height: bottom - first.top + d.topPad + d.bottomPad)
            let path = PlatformPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 8)
            p.bgSubtle.setFill()
            path.fill()
            p.border.setStroke()
            path.lineWidth = 1
            path.stroke()
            let e = NSAttributedString(string: emoji, attributes: [.font: PlatformFont.systemFont(ofSize: 19)])
            let s = e.size()
            e.draw(at: CGPoint(x: left + 13 + (28 - s.width) / 2, y: r.minY + 13 + (28 - s.height) / 2))
        case let .code(language):
            let r = CGRect(x: left, y: first.top - d.topPad, width: right - left, height: bottom - first.top + d.topPad + d.bottomPad)
            let path = PlatformPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 8)
            p.bgSubtle.setFill()
            path.fill()
            p.border.setStroke()
            path.lineWidth = 1
            path.stroke()
            let names = ["ts": "TypeScript", "js": "JavaScript", "py": "Python", "swift": "Swift", "rust": "Rust", "json": "JSON",
                         "html": "HTML", "css": "CSS", "sh": "Shell", "bash": "Bash", "sql": "SQL", "go": "Go", "java": "Java"]
            let label = language.isEmpty ? "Plain text" : (names[language.lowercased()] ?? language)
            let attrs: [NSAttributedString.Key: Any] = [.font: WebType.ui(12), .foregroundColor: p.text2]
            NSAttributedString(string: label, attributes: attrs).draw(at: CGPoint(x: left + 14, y: r.minY + 9))
            let copy = NSAttributedString(string: "Copy", attributes: attrs)
            copy.draw(at: CGPoint(x: right - 14 - copy.size().width, y: r.minY + 9))
        case .quote:
            p.borderStrong.setFill()
            platformFill(CGRect(x: left, y: first.top - d.topPad, width: 3, height: bottom - first.top + d.topPad + d.bottomPad))
        case let .guide(done):
            let path = PlatformPath()
            path.move(to: CGPoint(x: left + 1, y: first.top - 4))
            path.addLine(to: CGPoint(x: left + 1, y: bottom + 4))
            path.lineWidth = 2
            if done { path.dash(4, 3) }
            p.border.setStroke()
            path.stroke()
        case let .table(rows, heights):
            let top = first.top - d.topPad
            let width = right - left
            let cols = max(rows.map(\.count).max() ?? 1, 1)
            let colW = width / CGFloat(cols)
            var y = top
            var ys: [CGFloat] = [top]
            for (i, row) in rows.enumerated() {
                let h = heights.indices.contains(i) ? heights[i] : 40.2
                for (j, cell) in row.enumerated() {
                    let r = CGRect(x: left + CGFloat(j) * colW, y: y, width: colW, height: h)
                    if cell.1 {
                        p.bgSubtle.setFill()
                        platformFill(r)
                    }
                    let text = BoxTextRenderer.cellText(cell.0, header: cell.1, color: p.text)
                    let natural = WebType.ui(16, cell.1 ? 600 : 400).lineHeight
                    text.draw(with: CGRect(x: r.minX + 10, y: r.minY + 6.5 + (27.2 - natural) / 2, width: colW - 20, height: h), options: .usesLineFragmentOrigin, context: nil)
                }
                y += h
                ys.append(y)
            }
            p.border.setFill()
            for yy in ys { platformFill(CGRect(x: left, y: yy, width: width, height: 1)) }
            for j in 0...cols { platformFill(CGRect(x: min(left + CGFloat(j) * colW, right - 1), y: top, width: 1, height: y - top + 1)) }
        }
    }

    /// A marker in the indent of the line at `line`; `x` is where the line's text starts.
    func marker(_ kind: BoxMarker.Kind, x: CGFloat, line: BoxLineBox) {
        let p = palette
        switch kind {
        case let .text(text):
            let font = text.attribute(.font, at: 0, effectiveRange: nil) as? PlatformFont ?? PlatformFont.systemFont(ofSize: 16)
            let w = text.size().width
            text.draw(at: CGPoint(x: max(x - w - 5, 0), y: line.baseline - font.ascender))
        case let .checkbox(checked):
            let r = CGRect(x: x - 8 - 15, y: line.top + (line.height - 15) / 2, width: 15, height: 15)
            let path = PlatformPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 2.5)
            if checked {
                p.accent.setFill()
                path.fill()
                PlatformImage.lucide("check", size: 11, color: .white)?.paint(at: CGPoint(x: r.minX + 2, y: r.minY + 2))
            } else {
                p.bg.setFill()
                path.fill()
                p.textMuted.setStroke()
                path.lineWidth = 1
                path.stroke()
            }
        case let .bullet(depth):
            let cx = x - 12.5, cy = line.baseline - 4.6
            let r = CGRect(x: cx - 2.75, y: cy - 2.75, width: 5.5, height: 5.5)
            p.text.setFill()
            p.text.setStroke()
            switch depth {
            case 0: PlatformPath(ovalIn: r).fill()
            case 1:
                let c = PlatformPath(ovalIn: r.insetBy(dx: 0.5, dy: 0.5))
                c.lineWidth = 1
                c.stroke()
            default: platformFill(r.insetBy(dx: 0.25, dy: 0.25))
            }
        case .fold:
            break // drawn separately (outside the text)
        case let .toggle(open):
            let cy = line.top + line.height / 2
            let tri = PlatformPath()
            if open {
                tri.move(to: CGPoint(x: x - 19.5, y: cy - 1.5))
                tri.addLine(to: CGPoint(x: x - 10.5, y: cy - 1.5))
                tri.addLine(to: CGPoint(x: x - 15, y: cy + 4.5))
            } else {
                tri.move(to: CGPoint(x: x - 17, y: cy - 4.5))
                tri.addLine(to: CGPoint(x: x - 17, y: cy + 4.5))
                tri.addLine(to: CGPoint(x: x - 11, y: cy))
            }
            tri.close()
            p.textMuted.setFill()
            tri.fill()
        }
    }
}
