import AppKit
import NotiveloCore

/// A page's ink on the Mac canvas, read-only (drawing is on the iPad with the Pencil). Strokes are the core's: the outline
/// from `inkOutlineOps` is filled in the stroke's colour (nonzero rule), in page points from the page origin, in the same
/// flipped space as the surface so they scroll and zoom with the boxes. Two of these sit in the surface: highlighters
/// behind the boxes and pens in front of them (the web's `InkRenderer` layers). It never takes a click.
final class MacInkView: NSView {
    private struct Item {
        let id: String
        let path: CGPath
        let color: UInt32
    }

    /// Highlighters (behind the boxes) or pens (in front).
    let under: Bool
    private var items: [Item] = []
    private var cache: [String: CGPath] = [:]
    /// Where the page's origin is on the surface.
    var origin = CGPoint.zero {
        didSet { if origin != oldValue { needsDisplay = true } }
    }
    /// The dark theme draws near-black ink near-white.
    var dark = false {
        didSet { if dark != oldValue { needsDisplay = true } }
    }
    /// Where the view sorts among the surface's subviews (the boxes sort by z; these go to the ends).
    var sortKey: Double { under ? -Double.infinity : Double.infinity }

    init(under: Bool) {
        self.under = under
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var mouseDownCanMoveWindow: Bool { false }

    var isEmpty: Bool { items.isEmpty }

    func set(_ strokes: [InkStrokeInfo]) {
        var next: [Item] = []
        var kept: [String: CGPath] = [:]
        for s in strokes where s.readable && s.bounds != nil && (s.tool == 1) == under {
            let path: CGPath
            if let known = cache[s.id] {
                path = known
            } else {
                let ops = inkOutlineOps(data: s.data)
                guard !ops.isEmpty else { continue }
                path = InkGeometry.path(ops)
            }
            kept[s.id] = path
            next.append(Item(id: s.id, path: path, color: s.color))
        }
        cache = kept
        items = next
        needsDisplay = true
    }

    func clear() { set([]) }

    override func draw(_ dirtyRect: NSRect) {
        guard !items.isEmpty, let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        ctx.translateBy(x: origin.x, y: origin.y)
        for item in items {
            ctx.addPath(item.path)
            ctx.setFillColor(InkGeometry.color(item.color, dark: dark))
            ctx.fillPath(using: .winding)
        }
        ctx.restoreGState()
    }
}
