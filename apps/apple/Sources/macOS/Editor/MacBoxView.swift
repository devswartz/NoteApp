import AppKit
import NotiveloCore

/// One text box of the Mac canvas: an `NSTextView` on TextKit 2 that shows a box and, once a `BoxEditor` is attached, edits it
/// through the engine (EDITOR.md 10.4). The engine owns the text, the selection and the composition; this view owns the
/// layout, the drawing and the AppKit input protocol.
///
/// How the two meet:
/// - The text view's storage is only ever written from the engine's state (`reload`): the renderer (Shared/Editor/BoxRender)
///   draws the box's tree as one attributed string with the same UTF-16 offsets as `textForView()`.
/// - Everything that would change the storage goes to the engine instead: `insertText`, `setMarkedText`, `unmarkText`,
///   `doCommand(by:)` (Return, Tab, Delete … become `key(chord)`), cut/copy/paste, and `shouldChangeText` (spell-check
///   corrections, services) which is refused after sending the change as `replace_range`.
/// - Moving the caret or selecting (mouse, arrows, word and line moves) is NSTextView's own layout-aware logic; the result
///   is sent to the engine (`setSelectedRanges`), and the engine's selection is shown back after each change.
/// - Markers, block backgrounds and the editing frame are drawn around the text by `draw` (BoxPainter, the iPad's drawing).
///
/// The view is bigger than the box: `gutter*` is room for what sits outside the box (fold arrows left, the move bar above,
/// the width handle right), so layers of the view aren't clipped. `boxFrame` is the box itself.
final class MacBoxView: NSTextView, EditorTarget {
    static let padX: CGFloat = 11
    static let padY: CGFloat = 7
    static let gutterLeft: CGFloat = 20
    static let gutterTop: CGFloat = 10
    static let gutterRight: CGFloat = 4

    let boxId: String
    var tasks: [String: TaskLine] = [:]
    var pageTitles: [String: String] = [:]
    var decor: [String: TaskDecor] = [:]
    /// People the `@` menu offers, and pages the `[[` menu offers (set by the canvas).
    var people: [PageMember] = []
    var pageChoices: [PageChoice] = []
    /// The box's z (higher is in front).
    var zOrder: Double = 0
    /// The box being edited is in front of all.
    var raised = false
    var sortKey: Double { raised ? Double.greatestFiniteMagnitude : zOrder }
    /// The page's palette (Hybrid: the light one).
    var palette: Palette = .light {
        didSet { applyColors() }
    }
    /// The box is being edited: opaque `--bg`, `--border-strong` border, move bar and width handle.
    var chrome = false {
        didSet {
            guard chrome != oldValue else { return }
            if !chrome { removeTitleField() }
            needsDisplay = true
        }
    }
    /// A mouse press in the box (return true when the canvas took it: starting to edit, moving, resizing, a fold arrow).
    var onMouseDown: ((MacBoxView, NSEvent) -> Bool)?
    /// The height changed (the box grows with its text).
    var onHeightChange: ((MacBoxView) -> Void)?
    /// The caret moved or the text changed (the canvas keeps the caret in view and the toolbar over the selection).
    var onCaretChange: ((MacBoxView) -> Void)?
    /// A `/`, `[[` or `@` menu opened, changed or closed (nil).
    var onMenu: ((MacBoxView, MenuContent?) -> Void)?
    private(set) var contentHeight: CGFloat = 28

    private var rendering = BoxRendering.empty
    private var shownContent: [ContentNode]?
    private var shownDocJSON: String?
    private var layoutWidth: CGFloat = 0

    // Editing
    private(set) var editor: BoxEditor?
    /// The view's text (the session's `textForView()`).
    private var text: NSString = ""
    private var sel = (lo: 0, hi: 0)
    private var marked: (lo: Int, hi: Int)?
    private var suggestion: EditorSuggestion?
    /// Set while this view writes the storage or the selection itself (the engine's state), so the selection override
    /// doesn't send it back.
    private var syncing = false

