#if canImport(UIKit)
// The iPad's native pen layer (docs/PLAN_INK.md, phase I2), driven by the web page through
// NoteAppInkPlugin (App/NoteAppInkPlugin.swift) and src/ink/nativeInk.ts.
//
// - Finished strokes: InkContentView, a subview of WebKit's own UIScrollView for the page's
//   scroller, so panning moves ink and text in the same frame (one transform: UIKit's).
// - The stroke being drawn: LiveStrokeView (Metal) over that scroll view, fed by coalesced and
//   predicted touches. Scrolling is locked while the pen is down, so its mapping never changes.
// - Pinch zoom: native owns it. A snapshot of the page (text and ink as one picture) follows the
//   fingers; when they lift, the web gets the new zoom and scroll offset (the transform comes from
//   here), lays the page out at that zoom (sharp text), says so (viewApplied), and the snapshot goes.
// - Strokes cross to the web once each, on pen-up; erases once per gesture. The page's strokes come
//   back from the web (setStrokes/updateStrokes), which is the only source of truth.
import PencilKit
import UIKit
import WebKit

public protocol NativeInkDelegate: AnyObject {
    /// A finished stroke; `token` comes back with the update that adds it.
    func nativeInk(strokeFinished blob: Data, token: String)
    /// An erase gesture: page strokes gone, pieces left by the partial eraser.
    func nativeInk(erased removed: [String], added: [Data], token: String)
    /// The view changed: `final` after a pinch (the web must apply it, then call viewApplied),
    /// otherwise a report after scrolling stops.
    func nativeInk(viewChanged zoom: CGFloat, offset: CGPoint, final: Bool)
    /// The Pencil switched the tool: double-tap, or (`enterDraw`) a Pencil touch in type mode turned draw mode on.
    func nativeInk(toolChanged tool: String, enterDraw: Bool)
    /// Two-finger tap: undo.
    func nativeInkUndo()
    /// Three-finger tap: redo.
    func nativeInkRedo()
    /// What the pen layer just recognised, in words (the status readout).
    func nativeInkDebug(_ text: String)
    /// The page's scroll view couldn't be found (the web falls back to its own pen).
    func nativeInkDetached()
}

public final class NativeInkController: NSObject, UIGestureRecognizerDelegate, UIPencilInteractionDelegate, UIScribbleInteractionDelegate {
    /// How many pages have the pen layer attached: the app's view controller turns the system's
    /// three-finger editing gestures off meanwhile, so the three-finger tap is ours (redo).
    public private(set) static var attachedCount = 0
    private var counted = false

    public weak var delegate: NativeInkDelegate?
    private weak var webView: WKWebView?
    public let store = InkStore()
    private var content: InkContentView?
    private weak var scrollView: UIScrollView?
    private var layout: InkLayout?
    public private(set) var tool = InkToolState()
    private var previousTool = "pen"
    public private(set) var zoom: CGFloat = 1
    private let live = LiveStrokeView(frame: .zero)
    private let pen = PenInputRecognizer(target: nil, action: nil)
    /// Two-finger tap (undo), three-finger tap (redo) and pinch (zoom): see MultiTouchObserver.
    private let fingers = MultiTouchObserver(target: nil, action: nil)
    private var scribbleBlockers: [(UIView, UIScribbleInteraction)] = []
    private var pencilInteraction: UIPencilInteraction?
    private var seq = 0
    private var offsetObservation: NSKeyValueObservation?
    private var scrollReport: DispatchWorkItem?
    private var pencilKit: PKCanvasView?
    private var reattachTries = 0

    // A stroke in progress.
    private var builder: StrokeBuilder?
    /// Finished strokes the web hasn't painted yet (it draws finished ink): held on the live layer until their ack.
    private var heldStrokes: [(token: String, triangles: [Float], color: UInt32)] = []
    private var strokeCount = 0
    private var scrollWasEnabled = true
    // An erase gesture in progress.
    private var eraseToken: String?
    private var eraseLast: CGPoint?
    private var eraseRemoved = Set<String>()
    private var erasePieces: [(key: String, blob: Data, rect: CGRect)] = []
    // A pinch in progress.
    private var pinchHolder: UIView?
    private var pinchSnapshot: UIView?
    private var pinchStart: (focal: CGPoint, offset: CGPoint, zoom: CGFloat)?
    private var awaitingView = false

