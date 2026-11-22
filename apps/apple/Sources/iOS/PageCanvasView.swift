import NotiveloCore
import SwiftUI
import UIKit

/// The native page below its top bar, laid out as the web app's `.page-article` (LOOK.md 4.5):
/// the title and "Edited …" line, then the canvas surface whose origin is 40 pt in from the note
/// area's left edge, so a box at x = 0 has its text under the title. Boxes are `BoxTextView`s
/// (TextKit 2) at their saved positions; the box being edited gets the web's chrome. Rule lines
/// and grid are drawn on the surface. In a UIScrollView for native pan and pinch zoom. Tap a box
/// to edit it through the editor engine (`EditorSession`, one box at a time); tap outside the
/// boxes to stop. A live page redraws on every change, keeping zoom, scroll position and the caret.
struct PageCanvasView: UIViewRepresentable {
    let page: PageSnapshot
    /// Where box editors get the document and send edits; nil: read-only.
    let host: PageEditHost?
    let title: String
    let subline: String
    let palette: Palette
    var decor: [String: TaskDecor] = [:]
    var showAddIcon = false
    /// Phones: boxes stacked in reading order, full width (LOOK.md 3.2).
    var stacked = false

    func makeUIView(context: Context) -> PageScrollView {
        PageScrollView()
    }

    func updateUIView(_ view: PageScrollView, context: Context) {
        view.stacked = stacked
        BoxTextRenderer.phoneChips = stacked
        view.setHeader(title: title, subline: subline, palette: palette, showAddIcon: showAddIcon)
        view.decor = decor
        view.show(page, host: host)
    }
}

final class PageScrollView: UIScrollView, UIScrollViewDelegate {
    /// The surface origin: 40 pt in (the block-handle gutter), and below the article's top padding
    /// (32), icon row (28 + 4), title (36 × 1.2), sub-line (6 + 18.75 + 22) and the canvas padding (14).
    static let originX: CGFloat = 40
    static let originY: CGFloat = 32 + 28 + 4 + 43.2 + 6 + 18.75 + 22 + 14
    private let surface = PageSurfaceView()
    private let titleLabel = UILabel()
    private let subLabel = UILabel()
    private let addIcon = UILabel()
    private var palette = Palette.light
    private var paletteKey = ""
    var decor: [String: TaskDecor] = [:]
    var stacked = false
    /// Phones: the article's padding is 12 20, the title 28 pt.
    static let phoneOriginY: CGFloat = 12 + 44 + 4 + 33.6 + 6 + 18.75 + 22
    private var shownID: String?
    private var shownTasks: [String: TaskLine] = [:]
    private var shownTitles: [String: String] = [:]
    private var shownDecor: [String: TaskDecor] = [:]
    private var settings: PageSettings?
    private var boxes: [PageBox] = []
    private var boxViews: [String: BoxTextView] = [:]
    private var editors: [String: BoxEditor] = [:]
    private weak var host: PageEditHost?
    private weak var editing: BoxTextView?
    private var opening: String?
    private var demoDone = false
    private var lookDone = false
    private var laidOutWidth: CGFloat = 0
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
        backgroundColor = .clear
        contentInsetAdjustmentBehavior = .never
        surface.contentMode = .redraw
        surface.isOpaque = false
        surface.backgroundColor = .clear
        addSubview(surface)
        titleLabel.numberOfLines = 0
        subLabel.numberOfLines = 1
        surface.addSubview(titleLabel)
        surface.addSubview(subLabel)
        surface.addSubview(addIcon)
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

    override func layoutSubviews() {
        super.layoutSubviews()
        if abs(bounds.width - laidOutWidth) > 0.5 {
            laidOutWidth = bounds.width
            relayout()
        }
    }

    // MARK: Showing the page

