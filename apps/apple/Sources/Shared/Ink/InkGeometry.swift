import CoreGraphics
import Foundation

/// Drawing parts of the page's ink that don't depend on UIKit or AppKit: the core's outline commands as a path, and the
/// colour a stroke is drawn in. Used by the iPad's `InkController` and the Mac's read-only `MacInkView`.
enum InkGeometry {
    /// The core's path commands as a CGPath: `0 x y` move, `1 x y` line, `2 cx cy r` a whole circle, `3` close.
    static func path(_ ops: [Float]) -> CGPath {
        let p = CGMutablePath()
        var i = 0
        while i < ops.count {
            switch Int(ops[i]) {
            case 0:
                guard i + 2 < ops.count else { return p }
                p.move(to: CGPoint(x: CGFloat(ops[i + 1]), y: CGFloat(ops[i + 2])))
                i += 3
            case 1:
                guard i + 2 < ops.count else { return p }
                p.addLine(to: CGPoint(x: CGFloat(ops[i + 1]), y: CGFloat(ops[i + 2])))
                i += 3
            case 2:
                guard i + 3 < ops.count else { return p }
                let c = CGPoint(x: CGFloat(ops[i + 1]), y: CGFloat(ops[i + 2])), r = CGFloat(ops[i + 3])
                p.move(to: CGPoint(x: c.x + r, y: c.y))
                // Increasing angle, as the canvas's `arc(0, 2 pi)`: the same winding as the outline, so the nonzero rule fills it.
                p.addArc(center: c, radius: r, startAngle: 0, endAngle: .pi * 2, clockwise: false)
                p.closeSubpath()
                i += 4
            default:
                p.closeSubpath()
                i += 1
            }
        }
        return p
    }

    /// The colour a stroke is drawn in (0xRRGGBBAA): in the dark theme near-black ink is drawn near-white
    /// (`displayColor` in src/ink/render.ts).
    static func color(_ c: UInt32, dark: Bool) -> CGColor {
        var r = Double((c >> 24) & 255), g = Double((c >> 16) & 255), b = Double((c >> 8) & 255)
        let a = Double(c & 255) / 255
        if dark, (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.25 { r = 0xE6; g = 0xE6; b = 0xE6 }
        return CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }
}