    init(boxId: String) {
        self.boxId = boxId
        let storage = NSTextContentStorage()
        let layout = NSTextLayoutManager()
        storage.addTextLayoutManager(layout)
        if storage.textStorage == nil { storage.textStorage = NSTextStorage() }
        let container = NSTextContainer(size: CGSize(width: 600, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.textContainer = container
        super.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = false
        isRichText = true
        drawsBackground = false
        isVerticallyResizable = false
        isHorizontallyResizable = false
        textContainer?.widthTracksTextView = false
        textContainer?.heightTracksTextView = false
        textContainerInset = NSSize(width: Self.gutterLeft + Self.padX, height: Self.gutterTop + Self.padY)
        allowsUndo = false
        // Nothing may change the text on its own: the engine owns it.
        isAutomaticQuoteSubstitutionEnabled = false
        isAutomaticDashSubstitutionEnabled = false
        isAutomaticTextReplacementEnabled = false
        isAutomaticSpellingCorrectionEnabled = false
        isAutomaticLinkDetectionEnabled = false
        isAutomaticDataDetectionEnabled = false
        isAutomaticTextCompletionEnabled = false
        smartInsertDeleteEnabled = false
        isContinuousSpellCheckingEnabled = true
        isGrammarCheckingEnabled = false
        unregisterDraggedTypes()
        setAccessibilityIdentifier("box:\(boxId)")
        applyColors()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func applyColors() {
        insertionPointColor = palette.text
        selectedTextAttributes = [.backgroundColor: palette.accent.withAlphaComponent(0.22)]
        appearance = NSAppearance(named: palette.isDark ? .darkAqua : .aqua)
        needsDisplay = true
    }

    private var renderer: BoxTextRenderer {
        BoxTextRenderer(tasks: tasks, pageTitles: pageTitles, width: layoutWidth, palette: palette, decor: decor)
    }

    /// The box itself (without the gutters), in this view's coordinates.
    var boxRect: CGRect {
        CGRect(x: Self.gutterLeft, y: Self.gutterTop, width: max(bounds.width - Self.gutterLeft - Self.gutterRight, 0),
               height: max(bounds.height - Self.gutterTop, 0))
    }

    /// The box in the canvas surface's coordinates.
    var boxFrame: CGRect {
        CGRect(x: frame.minX + Self.gutterLeft, y: frame.minY + Self.gutterTop, width: boxRect.width, height: boxRect.height)
    }

    /// The plain text drawn.
    var shownText: String { rendering.string.string }

    private var isFocused: Bool { window?.firstResponder === self }

    /// An engine command from the ribbon or a menu, sent like any edit.
    @discardableResult
    func command(_ name: String, _ argsJSON: String) -> Bool {
        guard editor != nil else { return false }
        let done = engine { s in (try? s.command(name: name, argsJson: argsJSON)) ?? false } ?? false
        refocus()
        return done
    }

    var engineCanUndo: Bool { editor?.session.canUndo() ?? false }
    var engineCanRedo: Bool { editor?.session.canRedo() ?? false }

    func engineUndo() {
        guard let editor else { return }
        engine(edits: false) { _ in editor.undo() }
        refocus()
    }

    func engineRedo() {
        guard let editor else { return }
        engine(edits: false) { _ in editor.redo() }
        refocus()
    }

    // MARK: Content

    /// The box's width in page units; lays the text out again when it changes.
    func setWidth(_ width: CGFloat) {
        let w = max(width - 2 * Self.padX, 20)
        guard w != layoutWidth else { return }
        layoutWidth = w
        textContainer?.size = CGSize(width: w, height: CGFloat.greatestFiniteMagnitude)
        rerender()
    }

    /// Read-only content (the core's typed box content). Ignored once an editor is attached.
    func show(content: [ContentNode]) {
        guard editor == nil, content != shownContent else { return }
        shownContent = content
        apply(renderer.render(BoxNode.document(content: content)))
    }

    /// Draw again (task titles or page titles changed, or the width, or the theme).
    func rerender() {
        if editor != nil {
            shownDocJSON = nil
            reload(invalidateInput: false)
        } else if let content = shownContent {
            apply(renderer.render(BoxNode.document(content: content)))
        }
    }

    private func apply(_ r: BoxRendering) {
        rendering = r
        syncing = true
        textContentStorage?.performEditingTransaction {
            textContentStorage?.textStorage?.setAttributedString(r.string)
        }
        syncing = false
        textContainerInset = NSSize(width: Self.gutterLeft + Self.padX, height: Self.gutterTop + Self.padY + r.topMargin)
        if let lm = textLayoutManager { lm.ensureLayout(for: lm.documentRange) }
        let used = textLayoutManager?.usageBoundsForTextContainer.height ?? 0
        let h = max(ceil(used) + Self.padY + r.topMargin + Self.padY + r.bottomMargin, 41.2)
        needsDisplay = true
        if h != contentHeight {
            contentHeight = h
            onHeightChange?(self)
        }
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        let p = palette
        let inset = textContainerInset
        let box = boxRect
        if chrome {
            let path = PlatformPath(roundedRect: box.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 6)
            p.bg.setFill()
            path.fill()
            p.borderStrong.setStroke()
            path.lineWidth = 1
            path.stroke()
            // The move bar: 12 high, 9 above the box, top corners rounded.
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(rect: CGRect(x: box.minX - 1, y: box.minY - 9, width: box.width + 2, height: 12)).addClip()
            p.bgPressed.setFill()
            PlatformPath(roundedRect: CGRect(x: box.minX - 1, y: box.minY - 9, width: box.width + 2, height: 20), cornerRadius: 6).fill()
            NSGraphicsContext.restoreGraphicsState()
            // The width handle: 3 × 24 on the right edge.
            p.borderStrong.setFill()
            PlatformPath(roundedRect: CGRect(x: box.maxX - 2, y: box.midY - 12, width: 3, height: 24), cornerRadius: 2).fill()
        }
        if rendering.blank, let line = lineBox(0) {
            // The lone empty line shows the placeholder (LOOK.md 2.3), on the line's baseline.
            let f = renderer.font(renderer.bodySize)
            NSAttributedString(string: "Type '/' for commands…", attributes: [.font: f, .foregroundColor: p.textPlaceholder])
                .draw(at: CGPoint(x: inset.width, y: line.baseline - f.ascender))
        }
        let painter = BoxPainter(palette: p)
        for d in rendering.decorations {
            guard d.to > d.from, let first = lineBox(d.from), let bottom = lineBottom(d.to) else { continue }
            painter.decoration(d, left: inset.width + d.left, right: inset.width + layoutWidth - d.right, first: first, bottom: bottom)
        }
        super.draw(dirtyRect)
        foldHits = []
        for m in rendering.markers {
            guard let line = lineBox(m.offset) else { continue }
            if case let .fold(collapsed, id) = m.kind {
                // The fold arrow of a task with notes sits in the gutter left of the task's circle.
                let x = inset.width + m.x - 21
                PlatformImage.lucide(collapsed ? "chevron-right" : "chevron-down", size: 14, color: p.textMuted)?
                    .paint(at: CGPoint(x: x, y: line.top + 21))
                foldHits.append((CGRect(x: x - 6, y: line.top + 11, width: 20, height: 34), id))
            } else {
                painter.marker(m.kind, x: inset.width + m.x, line: line)
            }
        }
    }

    /// The line that starts at `offset`: its top, height and baseline in view coordinates.
    private func lineBox(_ offset: Int) -> BoxLineBox? {
        guard let lm = textLayoutManager, let loc = location(offset), let fragment = lm.textLayoutFragment(for: loc),
              let line = fragment.textLineFragments.first else { return nil }
        let frame = fragment.layoutFragmentFrame
        let bounds = line.typographicBounds
        let top = textContainerInset.height + frame.minY + bounds.minY
        return BoxLineBox(top: top, height: bounds.height, baseline: top + line.glyphOrigin.y)
    }

    /// The bottom of the line holding the character before `offset`, in view coordinates.
    private func lineBottom(_ offset: Int) -> CGFloat? {
        guard let lm = textLayoutManager, let loc = location(max(offset - 1, 0)), let fragment = lm.textLayoutFragment(for: loc),
              let line = fragment.textLineFragments.last else { return nil }
        return textContainerInset.height + fragment.layoutFragmentFrame.minY + line.typographicBounds.maxY
    }

    // MARK: Layout answers (TextKit 2, never the engine)

    private func location(_ offset: Int) -> NSTextLocation? {
        guard let cs = textContentStorage else { return nil }
        return cs.location(cs.documentRange.location, offsetBy: min(max(offset, 0), rendering.string.length))
    }

    private func segments(_ lo: Int, _ hi: Int, type: NSTextLayoutManager.SegmentType) -> [CGRect] {
        guard let lm = textLayoutManager, let a = location(lo), let b = location(hi), let range = NSTextRange(location: a, end: b) else { return [] }
        let inset = textContainerInset
        var rects: [CGRect] = []
        lm.enumerateTextSegments(in: range, type: type, options: [.rangeNotRequired]) { _, frame, _, _ in
            rects.append(frame.offsetBy(dx: inset.width, dy: inset.height))
            return true
        }
        return rects
    }

    /// The caret's rect at `offset` (view coordinates).
    func caretRect(at offset: Int) -> CGRect {
        guard let r = segments(offset, offset, type: .standard).first else {
            return CGRect(x: textContainerInset.width, y: textContainerInset.height, width: 2, height: 20)
        }
        return CGRect(x: r.minX, y: r.minY, width: 2, height: max(r.height, 16))
    }

    /// The character offset nearest `point` (view coordinates).
    func closestOffset(to point: CGPoint) -> Int {
        let len = text.length
        guard let lm = textLayoutManager, let cs = textContentStorage else { return len }
        let p = CGPoint(x: point.x - textContainerInset.width, y: point.y - textContainerInset.height)
        if p.y < 0 { return 0 }
        if p.y > lm.usageBoundsForTextContainer.maxY { return len }
        let selections = lm.textSelectionNavigation.textSelections(
            interactingAt: p, inContainerAt: lm.documentRange.location,
            anchors: [], modifiers: [], selecting: false, bounds: .zero)
        guard let loc = selections.first?.textRanges.first?.location else { return len }
        return min(max(cs.offset(from: cs.documentRange.location, to: loc), 0), len)
    }

    /// The selected text's bounds in this view's coordinates; nil for a caret (the floating toolbar).
    var selectionBounds: CGRect? {
        guard editor != nil, marked == nil, sel.hi > sel.lo else { return nil }
        let rects = segments(sel.lo, sel.hi, type: .selection)
        guard let first = rects.first else { return nil }
        return rects.reduce(first) { $0.union($1) }
    }

    /// The caret's rect now (the canvas keeps it in view).
    var caretNow: CGRect { caretRect(at: sel.hi) }

    // MARK: Hit tests

    private var foldHits: [(rect: CGRect, id: String)] = []

    /// The task whose fold arrow is at `p` (view coordinates).
    func foldTask(at p: CGPoint) -> String? { foldHits.first { $0.rect.contains(p) }?.id }

    /// Only the box (and its bar while edited, and fold arrows) takes the mouse: the gutters belong to the canvas.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let p = convert(point, from: superview)
        var live = boxRect
        if chrome { live = live.union(CGRect(x: boxRect.minX, y: 0, width: boxRect.width, height: Self.gutterTop + 8)) }
        if live.contains(p) || foldHits.contains(where: { $0.rect.contains(p) }) { return super.hitTest(point) }
        return nil
    }

    /// The window is dragged by its background (MacRoot): a press in a box is the box's, not the window's.
    override var mouseDownCanMoveWindow: Bool { false }

    override func mouseDown(with event: NSEvent) {
        if let onMouseDown, onMouseDown(self, event) { return }
        super.mouseDown(with: event)
    }

    override func resetCursorRects() {
        if isEditable { super.resetCursorRects() } else { addCursorRect(boxRect, cursor: .iBeam) }
    }

    /// The address of the link under `point` (this view's coordinates), if any.
    func linkHref(at point: CGPoint) -> String? {
        guard rendering.length > 0 else { return nil }
        let o = closestOffset(to: point)
        let str = rendering.string
        // The glyph must really be under the pointer: the nearest position snaps to an edge.
        for i in [o, o - 1] where i >= 0 && i < rendering.length {
            guard let href = str.attribute(.nvHref, at: i, effectiveRange: nil) as? String else { continue }
            if segments(i, i + 1, type: .standard).contains(where: { $0.insetBy(dx: -2, dy: -2).contains(point) }) { return href }
        }
        return nil
    }

    /// The comment thread whose mark is under `point` (this view's coordinates), if any.
    func commentThread(at point: CGPoint) -> String? {
        guard rendering.length > 0 else { return nil }
        let o = closestOffset(to: point)
        let str = rendering.string
        for i in [o, o - 1] where i >= 0 && i < rendering.length {
            guard let id = str.attribute(.nvThread, at: i, effectiveRange: nil) as? String, !id.isEmpty else { continue }
            if segments(i, i + 1, type: .standard).contains(where: { $0.insetBy(dx: -2, dy: -2).contains(point) }) { return id }
        }
        return nil
    }

    /// Does the text carry the mark of this comment thread?
    func hasThread(_ id: String) -> Bool {
        var found = false
        let whole = NSRange(location: 0, length: rendering.string.length)
        rendering.string.enumerateAttribute(.nvThread, in: whole, options: []) { value, _, stop in
            if (value as? String) == id {
                found = true
                stop.pointee = true
            }
        }
        return found
    }

    /// The selected text (the quote of a new comment); "" for a caret.
    var selectedQuote: String {
        guard editor != nil, sel.hi > sel.lo, sel.hi <= text.length else { return "" }
        return text.substring(with: NSRange(location: sel.lo, length: sel.hi - sel.lo)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Is the caret in a link (for Cmd+K)?
    var caretInLink: Bool {
        let n = rendering.length
        return [sel.lo - 1, sel.lo].contains { $0 >= 0 && $0 < n && rendering.string.attribute(.nvHref, at: $0, effectiveRange: nil) != nil }
    }

    var hasSelection: Bool { sel.hi > sel.lo }

    /// What the link editor opens on: the selection, or the whole link around the caret (which is then selected in the
    /// engine, as the web's `extendMarkRange` does). Nil when not editing.
    func prepareLink() -> (text: String, href: String, rect: CGRect)? {
        guard editor != nil, marked == nil else { return nil }
        let str = rendering.string
        let n = rendering.length
        var lo = sel.lo, hi = sel.hi
        var href = ""
        func hrefAt(_ i: Int, _ r: inout NSRange) -> String? {
            guard i >= 0, i < n else { return nil }
            return str.attribute(.nvHref, at: i, longestEffectiveRange: &r, in: NSRange(location: 0, length: n)) as? String
        }
        var run = NSRange()
        if lo == hi {
            if let h = hrefAt(lo - 1, &run) ?? hrefAt(lo, &run) {
                href = h
                lo = run.location
                hi = run.location + run.length
                selectByPlatform(lo: lo, hi: hi)
            }
        } else if let h = hrefAt(lo, &run) {
            href = h
        }
        let shown = hi > lo ? text.substring(with: NSRange(location: lo, length: hi - lo)) : ""
        let rect = hi > lo ? (selectionBounds ?? caretRect(at: lo)) : caretRect(at: lo)
        return (shown, href, rect)
    }

    // MARK: Task titles (a task line's title has its own field, as on the web)

    private var titleField: NSTextField?
    private var titleTask: String?
    private lazy var titleDelegate: TitleDelegate = {
        let d = TitleDelegate()
        d.box = self
        return d
    }()

    /// The task whose title is under `p` (view coordinates).
    func titleHit(at p: CGPoint) -> String? {
        for t in rendering.taskTitles {
            guard let line = lineBox(t.offset) else { continue }
            if CGRect(x: textContainerInset.width + t.x, y: line.top + 11, width: max(t.width, 30), height: 34).contains(p) { return t.id }
        }
        return nil
    }

    /// A click on a task line's title edits the title (its own field, as on the web).
    @discardableResult
    func beginTitleEdit(at p: CGPoint) -> Bool {
        guard editor != nil, let id = titleHit(at: p) else { return false }
        runCommand("focusTitle", ["id": id])
        return true
    }

    private func updateTitleField(_ id: String?) {
        guard let id, let t = rendering.taskTitles.first(where: { $0.id == id }), let line = lineBox(t.offset), editor != nil else {
            removeTitleField()
            return
        }
        let field: NSTextField
        if let f = titleField {
            field = f
        } else {
            field = NSTextField()
            field.isBordered = false
            field.isBezeled = false
            field.focusRingType = .none
            field.drawsBackground = true
            field.usesSingleLineMode = true
            field.cell?.isScrollable = true
            field.delegate = titleDelegate
            addSubview(field)
            titleField = field
        }
        field.font = WebType.ui(16)
        field.textColor = palette.text
        field.backgroundColor = palette.bg
        field.placeholderAttributedString = NSAttributedString(string: "Task", attributes: [.foregroundColor: palette.textPlaceholder, .font: WebType.ui(16)])
        field.frame = CGRect(x: textContainerInset.width + t.x, y: line.top + 16, width: max(t.width, 60), height: 24)
        if titleTask != id {
            titleTask = id
            field.stringValue = editor?.tasks?.title(id: id) ?? ""
        }
        if field.currentEditor() == nil {
            syncing = true
            window?.makeFirstResponder(field)
            syncing = false
        }
    }

    private func removeTitleField() {
        guard let f = titleField else { return }
        titleField = nil
        titleTask = nil
        f.delegate = nil
        if f.currentEditor() != nil { window?.makeFirstResponder(nil) }
        f.removeFromSuperview()
    }

    fileprivate func titleChanged() {
        guard let id = titleTask, let f = titleField else { return }
        editor?.tasks?.editTitle(id: id, title: f.stringValue)
    }

    fileprivate func titleReturn() {
        flushTitle()
        if let id = titleTask { titleKey("Enter", id) }
    }

    fileprivate func titleEmptyBackspace() {
        guard let id = titleTask else { return }
        flushTitle()
        titleKey("Backspace", id)
    }

    fileprivate func titleDidEnd() { flushTitle() }

    /// Send a pending title change to the server now.
    private func flushTitle() { editor?.tasks?.flush() }

    /// Stop editing a task title (leaving the box ends the page's editing).
    func endTitleEdit() {
        flushTitle()
        removeTitleField()
    }

    /// A key in the focused title (Enter: the next task or a note line; Backspace in an empty title: a plain line).
    private func titleKey(_ chord: String, _ id: String) {
        guard let editor else { return }
        _ = engine(edits: false) { $0.key(chord: chord) }
        editor.edited()
        if editor.session.state().focusTaskId == nil { refocus() }
    }

    // MARK: Editing

    /// Make the box editable through `editor` (it stays attached and keeps drawing the session's state after editing ends).
    func attach(_ editor: BoxEditor) {
        self.editor = editor
        shownDocJSON = nil
        reload(invalidateInput: false)
    }

    /// Start or stop taking the keyboard and the mouse as an editor.
    func setActive(_ on: Bool) {
        guard editor != nil || !on else { return }
        isEditable = on
        isSelectable = on
        if on {
            refocus()
        } else if isFocused {
            window?.makeFirstResponder(nil)
        }
        window?.invalidateCursorRects(for: self)
        needsDisplay = true
    }

    /// Take the keyboard (again), keeping the engine's selection.
    func refocus() {
        guard editor != nil, isEditable, let window, !isFocused else { return }
        syncing = true
        window.makeFirstResponder(self)
        syncing = false
        pushSelection()
    }

    override var acceptsFirstResponder: Bool { editor != nil && isEditable }

    override func resignFirstResponder() -> Bool {
        // Losing focus ends an open composition (EDITOR.md 10.2).
        if marked != nil { engine { $0.finishComposition() } }
        return super.resignFirstResponder()
    }

    /// Put the caret at `point` (view coordinates), as a click does.
    func placeCaret(at point: CGPoint) {
        guard editor != nil else { return }
        let o = closestOffset(to: point)
        selectByPlatform(lo: o, hi: o)
    }

    /// Put the caret at the end of the box.
    func placeCaretAtEnd() {
        selectByPlatform(lo: text.length, hi: text.length)
    }

    /// Someone else changed the page: the session already merged it; draw it.
    func remoteChanged() {
        reload(invalidateInput: true)
    }

    /// Run an engine call, then show the session's state. Calls the input protocol makes (`fromProtocol`) don't tell the
    /// input context; everything else (menu commands, undo, remote changes, keys) does (EDITOR.md 10.2).
    @discardableResult
    private func engine<T>(fromProtocol: Bool = false, edits: Bool = true, _ work: (EditorSession) -> T) -> T? {
        guard let editor else { return nil }
        let result = work(editor.session)
        if edits { editor.edited() }
        reload(invalidateInput: !fromProtocol)
        return result
    }

    private func runCommand(_ name: String, _ args: [String: Any]) {
        let json = (try? JSONSerialization.data(withJSONObject: args)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        command(name, json)
    }

    /// Read the session's state: text, selection, composition; draw again if the tree changed.
    private func reload(invalidateInput: Bool) {
        guard let editor else { return }
        let s = editor.session
        let state = s.state()
        text = s.textForView() as NSString
        let len = text.length
        func off(_ p: UInt32) -> Int { min(Int(s.posToViewOffset(pos: p)), len) }
        switch state.selection {
        case let .text(anchor, head):
            let a = off(anchor), h = off(head)
            sel = (lo: min(a, h), hi: max(a, h))
        case let .node(pos):
            let o = off(pos)
            sel = (lo: o, hi: min(o + 1, len))
        case .all:
            sel = (lo: 0, hi: len)
        }
        marked = state.composing.map { (lo: off($0.from), hi: off($0.to)) }
        suggestion = state.suggestion
        if state.docJson != shownDocJSON || marked != nil {
            shownDocJSON = marked == nil ? state.docJson : nil
            if let doc = BoxNode.document(json: state.docJson) {
                var r = renderer.render(doc)
                if r.length != len {
                    // Never expected (the renderer walks the tree as the engine does); stay usable.
                    r = BoxRendering(string: NSAttributedString(string: (text as String) + "\u{200B}", attributes: [.font: NSFont.systemFont(ofSize: 16)]),
                                     markers: [], decorations: [], length: len, topMargin: 0)
                }
                if let m = marked, m.hi > m.lo, m.hi <= r.string.length {
                    let u = NSMutableAttributedString(attributedString: r.string)
                    u.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: NSRange(location: m.lo, length: m.hi - m.lo))
                    u.addAttribute(.underlineColor, value: palette.text, range: NSRange(location: m.lo, length: m.hi - m.lo))
                    r = BoxRendering(string: u, markers: r.markers, decorations: r.decorations, length: r.length, topMargin: r.topMargin,
                                     bottomMargin: r.bottomMargin, taskTitles: r.taskTitles, blank: r.blank)
                }
                apply(r)
            }
        }
        pushSelection()
        if chrome { updateTitleField(state.focusTaskId) }
        updateSuggestion()
        if invalidateInput { inputContext?.invalidateCharacterCoordinates() }
        onCaretChange?(self)
    }

    /// Show the engine's selection in the text view.
    private func pushSelection() {
        // While composing, the input method owns the text view's selection (moving it would discard the marked text).
        guard marked == nil else { return }
        let want = NSRange(location: sel.lo, length: sel.hi - sel.lo)
        guard selectedRanges.first?.rangeValue != want else { return }
        syncing = true
        super.setSelectedRanges([NSValue(range: want)], affinity: .downstream, stillSelecting: false)
        syncing = false
    }

    // MARK: Selection (NSTextView's layout-aware moves, sent to the engine)

    override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting stillSelectingFlag: Bool) {
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelectingFlag)
        guard !syncing, !stillSelectingFlag, editor != nil, let r = ranges.first?.rangeValue, r.location != NSNotFound else { return }
        let lo = r.location, hi = r.location + r.length
        guard lo != sel.lo || hi != sel.hi else { return }
        selectByPlatform(lo: lo, hi: hi)
    }

    /// The platform set the selection (clicks, arrows, word moves, the IME).
    private func selectByPlatform(lo a: Int, hi b: Int) {
        let len = text.length
        let lo = min(max(a, 0), len), hi = min(max(b, 0), len)
        engine(fromProtocol: true, edits: false) { s in
            if hi == lo + 1, isObjectLine(lo) {
                s.selectNode(pos: s.viewOffsetToPos(offset: UInt32(lo)))
            } else {
                s.setSelection(anchor: s.viewOffsetToPos(offset: UInt32(lo)), head: s.viewOffsetToPos(offset: UInt32(hi)))
            }
        }
    }

    /// Look mode (CI): select from `lo` to the end of the text through the engine, telling AppKit.
    func lookSelect(from lo: Int) {
        let len = text.length
        selectByPlatform(lo: lo, hi: len)
        pushSelection()
    }

    /// One object line's U+FFFC (a task line, a rule, an image): selecting it selects the node.
    private func isObjectLine(_ o: Int) -> Bool {
        guard o < text.length, text.character(at: o) == 0xFFFC else { return false }
        let before = o == 0 || text.character(at: o - 1) == 0x0A
        let after = o + 1 == text.length || text.character(at: o + 1) == 0x0A
        return before && after
    }

    // MARK: Suggestion menus (`/`, `[[`, `@`)

    private var menuRows: [MenuRow] = []
    private var menuKind = MenuContent.Kind.slash
    private var menuHighlight = 0
    private var menuKey = ""

    private func hideMenu() {
        guard !menuRows.isEmpty || menuKey != "" else { return }
        menuRows = []
        menuKey = ""
        onMenu?(self, nil)
    }

    /// Whether a `[[` or `@` menu with rows is open (their highlight and keys are this view's).
    private var ownMenuOpen: Bool {
        isFocused && suggestion != nil && menuKind != .slash && !menuRows.isEmpty
    }

    private func pageMatches(_ query: String) -> [MenuRow] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        var scored: [(Int, Int, PageChoice)] = []
        for (n, p) in pageChoices.enumerated() {
            let t = (p.title.isEmpty ? "Untitled" : p.title).lowercased()
            let score: Int
            if q.isEmpty { score = 1 } else if t.hasPrefix(q) { score = 0 } else if t.split(separator: " ").contains(where: { $0.hasPrefix(q) }) { score = 1 } else if t.contains(q) { score = 2 } else { score = -1 }
            if score >= 0 { scored.append((score, n, p)) }
        }
        scored.sort { ($0.0, $0.1) < ($1.0, $1.1) }
        return scored.prefix(8).map { MenuRow(id: $0.2.id, title: $0.2.title.isEmpty ? "Untitled" : $0.2.title, detail: $0.2.crumb, icon: "file-text", dot: nil) }
    }

    private func peopleMatches(_ query: String) -> [MenuRow] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let hits = people.filter { q.isEmpty || $0.name.lowercased().contains(q) || $0.email.lowercased().contains(q) }
        return hits.prefix(8).map { MenuRow(id: $0.id, title: $0.name, detail: $0.email, icon: nil, dot: PlatformColor(css: $0.color)) }
    }