    /// The title (36/1.2, 700, −0.025 em; "Untitled" in `--border-strong` when empty) and the
    /// "Edited …" line (12.5 muted).
    func setHeader(title: String, subline: String, palette: Palette, showAddIcon: Bool) {
        let key = "\(palette.isDark)-\(palette.bg.hashValue)-\(palette.textMuted.hashValue)"
        if key != paletteKey {
            paletteKey = key
            self.palette = palette
            for view in boxViews.values {
                view.palette = palette
                view.rerender()
            }
            surface.ruleColor = palette.pageRule
            surface.setNeedsDisplay()
        }
        let titleSize: CGFloat = stacked ? 28 : 36
        let titleLine = titleSize * 1.2
        let titleFont = WebType.ui(titleSize, 700)
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = titleLine
        style.maximumLineHeight = titleLine
        titleLabel.attributedText = NSAttributedString(string: title.isEmpty ? "Untitled" : title, attributes: [
            .font: titleFont, .kern: -0.025 * titleSize, .paragraphStyle: style,
            .foregroundColor: title.isEmpty ? palette.borderStrong : palette.text,
            .baselineOffset: (titleLine - titleFont.lineHeight) / BoxTextRenderer.baselineDivisor,
        ])
        subLabel.attributedText = NSAttributedString(string: subline, attributes: [.font: WebType.ui(12.5), .foregroundColor: palette.textMuted])
        if showAddIcon {
            let s = NSMutableAttributedString()
            if let icon = UIImage.lucide("face-slightly-smiling-plus", size: 15, color: palette.textMuted) {
                let a = NSTextAttachment(image: icon)
                a.bounds = CGRect(x: 0, y: -2.5, width: 15, height: 15)
                s.append(NSAttributedString(attachment: a))
            }
            s.append(NSAttributedString(string: "  Add icon", attributes: [.font: WebType.ui(13, 500), .foregroundColor: palette.textMuted]))
            addIcon.attributedText = s
            addIcon.isHidden = false
        } else {
            addIcon.isHidden = true
        }
        layoutHeader()
    }

    private func layoutHeader() {
        let left = stacked ? 20 : Self.originX + BoxTextView.pad.left
        let width = max(bounds.width / max(zoomScale, 0.01) - left - (stacked ? 20 : 40), 100)
        let titleSize = titleLabel.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let top: CGFloat = stacked ? 12 : 32
        let iconRow: CGFloat = stacked ? 44 : 28
        titleLabel.frame = CGRect(x: left, y: top + iconRow + 4, width: width, height: max(titleSize.height, stacked ? 33.6 : 43.2))
        subLabel.frame = CGRect(x: left, y: titleLabel.frame.maxY + 6, width: width, height: 18.75)
        addIcon.frame = CGRect(x: left - (stacked ? 0 : 8), y: top, width: 160, height: iconRow)
    }

    func show(_ page: PageSnapshot, host: PageEditHost?) {
        if page.id != shownID {
            stopEditing()
            boxViews.values.forEach { $0.removeFromSuperview() }
            boxViews = [:]
            editors = [:]
            shownID = page.id
            demoDone = false
            lookDone = false
            zoomScale = 1
            contentOffset = .zero
        }
        if self.host !== host {
            self.host = host
            host?.onRemoteChange = { [weak self] in self?.remoteChanged() }
            host?.onSynced = { [weak self] in self?.editors.values.forEach { $0.send(all: true) } }
        }
        let tasksChanged = page.tasks != shownTasks || page.pageTitles != shownTitles || decor != shownDecor
        shownTasks = page.tasks
        shownTitles = page.pageTitles
        shownDecor = decor
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
            view.decor = decor
            view.setWidth(width(of: item.box))
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
        runLookIfAsked()
    }

    /// A box's drawn width: wide boxes span the visible note area minus 40 pt on each side.
    private func width(of box: PageBox) -> CGFloat {
        if stacked { return max((bounds.width > 0 ? bounds.width : 390) - 18, 120) }
        guard box.wide else { return CGFloat(box.w) }
        let visible = (bounds.width > 0 ? bounds.width : 900) / max(zoomScale, 0.01)
        return max(visible - Self.originX - 40, 120)
    }

    private func makeBoxView(_ id: String) -> BoxTextView {
        let view = BoxTextView(boxId: id)
        view.palette = palette
        view.onHeightChange = { [weak self] _ in self?.relayout() }
        view.onCaretChange = { [weak self] box in
            self?.keepCaretVisible(box)
            if box === self?.editing { EditorFocus.shared.refresh() }
        }
        boxViews[id] = view
        surface.addSubview(view)
        return view
    }

    /// Box frames, the surface and the content size from the boxes' geometry and their text's
    /// height. Works at any zoom (the surface is sized through bounds and center).
    private var relaying = false

