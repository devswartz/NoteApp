import NotiveloCore
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Recognises the Apple Pencil only (a finger never reaches it, so the page scrolls and zooms under a finger). It
/// begins at touch-down and hands every touch, with its event (coalesced and predicted touches), to `onTouch`.
final class PencilRecognizer: UIGestureRecognizer {
    var onTouch: ((UITouch, UIEvent, UITouch.Phase) -> Void)?
    private var tracked: UITouch?

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        cancelsTouchesInView = true
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard tracked == nil, let t = touches.first(where: { $0.type == .pencil }) else { return }
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

    override func reset() { tracked = nil }
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

/// A box for a value a call on the page's queue fills in.
private final class Slot<T>: @unchecked Sendable {
    var value: T?
}

/// A page's ink on the iPad canvas (docs/rewrite/status/core.md "For apple: ink"). Strokes are the core's: one filled
/// `CAShapeLayer` per stroke from the core's outline (`inkOutlineOps`, nonzero rule), in page points from the page
/// origin, laid on the page surface so they scroll and zoom with the boxes. Highlighters sit under the boxes, pens over
/// them (the web's `InkRenderer` layers). The Pencil draws, erases or lassos depending on `InkTool`; one core call at the
/// end of each gesture (the stroke when the pen lifts, the whole erase track, the whole drag).
final class InkController: NSObject {
    private struct Entry {
        let info: InkStrokeInfo
        let layer: CAShapeLayer
        let under: Bool
    }

    private enum Gesture {
        case stroke(builder: InkStrokeBuilder, tool: UInt8, color: UInt32)
        case erase(track: [Float], hits: Set<String>, partial: Bool)
        case lasso(polygon: [CGPoint])
        case move(start: CGPoint, dx: CGFloat, dy: CGFloat)
    }

    private weak var surface: UIView?
    private weak var scroll: UIScrollView?
    let recognizer = PencilRecognizer(target: nil, action: nil)
    private let underView = InkContainer()
    private let overView = InkContainer()
    private let liveView = InkContainer()
    private let liveShape = CAShapeLayer()
    private let guideShape = CAShapeLayer()
    private let selectionShape = CAShapeLayer()
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private var selected: Set<String> = []
    private var gesture: Gesture?
    private var generation = 0
    private var completions: [() -> Void] = []
    private let defaultPanTypes: [NSNumber]
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
    /// Phones show ink read-only.
    var drawingAllowed = true {
        didSet { if drawingAllowed != oldValue { updateMode() } }
    }
    weak var host: PageEditHost? {
        didSet { updateMode() }
    }
    var notify: ((String) -> Void)?

    init(scroll: UIScrollView, surface: UIView) {
        self.scroll = scroll
        self.surface = surface
        defaultPanTypes = scroll.panGestureRecognizer.allowedTouchTypes
        super.init()
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
        gesture = nil
        generation += 1
        completions = []
        for e in entries.values { e.layer.removeFromSuperlayer() }
        entries = [:]
        order = []
        setSelection([])
        clearLive()
    }

    // MARK: Mode

    @objc private func toolChanged() {
        if gesture != nil { cancelGesture() }
        if tool.kind != .lasso { setSelection([]) }
        updateMode()
    }

    private func canDraw() -> Bool { drawingAllowed && (host?.savesBoxes ?? false) }

    /// The recogniser takes the Pencil only while a pen tool is chosen, so with the Select tool Scribble and the text
    /// boxes get the Pencil as before; the page's pan then ignores the Pencil so it can't scroll while drawing.
    private func updateMode() {
        let on = tool.inking && canDraw()
        recognizer.isEnabled = on
        scroll?.panGestureRecognizer.allowedTouchTypes = on ? [NSNumber(value: UITouch.TouchType.direct.rawValue)] : defaultPanTypes
        if !on { setSelection([]); clearLive() }
    }

    // MARK: Reading

