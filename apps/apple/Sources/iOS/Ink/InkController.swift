import NotiveloCore
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Recognises the Apple Pencil (and a finger too while finger drawing is on, `fingerDrawing`; with it off a finger never
/// reaches it, so the page scrolls and zooms under a finger). It begins at touch-down and hands every touch, with its event
/// (coalesced and predicted touches), to `onTouch`. A second finger landing during a finger stroke cancels the stroke: two
/// fingers scroll and zoom.
final class PencilRecognizer: UIGestureRecognizer {
    var onTouch: ((UITouch, UIEvent, UITouch.Phase) -> Void)?
    private var tracked: UITouch?
    /// The stroke was cancelled: nothing more begins until every touch is up (`reset`).
    private var dead = false

    /// A finger draws too.
    var fingerDrawing = false {
        didSet { allowedTouchTypes = Self.types(fingerDrawing) }
    }

    private static func types(_ finger: Bool) -> [NSNumber] {
        var out = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        if finger { out.append(NSNumber(value: UITouch.TouchType.direct.rawValue)) }
        return out
    }

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        allowedTouchTypes = Self.types(false)
        cancelsTouchesInView = true
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if dead { return }
        if let current = tracked {
            // A second finger while a finger draws: the stroke stops, the page's pan and pinch take the two fingers.
            if current.type == .direct, touches.contains(where: { $0.type == .direct }) {
                dead = true
                tracked = nil
                state = .cancelled
                onTouch?(current, event, .cancelled)
            }
            return
        }
        guard let t = touches.first(where: { $0.type == .pencil }) ?? touches.first(where: { $0.type == .direct }) else { return }
        tracked = t
        state = .began
        onTouch?(t, event, .began)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = tracked, touches.contains(t) else { return }
        state = .changed
        onTouch?(t, event, .moved)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = tracked, touches.contains(t) else { return }
        state = .ended
        onTouch?(t, event, .ended)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = tracked, touches.contains(t) else { return }
        state = .cancelled
        onTouch?(t, event, .cancelled)
    }

    override func reset() {
        tracked = nil
        dead = false
    }
}

/// A transparent layer holder that never takes a touch.
final class InkContainer: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
}


/// The undo manager the page canvas and its boxes give the responder chain: shake to undo, the three-finger
/// swipes and the Edit menu reach the page's one undo (`PageHistory`) through `EditorFocus`.
final class PageUndoManager: UndoManager {
    override var canUndo: Bool { EditorFocus.shared.canUndo }
    override var canRedo: Bool { EditorFocus.shared.canRedo }
    override func undo() { EditorFocus.shared.undo() }
    override func redo() { EditorFocus.shared.redo() }
}

/// A page's ink on the iPad canvas (docs/rewrite/status/core.md "For apple: ink"). Strokes are the core's: one filled
/// `CAShapeLayer` per stroke from the core's outline (`inkOutlineOps`, nonzero rule), in page points from the page
/// origin, laid on the page surface so they scroll and zoom with the boxes. Highlighters sit under the boxes, pens over
/// them (the web's `InkRenderer` layers). The Pencil (and a finger, with finger drawing on) draws, erases or lassos
/// depending on `InkTool`; the drawing itself is the shared `InkSession` (one core call at the end of each gesture); this
/// draws what it reports.
final class InkController: NSObject, InkSessionView, UIGestureRecognizerDelegate {
    private struct Entry {
        let info: InkStrokeInfo
        let layer: CAShapeLayer
        let under: Bool
    }

    private weak var surface: UIView?
    private weak var scroll: UIScrollView?
    let recognizer = PencilRecognizer(target: nil, action: nil)
    let session = InkSession()
    private let underView = InkContainer()
    private let overView = InkContainer()
    private let liveView = InkContainer()
    private let liveShape = CAShapeLayer()
    private let guideShape = CAShapeLayer()
    private let selectionShape = CAShapeLayer()
    private var entries: [String: Entry] = [:]
    private let defaultPanTypes: [NSNumber]
    private let defaultPanTouches: Int
    private let tool = InkTool.shared

    /// Where the page's origin is on the surface.
    var origin: CGPoint = .zero {
        didSet { if origin != oldValue { applyOrigin() } }
    }
    /// The dark theme draws near-black ink near-white (`displayColor` in src/ink/render.ts).
    var dark = false {
        didSet { if dark != oldValue { recolour() } }
    }
    var accent: UIColor = .systemBlue {
        didSet { styleGuides() }
    }
    /// Phones show ink read-only: the stacked layout has no page coordinates, and the web has no ink on phones either.
    var drawingAllowed = true {
        didSet { if drawingAllowed != oldValue { session.drawingAllowed = drawingAllowed; updateMode() } }
    }
    weak var host: PageEditHost? {
        didSet {
            session.host = host
            updateMode()
        }
    }
    var notify: ((String) -> Void)? {
        didSet { session.notify = notify }
    }

