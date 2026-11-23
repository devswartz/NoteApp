import Foundation
#if canImport(UIKit)
import UIKit
typealias PlatformImage = UIImage
typealias PlatformPath = UIBezierPath
#else
import AppKit
typealias PlatformImage = NSImage
typealias PlatformPath = NSBezierPath
#endif

// The drawing calls the box renderer and painters make, in one spelling for UIKit and AppKit. The drawing is written
// top-left origin (UIKit's): on the Mac images are made flipped and views are flipped, so the same numbers draw the same.

/// Fill `rect` with the colour set by `setFill()`.
func platformFill(_ rect: CGRect) {
    #if canImport(UIKit)
    UIRectFill(rect)
    #else
    NSBezierPath(rect: rect).fill()
    #endif
}

extension NSTextAttachment {
    /// An attachment drawn from `image` (no attachment view): one U+FFFC in the text.
    static func drawing(_ image: PlatformImage) -> NSTextAttachment {
        #if canImport(UIKit)
        let a = NSTextAttachment(image: image)
        #else
        let a = NSTextAttachment()
        a.image = image
        #endif
        a.allowsTextAttachmentView = false
        return a
    }
}

#if canImport(UIKit)

extension UIImage {
    /// An image `size` big, drawn by `draw` (top-left origin) when made.
    static func render(_ size: CGSize, _ draw: @escaping (CGContext) -> Void) -> UIImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        return UIGraphicsImageRenderer(size: size, format: format).image { draw($0.cgContext) }
    }

    /// Draw at `p` (top-left).
    func paint(at p: CGPoint) { draw(at: p) }
}

extension UIBezierPath {
    /// A dash pattern: `on` drawn, `off` skipped.
    func dash(_ on: CGFloat, _ off: CGFloat) { setLineDash([on, off], count: 2, phase: 0) }
}

extension UIFont {
    func italicVariant(_ size: CGFloat) -> UIFont {
        guard let d = fontDescriptor.withSymbolicTraits(fontDescriptor.symbolicTraits.union(.traitItalic)) else { return self }
        return UIFont(descriptor: d, size: size)
    }
}

#else

extension NSImage {
    /// An image `size` big, drawn by `draw` (top-left origin, flipped) whenever it is drawn.
    static func render(_ size: CGSize, _ draw: @escaping (CGContext) -> Void) -> NSImage {
        NSImage(size: NSSize(width: size.width, height: size.height), flipped: true) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            draw(ctx)
            return true
        }
    }

    /// Draw at `p` (top-left), upright in a flipped context.
    func paint(at p: CGPoint) {
        draw(in: NSRect(origin: p, size: size), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }

    /// A Lucide icon (`lucide-<name>` in the asset catalog) tinted `color`, `size` points square.
    static func lucide(_ name: String, size: CGFloat, color: NSColor) -> NSImage? {
        guard let base = NSImage(named: "lucide-\(name)") else { return nil }
        return NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            base.draw(in: rect)
            ctx.setBlendMode(.sourceAtop)
            ctx.setFillColor(color.cgColor)
            ctx.fill(rect)
            return true
        }
    }
}

extension NSFont {
    /// UIFont's `lineHeight`.
    var lineHeight: CGFloat { ascender - descender + leading }

    func italicVariant(_ size: CGFloat) -> NSFont {
        let d = fontDescriptor.withSymbolicTraits(fontDescriptor.symbolicTraits.union(.italic))
        return NSFont(descriptor: d, size: size) ?? self
    }
}

extension NSBezierPath {
    /// UIBezierPath's spelling.
    convenience init(roundedRect rect: CGRect, cornerRadius r: CGFloat) {
        self.init(roundedRect: rect, xRadius: r, yRadius: r)
    }

    func addLine(to p: CGPoint) { line(to: p) }

    func dash(_ on: CGFloat, _ off: CGFloat) {
        let pattern: [CGFloat] = [on, off]
        setLineDash(pattern, count: 2, phase: 0)
    }
}

#endif
