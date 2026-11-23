import AppKit
import NotiveloCore

/// A page's ink on the Mac canvas. Strokes are the core's: the outline from `inkOutlineOps` is filled in the stroke's colour
/// (nonzero rule), in page points from the page origin, in the same flipped space as the surface so they scroll and zoom with
/// the boxes. Two of these sit in the surface: highlighters behind the boxes and pens in front of them (the web's
/// `InkRenderer` layers). It never takes a click (`MacInkInput` does, while a pen tool is chosen).
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
    /// Strokes the whole-stroke eraser would take (drawn faint), and the strokes the lasso drags with the offset so far.
    var dimmed: Set<String> = [] {
        didSet { if dimmed != oldValue { needsDisplay = true } }
    }
    var moving: Set<String> = [] {
        didSet { if moving != oldValue { needsDisplay = true } }
    }
    var shift = CGSize.zero {
        didSet { if shift != oldValue { needsDisplay = true } }
    }
    /// Where the view sorts among the surface's subviews (the boxes sort by z; these go to the ends).
    var sortKey: Double { under ? -Double.infinity : Double.greatestFiniteMagnitude }

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
    /// Look mode (CI): outlines the stroke builder drew (no corpus page has ink this build can read), to show the drawing.
    func setDemo(_ list: [(ops: [Float], color: UInt32, highlighter: Bool)]) {
        items = list.enumerated().filter { $0.element.highlighter == under }
            .map { Item(id: "demo\($0.offset)", path: InkGeometry.path($0.element.ops), color: $0.element.color) }
        needsDisplay = true
    }


    override func draw(_ dirtyRect: NSRect) {
        guard !items.isEmpty, let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        ctx.translateBy(x: origin.x, y: origin.y)
        for item in items {
            ctx.saveGState()
            if moving.contains(item.id) { ctx.translateBy(x: shift.width, y: shift.height) }
            let color = InkGeometry.color(item.color, dark: dark)
            ctx.addPath(item.path)
            ctx.setFillColor(dimmed.contains(item.id) ? (color.copy(alpha: color.alpha * 0.25) ?? color) : color)
            ctx.fillPath(using: .winding)
            ctx.restoreGState()
        }
        ctx.restoreGState()
    }
}

/// The layer over the page that takes the mouse or trackpad while a pen tool is chosen (the web routes a mouse to the ink
/// layer too, `routePointer` in src/editor/canvasGeom.ts), and draws what is under way: the live stroke, the eraser's disc or
/// the lasso's loop, and the frame round the selection. Otherwise it is not there for clicks. Two-finger scrolls and pinches
/// are not its: they go on to the scroll view.
final class MacInkInput: NSView {
    var onDown: ((CGPoint, Double) -> Void)?
    var onDrag: ((CGPoint, Double) -> Void)?
    var onUp: (() -> Void)?
    /// Where the page's origin is on the surface.
    var origin = CGPoint.zero {
        didSet { if origin != oldValue { needsDisplay = true } }
    }
    var accent = NSColor.systemBlue {
        didSet { needsDisplay = true }
    }
    var dark = false
    /// A pen tool is chosen and the page takes ink: the mouse draws.
    var active = false {
        didSet {
            guard active != oldValue else { return }
            window?.invalidateCursorRects(for: self)
        }
    }
    var live: (path: CGPath, color: CGColor)? {
        didSet { needsDisplay = true }
    }
    var guide: CGPath? {
        didSet { needsDisplay = true }
    }
    var selection: CGRect? {
        didSet { needsDisplay = true }
    }
    var shift = CGSize.zero {
        didSet { if shift != oldValue { needsDisplay = true } }
    }
    var sortKey: Double { .infinity }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? { active && frame.contains(point) ? self : nil }

    override func resetCursorRects() {
        if active { addCursorRect(bounds, cursor: .crosshair) }
    }

    private func page(_ event: NSEvent) -> CGPoint {
        let p = convert(event.locationInWindow, from: nil)
        return CGPoint(x: p.x - origin.x, y: p.y - origin.y)
    }

