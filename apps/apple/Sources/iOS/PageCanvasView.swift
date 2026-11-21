import NotiveloCore
import SwiftUI
import UIKit

/// The native page: its text boxes at their saved positions on a surface with the page colour and
/// rule lines, in a UIScrollView for native pan and pinch zoom. Each box is a `BoxTextView`
/// (TextKit 2). Tap a box to edit it through the editor engine (`EditorSession`, one box at a
/// time); tap outside the boxes to stop. A live page redraws on every change, keeping zoom,
/// scroll position and the caret.
struct PageCanvasView: UIViewRepresentable {
    let page: PageSnapshot
    /// Where box editors get the document and send edits; nil: read-only.
    let host: PageEditHost?

    func makeUIView(context: Context) -> PageScrollView {
        PageScrollView()
    }

    func updateUIView(_ view: PageScrollView, context: Context) {
        view.show(page, host: host)
    }
}

final class PageScrollView: UIScrollView, UIScrollViewDelegate {
    /// Page units are CSS pixels in the web app; one page unit is one point here.
    static let margin: CGFloat = 40
    private let surface = PageSurfaceView()
    private var shownID: String?
    private var shownTasks: [String: TaskLine] = [:]
    private var shownTitles: [String: String] = [:]
    private var settings: PageSettings?
    private var boxes: [PageBox] = []
    private var boxViews: [String: BoxTextView] = [:]
    private var editors: [String: BoxEditor] = [:]
    private weak var host: PageEditHost?
    private weak var editing: BoxTextView?
    private var opening: String?
    private var demoDone = false
    private let singleTap = UITapGestureRecognizer()
    private let doubleTap = UITapGestureRecognizer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        minimumZoomScale = 0.25
        maximumZoomScale = 4
        bouncesZoom = true
        alwaysBounceVertical = true
        keyboardDismissMode = .none
        backgroundColor = .systemBackground
        surface.contentMode = .redraw
        addSubview(surface)
        doubleTap.addTarget(self, action: #selector(toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        singleTap.addTarget(self, action: #selector(tapped(_:)))
        singleTap.require(toFail: doubleTap)
        addGestureRecognizer(singleTap)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)),
                                               name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // MARK: Showing the page

    func show(_ page: PageSnapshot, host: PageEditHost?) {
        if page.id != shownID {
            stopEditing()
            boxViews.values.forEach { $0.removeFromSuperview() }
            boxViews = [:]
            editors = [:]
            shownID = page.id
            demoDone = false
            zoomScale = 1
            contentOffset = CGPoint(x: -adjustedContentInset.left, y: -adjustedContentInset.top)
        }
        if self.host !== host {
            self.host = host
            host?.onRemoteChange = { [weak self] in self?.remoteChanged() }
            host?.onSynced = { [weak self] in self?.editors.values.forEach { $0.send(all: true) } }
        }
        let tasksChanged = page.tasks != shownTasks || page.pageTitles != shownTitles
        shownTasks = page.tasks
        shownTitles = page.pageTitles
        settings = page.info.settings
        let shown = page.boxes
        boxes = shown.map(\.box)

        var seen = Set<String>()
        for item in shown {
            let id = item.box.id
            seen.insert(id)
            let view = boxViews[id] ?? makeBoxView(id)
            view.tasks = page.tasks
            view.pageTitles = page.pageTitles
            view.setWidth(CGFloat(item.box.w))
            if view.editor == nil {
                view.show(content: item.content)
            }
            if tasksChanged { view.rerender() }
        }
        for (id, view) in boxViews where !seen.contains(id) {
            // The box was deleted (by someone else): stop editing it.
            if view === editing { stopEditing() }
            view.removeFromSuperview()
            boxViews[id] = nil
            editors[id] = nil
        }
        relayout()
        runDemoIfAsked()
    }

    private func makeBoxView(_ id: String) -> BoxTextView {
        let view = BoxTextView(boxId: id)
        view.onHeightChange = { [weak self] _ in self?.relayout() }
        view.onCaretChange = { [weak self] box in self?.keepCaretVisible(box) }
        boxViews[id] = view
        surface.addSubview(view)
        return view
    }

    /// Box frames, the surface and the content size from the boxes' geometry and their text's
    /// height. Works at any zoom (the surface is sized through bounds and center).
    private func relayout() {
        var frames: [(String, CGRect, Double)] = []
        for box in boxes {
            guard let view = boxViews[box.id] else { continue }
            frames.append((box.id, CGRect(x: box.x, y: box.y, width: box.w, height: Double(view.contentHeight)), box.z))
        }
        // The surface starts at the page origin or the top-left box, whichever is further out
        // (boxes can sit at negative positions), plus a margin.
        let union = frames.reduce(CGRect(x: 0, y: 0, width: 686, height: 400)) { $0.union($1.1) }
        let origin = CGPoint(x: min(union.minX, 0) - Self.margin, y: min(union.minY, 0) - Self.margin)
        for (id, frame, _) in frames.sorted(by: { $0.2 < $1.2 }) { // stacking order: higher z in front
            guard let view = boxViews[id] else { continue }
            view.frame = frame.offsetBy(dx: -origin.x, dy: -origin.y)
            surface.bringSubviewToFront(view)
        }
        let size = CGSize(width: union.maxX - origin.x + Self.margin, height: union.maxY - origin.y + Self.margin * 4)
        surface.bounds = CGRect(origin: .zero, size: size)
        surface.center = CGPoint(x: size.width * zoomScale / 2, y: size.height * zoomScale / 2)
        if let settings { surface.configure(settings: settings, pageOrigin: CGPoint(x: -origin.x, y: -origin.y)) }
        contentSize = CGSize(width: size.width * zoomScale, height: size.height * zoomScale)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { surface }

    // MARK: Editing

    @objc private func tapped(_ tap: UITapGestureRecognizer) {
        let p = tap.location(in: surface)
        guard let box = box(at: p) else {
            stopEditing()
            return
        }
        beginEditing(box, at: tap.location(in: box))
    }

    /// The front-most box under a point of the surface.
    private func box(at p: CGPoint) -> BoxTextView? {
        surface.subviews.reversed().compactMap { $0 as? BoxTextView }.first { $0.frame.contains(p) }
    }

    /// Focus `box` with the caret at `point` (box coordinates; nil: at the end). Opens the box in
    /// the engine the first time.
    private func beginEditing(_ box: BoxTextView, at point: CGPoint?, then: (() -> Void)? = nil) {
        if box === editing {
            if let point { box.placeCaret(at: point) }
            then?()
            return
        }
        stopEditing()
        let focus = { [weak self, weak box] in
            guard let self, let box, box.superview != nil else { return }
            self.editing = box
            _ = box.becomeFirstResponder()
            if let point { box.placeCaret(at: point) } else { box.placeCaretAtEnd() }
            then?()
        }
        if box.editor != nil {
            focus()
            return
        }
        guard let host, opening == nil else { return }
        let id = box.boxId
        opening = id
        BoxEditor.open(boxId: id, host: host) { [weak self, weak box] result in
            guard let self else { return }
            self.opening = nil
            guard let box, self.boxViews[id] === box, case let .success(editor) = result else { return }
            self.editors[id] = editor
            box.attach(editor)
            focus()
        }
    }

    private func stopEditing() {
        guard let box = editing else { return }
        editing = nil
        _ = box.resignFirstResponder()
    }

    /// Someone else changed the page: every open box merges the page document again (the
    /// read-only boxes redraw from the snapshot in `show`).
    private func remoteChanged() {
        guard !editors.isEmpty, let host else { return }
        host.fetchDocument { [weak self] document in
            guard let self, let document else { return }
            for (id, editor) in self.editors {
                editor.applyRemote(document)
                self.boxViews[id]?.remoteChanged()
            }
        }
    }

    private func keepCaretVisible(_ box: BoxTextView) {
        guard box === editing, box.isFirstResponder, let range = box.selectedTextRange else { return }
        let caret = box.caretRect(for: range.end)
        let r = convert(caret, from: box).insetBy(dx: -20, dy: -40)
        scrollRectToVisible(r, animated: false)
    }

    @objc private func keyboardChanged(_ note: Notification) {
        guard let window, let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let hiding = note.name == UIResponder.keyboardWillHideNotification
        let mine = convert(bounds, to: window)
        let overlap = hiding ? 0 : max(0, mine.maxY - end.minY)
        contentInset.bottom = overlap
        verticalScrollIndicatorInsets.bottom = overlap
        if let box = editing { keepCaretVisible(box) }
    }

    // MARK: Gestures

    override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        // Taps inside the box being edited are its text interaction's (caret, word selection).
        if g === singleTap || g === doubleTap, let box = editing, box.bounds.contains(g.location(in: box)) { return false }
        return super.gestureRecognizerShouldBegin(g)
    }

    @objc private func toggleZoom(_ tap: UITapGestureRecognizer) {
        if zoomScale > 1.01 {
            setZoomScale(1, animated: true)
        } else {
            let p = tap.location(in: surface)
            zoom(to: CGRect(x: p.x - bounds.width / 4, y: p.y - bounds.height / 4, width: bounds.width / 2, height: bounds.height / 2), animated: true)
        }
    }

    // MARK: CI evidence

    /// `-demoEdit YES` (corpus mode, CI screenshots): focus the first box and type into it through
    /// the same UITextInput calls the keyboard makes (Return, a "- " list rule, typing, a marked-text composition).
    private func runDemoIfAsked() {
        guard !demoDone, UserDefaults.standard.bool(forKey: "demoEdit"), let first = boxes.first, let box = boxViews[first.id] else { return }
        demoDone = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak box] in
            guard let self, let box else { return }
            self.beginEditing(box, at: nil) {
                box.insertText("\n")
                box.insertText("- ")
                box.insertText("Typed on iPad")
                box.insertText("\n")
                box.insertText("through UITextInput")
                box.insertText("\n")
                box.setMarkedText("にほんご", selectedRange: NSRange(location: 4, length: 0))
            }
        }
    }
}