    public init(webView: WKWebView) {
        self.webView = webView
        super.init()
        pen.delegate = self
        pen.onBegan = { [weak self] t, e in self?.began(t, e) }
        pen.onMoved = { [weak self] t, e in self?.moved(t, e) }
        pen.onEnded = { [weak self] t, e, cancelled in self?.ended(t, e, cancelled) }
        // Notability's gestures: a two-finger tap undoes, a three-finger tap redoes; a pinch zooms.
        fingers.delegate = self
        fingers.onTap = { [weak self] n in
            // Reported only: the web's pointer-event detector does the undo/redo (one source of taps).
            self?.delegate?.nativeInkDebug("\(n)-finger tap\(self?.isAttached == true ? "" : " (layer not attached)")")
        }
        fingers.onFingers = { [weak self] n in
            if n >= 2 { self?.delegate?.nativeInkDebug("saw \(n) fingers") }
        }
        fingers.onPinch = { [weak self] state, scale, centre in self?.pinch(state, scale, centre) }
        fingers.pinchAllowed = { [weak self] centre in
            guard let self, let l = self.layout, self.isAttached else { return false }
            return self.pencilKit == nil && self.builder == nil && self.eraseToken == nil && l.scroller.contains(centre)
        }
        live.isHidden = true
        applyTouchTypes()
    }

    public var isAttached: Bool { content?.window != nil && scrollView != nil }

    /// Why the last attach failed: the scroll views in the web view and the box wanted (status readout).
    public private(set) var attachDetail = ""

    static func describe(in wv: WKWebView, wanted: CGRect) -> String {
        var rects: [CGRect] = []
        func walk(_ v: UIView) {
            for s in v.subviews where !(s is InkContentView) {
                if let sv = s as? UIScrollView { rects.append(sv.convert(sv.bounds, to: wv)) }
                walk(s)
            }
        }
        rects.append(wv.scrollView.convert(wv.scrollView.bounds, to: wv))
        walk(wv.scrollView)
        let f = { (r: CGRect) in "\(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))x\(Int(r.height))" }
        return "wanted \(f(wanted)); scroll views: " + rects.prefix(6).map(f).joined(separator: " | ")
    }

    // MARK: - Attaching to the page

    /// Finds the page's scroll view (WebKit makes a native UIScrollView for each scrolling element)
    /// and puts the ink in it. False when no scroll view matches the scroller's box.
    @discardableResult
    public func attach(_ l: InkLayout) -> Bool {
        layout = l
        zoom = l.zoom
        guard let wv = webView else { return false }
        if pen.view == nil {
            wv.addGestureRecognizer(pen)
            wv.addGestureRecognizer(fingers)
            blockScribble(in: wv)
            let pi = UIPencilInteraction()
            pi.delegate = self
            wv.addInteraction(pi)
            pencilInteraction = pi
        }
        if live.superview == nil { wv.addSubview(live) }
        return reattach()
    }