    init(scroll: UIScrollView, surface: UIView) {
        self.scroll = scroll
        self.surface = surface
        defaultPanTypes = scroll.panGestureRecognizer.allowedTouchTypes
        defaultPanTouches = scroll.panGestureRecognizer.minimumNumberOfTouches
        super.init()
        session.view = self
        surface.addSubview(underView)
        surface.addSubview(overView)
        surface.addSubview(liveView)
        liveShape.anchorPoint = .zero
        guideShape.anchorPoint = .zero
        selectionShape.anchorPoint = .zero
        for s in [selectionShape, guideShape, liveShape] {
            s.actions = ["path": NSNull(), "position": NSNull(), "fillColor": NSNull(), "strokeColor": NSNull(), "opacity": NSNull(), "hidden": NSNull()]
            liveView.layer.addSublayer(s)
        }
        styleGuides()
        recognizer.onTouch = { [weak self] t, e, phase in self?.touch(t, e, phase) }
        recognizer.delegate = self
        scroll.addGestureRecognizer(recognizer)
        NotificationCenter.default.addObserver(self, selector: #selector(toolChanged), name: InkTool.changed, object: nil)
        updateMode()
    }

    // MARK: Layout

    /// After the surface was resized or its subviews were reordered: the ink layers cover the surface, highlighters at the
    /// back, pens and the live stroke in front of every box.
    private var laying = false

    func layout() {
        guard let surface, !laying else { return }
        laying = true
        defer { laying = false }
        for v in [underView, overView, liveView] { v.frame = surface.bounds }
        surface.sendSubviewToBack(underView)
        surface.bringSubviewToFront(overView)
        surface.bringSubviewToFront(liveView)
    }

    private func applyOrigin() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for e in entries.values { e.layer.position = origin }
        for s in [liveShape, guideShape, selectionShape] { s.position = origin }
        CATransaction.commit()
    }

    /// A different page: nothing of the last one stays.
    func reset() {
        session.reset()
        for e in entries.values { e.layer.removeFromSuperlayer() }
        entries = [:]
    }

    func reload(then: (() -> Void)? = nil) { session.reload(then: then) }

    // MARK: Mode

    @objc private func toolChanged() {
        session.toolChanged()
        updateMode()
    }

    /// The recogniser takes the Pencil (and a finger, with finger drawing on) only while a pen tool is chosen, so with the
    /// Select tool Scribble and the text boxes get the Pencil as before. The page's pan then ignores the Pencil so it can't
    /// scroll while drawing; with finger drawing on it takes two fingers (one finger draws).
    private func updateMode() {
        let on = tool.inking && session.canDraw
        let finger = on && tool.fingerDrawing
        recognizer.fingerDrawing = finger
        recognizer.isEnabled = on
        scroll?.panGestureRecognizer.allowedTouchTypes = on ? [NSNumber(value: UITouch.TouchType.direct.rawValue)] : defaultPanTypes
        scroll?.panGestureRecognizer.minimumNumberOfTouches = finger ? 2 : defaultPanTouches
        if !on {
            session.clearSelection()
            clearLive()
        }
    }

