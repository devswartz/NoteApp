import AppKit
import NotiveloCore
import SwiftUI

/// The page on the Mac below its top bar, laid out as the web app's `.page-article` (LOOK.md 4.5) like the iPad's
/// `PageCanvasView`: the title and "Edited …" line, then the canvas surface whose origin is 40 pt in from the note area's left
/// edge, so a box at x = 0 has its text under the title. Boxes are `MacBoxView`s at their saved positions; the box being
/// edited gets the web's chrome (border, grey top bar, right width handle). In an NSScrollView with magnification (pinch, and
/// View ▸ Zoom through `Shell.zoom`). Click a box to edit it through the editor engine (one box at a time); click empty canvas
/// to make a box (or, while editing, to stop). A live page redraws on every change, keeping zoom, scroll position and the caret.
struct MacCanvas: NSViewRepresentable {
    let page: PageSnapshot
    /// Where box editors get the document and send edits; nil: read-only.
    let host: PageEditHost?
    let title: String
    let subline: String
    let palette: Palette
    var decor: [String: TaskDecor] = [:]
    var zoom: Double = 1
    var onZoom: ((Double) -> Void)?
    /// A short message for the user (the shell's toast).
    var notify: ((String) -> Void)?

    func makeNSView(context: Context) -> MacCanvasView {
        MacCanvasView()
    }

    func updateNSView(_ view: MacCanvasView, context: Context) {
        view.notify = notify
        view.onZoom = onZoom
        view.setHeader(title: title, subline: subline, palette: palette)
        view.decor = decor
        view.setZoom(zoom)
        view.show(page, host: host)
    }
}

/// The page surface (the scroll view's document): rule lines or grid, 28 points apart, as the web app draws them (LOOK.md 1.3):
/// a 1 pt line on the last point of every band, the pattern starting 7 pt below the surface origin; and the title.
final class MacSurfaceView: NSView {
    static let rule: CGFloat = 28
    var onMouseDown: ((NSEvent) -> Void)?
    var ruleColor = Palette.light.pageRule
    var title = NSAttributedString()
    var titleRect = CGRect.zero
    var subline = NSAttributedString()
    var sublineRect = CGRect.zero
    private var rules = "none"
    private var originY: CGFloat = 0

    override var isFlipped: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) { onMouseDown?(event) }

    func configure(rules: String, originY: CGFloat) {
        guard rules != self.rules || originY != self.originY else { return }
        self.rules = rules
        self.originY = originY
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        if rules == "lines" || rules == "grid" {
            ruleColor.setFill()
            let step = Self.rule
            let top = originY + 7
            var y = top + step - 1
            while y < bounds.maxY {
                if y + 1 >= dirtyRect.minY && y <= dirtyRect.maxY { platformFill(CGRect(x: dirtyRect.minX, y: y, width: dirtyRect.width, height: 1)) }
                y += step
            }
            if rules == "grid" {
                var x: CGFloat = 0
                while x < bounds.maxX {
                    if x + 1 >= dirtyRect.minX && x <= dirtyRect.maxX {
                        let from = max(top, dirtyRect.minY)
                        platformFill(CGRect(x: x, y: from, width: 1, height: max(dirtyRect.maxY - from, 0)))
                    }
                    x += step
                }
            }
        }
        title.draw(with: titleRect, options: [.usesLineFragmentOrigin], context: nil)
        subline.draw(with: sublineRect, options: [.usesLineFragmentOrigin], context: nil)
    }
}

final class MacCanvasView: NSView {
    /// The surface origin: 40 pt in (the block-handle gutter), and below the article's top padding
    /// (32), icon row (28 + 4), title (36 × 1.2), sub-line (6 + 18.75 + 22) and the canvas padding (14).
    static let originX: CGFloat = 40
    static let originY: CGFloat = 32 + 28 + 4 + 43.2 + 6 + 18.75 + 22 + 14