    /// The engine's open suggestion menu: slash rows from the engine (it owns the highlight), pages and people from the app
    /// (this view owns their highlight).
    private func updateSuggestion() {
        guard isFocused, editor != nil, let s = suggestion else {
            hideMenu()
            return
        }
        let key = "\(s.trigger)|\(s.query)"
        if key != menuKey { menuKey = key; menuHighlight = 0 }
        let kind: MenuContent.Kind
        var rows: [MenuRow] = []
        var highlighted: Int?
        var empty: String?
        switch s.trigger {
        case .slash:
            kind = .slash
            rows = s.items.map { MenuRow(id: $0.id, title: $0.label, detail: $0.description, icon: $0.icon, dot: nil) }
            highlighted = s.highlighted.map { Int($0) }
        case .pageLink:
            kind = .page
            rows = pageMatches(s.query)
            empty = "Type a page title…"
        case .mention:
            kind = .mention
            rows = peopleMatches(s.query)
            empty = "No matching people"
        }
        if kind != .slash, !rows.isEmpty {
            menuHighlight = min(menuHighlight, rows.count - 1)
            highlighted = menuHighlight
        }
        menuRows = rows
        menuKind = kind
        if kind == .slash && rows.isEmpty {
            onMenu?(self, nil)
            return
        }
        let anchor = caretRect(at: min(Int(s.viewFrom), text.length))
        onMenu?(self, MenuContent(kind: kind, rows: rows, highlighted: highlighted, anchor: anchor, emptyText: empty))
    }

