import CoreGraphics
import Foundation
import NotiveloCore
import Observation

/// A box for a value a call on the page's queue fills in.
final class InkSlot<T>: @unchecked Sendable {
    var value: T?
}

/// The page's one undo (docs/rewrite/status/core.md "For apple, windows and android: page undo"): core's `LivePage.undo()` /
/// `redo()` take back this client's newest change on the page, whichever kind it was (text of a box edited live, ink, box
/// geometry). Holds the flags the ribbon's buttons and the shortcuts read (`canUndo()` / `canRedo()`), refreshed after every
/// write: `PageEditHost.boxCall` reports them with each call, typing sets them (`BoxEditor.edited`).
@Observable
final class PageHistory {
    static let shared = PageHistory()
    private(set) var canUndo = false
    private(set) var canRedo = false
    /// The page being edited; its calls and flags are the ones that count.
    @ObservationIgnored weak var host: PageEditHost? {
        didSet { if host !== oldValue { set(undo: false, redo: false) } }
    }
    /// The canvas: called before a step (stop a pen stroke, note which boxes' text there is); returns what to do once core
    /// has taken the step (draw the strokes, boxes and text again, put the caret back).
    @ObservationIgnored var beginStep: (() -> (() -> Void)?)?
    @ObservationIgnored var notify: ((String) -> Void)?

    func set(undo: Bool, redo: Bool) {
        if canUndo != undo { canUndo = undo }
        if canRedo != redo { canRedo = redo }
    }

    /// The flags core has now (after a change the flags weren't reported with).
    func refresh() {
        guard let host, host.savesBoxes else { return }
        host.pageFlags { [weak self, weak host] flags in
            guard let self, let host, self.host === host else { return }
            self.set(undo: flags.0, redo: flags.1)
        }
    }

    func undo() { step(redo: false) }
    func redo() { step(redo: true) }

    private func step(redo: Bool) {
        guard let host, host.savesBoxes else { return }
        let finish = beginStep?()
        host.boxCall({ page in _ = try (redo ? page.redo() : page.undo()) }) { [weak self, weak host] error in
            guard let self, let host, self.host === host else { return }
            if let error { self.notify?("Couldn't \(redo ? "redo" : "undo"): \(CoreBridge.message(error))") }
            finish?()
        }
    }
}

/// What a platform draws for an `InkSession`. All coordinates are page points from the page origin.
protocol InkSessionView: AnyObject {
    /// The page's readable strokes in drawing order (after a read of the page's ink).
    func inkStrokes(_ list: [InkStrokeInfo])
    /// The stroke being drawn (nil clears).
    func inkLive(_ path: CGPath?, color: UInt32)
    /// The eraser's disc or the lasso's loop (nil clears).
    func inkGuide(_ path: CGPath?)
    /// The frame round the strokes the lasso holds (nil: none).
    func inkSelection(_ rect: CGRect?)
    /// Strokes the whole-stroke eraser would take, drawn faint (empty: all normal).
    func inkDim(_ ids: Set<String>)
    /// While the selection is dragged: the strokes and the frame follow by (dx, dy); (0, 0) puts them back.
    func inkTranslate(_ ids: Set<String>, dx: CGFloat, dy: CGFloat)
}

/// A page's ink drawing, the part that doesn't depend on UIKit or AppKit: the pen, highlighter, both erasers and the lasso
/// with move and delete as core calls (`InkStrokeBuilder`, `addInkStroke`, `eraseInk`, `inkHitLasso`, `inkHitPoint`,
/// `moveInkStrokes`, `deleteInkStrokes`), one call at the end of each gesture; undo and redo. The iPad's `InkController` (the
/// Pencil, and a finger when finger drawing is on) and the Mac's `MacInkController` (the mouse and trackpad) feed it points
/// and draw what it reports through `InkSessionView`.
final class InkSession {
    private enum Gesture {
        case stroke(builder: InkStrokeBuilder, color: UInt32)
        case erase(track: [Float], hits: Set<String>, partial: Bool)
        case lasso(polygon: [CGPoint])
        case move(start: CGPoint, dx: CGFloat, dy: CGFloat)
    }

    weak var view: InkSessionView?
    weak var host: PageEditHost? {
        didSet { if host !== oldValue { PageHistory.shared.host = host } }
    }
    var notify: ((String) -> Void)?
    /// Phones show ink read-only.
    var drawingAllowed = true
    private let tool = InkTool.shared
    private var strokes: [String: InkStrokeInfo] = [:]
    private var order: [String] = []
    private var selected: Set<String> = []
    private var gesture: Gesture?
    private var generation = 0
    private var completions: [() -> Void] = []