    /// Read the page's strokes again (a page opened, someone else changed it, the connection came back, an edit of ours).
    func reload(then: (() -> Void)? = nil) {
        if let then { completions.append(then) }
        guard let host else { runCompletions(); return }
        generation += 1
        let mine = generation
        host.loadInk { [weak self] strokes in
            guard let self, mine == self.generation else { return }
            if let strokes { self.apply(strokes) }
            self.runCompletions()
        }
    }

    private func runCompletions() {
        let list = completions
        completions = []
        for c in list { c() }
    }

    private func apply(_ list: [InkStrokeInfo]) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        var next: [String: Entry] = [:]
        var nextOrder: [String] = []
        for s in list where s.readable && s.bounds != nil {
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
            nextOrder.append(s.id)
        }
        for (id, e) in entries where next[id] == nil { e.layer.removeFromSuperlayer() }
        entries = next
        order = nextOrder
        let ordered = nextOrder.compactMap { next[$0] }
        underView.layer.sublayers = ordered.filter(\.under).map(\.layer)
        overView.layer.sublayers = ordered.filter { !$0.under }.map(\.layer)
        CATransaction.commit()
        setSelection(selected.filter { entries[$0] != nil })
    }

    private func recolour() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for e in entries.values { e.layer.fillColor = display(e.info.color).cgColor }
        CATransaction.commit()
    }

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

    /// The colour a stroke is drawn in (0xRRGGBBAA): in the dark theme near-black ink is drawn near-white.
    private func display(_ c: UInt32) -> UIColor {
        var r = Double((c >> 24) & 255), g = Double((c >> 16) & 255), b = Double((c >> 8) & 255)
        let a = Double(c & 255) / 255
        if dark, (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.25 { r = 0xE6; g = 0xE6; b = 0xE6 }
        return UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }

    // MARK: The Pencil

    private func point(_ t: UITouch) -> CGPoint {
        let p = t.location(in: surface)
        return CGPoint(x: p.x - origin.x, y: p.y - origin.y)
    }

    /// Six numbers per touch for the builder: x, y, pressure, altitude, azimuth, time (ms).
    private func samples(_ touches: [UITouch]) -> [Double] {
        var out: [Double] = []
        out.reserveCapacity(touches.count * 6)
        for t in touches {
            let p = point(t)
            let pressure = t.maximumPossibleForce > 0 ? min(max(t.force / t.maximumPossibleForce, 0), 1) : 0.5
            out += [Double(p.x), Double(p.y), Double(pressure), Double(t.altitudeAngle), Double(t.azimuthAngle(in: surface)), t.timestamp * 1000]
        }
        return out
    }

    private func touch(_ t: UITouch, _ event: UIEvent, _ phase: UITouch.Phase) {
        let coalesced = event.coalescedTouches(for: t) ?? [t]
        switch phase {
        case .began: begin(t, coalesced)
        case .moved: move(t, event, coalesced)
        case .ended: end(t, coalesced)
        default: cancelGesture()
        }
    }

    private func begin(_ t: UITouch, _ coalesced: [UITouch]) {
        let p = point(t)
        switch tool.kind {
        case .pen, .highlighter:
            guard let style = tool.strokeStyle else { return }
            let builder = InkStrokeBuilder(tool: style.tool, color: style.color, width: style.width, pressure: true, tilt: true)
            try? builder.pushMany(samples: samples(coalesced))
            gesture = .stroke(builder: builder, tool: style.tool, color: style.color)
            drawLive(builder, predicted: [])
        case .eraser, .partialEraser:
            gesture = .erase(track: [Float(p.x), Float(p.y)], hits: [], partial: tool.kind == .partialEraser)
            eraseMoved(to: [p])
        case .lasso:
            if !selected.isEmpty, selectionRect().insetBy(dx: -12, dy: -12).contains(p) {
                gesture = .move(start: p, dx: 0, dy: 0)
            } else {
                setSelection([])
                gesture = .lasso(polygon: [p])
            }
        case .select:
            break
        }
    }

    private func move(_ t: UITouch, _ event: UIEvent, _ coalesced: [UITouch]) {
        guard let g = gesture else { return }
        switch g {
        case let .stroke(builder, kind, color):
            try? builder.pushMany(samples: samples(coalesced))
            let predicted = (event.predictedTouches(for: t) ?? []).flatMap { pt -> [Float] in
                let p = point(pt)
                let pressure = pt.maximumPossibleForce > 0 ? min(max(pt.force / pt.maximumPossibleForce, 0), 1) : 0.5
                return [Float(p.x), Float(p.y), Float(pressure)]
            }
            drawLive(builder, predicted: predicted)
            gesture = .stroke(builder: builder, tool: kind, color: color)
        case .erase:
            eraseMoved(to: coalesced.map(point))
        case var .lasso(polygon):
            for pt in coalesced.map(point) {
                if let last = polygon.last, hypot(pt.x - last.x, pt.y - last.y) < 1.5 { continue }
                polygon.append(pt)
            }
            gesture = .lasso(polygon: polygon)
            drawLasso(polygon)
        case let .move(start, _, _):
            let p = point(t)
            let dx = p.x - start.x, dy = p.y - start.y
            gesture = .move(start: start, dx: dx, dy: dy)
            translateSelection(dx, dy)
        }
    }

    private func end(_ t: UITouch, _ coalesced: [UITouch]) {
        guard let g = gesture else { return }
        gesture = nil
        switch g {
        case let .stroke(builder, _, _):
            try? builder.pushMany(samples: samples(coalesced))
            commit(builder)
        case let .erase(track, _, partial):
            var track = track
            for p in coalesced.map(point) { track += [Float(p.x), Float(p.y)] }
            eraseEnded(track, partial: partial)
        case let .lasso(polygon):
            lassoEnded(polygon + coalesced.map(point))
        case let .move(_, dx, dy):
            moveEnded(dx, dy)
        }
    }

    private func cancelGesture() {
        gesture = nil
        clearLive()
        restoreDim()
        translateSelection(0, 0)
    }

    // MARK: Drawing a stroke

    private func drawLive(_ builder: InkStrokeBuilder, predicted: [Float]) {
        guard case let .stroke(_, _, color)? = gesture else { return }
        liveShape.fillColor = display(color).cgColor
        liveShape.path = Self.path(builder.preview(predicted: predicted))
    }

    private func clearLive() {
        liveShape.path = nil
        guideShape.path = nil
    }

    /// The pen lifted: one `addInkStroke`, then the page's strokes again; the live stroke stays until the stored one is drawn.
    private func commit(_ builder: InkStrokeBuilder) {
        guard builder.pointCount() > 0, let host else { clearLive(); return }
        host.boxCall({ page in _ = try page.addInkStroke(builder: builder) }) { [weak self] error in
            guard let self else { return }
            if let error { self.notify?("Couldn't save the stroke: \(CoreBridge.message(error))") }
            self.reload { [weak self] in self?.clearLive() }
        }
    }

    // MARK: Erasing

    private func eraseMoved(to points: [CGPoint]) {
        guard case .erase(var track, var hits, let partial)? = gesture else { return }
        let r = CGFloat(InkTool.eraserRadius)
        for p in points {
            let last = track.count >= 2 ? CGPoint(x: CGFloat(track[track.count - 2]), y: CGFloat(track[track.count - 1])) : p
            if p != last { track += [Float(p.x), Float(p.y)] }
            if partial { continue }
            for (id, e) in entries where !hits.contains(id) && Self.touches(e.info, from: last, to: p, radius: r) { hits.insert(id) }
        }
        gesture = .erase(track: track, hits: hits, partial: partial)
        // The disc, and the strokes it would take (the whole-stroke eraser) dimmed.
        if let p = points.last {
            guideShape.path = CGPath(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2), transform: nil)
        }
        for (id, e) in entries { e.layer.opacity = hits.contains(id) ? 0.25 : 1 }
    }

    private func restoreDim() {
        for e in entries.values { e.layer.opacity = 1 }
    }

    /// Whether the disc of `radius`, dragged from `a` to `b`, reaches a stroke's ink (its stored points as a line, with the
    /// stroke's width): what the core's `eraseInk` will do, close enough to show it before the pen lifts.
    private static func touches(_ s: InkStrokeInfo, from a: CGPoint, to b: CGPoint, radius: CGFloat) -> Bool {
        guard let box = s.bounds else { return false }
        let hit = CGRect(x: min(a.x, b.x) - radius, y: min(a.y, b.y) - radius, width: abs(a.x - b.x) + radius * 2, height: abs(a.y - b.y) + radius * 2)
        guard hit.intersects(CGRect(x: CGFloat(box.minX), y: CGFloat(box.minY), width: CGFloat(box.maxX - box.minX), height: CGFloat(box.maxY - box.minY))) else { return false }
        let reach = radius + CGFloat(s.width) * 0.5
        let pts = s.points
        let n = pts.count / 6
        guard n > 0 else { return false }
        func seg(_ i: Int) -> (CGPoint, CGPoint) {
            let p = CGPoint(x: CGFloat(pts[i * 6]), y: CGFloat(pts[i * 6 + 1]))
            let q = i + 1 < n ? CGPoint(x: CGFloat(pts[(i + 1) * 6]), y: CGFloat(pts[(i + 1) * 6 + 1])) : p
            return (p, q)
        }
        for i in 0..<n {
            let (p, q) = seg(i)
            if distance(segment: (a, b), to: (p, q)) <= reach { return true }
        }
        return false
    }

    private static func distance(segment s1: (CGPoint, CGPoint), to s2: (CGPoint, CGPoint)) -> CGFloat {
        // Close enough for a preview: the nearest of the end points and, along s1, a few steps.
        var best = CGFloat.greatestFiniteMagnitude
        let steps = max(2, Int(hypot(s1.1.x - s1.0.x, s1.1.y - s1.0.y) / 3))
        for k in 0...steps {
            let f = CGFloat(k) / CGFloat(steps)
            let p = CGPoint(x: s1.0.x + (s1.1.x - s1.0.x) * f, y: s1.0.y + (s1.1.y - s1.0.y) * f)
            best = min(best, distance(point: p, toSegment: s2))
        }
        return best
    }

    private static func distance(point p: CGPoint, toSegment s: (CGPoint, CGPoint)) -> CGFloat {
        let dx = s.1.x - s.0.x, dy = s.1.y - s.0.y
        let len2 = dx * dx + dy * dy
        let f = len2 > 0 ? min(max(((p.x - s.0.x) * dx + (p.y - s.0.y) * dy) / len2, 0), 1) : 0
        return hypot(p.x - (s.0.x + dx * f), p.y - (s.0.y + dy * f))
    }

    private func eraseEnded(_ track: [Float], partial: Bool) {
        guard let host, track.count >= 2 else { clearLive(); restoreDim(); return }
        host.boxCall({ page in _ = try page.eraseInk(track: track, radius: InkTool.eraserRadius, partial: partial) }) { [weak self] error in
            guard let self else { return }
            if let error { self.notify?("Couldn't erase: \(CoreBridge.message(error))") }
            self.reload { [weak self] in
                self?.clearLive()
                self?.restoreDim()
            }
        }
    }

    // MARK: Lasso, move, delete

    private func drawLasso(_ polygon: [CGPoint]) {
        let p = CGMutablePath()
        if let first = polygon.first {
            p.move(to: first)
            for pt in polygon.dropFirst() { p.addLine(to: pt) }
        }
        guideShape.path = p
    }

    private func lassoEnded(_ polygon: [CGPoint]) {
        guideShape.path = nil
        guard let host else { return }
        var minX = CGFloat.infinity, minY = CGFloat.infinity, maxX = -CGFloat.infinity, maxY = -CGFloat.infinity
        for p in polygon {
            minX = min(minX, p.x); maxX = max(maxX, p.x); minY = min(minY, p.y); maxY = max(maxY, p.y)
        }
        let slot = Slot<[String]>()
        let tap = polygon.count < 3 || hypot(maxX - minX, maxY - minY) < 6
        let flat = polygon.flatMap { [Float($0.x), Float($0.y)] }
        let centre = CGPoint(x: (minX + maxX) / 2, y: (minY + maxY) / 2)
        host.boxCall({ page in
            slot.value = tap
                ? try page.inkHitPoint(x: Float(centre.x), y: Float(centre.y), radius: 6)
                : try page.inkHitLasso(polygon: flat, minFraction: 0.5)
        }) { [weak self] error in
            guard let self else { return }
            if let error { self.notify?("Couldn't select: \(CoreBridge.message(error))"); return }
            // A tap picks the top stroke only.
            let ids = slot.value ?? []
            let top = ids.max { (self.order.firstIndex(of: $0) ?? 0) < (self.order.firstIndex(of: $1) ?? 0) }
            self.setSelection(Set(tap ? (top.map { [$0] } ?? []) : ids))
        }
    }

    private func selectionRect() -> CGRect {
        var rect = CGRect.null
        for id in selected {
            guard let b = entries[id]?.info.bounds else { continue }
            rect = rect.union(CGRect(x: CGFloat(b.minX), y: CGFloat(b.minY), width: CGFloat(b.maxX - b.minX), height: CGFloat(b.maxY - b.minY)))
        }
        return rect
    }

    private func setSelection(_ ids: Set<String>) {
        selected = ids
        let rect = selectionRect()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        selectionShape.path = ids.isEmpty || rect.isNull ? nil : CGPath(roundedRect: rect.insetBy(dx: -4, dy: -4), cornerWidth: 4, cornerHeight: 4, transform: nil)
        selectionShape.transform = CATransform3DIdentity
        CATransaction.commit()
        tool.setSelectionCount(ids.count)
        tool.deleteSelection = ids.isEmpty ? nil : { [weak self] in self?.deleteSelected() }
    }

    /// While the selection is dragged: its strokes and its frame follow the Pencil.
    private func translateSelection(_ dx: CGFloat, _ dy: CGFloat) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let t = CATransform3DMakeTranslation(dx, dy, 0)
        for id in selected { entries[id]?.layer.transform = t }
        selectionShape.transform = t
        CATransaction.commit()
    }

    private func moveEnded(_ dx: CGFloat, _ dy: CGFloat) {
        guard let host, hypot(dx, dy) >= 1, !selected.isEmpty else { translateSelection(0, 0); return }
        let ids = Array(selected)
        let slot = Slot<[InkMovedStroke]>()
        host.boxCall({ page in slot.value = try page.moveInkStrokes(ids: ids, dx: Float(dx), dy: Float(dy)) }) { [weak self] error in
            guard let self else { return }
            if let error {
                self.notify?("Couldn't move: \(CoreBridge.message(error))")
                self.translateSelection(0, 0)
                return
            }
            // The moved strokes have new ids: the selection follows them.
            let moved = Dictionary((slot.value ?? []).map { ($0.oldId, $0.newId) }, uniquingKeysWith: { a, _ in a })
            let following = Set(ids.map { moved[$0] ?? $0 })
            self.reload { [weak self] in
                guard let self else { return }
                self.setSelection(following.filter { self.entries[$0] != nil })
            }
        }
    }

    private func deleteSelected() {
        guard let host, !selected.isEmpty else { return }
        let ids = Array(selected)
        host.boxCall({ page in _ = try page.deleteInkStrokes(ids: ids) }) { [weak self] error in
            guard let self else { return }
            if let error { self.notify?("Couldn't delete: \(CoreBridge.message(error))") }
            self.setSelection([])
            self.reload()
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