    /// Run row `i` of the open menu.
    func pickMenuRow(_ i: Int) {
        guard menuRows.indices.contains(i) else { return }
        let r = menuRows[i]
        switch menuKind {
        case .slash: runCommand("pickSlash", ["title": r.id])
        case .page: runCommand("pickPage", ["pageId": r.id])
        case .mention: runCommand("pickMention", ["id": r.id, "label": r.title])
        }
    }

    /// Up and down while a menu is open move its highlight. True when handled.
    private func menuArrow(up: Bool) -> Bool {
        guard isFocused, suggestion != nil, !menuRows.isEmpty, marked == nil else { return false }
        if menuKind == .slash { return sendKey(up ? "ArrowUp" : "ArrowDown") }
        menuHighlight = (menuHighlight + (up ? menuRows.count - 1 : 1)) % menuRows.count
        updateSuggestion()
        return true
    }

    // MARK: Keys

    /// A key chord for the engine (EDITOR.md 4 and 10.2). False when the engine didn't use it.
    @discardableResult
    func sendKey(_ chord: String) -> Bool {
        guard let editor else { return false }
        let handled = engine(edits: false) { $0.key(chord: chord) } ?? false
        editor.noteKey(chord, handled: handled)
        if handled { editor.send() }
        return handled
    }