    private let scroll = NSScrollView()
    private let surface = MacSurfaceView()
    private var palette = Palette.light
    private var paletteKey = ""
    var decor: [String: TaskDecor] = [:]
    var notify: ((String) -> Void)?
    var onZoom: ((Double) -> Void)?
    private var shownID: String?
    private var shownTasks: [String: TaskLine] = [:]
    private var shownTitles: [String: String] = [:]
    private var shownDecor: [String: TaskDecor] = [:]
    private var settings: PageSettings?
    private var boxes: [PageBox] = []
    private var boxViews: [String: MacBoxView] = [:]
    private var editors: [String: BoxEditor] = [:]
    private weak var host: PageEditHost?
    private weak var editing: MacBoxView?
    private var opening: String?
    private var laidOutWidth: CGFloat = 0
    private var geometry: BoxGeometryStore = LocalBoxGeometry()
    private var needsGeometry = true
    private var lastPage: PageSnapshot?
    private var lastCommit = Date.distantPast
    /// The boxes as the page document has them (before local changes).
    private var pageBoxes: [PageBox] = []
    private var dragging = false
    private enum Drag { case move(id: String, start: CGPoint, x: Double, y: Double), resize(id: String, start: CGPoint, w: Double) }

    // Popups over the page (outside the scroll view, so they keep their size when zoomed).
    private var toolbarHost: NSHostingView<AnyView>?
    private var swatchKind: String?
    private var menuHost: NSHostingView<AnyView>?
    private weak var menuOwner: MacBoxView?
    private var linkHost: NSHostingView<AnyView>?

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.allowsMagnification = true
        scroll.minMagnification = 0.5
        scroll.maxMagnification = 3
        scroll.documentView = surface
        scroll.contentView.postsBoundsChangedNotifications = true
        addSubview(scroll)
        surface.onMouseDown = { [weak self] event in self?.surfaceMouseDown(event) }
        setAccessibilityIdentifier("page-scroll")
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(clipBoundsChanged), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        center.addObserver(self, selector: #selector(magnified), name: NSScrollView.didEndLiveMagnifyNotification, object: scroll)
        center.addObserver(self, selector: #selector(commentsChanged), name: CommentsModel.changed, object: nil)
        center.addObserver(self, selector: #selector(commentUnset(_:)), name: CommentsModel.unset, object: nil)
        EditorFocus.shared.onLink = { [weak self] in self?.showLinkEditor() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        NotificationCenter.default.removeObserver(self)
        if EditorFocus.shared.box == nil { EditorFocus.shared.onLink = nil }
    }

    override func layout() {
        super.layout()
        scroll.frame = bounds
        relayoutIfWidthChanged()
    }

    /// The part of the surface in view, in surface points.
    private var visible: CGSize {
        let s = scroll.contentView.bounds.size
        return CGSize(width: max(s.width, 1), height: max(s.height, 1))
    }

    @objc private func clipBoundsChanged() { relayoutIfWidthChanged() }

    private func relayoutIfWidthChanged() {
        let w = scroll.contentView.bounds.width
        if abs(w - laidOutWidth) > 0.5 {
            laidOutWidth = w
            relayout()
        }
    }

    // MARK: Zoom

    /// View ▸ Zoom In / Out / Actual Size: the shell's zoom, applied about the middle of what is in view.
    func setZoom(_ z: Double) {
        let m = CGFloat(z)
        guard abs(scroll.magnification - m) > 0.004 else { return }
        let vis = scroll.contentView.bounds
        scroll.setMagnification(m, centeredAt: CGPoint(x: vis.midX, y: vis.midY))
        updateToolbar()
    }

    /// A pinch ended: tell the shell (View ▸ Actual Size then goes back from here).
    @objc private func magnified() {
        onZoom?((Double(scroll.magnification) * 100).rounded() / 100)
        updateToolbar()
    }

    // MARK: Showing the page

    /// The title (36/1.2, 700, −0.025 em; "Untitled" in `--border-strong` when empty) and the "Edited …" line (12.5 muted).
    func setHeader(title: String, subline: String, palette: Palette) {
        let key = "\(palette.isDark)-\(palette.bg.hashValue)-\(palette.textMuted.hashValue)"
        if key != paletteKey {
            paletteKey = key
            self.palette = palette
            for view in boxViews.values {
                view.palette = palette
                view.rerender()
            }
            surface.ruleColor = palette.pageRule
        }
        let titleSize: CGFloat = 36
        let titleLine = titleSize * 1.2
        let titleFont = WebType.ui(titleSize, 700)
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = titleLine
        style.maximumLineHeight = titleLine
        surface.title = NSAttributedString(string: title.isEmpty ? "Untitled" : title, attributes: [
            .font: titleFont, .kern: -0.025 * titleSize, .paragraphStyle: style,
            .foregroundColor: title.isEmpty ? palette.borderStrong : palette.text,
            .baselineOffset: (titleLine - titleFont.lineHeight) / BoxTextRenderer.baselineDivisor,
        ])
        surface.subline = NSAttributedString(string: subline, attributes: [.font: WebType.ui(12.5), .foregroundColor: palette.textMuted])
        layoutHeader()
    }

    private func layoutHeader() {
        let left = Self.originX + MacBoxView.padX
        let width = max(visible.width - left - 40, 100)
        let used = surface.title.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil).height
        surface.titleRect = CGRect(x: left, y: 32 + 28 + 4, width: width, height: max(ceil(used), 43.2))
        surface.sublineRect = CGRect(x: left, y: surface.titleRect.maxY + 6, width: width, height: 18.75)
        surface.needsDisplay = true
    }

    func show(_ page: PageSnapshot, host: PageEditHost?) {
        if page.id != shownID {
            stopEditing()
            boxViews.values.forEach { $0.removeFromSuperview() }
            boxViews = [:]
            editors = [:]
            shownID = page.id
            needsGeometry = true
            hideToolbar()
            hideMenu()
            scroll.contentView.scroll(to: .zero)
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        if self.host !== host {
            self.host = host
            host?.onRemoteChange = { [weak self] in self?.remoteChanged() }
            host?.onSynced = { [weak self] in self?.editors.values.forEach { $0.send(all: true) } }
            needsGeometry = true
        }
        if needsGeometry {
            needsGeometry = false
            let store: BoxGeometryStore
            if let host, host.savesBoxes { store = LiveBoxGeometry(host: host) } else { store = LocalBoxGeometry() }
            store.onFailure = { [weak self] id, message in self?.boxFailed(id, message) }
            geometry = store
        }
        lastPage = page
        let tasksChanged = page.tasks != shownTasks || page.pageTitles != shownTitles || decor != shownDecor
        shownTasks = page.tasks
        shownTitles = page.pageTitles
        shownDecor = decor
        settings = page.info.settings
        let shown = page.boxes
        let contentOf = Dictionary(shown.map { ($0.box.id, $0.content) }, uniquingKeysWith: { a, _ in a })
        pageBoxes = shown.map { $0.box }
        let merged = geometry.apply(to: pageBoxes)
        boxes = merged

        var seen = Set<String>()
        for box in merged {
            let id = box.id
            seen.insert(id)
            let view = boxViews[id] ?? makeBoxView(id)
            view.tasks = page.tasks
            view.pageTitles = page.pageTitles
            view.pageChoices = page.pageChoices
            view.people = page.people
            view.decor = decor
            view.setWidth(width(of: box))
            if view.editor == nil {
                view.show(content: contentOf[id] ?? [])
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
    }

    /// A box's drawn width: wide boxes span the visible note area minus 40 pt on each side.
    private func width(of box: PageBox) -> CGFloat {
        guard box.wide else { return CGFloat(box.w) }
        let w = scroll.contentView.bounds.width
        return max((w > 1 ? w : 900) - Self.originX - 40, 120)
    }

    private func makeBoxView(_ id: String) -> MacBoxView {
        let view = MacBoxView(boxId: id)
        view.palette = palette
        view.onHeightChange = { [weak self] _ in self?.relayout() }
        view.onMenu = { [weak self] box, content in self?.showMenu(box, content) }
        view.onMouseDown = { [weak self] box, event in self?.boxMouseDown(box, event) ?? false }
        view.onCaretChange = { [weak self] box in
            guard let self, box === self.editing else { return }
            self.keepCaretVisible(box)
            EditorFocus.shared.refresh()
            self.updateToolbar()
        }
        boxViews[id] = view
        surface.addSubview(view)
        return view
    }

    /// Box frames, the surface and the scroll size from the boxes' geometry and their text's height.
    private var relaying = false

    private func relayout() {
        guard !relaying else { return }
        relaying = true
        defer { relaying = false }
        let ox = Self.originX, oy = Self.originY
        var maxX: CGFloat = 0, maxY: CGFloat = 0
        for box in boxes {
            guard let view = boxViews[box.id] else { continue }
            let w = width(of: box)
            view.setWidth(w)
            view.zOrder = box.z
            view.raised = view === editing
            let f = CGRect(x: ox + CGFloat(box.x), y: oy + CGFloat(box.y), width: w, height: view.contentHeight)
            view.frame = CGRect(x: f.minX - MacBoxView.gutterLeft, y: f.minY - MacBoxView.gutterTop,
                                width: f.width + MacBoxView.gutterLeft + MacBoxView.gutterRight, height: f.height + MacBoxView.gutterTop)
            maxX = max(maxX, f.maxX)
            maxY = max(maxY, f.maxY)
        }
        // Stacking order: higher z in front (the box being edited in front of all).
        surface.sortSubviews({ a, b, _ in
            let ka = (a as? MacBoxView)?.sortKey ?? -1, kb = (b as? MacBoxView)?.sortKey ?? -1
            return ka < kb ? .orderedAscending : (ka > kb ? .orderedDescending : .orderedSame)
        }, context: nil)
        let vis = visible
        let size = CGSize(width: max(maxX + 240, vis.width), height: max(maxY + 320, oy + 320, vis.height))
        if surface.frame.size != size { surface.setFrameSize(size) }
        if let settings { surface.configure(rules: settings.rules, originY: oy) }
        layoutHeader()
        window?.invalidateCursorRects(for: surface)
    }

    // MARK: Mouse

    private func surfaceMouseDown(_ event: NSEvent) {
        let p = surface.convert(event.locationInWindow, from: nil)
        if linkEditorShown { hideLinkEditor(refocus: false) }
        if let hit = moveHit(p) {
            startDrag(hit)
            return
        }
        // A click on empty canvas: while editing it only stops; else it makes a box (the web's click-to-create).
        if editing != nil || host == nil || p.y < Self.originY {
            stopEditing()
        } else {
            createBox(at: p)
        }
    }

    /// A press in a box. True when the canvas took it (start editing, move, resize, fold arrow, a link); false: the box's own
    /// text selection handles it.
    private func boxMouseDown(_ box: MacBoxView, _ event: NSEvent) -> Bool {
        let local = box.convert(event.locationInWindow, from: nil)
        // A task's fold arrow (in the gutter, outside the box's own text).
        if let id = box.foldTask(at: local) {
            BoxTextRenderer.toggleCollapsed(id)
            box.rerender()
            return true
        }
        if linkEditorShown { hideLinkEditor(refocus: false) }
        let p = surface.convert(event.locationInWindow, from: nil)
        if let hit = moveHit(p) {
            startDrag(hit)
            return true
        }
        if box !== editing {
            // A link in a box that is not being edited opens (http, https, mailto), as the web's read-only text does.
            if let url = box.linkHref(at: local).flatMap(LinkURL.openable) {
                NSWorkspace.shared.open(url)
                return true
            }
            // Text with a comment: its thread opens in the comments panel (the editing carries on).
            if let thread = box.commentThread(at: local) { CommentsModel.shared.focus(thread) }
            beginEditing(box, at: local)
            return true
        }
        if let thread = box.commentThread(at: local) { CommentsModel.shared.focus(thread) }
        // A click on a task line's title edits the title.
        return box.beginTitleEdit(at: local)
    }

    // MARK: Comments

    /// The toolbar's Comment button: mark the selection with a new thread and ask for the comment in the panel.
    private func startComment() {
        guard let box = editing, host != nil else { return }
        let quote = box.selectedQuote
        guard !quote.isEmpty else { return }
        CommentsModel.shared.begin(box: box, quote: quote)
        hideToolbar()
    }

    /// Threads were loaded, resolved or focused: draw the marks again (resolved ones plain, the open one stronger).
    @objc private func commentsChanged() {
        for view in boxViews.values { view.rerender() }
    }

    /// Take a thread's mark off the page (a cancelled or deleted thread): in every box that carries it, opening the boxes that
    /// were never edited.
    @objc private func commentUnset(_ note: Notification) {
        guard let id = note.object as? String else { return }
        let json = "{\"threadId\":\"\(id)\"}"
        for (boxId, view) in boxViews where view.hasThread(id) {
            if view.editor != nil {
                view.command("unsetComment", json)
            } else if let host {
                BoxEditor.open(boxId: boxId, host: host) { [weak self, weak view] result in
                    guard let self, let view, self.boxViews[boxId] === view, case let .success(editor) = result else { return }
                    self.editors[boxId] = editor
                    view.attach(editor)
                    view.command("unsetComment", json)
                }
            }
        }
    }

    // MARK: Creating, moving and resizing boxes

    /// A click on empty canvas: a box 360 wide, 12 pt above the click, in front. On a live page the box exists on the server at
    /// once and is opened in the editor, so it can be typed in.
    private func createBox(at p: CGPoint) {
        let x = max(Double(p.x - Self.originX), 0)
        let y = max(Double(p.y - Self.originY - 12), 0)
        let front = (boxes.map(\.z).max() ?? 0) + 1
        let id = geometry.createBox(x: x, y: y, width: 360, front: front)
        boxes = geometry.apply(to: pageBoxes)
        let view = makeBoxView(id)
        view.show(content: [])
        view.setWidth(360)
        relayout()
        if geometry.savesToServer {
            beginEditing(view, at: nil)
        } else {
            // No server (corpus pages): the box is drawn as the web draws a new one, without an editor.
            editing = view
            view.chrome = true
            relayout()
            EditorFocus.shared.set(nil)
        }
    }

    /// The server refused a box change (the store has taken it back): say so and draw the page as it is.
    private func boxFailed(_ id: String, _ message: String?) {
        if let message { notify?(message) }
        if let view = boxViews[id], !geometry.apply(to: pageBoxes).contains(where: { $0.id == id }) {
            if view === editing { stopEditing(drop: false) }
            view.removeFromSuperview()
            boxViews[id] = nil
            editors[id] = nil
        }
        if let lastPage {
            show(lastPage, host: host)
        } else {
            boxes = geometry.apply(to: pageBoxes)
            relayout()
        }
    }

    /// A box left empty goes away (the web removes an empty box on leaving it): at once on screen, on the server by
    /// `deleteBox`, which refuses a box that has anything in it.
    private func removeIfEmpty(_ box: MacBoxView) {
        guard box.boxId != "default", box.shownText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if geometry.savesToServer {
            if box.editor == nil && !geometry.isLocal(box.boxId) { return } // never opened: not ours to remove
        } else if !geometry.isLocal(box.boxId) {
            return
        }
        geometry.deleteBox(box.boxId)
        boxes.removeAll { $0.id == box.boxId }
        boxViews[box.boxId] = nil
        editors[box.boxId] = nil
        box.removeFromSuperview()
    }

    /// The box is being edited or dragged: in front of the others (the web does on focus and on drag start).
    private func bringToFront(_ id: String) {
        guard let mine = boxes.first(where: { $0.id == id }) else { return }
        let others = boxes.filter { $0.id != id }.map(\.z).max() ?? -1
        guard mine.z <= others else { return }
        geometry.bringToFront(id, z: others + 1)
        boxes = geometry.apply(to: pageBoxes)
        relayout()
    }

    /// The edited box's top bar (the web's 12 high, here a little bigger) and its width handle on the right edge.
    private func moveHit(_ p: CGPoint) -> Drag? {
        guard let box = editing, box.superview != nil, let b = boxes.first(where: { $0.id == box.boxId }) else { return nil }
        let f = box.boxFrame
        if CGRect(x: f.minX, y: f.minY - 16, width: f.width, height: 20).contains(p) {
            return .move(id: b.id, start: p, x: b.x, y: b.y)
        }
        if CGRect(x: f.maxX - 8, y: f.midY - 30, width: 16, height: 60).contains(p) {
            return .resize(id: b.id, start: p, w: Double(f.width))
        }
        return nil
    }

    /// Follow the mouse until it is released, moving or resizing the box and sending the geometry every so often.
    private func startDrag(_ hit: Drag) {
        guard let window else { return }
        hideToolbar()
        dragging = true
        switch hit {
        case let .move(id, _, _, _), let .resize(id, _, _): bringToFront(id)
        }
        while let event = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            let p = surface.convert(event.locationInWindow, from: nil)
            if event.type == .leftMouseUp { break }
            switch hit {
            case let .move(id, start, x, y):
                geometry.moveBox(id, x: max(x + Double(p.x - start.x), 0), y: max(y + Double(p.y - start.y), 0))
            case let .resize(id, start, w):
                geometry.resizeBox(id, width: min(max(w + Double(p.x - start.x), 120), 2400))
            }
            boxes = geometry.apply(to: pageBoxes)
            relayout()
            if Date().timeIntervalSince(lastCommit) > 0.15 {
                lastCommit = Date()
                switch hit {
                case let .move(id, _, _, _), let .resize(id, _, _): geometry.commit(id)
                }
            }
        }
        switch hit {
        case let .move(id, _, _, _), let .resize(id, _, _): geometry.commit(id)
        }
        dragging = false
        updateToolbar()
    }

    // MARK: Editing

    /// Focus `box` with the caret at `point` (box coordinates; nil: at the end). Opens the box in the engine the first time.
    private func beginEditing(_ box: MacBoxView, at point: CGPoint?, then: (() -> Void)? = nil) {
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
            self.bringToFront(box.boxId)
            self.relayout()
            box.setActive(true)
            if let point { box.placeCaret(at: point) } else { box.placeCaretAtEnd() }
            if let point { box.beginTitleEdit(at: point) }
            EditorFocus.shared.set(box)
            self.updateToolbar()
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

    private func stopEditing(drop: Bool = true) {
        guard let box = editing else { return }
        editing = nil
        hideToolbar()
        hideMenu()
        if linkEditorShown { hideLinkEditor(refocus: false) }
        if drop { removeIfEmpty(box) }
        box.endTitleEdit()
        box.chrome = false
        box.setActive(false)
        EditorFocus.shared.set(nil)
        relayout()
    }

    /// Someone else changed the page: every open box merges the page document again (the read-only boxes redraw from the
    /// snapshot in `show`).
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

    private func keepCaretVisible(_ box: MacBoxView) {
        guard box.isEditable, !dragging else { return }
        _ = box.scrollToVisible(box.caretNow.insetBy(dx: -20, dy: -40))
    }

    // MARK: Popups

    private func popupHost(_ existing: NSHostingView<AnyView>?, _ root: AnyView) -> NSHostingView<AnyView> {
        if let existing {
            existing.rootView = root
            return existing
        }
        let h = NSHostingView(rootView: root)
        h.isHidden = true
        addSubview(h)
        return h
    }

    /// The area the popups stay inside (this view's coordinates).
    private var popupArea: CGRect { bounds }

    // Floating toolbar

    private func hideToolbar() {
        toolbarHost?.isHidden = true
        swatchKind = nil
    }

    /// Show the toolbar over the selected text of the box being edited, or hide it.
    private func updateToolbar() {
        guard let box = editing, !dragging, !linkEditorShown, menuHost?.isHidden ?? true, let rect = box.selectionBounds else {
            hideToolbar()
            return
        }
        showToolbar(over: convert(rect, from: box))
    }

    private func showToolbar(over selection: CGRect) {
        let root = AnyView(MacFormatToolbar(
            palette: palette, swatch: swatchKind,
            run: { [weak self] name, args in
                EditorFocus.shared.run(name, args)
                self?.updateToolbar()
            },
            onLink: { [weak self] in self?.showLinkEditor() },
            onComment: { [weak self] in self?.startComment() },
            onSwatch: { [weak self] kind in
                guard let self else { return }
                self.swatchKind = self.swatchKind == kind ? nil : kind
                self.updateToolbar()
            }))
        let host = popupHost(toolbarHost, root)
        toolbarHost = host
        host.layoutSubtreeIfNeeded()
        let size = host.fittingSize
        let visible = popupArea
        var x = selection.midX - size.width / 2
        x = min(max(x, visible.minX + 8), max(visible.maxX - size.width - 8, visible.minX + 8))
        let barHeight: CGFloat = 36
        var y = selection.minY - 8 - barHeight
        if y < visible.minY + 8 { y = selection.maxY + 10 }
        host.frame = CGRect(x: x, y: y, width: size.width, height: size.height)
        host.isHidden = false
    }

    // `/`, `[[` and `@` menu

    private func hideMenu() { menuHost?.isHidden = true }

    private func showMenu(_ box: MacBoxView, _ content: MenuContent?) {
        if content != nil { hideToolbar() }
        guard let content else {
            if menuOwner === box || menuOwner == nil { hideMenu() }
            return
        }
        menuOwner = box
        let root = AnyView(MacSuggestionMenu(content: content, palette: palette, onPick: { [weak box] i in box?.pickMenuRow(i) }))
        let host = popupHost(menuHost, root)
        menuHost = host
        let m = MacSuggestionMenu.metrics(content)
        let anchor = convert(content.anchor, from: box)
        let visible = popupArea
        var x = anchor.minX
        x = min(x, visible.maxX - m.width - 8)
        x = max(x, visible.minX + 8)
        var y = anchor.maxY + 6
        if y + m.total > visible.maxY - 8 { y = max(visible.minY + 8, anchor.minY - 6 - m.total) }
        host.frame = CGRect(x: x, y: y, width: m.width, height: m.total)
        host.isHidden = false
    }

    // Link editor

    private var linkEditorShown: Bool { !(linkHost?.isHidden ?? true) }

    /// Show the link editor under the selection or caret of the box being edited (the toolbar and ribbon Link buttons,
    /// Cmd+K): prefilled when the selection is in a link.
    private func showLinkEditor() {
        guard let box = editing, box.editor != nil, let ctx = box.prepareLink() else { return }
        hideToolbar()
        hideMenu()
        let width = max(min(bounds.width - 16, 360), 200)
        let root = AnyView(MacLinkEditor(
            palette: palette, text: ctx.text, address: ctx.href, width: width,
            onApply: { [weak self] text, address in self?.applyLink(text: text, address: address) },
            onRemove: { [weak self] in self?.removeLink() },
            onOpen: { href in if let url = LinkURL.openable(href) { NSWorkspace.shared.open(url) } },
            onCancel: { [weak self] in self?.hideLinkEditor(refocus: true) })
            .id(UUID()))
        let host = popupHost(linkHost, root)
        linkHost = host
        let anchor = convert(ctx.rect, from: box)
        let visible = popupArea
        let size = CGSize(width: width, height: MacLinkEditor.height)
        let x = min(max(anchor.minX, visible.minX + 8), max(visible.maxX - size.width - 8, visible.minX + 8))
        var y = anchor.maxY + 8
        if y + size.height > visible.maxY - 8 { y = max(anchor.minY - 8 - size.height, visible.minY + 8) }
        host.frame = CGRect(origin: CGPoint(x: x, y: y), size: size)
        host.isHidden = false
    }

    private func hideLinkEditor(refocus: Bool) {
        guard linkEditorShown else { return }
        linkHost?.isHidden = true
        linkHost?.rootView = AnyView(EmptyView())
        if refocus, let box = editing { box.refocus() }
        updateToolbar()
    }

    private func applyLink(text: String, address: String) {
        guard let box = editing else { return }
        hideLinkEditor(refocus: false)
        box.refocus()
        EditorFocus.shared.run("editLink", ["text": text, "href": address])
        updateToolbar()
    }

    private func removeLink() {
        guard let box = editing else { return }
        hideLinkEditor(refocus: false)
        box.refocus()
        EditorFocus.shared.run("unsetLink")
        updateToolbar()
    }
}