    /// Whether the page takes ink now (a phone, or a page that isn't saved, doesn't).
    var canDraw: Bool { drawingAllowed && (host?.savesBoxes ?? false) }
    /// A gesture is under way.
    var busy: Bool { gesture != nil }

    // MARK: Samples

    /// Six numbers for the builder: x, y, pressure, altitude, azimuth, time (ms).
    static func sample(_ p: CGPoint, pressure: Double = 0.5, altitude: Double = .pi / 2, azimuth: Double = 0, ms: Double) -> [Double] {
        [Double(p.x), Double(p.y), pressure, altitude, azimuth, ms]
    }

    // MARK: Page

    /// A different page: nothing of the last one stays.
    func reset() {
        gesture = nil
        generation += 1
        completions = []
        strokes = [:]
        order = []
        setSelection([])
        clearLive()
        view?.inkStrokes([])
        PageHistory.shared.set(undo: false, redo: false)
    }

    /// Read the page's strokes again (a page opened, someone else changed it, the connection came back, an edit of ours).
    func reload(then: (() -> Void)? = nil) {
        if let then { completions.append(then) }
        guard let host else { runCompletions(); return }
        generation += 1
        let mine = generation
        host.loadInk { [weak self] list in
            guard let self, mine == self.generation else { return }
            if let list { self.apply(list) }
            self.runCompletions()
        }
    }

    private func runCompletions() {
        let list = completions
        completions = []
        for c in list { c() }
    }