    override func keyDown(with event: NSEvent) {
        // Option+Shift+Up/Down move the block (the engine's); other Option moves are NSTextView's (words, paragraphs).
        if editor != nil, marked == nil, event.modifierFlags.intersection([.command, .shift, .option, .control]) == [.option, .shift] {
            if event.keyCode == 126, sendKey("Alt+Shift+ArrowUp") { return }
            if event.keyCode == 125, sendKey("Alt+Shift+ArrowDown") { return }
        }
        super.keyDown(with: event)
    }

    /// Command chords the main menu doesn't have go to the engine (Cmd+E code, Cmd+Shift+7 / 8 lists, Cmd+. , Cmd+Return, Cmd+Y).
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard editor != nil, isFocused, marked == nil else { return super.performKeyEquivalent(with: event) }
        let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
        guard flags.contains(.command), !flags.contains(.control), !flags.contains(.option) else { return super.performKeyEquivalent(with: event) }
        let key = (event.charactersIgnoringModifiers ?? "").lowercased()
        let shift = flags.contains(.shift)
        var chord: String?
        switch key {
        case "e" where !shift: chord = "Mod+e"
        case "y" where !shift: chord = "Mod+y"
        case "." where !shift: chord = "Mod+."
        case "\r" where !shift: chord = "Mod+Enter"
        case "8", "*": chord = shift ? "Mod+Shift+8" : nil
        case "7", "&": chord = shift ? "Mod+Shift+7" : nil
        default: break
        }
        if let chord, sendKey(chord) { return true }
        return super.performKeyEquivalent(with: event)
    }

    /// The Mac keybindings (`interpretKeyEvents` → selectors): the ones that change text are keys for the engine; caret moves
    /// stay NSTextView's.
    override func doCommand(by selector: Selector) {
        guard editor != nil else {
            super.doCommand(by: selector)
            return
        }
        let flags = NSApp.currentEvent?.modifierFlags ?? []
        switch selector {
        case #selector(NSResponder.insertNewline(_:)):
            if ownMenuOpen && marked == nil { pickMenuRow(menuHighlight); return }
            sendKey(flags.contains(.shift) ? "Shift+Enter" : "Enter")
        case #selector(NSResponder.insertLineBreak(_:)), #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
            sendKey("Shift+Enter")
        case #selector(NSResponder.insertTab(_:)):
            if ownMenuOpen && marked == nil { pickMenuRow(menuHighlight); return }
            sendKey("Tab")
        case #selector(NSResponder.insertBacktab(_:)):
            sendKey("Shift+Tab")
        case #selector(NSResponder.deleteBackward(_:)), #selector(NSResponder.deleteBackwardByDecomposingPreviousCharacter(_:)):
            sendKey("Backspace")
        case #selector(NSResponder.deleteForward(_:)):
            sendKey("Delete")
        case #selector(NSResponder.deleteWordBackward(_:)):
            sendKey("Alt+Backspace")
        case #selector(NSResponder.deleteWordForward(_:)):
            sendKey("Alt+Delete")
        case #selector(NSResponder.deleteToBeginningOfLine(_:)), #selector(NSResponder.deleteToBeginningOfParagraph(_:)):
            if !hasSelection { super.doCommand(by: #selector(NSResponder.moveToBeginningOfLineAndModifySelection(_:))) }
            sendKey("Backspace")
        case #selector(NSResponder.deleteToEndOfLine(_:)), #selector(NSResponder.deleteToEndOfParagraph(_:)):
            if !hasSelection { super.doCommand(by: #selector(NSResponder.moveToEndOfLineAndModifySelection(_:))) }
            sendKey("Backspace")
        case #selector(NSResponder.cancelOperation(_:)):
            if suggestion != nil {
                if menuKind == .slash { sendKey("Escape") } else { runCommand("dismissSuggestion", [:]) }
            } else {
                super.doCommand(by: selector)
            }
        case #selector(NSResponder.moveUp(_:)):
            if !menuArrow(up: true) { super.doCommand(by: selector) }
        case #selector(NSResponder.moveDown(_:)):
            if !menuArrow(up: false) { super.doCommand(by: selector) }
        default:
            super.doCommand(by: selector)
        }
    }

    // MARK: NSTextInputClient (EDITOR.md 10.4)

    override func insertText(_ string: Any, replacementRange: NSRange) {
        guard editor != nil else { return }
        let s = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        if marked != nil {
            engine(fromProtocol: true) { $0.commitComposition(text: s) }
            return
        }
        if replacementRange.location != NSNotFound {
            // Press-and-hold accents, the character viewer, reconversion: replace that range.
            replaceRange(replacementRange, with: s)
            return
        }
        engine(fromProtocol: true) { session in
            if s == "\n" || s == "\r" {
                _ = session.key(chord: "Enter")
            } else if s == "\t" {
                _ = session.key(chord: "Tab")
            } else if s.contains("\n") {
                for (i, part) in s.components(separatedBy: "\n").enumerated() {
                    if i > 0 { _ = session.key(chord: "Enter") }
                    if !part.isEmpty { session.insertText(text: part) }
                }
            } else {
                session.insertText(text: s)
            }
        }
    }

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        guard editor != nil else { return }
        let t = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        let start = UInt32(max(selectedRange.location, 0))
        let end = UInt32(max(selectedRange.location + selectedRange.length, 0))
        let replace = replacementRange.location != NSNotFound ? replacementRange : nil
        engine(fromProtocol: true, edits: false) { s in
            if marked == nil, let r = replace {
                s.setSelection(anchor: s.viewOffsetToPos(offset: UInt32(r.location)), head: s.viewOffsetToPos(offset: UInt32(r.location + r.length)))
            }
            s.setComposition(text: t, selStart: start, selEnd: end)
        }
    }

    override func unmarkText() {
        guard marked != nil else { return }
        engine(fromProtocol: true) { $0.finishComposition() }
    }

    override func hasMarkedText() -> Bool { marked != nil }

    override func markedRange() -> NSRange {
        guard let m = marked else { return NSRange(location: NSNotFound, length: 0) }
        return NSRange(location: m.lo, length: m.hi - m.lo)
    }

    /// Replace a range of the view's text (spell-check corrections, accents, reconversion).
    private func replaceRange(_ range: NSRange, with replacement: String) {
        let len = text.length
        guard range.location != NSNotFound, range.location <= len else { return }
        let lo = range.location, hi = min(range.location + range.length, len)
        engine(fromProtocol: true) { s in
            let from = s.viewOffsetToPos(offset: UInt32(lo)), to = s.viewOffsetToPos(offset: UInt32(hi))
            if !s.replaceRange(from: from, to: to, text: replacement) {
                // Refused (the range isn't in text): type it over the range instead.
                s.setSelection(anchor: from, head: to)
                if replacement.isEmpty { _ = s.key(chord: "Backspace") } else { s.insertText(text: replacement) }
            }
        }
    }

    /// Anything else that would change the text (a spelling correction, a service, a drop) arrives here first: it goes to the
    /// engine and the text view's own change is refused.
    override func shouldChangeText(in affectedCharRange: NSRange, replacementString: String?) -> Bool {
        guard editor != nil, !syncing else { return false }
        replaceRange(affectedCharRange, with: replacementString ?? "")
        return false
    }

    // Dragging text is not supported yet (the engine has no move-range call): neither a source nor a target.
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { [] }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { [] }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { false }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool { false }

    // MARK: Clipboard

    override func copy(_ sender: Any?) {
        guard let c = editor?.session.copy() else { return }
        Self.put(c)
    }

    override func cut(_ sender: Any?) {
        guard let c = engine(fromProtocol: false, { $0.cut() }) else { return }
        Self.put(c)
    }

    override func paste(_ sender: Any?) {
        let board = NSPasteboard.general
        let html = board.string(forType: .html) ?? ""
        let plain = board.string(forType: .string) ?? ""
        guard !html.isEmpty || !plain.isEmpty else { return }
        engine { _ = $0.paste(html: html, text: plain) }
    }

    override func pasteAsPlainText(_ sender: Any?) {
        let plain = NSPasteboard.general.string(forType: .string) ?? ""
        guard !plain.isEmpty else { return }
        engine { _ = $0.paste(html: "", text: plain) }
    }

    override func pasteAsRichText(_ sender: Any?) { paste(sender) }

    override func selectAll(_ sender: Any?) { sendKey("Mod+a") }

    private static func put(_ c: ClipboardData) {
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(c.text, forType: .string)
        if !c.html.isEmpty { board.setString(c.html, forType: .html) }
    }
}

/// The task title field's delegate: Return goes to the engine (the next task or a note line), Backspace in an empty title too.
private final class TitleDelegate: NSObject, NSTextFieldDelegate {
    weak var box: MacBoxView?

    func controlTextDidChange(_ obj: Notification) { box?.titleChanged() }

    func controlTextDidEndEditing(_ obj: Notification) { box?.titleDidEnd() }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            box?.titleReturn()
            return true
        }
        if commandSelector == #selector(NSResponder.deleteBackward(_:)), textView.string.isEmpty {
            box?.titleEmptyBackspace()
            return true
        }
        return false
    }
}