    private func relayout() {
        guard !relaying else { return }
        relaying = true
        defer { relaying = false }
        let ox = Self.originX, oy = Self.originY
        var maxX: CGFloat = 0, maxY: CGFloat = 0
        var frames: [(String, CGRect, Double)] = []
        var separators: [CGFloat] = []
        // Phones: one under the other, padding 12 0, a hairline between (text 20 pt in).
        var y = Self.phoneOriginY - BoxTextView.pad.top
        for box in boxes {
            guard let view = boxViews[box.id] else { continue }
            let w = width(of: box)
            view.setWidth(w)
            let frame: CGRect
            if stacked {
                frame = CGRect(x: 20 - BoxTextView.pad.left, y: y, width: w, height: view.contentHeight)
                separators.append(frame.maxY + 5)
                y = frame.maxY + 5 + 1 + 5
            } else {
                frame = CGRect(x: ox + CGFloat(box.x), y: oy + CGFloat(box.y), width: w, height: view.contentHeight)
            }
            frames.append((box.id, frame, stacked ? 0 : box.z))
            maxX = max(maxX, frame.maxX)
            maxY = max(maxY, frame.maxY)
        }
        surface.separators = separators
        surface.separatorColor = palette.border
        surface.separatorInset = 20
        for (id, frame, _) in frames.sorted(by: { $0.2 < $1.2 }) { // stacking order: higher z in front
            guard let view = boxViews[id] else { continue }
            view.frame = frame
            surface.bringSubviewToFront(view)
        }
        if let editing { surface.bringSubviewToFront(editing) }
        let visible = CGSize(width: max(bounds.width, 1) / max(zoomScale, 0.01), height: max(bounds.height, 1) / max(zoomScale, 0.01))
        let size = stacked
            ? CGSize(width: visible.width, height: max(maxY + visible.height * 0.4, visible.height))
            : CGSize(width: max(maxX + 240, visible.width), height: max(maxY + 320, oy + 320, visible.height))
        surface.bounds = CGRect(origin: .zero, size: size)
        surface.center = CGPoint(x: size.width * zoomScale / 2, y: size.height * zoomScale / 2)
        if let settings { surface.configure(rules: settings.rules, originY: oy) }
        contentSize = CGSize(width: size.width * zoomScale, height: size.height * zoomScale)
        layoutHeader()
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
            box.chrome = true
            self.surface.bringSubviewToFront(box)
            _ = box.becomeFirstResponder()
            if let point { box.placeCaret(at: point) } else { box.placeCaretAtEnd() }
            EditorFocus.shared.set(box)
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
        box.chrome = false
        _ = box.resignFirstResponder()
        EditorFocus.shared.set(nil)
        relayout()
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

    /// Look states with a box being edited (`-lookState edit-caret`, CI): the caret at the end of "Box c", as the web reference.
    private func runLookIfAsked() {
        guard !lookDone, UserDefaults.standard.bool(forKey: "previewSignedIn"),
              let state = LookData.state, ["edit-caret", "ribbon-page-active", "edit-selection"].contains(state) else { return }
        guard let box = boxViews.values.first(where: { $0.shownText.contains("Box c") }) else { return }
        lookDone = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak box] in
            guard let self, let box else { return }
            self.beginEditing(box, at: nil)
        }
    }
}

/// The page surface: rule lines or grid, 28 points apart, as the web app draws them (LOOK.md 1.3):
/// a 1 pt line on the last point of every band, the pattern starting 7 pt below the surface origin.
final class PageSurfaceView: UIView {
    static let rule: CGFloat = 28
    var ruleColor = Palette.light.pageRule
    var separators: [CGFloat] = [] {
        didSet { if separators != oldValue { setNeedsDisplay() } }
    }
    var separatorColor = Palette.light.border
    var separatorInset: CGFloat = 20
    private var rules = "none"
    private var originY: CGFloat = 0

    func configure(rules: String, originY: CGFloat) {
        guard rules != self.rules || originY != self.originY else { return }
        self.rules = rules
        self.originY = originY
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        separatorColor.setFill()
        for y in separators { UIRectFill(CGRect(x: separatorInset, y: y, width: bounds.width - separatorInset * 2, height: 1)) }
        guard rules == "lines" || rules == "grid" else { return }
        ruleColor.setFill()
        let step = Self.rule
        let top = originY + 7
        var y = top + step - 1
        while y < bounds.maxY {
            if y + 1 >= rect.minY && y <= rect.maxY { UIRectFill(CGRect(x: rect.minX, y: y, width: rect.width, height: 1)) }
            y += step
        }
        if rules == "grid" {
            var x: CGFloat = 0
            while x < bounds.maxX {
                if x + 1 >= rect.minX && x <= rect.maxX { UIRectFill(CGRect(x: x, y: max(top, rect.minY), width: 1, height: max(rect.maxY - max(top, rect.minY), 0))) }
                x += step
            }
        }
    }
}