    private func apply(_ list: [InkStrokeInfo]) {
        let readable = list.filter { $0.readable && $0.bounds != nil }
        strokes = Dictionary(readable.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        order = readable.map(\.id)
        view?.inkStrokes(readable)
        setSelection(selected.filter { strokes[$0] != nil })
    }

    /// The tool, its colour or a width changed.
    func toolChanged() {
        if gesture != nil { cancel() }
        if tool.kind != .lasso { setSelection([]) }
    }

    /// A write to the page's ink on the page's queue (`boxCall` reports the undo flags with it).
    private func write(_ what: String, _ call: @escaping (LivePage) throws -> Void, then: @escaping (Bool) -> Void) {
        guard let host else { then(false); return }
        host.boxCall(call) { [weak self] error in
            guard let self else { return }
            if let error { self.notify?("Couldn't \(what): \(CoreBridge.message(error))") }
            then(error == nil)
        }
    }

    // MARK: Gestures

    /// A press at page point `p` (and the samples so far, for a stroke); `pen`: it has pressure and tilt (the Pencil),
    /// else a finger or a mouse, as the web (flags only for a pen).
    func begin(_ p: CGPoint, samples: [Double], pen: Bool) {
        switch tool.kind {
        case .pen, .highlighter:
            guard let style = tool.strokeStyle else { return }
            let builder = InkStrokeBuilder(tool: style.tool, color: style.color, width: style.width, pressure: pen, tilt: pen)
            try? builder.pushMany(samples: samples)
            gesture = .stroke(builder: builder, color: style.color)
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

    /// The pointer moved: the page points since the last call (the Pencil's coalesced touches), their samples, and for a
    /// stroke the predicted points (x, y, pressure each).
    func move(_ points: [CGPoint], samples: [Double], predicted: [Float] = []) {
        guard let g = gesture else { return }
        switch g {
        case let .stroke(builder, _):
            try? builder.pushMany(samples: samples)
            drawLive(builder, predicted: predicted)
        case .erase:
            eraseMoved(to: points)
        case var .lasso(polygon):
            for pt in points {
                if let last = polygon.last, hypot(pt.x - last.x, pt.y - last.y) < 1.5 { continue }
                polygon.append(pt)
            }
            gesture = .lasso(polygon: polygon)
            drawLasso(polygon)
        case let .move(start, _, _):
            guard let p = points.last else { return }
            let dx = p.x - start.x, dy = p.y - start.y
            gesture = .move(start: start, dx: dx, dy: dy)
            view?.inkTranslate(selected, dx: dx, dy: dy)
        }
    }

    /// The pointer lifted: one core call for the whole gesture.
    func end(_ points: [CGPoint], samples: [Double]) {
        guard let g = gesture else { return }
        gesture = nil
        switch g {
        case let .stroke(builder, _):
            try? builder.pushMany(samples: samples)
            commit(builder)
        case let .erase(track, _, partial):
            var track = track
            for p in points { track += [Float(p.x), Float(p.y)] }
            eraseEnded(track, partial: partial)
        case let .lasso(polygon):
            lassoEnded(polygon + points)
        case let .move(_, dx, dy):
            moveEnded(dx, dy)
        }
    }

    /// The gesture was interrupted (a second finger, a tool change): nothing is written.
    func cancel() {
        gesture = nil
        clearLive()
        view?.inkDim([])
        view?.inkTranslate(selected, dx: 0, dy: 0)
    }

    // MARK: Drawing a stroke

    private func drawLive(_ builder: InkStrokeBuilder, predicted: [Float]) {
        guard case let .stroke(_, color)? = gesture else { return }
        view?.inkLive(InkGeometry.path(builder.preview(predicted: predicted)), color: color)
    }

    private func clearLive() {
        view?.inkLive(nil, color: 0)
        view?.inkGuide(nil)
    }

    /// The pen lifted: one `addInkStroke`, then the page's strokes again; the live stroke stays until the stored one is drawn.
    private func commit(_ builder: InkStrokeBuilder) {
        guard builder.pointCount() > 0, host != nil else { clearLive(); return }
        write("save the stroke", { page in _ = try page.addInkStroke(builder: builder) }) { [weak self] _ in
            self?.reload { [weak self] in self?.clearLive() }
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
            for (id, s) in strokes where !hits.contains(id) && Self.touches(s, from: last, to: p, radius: r) { hits.insert(id) }
        }
        gesture = .erase(track: track, hits: hits, partial: partial)
        // The disc, and the strokes it would take (the whole-stroke eraser) dimmed.
        if let p = points.last {
            view?.inkGuide(CGPath(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2), transform: nil))
        }
        view?.inkDim(hits)
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
        guard host != nil, track.count >= 2 else { clearLive(); view?.inkDim([]); return }
        write("erase", { page in _ = try page.eraseInk(track: track, radius: InkTool.eraserRadius, partial: partial) }) { [weak self] _ in
            self?.reload { [weak self] in
                self?.clearLive()
                self?.view?.inkDim([])
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
        view?.inkGuide(p)
    }

    private func lassoEnded(_ polygon: [CGPoint]) {
        view?.inkGuide(nil)
        guard let host else { return }
        var minX = CGFloat.infinity, minY = CGFloat.infinity, maxX = -CGFloat.infinity, maxY = -CGFloat.infinity
        for p in polygon {
            minX = min(minX, p.x); maxX = max(maxX, p.x); minY = min(minY, p.y); maxY = max(maxY, p.y)
        }
        let slot = InkSlot<[String]>()
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
            guard let b = strokes[id]?.bounds else { continue }
            rect = rect.union(CGRect(x: CGFloat(b.minX), y: CGFloat(b.minY), width: CGFloat(b.maxX - b.minX), height: CGFloat(b.maxY - b.minY)))
        }
        return rect
    }

    private func setSelection(_ ids: Set<String>) {
        selected = ids
        let rect = selectionRect()
        view?.inkSelection(ids.isEmpty || rect.isNull ? nil : rect)
        tool.setSelectionCount(ids.count)
        tool.deleteSelection = ids.isEmpty ? nil : { [weak self] in self?.deleteSelected() }
    }

    /// Clear the lasso's selection (the page went read-only, the tool changed).
    func clearSelection() { setSelection([]) }

    private func moveEnded(_ dx: CGFloat, _ dy: CGFloat) {
        guard host != nil, hypot(dx, dy) >= 1, !selected.isEmpty else { view?.inkTranslate(selected, dx: 0, dy: 0); return }
        let ids = Array(selected)
        let slot = InkSlot<[InkMovedStroke]>()
        write("move", { page in slot.value = try page.moveInkStrokes(ids: ids, dx: Float(dx), dy: Float(dy)) }) { [weak self] ok in
            guard let self else { return }
            if !ok {
                self.view?.inkTranslate(self.selected, dx: 0, dy: 0)
                return
            }
            // The moved strokes have new ids: the selection follows them.
            let moved = Dictionary((slot.value ?? []).map { ($0.oldId, $0.newId) }, uniquingKeysWith: { a, _ in a })
            let following = Set(ids.map { moved[$0] ?? $0 })
            self.reload { [weak self] in
                guard let self else { return }
                self.setSelection(following.filter { self.strokes[$0] != nil })
            }
        }
    }

    private func deleteSelected() {
        guard host != nil, !selected.isEmpty else { return }
        let ids = Array(selected)
        write("delete", { page in _ = try page.deleteInkStrokes(ids: ids) }) { [weak self] _ in
            self?.setSelection([])
            self?.reload()
        }
    }
}