/// The page itself: its colour and rule lines or grid, 28 points apart from the page origin, as the web app draws them.
final class PageSurfaceView: UIView {
    static let rule: CGFloat = 28
    private var rules = "none"
    private var pageOrigin = CGPoint.zero

    func configure(settings: PageSettings, pageOrigin: CGPoint) {
        guard settings.rules != rules || pageOrigin != self.pageOrigin || backgroundColor == nil else {
            backgroundColor = Self.tint(settings.color)
            return
        }
        rules = settings.rules
        self.pageOrigin = pageOrigin
        backgroundColor = Self.tint(settings.color)
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard rules == "lines" || rules == "grid", let ctx = UIGraphicsGetCurrentContext() else { return }
        ctx.setStrokeColor(UIColor.separator.cgColor)
        ctx.setLineWidth(1 / max(contentScaleFactor, 1))
        let step = Self.rule
        var y = pageOrigin.y.truncatingRemainder(dividingBy: step)
        while y < bounds.maxY {
            ctx.move(to: CGPoint(x: rect.minX, y: y))
            ctx.addLine(to: CGPoint(x: rect.maxX, y: y))
            y += step
        }
        if rules == "grid" {
            var x = pageOrigin.x.truncatingRemainder(dividingBy: step)
            while x < bounds.maxX {
                ctx.move(to: CGPoint(x: x, y: rect.minY))
                ctx.addLine(to: CGPoint(x: x, y: rect.maxY))
                x += step
            }
        }
        ctx.strokePath()
    }

    /// Page colours from src/styles.css (--page-*), light and dark.
    static func tint(_ name: String) -> UIColor {
        let colors: [String: (UInt32, UInt32)] = [
            "yellow": (0xFDF8E3, 0x221F1A), "green": (0xEFF7F0, 0x1A1F1C), "blue": (0xEEF4FB, 0x1A1D24),
            "purple": (0xF5F1FB, 0x1E1B24), "pink": (0xFCF1F5, 0x221B1F), "grey": (0xF4F4F5, 0x1F1F22),
        ]
        guard let (light, dark) = colors[name] else { return .systemBackground }
        return UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) }
    }
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