    private func reattach() -> Bool {
        guard let wv = webView, let l = layout else { return false }
        guard let sv = NativeInkController.findScrollView(in: wv, matching: l.scroller) else {
            attachDetail = NativeInkController.describe(in: wv, wanted: l.scroller)
            return false
        }
        attachDetail = ""
        let c = content ?? InkContentView(store: store)
        content = c
        c.dark = tool.dark
        c.onDetached = { [weak self] in self?.lostScrollView() }
        if c.superview !== sv {
            c.onDetached = nil
            c.removeFromSuperview()
            sv.addSubview(c)
            c.onDetached = { [weak self] in self?.lostScrollView() }
        }
        if scrollView !== sv {
            scrollView = sv
            offsetObservation = sv.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in self?.scrolled() }
        }
        c.place(origin: l.surfaceOrigin, size: l.surfaceSize, zoom: zoom)
        c.isHidden = !tool.nativeFinished // normally the web draws finished ink
        c.redrawAll()
        reattachTries = 0
        if !counted {
            counted = true
            NativeInkController.attachedCount += 1
        }
        return true
    }

    /// WebKit rebuilt the scroll view (a big relayout): find the new one, a few times, then give up.
    private func lostScrollView() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self, self.layout != nil, !self.isAttached else { return }
            if self.reattach() { return }
            self.reattachTries += 1
            if self.reattachTries < 20 { self.lostScrollView() } else { self.delegate?.nativeInkDetached() }
        }
    }

    /// The page moved or resized (the web measured it again).
    public func update(_ l: InkLayout) {
        let old = layout
        layout = l
        if !awaitingView { zoom = l.zoom }
        if !isAttached || old?.scroller != l.scroller || scrollView.map({ sv in !NativeInkController.matches(sv, l.scroller, in: webView) }) == true {
            if !reattach() { lostScrollView() }
            return
        }
        content?.place(origin: l.surfaceOrigin, size: l.surfaceSize, zoom: zoom)
    }

    public func detach() {
        cancelStroke()
        content?.onDetached = nil
        content?.removeFromSuperview()
        content = nil
        scrollView = nil
        offsetObservation = nil
        pen.view?.removeGestureRecognizer(pen)
        fingers.view?.removeGestureRecognizer(fingers)
        for (v, i) in scribbleBlockers { v.removeInteraction(i) }
        scribbleBlockers = []
        if counted {
            counted = false
            NativeInkController.attachedCount -= 1
        }
        if let pi = pencilInteraction { pi.view?.removeInteraction(pi) }
        pencilInteraction = nil
        live.removeFromSuperview()
        setPencilKit(false)
        endPinch()
        layout = nil
    }

    static func matches(_ sv: UIScrollView, _ rect: CGRect, in wv: WKWebView?) -> Bool {
        guard let wv else { return false }
        let r = sv.convert(sv.bounds, to: wv)
        return abs(r.minX - rect.minX) < 3 && abs(r.minY - rect.minY) < 3 && abs(r.width - rect.width) < 3 && abs(r.height - rect.height) < 3
    }

    /// The innermost UIScrollView whose visible box is `rect` (web view coordinates).
    static func findScrollView(in wv: WKWebView, matching rect: CGRect) -> UIScrollView? {
        var best: UIScrollView? = matches(wv.scrollView, rect, in: wv) ? wv.scrollView : nil
        func walk(_ v: UIView) {
            for s in v.subviews where !(s is InkContentView) {
                if let sv = s as? UIScrollView, matches(sv, rect, in: wv) { best = sv }
                walk(s)
            }
        }
        walk(wv.scrollView)
        return best
    }

    private func scrolled() {
        // Held strokes follow the page until the web has painted them.
        if !heldStrokes.isEmpty, builder == nil {
            mapLive()
            drawLive(nil)
        }
        scrollReport?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self, let sv = self.scrollView, !self.awaitingView else { return }
            self.delegate?.nativeInk(viewChanged: self.zoom, offset: sv.contentOffset, final: false)
        }
        scrollReport = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: w)
    }

    // MARK: - Strokes from the web

    public func setStrokes(_ items: [(String, Data)]) {
        let dirty = store.replaceAll(items)
        content?.forget(Array(store.page.keys))
        content?.redraw(dirty)
    }

    public func updateStrokes(added: [(String, Data)], removed: [String], ack: String?) {
        content?.forget(removed + added.map(\.0))
        content?.redraw(store.apply(added: added, removed: removed, ack: ack))
        if let ack, heldStrokes.contains(where: { $0.token == ack }) {
            heldStrokes.removeAll { $0.token == ack } // painted by the web now
            if builder == nil { drawLive(nil) }
        }
    }

    /// The live layer: held strokes, then the stroke being drawn.
    private func drawLive(_ current: (triangles: [Float], color: UInt32)?) {
        var items = heldStrokes.map { (triangles: $0.triangles, color: $0.color) }
        if let current { items.append(current) }
        if items.isEmpty { live.clear() } else { live.draw(items) }
    }

    /// Page px → live layer points, for the page as it is now.
    private func mapLive() {
        guard let sv = scrollView, let wv = webView, let c = content else { return }
        live.frame = sv.convert(sv.bounds, to: wv)
        wv.bringSubviewToFront(live)
        live.pageScale = zoom
        live.pageOffset = c.convert(CGPoint.zero, to: live)
    }

    // MARK: - Tools

    public func setTool(_ t: InkToolState) {
        let darkChanged = t.dark != tool.dark
        if !t.erases, t.tool != tool.tool { previousTool = t.tool }
        tool = t
        content?.isHidden = !t.nativeFinished
        applyTouchTypes()
        if darkChanged { content?.dark = t.dark }
        if let pk = pencilKit { pk.tool = pencilKitTool() }
    }

    private func applyTouchTypes() {
        var types = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        if tool.fingerDrawing { types.append(NSNumber(value: UITouch.TouchType.direct.rawValue)) }
        pen.allowedTouchTypes = types
        pen.isEnabled = (tool.active || tool.pencilSwitches) && pencilKit == nil
        // Finger drawing on: one finger draws, so scrolling takes two.
        scrollView?.panGestureRecognizer.minimumNumberOfTouches = tool.fingerDrawing && tool.active ? 2 : 1
    }

    public func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        guard tool.active else { return } // type mode: the Pencil is just a pointer
        let next = tool.erases ? (previousTool == "eraser" || previousTool == "partialEraser" ? "pen" : previousTool) : "eraser"
        if !tool.erases { previousTool = tool.tool }
        tool.tool = next
        applyTouchTypes()
        delegate?.nativeInk(toolChanged: next, enterDraw: false)
    }

    // MARK: - Scribble

    /// iPadOS Scribble turns Pencil writing over a text field into text (and scratch-out deletes
    /// text). While a pen tool is picked the Pencil draws, so Scribble must not start: an opt-out
    /// Scribble interaction on the web view and on WebKit's content view (the web side also makes
    /// the boxes non-editable meanwhile, which leaves Scribble nothing to write into).
    private func blockScribble(in wv: WKWebView) {
        var views: [UIView] = [wv]
        if let content = wv.scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContentView") }) { views.append(content) }
        for v in views {
            let i = UIScribbleInteraction(delegate: self)
            v.addInteraction(i)
            scribbleBlockers.append((v, i))
        }
    }

    public func scribbleInteraction(_ interaction: UIScribbleInteraction, shouldBeginAt location: CGPoint) -> Bool {
        InkRules.scribbleAllowed(toolActive: tool.active, pencilSwitches: tool.pencilSwitches)
    }

    // MARK: - Gesture rules

    public func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard g === pen else { return true }
        guard pencilKit == nil, pinchHolder == nil, !awaitingView, let wv = webView, let l = layout, let c = content, isAttached else { return false }
        guard InkRules.touchStartsInk(isPencil: touch.type == .pencil, toolActive: tool.active, fingerDrawing: tool.fingerDrawing, pencilSwitches: tool.pencilSwitches) else { return false }
        let p = touch.location(in: wv)
        guard l.scroller.contains(p), !l.exclusions.contains(where: { $0.contains(p) }) else { return false }
        let at = touch.location(in: c)
        let above = tool.active ? min(InkRules.maxAbove, l.surfaceOrigin.y) : 0 // type mode: the title is for typing
        return at.x >= 0 && at.x <= c.bounds.width && at.y >= -above && at.y <= c.bounds.height
    }

    public func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        g !== pen && other !== pen
    }

    // MARK: - Drawing

    private func sample(_ t: UITouch) -> (x: Float, y: Float, pressure: Float, altitude: Float, azimuth: Float, t: Double) {
        let c = content!
        let p = t.preciseLocation(in: c)
        let pencil = t.type == .pencil
        let pressure: CGFloat = pencil ? (t.maximumPossibleForce > 0 ? min(1, max(0.05, t.force / t.maximumPossibleForce)) : 0.5) : 0.5
        return (Float(p.x), Float(p.y), Float(pressure), Float(pencil ? t.altitudeAngle : .pi / 2), Float(pencil ? t.azimuthAngle(in: c) : 0), t.timestamp * 1000)
    }

    private func began(_ t: UITouch, _ e: UIEvent) {
        guard let sv = scrollView, webView != nil, content != nil else { return }
        if !tool.active {
            // Type mode with the auto-switch on: this Pencil touch turns draw mode on, and draws.
            tool.tool = tool.penTool
            applyTouchTypes()
            delegate?.nativeInk(toolChanged: tool.tool, enterDraw: true)
        }
        scrollWasEnabled = sv.isScrollEnabled
        sv.isScrollEnabled = false
        if tool.erases {
            seq += 1
            eraseToken = "e\(seq)"
            eraseRemoved = []
            erasePieces = []
            eraseLast = nil
            moved(t, e)
            return
        }
        mapLive()
        live.isHidden = false
        let pencil = t.type == .pencil
        let top = store.page.values.map(\.info.z).max()
        builder = StrokeBuilder(tool: tool.strokeTool, color: tool.color, width: tool.width, z: ZKeys.after(top),
                                flags: pencil ? InkFlag.pressure | InkFlag.tilt : 0)
        moved(t, e)
    }

    private func moved(_ t: UITouch, _ e: UIEvent) {
        let touches = e.coalescedTouches(for: t) ?? [t]
        if eraseToken != nil {
            var track: [Float] = []
            if let l = eraseLast { track += [Float(l.x), Float(l.y)] }
            for c in touches {
                let s = sample(c)
                track += [s.x, s.y]
                eraseLast = CGPoint(x: CGFloat(s.x), y: CGFloat(s.y))
            }
            erase(track)
            return
        }
        guard let b = builder else { return }
        for c in touches {
            let s = sample(c)
            b.push(x: s.x, y: s.y, pressure: s.pressure, altitude: s.altitude, azimuth: s.azimuth, t: s.t)
        }
        let predicted = (e.predictedTouches(for: t) ?? []).flatMap { p -> [Float] in
            let s = sample(p)
            return [s.x, s.y, s.pressure]
        }
        drawLive((b.previewTriangles(predicted: predicted), InkRules.displayColor(b.color, dark: tool.dark)))
    }

    private func ended(_ t: UITouch, _ e: UIEvent?, _ cancelled: Bool) {
        scrollView?.isScrollEnabled = scrollWasEnabled
        if let token = eraseToken {
            eraseToken = nil
            let removed = eraseRemoved.filter { !$0.contains("#") } // a stroke still on its way to the web stays
            let added = erasePieces.map { $0.blob }
            if cancelled || (removed.isEmpty && added.isEmpty) {
                content?.redraw(store.clearOverlay(token))
            } else {
                delegate?.nativeInk(erased: Array(removed), added: added, token: token)
            }
            return
        }
        guard let b = builder else { return }
        builder = nil
        if cancelled {
            delegate?.nativeInkDebug("stroke cancelled after \(b.count) points")
            b.cancel()
            drawLive(nil)
            return
        }
        let color = InkRules.displayColor(b.color, dark: tool.dark)
        let points = b.count
        guard let blob = b.finish() else { drawLive(nil); return }
        seq += 1
        strokeCount += 1
        let token = "s\(seq)"
        delegate?.nativeInkDebug("stroke \(strokeCount): \(points) points")
        content?.redraw(store.setOverlay(token, removed: [], added: [blob]))
        if tool.nativeFinished {
            // Shown as a finished stroke in this frame; the live layer clears on the next one, so it never blinks.
            DispatchQueue.main.async { [weak self] in self?.drawLive(nil) }
        } else {
            // The web draws it: hold it on the live layer until the web says it's painted (the ack).
            heldStrokes.append((token: token, triangles: InkEngine.triangles(blob), color: color))
            drawLive(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                // Never hold one for ever (an ack lost on the way).
                guard let self, self.heldStrokes.contains(where: { $0.token == token }) else { return }
                self.heldStrokes.removeAll { $0.token == token }
                if self.builder == nil { self.drawLive(nil) }
            }
        }
        delegate?.nativeInk(strokeFinished: blob, token: token)
    }

    private func cancelStroke() {
        builder?.cancel()
        builder = nil
        live.clear()
        if let token = eraseToken { content?.redraw(store.clearOverlay(token)) }
        eraseToken = nil
    }

    private func erase(_ track: [Float]) {
        guard let token = eraseToken, track.count >= 2 else { return }
        let r = tool.eraserRadius
        let xs = stride(from: 0, to: track.count, by: 2).map { CGFloat(track[$0]) }
        let ys = stride(from: 1, to: track.count, by: 2).map { CGFloat(track[$0]) }
        let box = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!).insetBy(dx: -CGFloat(r), dy: -CGFloat(r))
        let partial = tool.tool == "partialEraser"
        var candidates: [(String, Data, CGRect)] = store.visible().filter { !$0.id.hasPrefix(token + "#") }.map { ($0.id, $0.blob, $0.rect) }
        candidates += erasePieces.map { ($0.key, $0.blob, $0.rect) }
        var changed = false
        for (id, blob, rect) in candidates where rect.intersects(box) {
            if partial {
                if let pieces = InkEngine.erase(blob, track: track, radius: r) {
                    replace(id, pieces)
                    changed = true
                }
            } else if InkEngine.hitPath(blob, track: track, radius: r) {
                replace(id, [])
                changed = true
            }
        }
        if changed { content?.redraw(store.setOverlay(token, removed: eraseRemoved, added: erasePieces.map { $0.blob })) }
    }

    private func replace(_ id: String, _ pieces: [Data]) {
        if let i = erasePieces.firstIndex(where: { $0.key == id }) { erasePieces.remove(at: i) } else { eraseRemoved.insert(id) }
        for p in pieces {
            guard let e = StrokeEntry(id: "piece", blob: p) else { continue }
            seq += 1
            erasePieces.append((key: "p\(seq)", blob: p, rect: e.rect))
        }
    }

    // MARK: - Pinch zoom

    /// A pinch from the finger observer: `centre` in web view coordinates. Native owns zoom: a picture
    /// of the page follows the fingers, and the web lays the page out at the new zoom when they lift.
    /// If the scroll view can't be snapshotted, the scroll view itself (ink inside it) is transformed.
    private func pinch(_ state: UIGestureRecognizer.State, _ scale: CGFloat, _ centre: CGPoint) {
        guard let sv = scrollView, let wv = webView, let l = layout else { return }
        let frame = sv.convert(sv.bounds, to: wv)
        let f = CGPoint(x: centre.x - frame.minX, y: centre.y - frame.minY) // in the page's visible box
        switch state {
        case .began:
            guard builder == nil, eraseToken == nil, !awaitingView, pinchStart == nil else { return }
            let holder = UIView(frame: frame)
            holder.clipsToBounds = true
            holder.isUserInteractionEnabled = false
            holder.backgroundColor = wv.underPageBackgroundColor
            if let snap = sv.snapshotView(afterScreenUpdates: false) {
                snap.frame = holder.bounds
                holder.addSubview(snap)
                wv.addSubview(holder)
                pinchHolder = holder
                pinchSnapshot = snap
                delegate?.nativeInkDebug("pinch: zooming a picture of the page")
            } else {
                pinchSnapshot = nil
                pinchHolder = nil
                delegate?.nativeInkDebug("pinch: no snapshot; zooming the scroll view itself")
            }
            pinchStart = (f, sv.contentOffset, zoom)
            scrollWasEnabled = sv.isScrollEnabled
            sv.isScrollEnabled = false
        case .changed:
            guard let start = pinchStart else { return }
            let s = InkRules.clampZoom(start.zoom * scale) / start.zoom
            let c = CGPoint(x: frame.width / 2, y: frame.height / 2)
            let t = CGAffineTransform(translationX: f.x - c.x, y: f.y - c.y).scaledBy(x: s, y: s).translatedBy(x: c.x - start.focal.x, y: c.y - start.focal.y)
            if let snap = pinchSnapshot { snap.transform = t } else { sv.transform = t }
        case .ended, .cancelled, .failed:
            guard let start = pinchStart else { return }
            let s = InkRules.clampZoom(start.zoom * scale) / start.zoom
            let fEnd = state == .ended ? f : start.focal
            let z1 = start.zoom * s
            let offset = InkRules.offsetAfterPinch(offset: start.offset, surface: l.surfaceOrigin, scale: s, focalStart: start.focal, focalEnd: fEnd)
            awaitingView = true
            delegate?.nativeInkDebug(String(format: "pinch: zoom %.2f", z1))
            delegate?.nativeInk(viewChanged: z1, offset: offset, final: true)
            // The web answers with viewApplied; if it never does, don't leave the picture up.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                if self?.awaitingView == true { self?.viewApplied(zoom: z1) }
            }
        default:
            break
        }
    }

    /// The web has laid the page out at `zoom` (and scrolled): ink follows, and the snapshot goes.
    public func viewApplied(zoom z: CGFloat) {
        zoom = z
        awaitingView = false
        if let l = layout { content?.place(origin: l.surfaceOrigin, size: l.surfaceSize, zoom: z) }
        if let pk = pencilKit { pk.tool = pencilKitTool() }
        // One frame for WebKit's own commit to reach the screen, then fade the picture out.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.034) { [weak self] in self?.endPinch(animated: true) }
    }

    private func endPinch(animated: Bool = false) {
        let wasPinching = pinchStart != nil || pinchHolder != nil || awaitingView
        pinchStart = nil
        pinchSnapshot = nil
        if wasPinching { scrollView?.isScrollEnabled = scrollWasEnabled }
        scrollView?.transform = .identity // the no-snapshot pinch
        guard let holder = pinchHolder else { return }
        pinchHolder = nil
        if animated {
            UIView.animate(withDuration: 0.1, animations: { holder.alpha = 0 }, completion: { _ in holder.removeFromSuperview() })
        } else {
            holder.removeFromSuperview()
        }
    }

    // MARK: - PencilKit (latency comparison only; its strokes aren't saved)

    public var usesPencilKit: Bool { pencilKit != nil }

    public func setPencilKit(_ on: Bool) {
        if !on {
            pencilKit?.removeFromSuperview()
            pencilKit = nil
            applyTouchTypes()
            return
        }
        guard pencilKit == nil, let wv = webView, let sv = scrollView else { return }
        let pk = PKCanvasView(frame: sv.convert(sv.bounds, to: wv))
        pk.backgroundColor = .clear
        pk.isOpaque = false
        pk.drawingPolicy = tool.fingerDrawing ? .anyInput : .pencilOnly
        pk.isScrollEnabled = false
        pk.tool = pencilKitTool()
        wv.addSubview(pk)
        pencilKit = pk
        applyTouchTypes()
    }

    private func pencilKitTool() -> PKTool {
        let c = InkRules.displayColor(tool.color, dark: tool.dark)
        let color = UIColor(red: CGFloat((c >> 24) & 255) / 255, green: CGFloat((c >> 16) & 255) / 255, blue: CGFloat((c >> 8) & 255) / 255, alpha: CGFloat(c & 255) / 255)
        if tool.tool == "highlighter" { return PKInkingTool(.marker, color: color, width: CGFloat(tool.width) * zoom) }
        return PKInkingTool(.pen, color: color, width: CGFloat(tool.width) * zoom)
    }
}
#endif