    override func mouseDown(with event: NSEvent) { onDown?(page(event), event.timestamp * 1000) }
    override func mouseDragged(with event: NSEvent) { onDrag?(page(event), event.timestamp * 1000) }
    override func mouseUp(with event: NSEvent) { onUp?() }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        ctx.translateBy(x: origin.x, y: origin.y)
        let c = accent.cgColor
        if let selection {
            let frame = CGPath(roundedRect: selection.insetBy(dx: -4, dy: -4).offsetBy(dx: shift.width, dy: shift.height),
                               cornerWidth: 4, cornerHeight: 4, transform: nil)
            ctx.addPath(frame)
            ctx.setFillColor(c.copy(alpha: 0.06) ?? c)
            ctx.fillPath()
            ctx.addPath(frame)
            ctx.setStrokeColor(c)
            ctx.setLineWidth(1.5)
            ctx.setLineDash(phase: 0, lengths: [5, 4])
            ctx.strokePath()
        }
        if let live {
            ctx.addPath(live.path)
            ctx.setFillColor(live.color)
            ctx.fillPath(using: .winding)
        }
        if let guide {
            ctx.addPath(guide)
            ctx.setStrokeColor(c)
            ctx.setLineWidth(1.5)
            ctx.setLineDash(phase: 0, lengths: [4, 4])
            ctx.setLineJoin(.round)
            ctx.strokePath()
        }
        ctx.restoreGState()
    }
}

/// Ink drawing on the Mac: the mouse or trackpad draws with the pen, highlighter, both erasers and the lasso (move, delete),
/// as the iPad's Pencil does. The drawing is the shared `InkSession` (core's stroke builder and ink calls, undo); this owns
/// the two stroke views and the input layer and draws what the session reports.
final class MacInkController: InkSessionView {
    let under = MacInkView(under: true)
    let over = MacInkView(under: false)
    let input = MacInkInput()
    let session = InkSession()
    private let tool = InkTool.shared
    private var token: NSObjectProtocol?
    /// A pen tool was chosen: no box is being edited then.
    var onInking: (() -> Void)?

    weak var host: PageEditHost? {
        didSet {
            session.host = host
            updateMode()
        }
    }
    var notify: ((String) -> Void)? {
        didSet { session.notify = notify }
    }

    init() {
        session.view = self
        input.onDown = { [weak self] p, ms in self?.session.begin(p, samples: InkSession.sample(p, ms: ms), pen: false) }
        input.onDrag = { [weak self] p, ms in self?.session.move([p], samples: InkSession.sample(p, ms: ms)) }
        input.onUp = { [weak self] in self?.session.end([], samples: []) }
        token = NotificationCenter.default.addObserver(forName: InkTool.changed, object: nil, queue: .main) { [weak self] _ in
            self?.toolChanged()
        }
        updateMode()
    }

    deinit {
        if let token { NotificationCenter.default.removeObserver(token) }
    }

    /// The views fill the surface; the page's origin, the theme and the accent.
    func layout(in bounds: CGRect, origin: CGPoint, dark: Bool, accent: NSColor) {
        for v in [under, over, input] where v.frame != bounds { v.frame = bounds }
        for v in [under, over] {
            v.origin = origin
            v.dark = dark
        }
        input.origin = origin
        input.dark = dark
        input.accent = accent
    }

    func reload() { session.reload() }

    func reset() {
        session.reset()
        under.clear()
        over.clear()
    }

    private func toolChanged() {
        session.toolChanged()
        updateMode()
        if tool.inking && session.canDraw { onInking?() }
    }

    /// The mouse draws while a pen tool is chosen and the page takes ink (not a read-only page).
    func updateMode() {
        let on = tool.inking && session.canDraw
        input.active = on
        if !on {
            session.clearSelection()
            input.live = nil
            input.guide = nil
        }
    }

    // MARK: InkSessionView

    func inkStrokes(_ list: [InkStrokeInfo]) {
        under.set(list)
        over.set(list)
    }

    func inkLive(_ path: CGPath?, color: UInt32) {
        if let path { input.live = (path, InkGeometry.color(color, dark: input.dark)) } else { input.live = nil }
    }

    func inkGuide(_ path: CGPath?) { input.guide = path }

    func inkSelection(_ rect: CGRect?) {
        input.selection = rect
        input.shift = .zero
        under.shift = .zero
        over.shift = .zero
    }

    func inkDim(_ ids: Set<String>) {
        under.dimmed = ids
        over.dimmed = ids
    }

    func inkTranslate(_ ids: Set<String>, dx: CGFloat, dy: CGFloat) {
        let shift = CGSize(width: dx, height: dy)
        under.moving = ids
        over.moving = ids
        under.shift = shift
        over.shift = shift
        input.shift = shift
    }
}