    /// With finger drawing on, the page's pan and pinch work next to the stroke recogniser (the stroke is cancelled when a
    /// second finger lands).
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        guard g === recognizer, tool.fingerDrawing else { return false }
        return other === scroll?.panGestureRecognizer || other === scroll?.pinchGestureRecognizer
    }

    // MARK: Strokes

    func inkStrokes(_ list: [InkStrokeInfo]) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        var next: [String: Entry] = [:]
        var order: [String] = []
        for s in list {
            if let e = entries[s.id] {
                next[s.id] = e
            } else {
                let ops = inkOutlineOps(data: s.data)
                guard !ops.isEmpty else { continue }
                let layer = CAShapeLayer()
                layer.anchorPoint = .zero
                layer.position = origin
                layer.path = Self.path(ops)
                layer.fillRule = .nonZero
                layer.fillColor = display(s.color).cgColor
                next[s.id] = Entry(info: s, layer: layer, under: s.tool == 1)
            }
            order.append(s.id)
        }
        for (id, e) in entries where next[id] == nil { e.layer.removeFromSuperlayer() }
        entries = next
        let ordered = order.compactMap { next[$0] }
        underView.layer.sublayers = ordered.filter(\.under).map(\.layer)
        overView.layer.sublayers = ordered.filter { !$0.under }.map(\.layer)
        CATransaction.commit()
    }

    private func recolour() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for e in entries.values { e.layer.fillColor = display(e.info.color).cgColor }
        CATransaction.commit()
    }

    /// The core's path commands as a CGPath (shared with the Mac, `InkGeometry`).
    static func path(_ ops: [Float]) -> CGPath { InkGeometry.path(ops) }

    /// The colour a stroke is drawn in (0xRRGGBBAA): in the dark theme near-black ink is drawn near-white.
    private func display(_ c: UInt32) -> UIColor { UIColor(cgColor: InkGeometry.color(c, dark: dark)) }

    // MARK: InkSessionView

    func inkLive(_ path: CGPath?, color: UInt32) {
        if path != nil { liveShape.fillColor = display(color).cgColor }
        liveShape.path = path
    }

    func inkGuide(_ path: CGPath?) { guideShape.path = path }

    func inkSelection(_ rect: CGRect?) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        selectionShape.path = rect.map { CGPath(roundedRect: $0.insetBy(dx: -4, dy: -4), cornerWidth: 4, cornerHeight: 4, transform: nil) }
        selectionShape.transform = CATransform3DIdentity
        CATransaction.commit()
    }

    func inkDim(_ ids: Set<String>) {
        for (id, e) in entries { e.layer.opacity = ids.contains(id) ? 0.25 : 1 }
    }

    /// While the selection is dragged: its strokes and its frame follow the pointer.
    func inkTranslate(_ ids: Set<String>, dx: CGFloat, dy: CGFloat) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let t = CATransform3DMakeTranslation(dx, dy, 0)
        for (id, e) in entries { e.layer.transform = ids.contains(id) ? t : CATransform3DIdentity }
        selectionShape.transform = t
        CATransaction.commit()
    }

    private func clearLive() {
        liveShape.path = nil
        guideShape.path = nil
    }

    // MARK: The Pencil and fingers

    private func point(_ t: UITouch) -> CGPoint {
        let p = t.location(in: surface)
        return CGPoint(x: p.x - origin.x, y: p.y - origin.y)
    }

    /// Six numbers per touch for the builder: x, y, pressure, altitude, azimuth, time (ms). A finger has no pressure or tilt
    /// (the web: flags only for a pen).
    private func samples(_ touches: [UITouch]) -> [Double] {
        var out: [Double] = []
        out.reserveCapacity(touches.count * 6)
        for t in touches {
            let p = point(t)
            if t.type == .pencil {
                let pressure = t.maximumPossibleForce > 0 ? min(max(t.force / t.maximumPossibleForce, 0), 1) : 0.5
                out += InkSession.sample(p, pressure: Double(pressure), altitude: Double(t.altitudeAngle), azimuth: Double(t.azimuthAngle(in: surface)), ms: t.timestamp * 1000)
            } else {
                out += InkSession.sample(p, ms: t.timestamp * 1000)
            }
        }
        return out
    }

    private func touch(_ t: UITouch, _ event: UIEvent, _ phase: UITouch.Phase) {
        let coalesced = event.coalescedTouches(for: t) ?? [t]
        switch phase {
        case .began:
            session.begin(point(t), samples: samples(coalesced), pen: t.type == .pencil)
        case .moved:
            var predicted: [Float] = []
            if t.type == .pencil {
                for pt in event.predictedTouches(for: t) ?? [] {
                    let p = point(pt)
                    let pressure = pt.maximumPossibleForce > 0 ? min(max(pt.force / pt.maximumPossibleForce, 0), 1) : 0.5
                    predicted += [Float(p.x), Float(p.y), Float(pressure)]
                }
            }
            session.move(coalesced.map(point), samples: samples(coalesced), predicted: predicted)
        case .ended:
            session.end(coalesced.map(point), samples: samples(coalesced))
        default:
            session.cancel()
        }
    }

    private func styleGuides() {
        let c = accent
        liveShape.fillColor = c.cgColor
        guideShape.fillColor = nil
        guideShape.strokeColor = c.cgColor
        guideShape.lineWidth = 1.5
        guideShape.lineDashPattern = [4, 4]
        guideShape.lineJoin = .round
        selectionShape.fillColor = c.withAlphaComponent(0.06).cgColor
        selectionShape.strokeColor = c.cgColor
        selectionShape.lineWidth = 1.5
        selectionShape.lineDashPattern = [5, 4]
    }
}
