import NotiveloCore
import UIKit

/// A position in a box's view text: a UTF-16 offset (EDITOR.md 10.1).
final class BoxTextPosition: UITextPosition {
    let offset: Int
    init(_ offset: Int) { self.offset = offset }
}

final class BoxTextRange: UITextRange {
    let lo: Int
    let hi: Int
    init(_ a: Int, _ b: Int) {
        lo = min(a, b)
        hi = max(a, b)
    }
    override var start: UITextPosition { BoxTextPosition(lo) }
    override var end: UITextPosition { BoxTextPosition(hi) }
    override var isEmpty: Bool { lo == hi }
}

final class BoxSelectionRect: UITextSelectionRect {
    private let r: CGRect
    private let first: Bool
    private let last: Bool
    init(_ rect: CGRect, first: Bool, last: Bool) {
        r = rect
        self.first = first
        self.last = last
    }
    override var rect: CGRect { r }
    override var writingDirection: NSWritingDirection { .natural }
    override var containsStart: Bool { first }
    override var containsEnd: Bool { last }
    override var isVertical: Bool { false }
}

/// The keyboard's undo (shake, three-finger swipe, the shortcut bar) undoes engine steps
/// (EDITOR.md 10.3). Hardware Cmd+Z goes to `key("Mod+z")` instead (see `keyCommands`).
final class EngineUndoManager: UndoManager {
    weak var box: BoxTextView?
    override var canUndo: Bool { box?.editor?.canUndo ?? false }
    override var canRedo: Bool { box?.editor?.canRedo ?? false }
    override func undo() { box?.engineUndo() }
    override func redo() { box?.engineRedo() }
}

/// One text box of the page canvas: TextKit 2 layout of the box's text (an
/// `NSTextLayoutManager` and `NSTextContentStorage` it owns), drawn by the view itself.
///
/// Read-only until an editor is attached (`attach(_:)`): then the view draws the session's state
/// and adopts `UITextInput` by EDITOR.md 10.3. Offsets are UTF-16 units of the session's
/// `textForView()`; the drawn string has the same characters at the same offsets (BoxText.swift),
/// so TextKit 2 answers every geometry question and the engine owns text, selection, composition.
final class BoxTextView: UIView, UITextInput {
    let boxId: String
    /// A box's border + padding (1 + 6 top/bottom, 1 + 10 sides): text at x = 11 lines up with the title.
    static let pad = UIEdgeInsets(top: 7, left: 11, bottom: 7, right: 11)
    /// Where the text starts: the padding plus the first block's own top margin.
    private var inset: UIEdgeInsets {
        UIEdgeInsets(top: Self.pad.top + rendering.topMargin, left: Self.pad.left, bottom: Self.pad.bottom + rendering.bottomMargin, right: Self.pad.right)
    }

    var tasks: [String: TaskLine] = [:]
    var pageTitles: [String: String] = [:]
    var decor: [String: TaskDecor] = [:]
    /// The page's palette (Hybrid: the light one); text, markers and chrome use it.
    var palette: Palette = .light {
        didSet { tintColor = palette.text }
    }
    /// The box is being edited: opaque `--bg`, `--border-strong` border, move bar and width handle.
    var chrome = false {
        didSet {
            guard chrome != oldValue else { return }
            updateChrome()
        }
    }
    private let moveBar = CALayer()
    private let widthHandle = CALayer()
    /// The height changed (the box grows with its text).
    var onHeightChange: ((BoxTextView) -> Void)?
    /// The caret moved or the text changed while editing (the canvas keeps the caret in view).
    var onCaretChange: ((BoxTextView) -> Void)?
    private(set) var contentHeight: CGFloat = 28

    private let contentStorage = NSTextContentStorage()
    private let layoutManager = NSTextLayoutManager()
    private let container = NSTextContainer(size: CGSize(width: 600, height: CGFloat.greatestFiniteMagnitude))
    private var rendering = BoxRendering.empty
    private var shownContent: [ContentNode]?
    private var shownDocJSON: String?
    private var layoutWidth: CGFloat = 0

    // Editing
    private(set) var editor: BoxEditor?
    /// The view's text (what UITextInput reads), the session's `textForView()`.
    private var text: NSString = ""
    private var sel = (lo: 0, hi: 0)
    private var marked: (lo: Int, hi: Int)?
    private var suggestion: EditorSuggestion?
    private var interaction: UITextInteraction?
    private lazy var engineUndoManager: EngineUndoManager = {
        let m = EngineUndoManager()
        m.box = self
        return m
    }()
    /// Presses this view handled itself (their ends don't go to super either).
    private var handledPresses = Set<UIPress>()
    private let suggestionLabel = UILabel()

    weak var inputDelegate: UITextInputDelegate?
    lazy var tokenizer: UITextInputTokenizer = UITextInputStringTokenizer(textInput: self)
    var markedTextStyle: [NSAttributedString.Key: Any]?

    init(boxId: String) {
        self.boxId = boxId
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        contentMode = .redraw
        accessibilityIdentifier = "box:\(boxId)"
        container.lineFragmentPadding = 0
        layoutManager.textContainer = container
        contentStorage.addTextLayoutManager(layoutManager)
        if contentStorage.textStorage == nil { contentStorage.textStorage = NSTextStorage() }
        suggestionLabel.font = .systemFont(ofSize: 13)
        suggestionLabel.textColor = .secondaryLabel
        suggestionLabel.backgroundColor = .secondarySystemBackground
        suggestionLabel.layer.cornerRadius = 6
        suggestionLabel.layer.masksToBounds = true
        suggestionLabel.isHidden = true
        addSubview(suggestionLabel)
        tintColor = palette.text
        moveBar.cornerRadius = 6
        moveBar.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        widthHandle.cornerRadius = 2
        moveBar.isHidden = true
        widthHandle.isHidden = true
        layer.addSublayer(moveBar)
        layer.addSublayer(widthHandle)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        moveBar.frame = CGRect(x: -1, y: -9, width: bounds.width + 2, height: 12)
        widthHandle.frame = CGRect(x: bounds.width - 2, y: bounds.height / 2 - 12, width: 3, height: 24)
        CATransaction.commit()
    }

    private func updateChrome() {
        moveBar.backgroundColor = palette.bgPressed.cgColor
        widthHandle.backgroundColor = palette.borderStrong.cgColor
        moveBar.isHidden = !chrome
        widthHandle.isHidden = !chrome
        setNeedsDisplay()
    }

    /// The plain text drawn (to find a box by its words, CI).
    var shownText: String { rendering.string.string }

    /// An engine command (`EditorSession.command`) from the ribbon or a menu, sent like any edit.
    @discardableResult
    func command(_ name: String, _ argsJSON: String) -> Bool {
        guard editor != nil else { return false }
        return engine(fromProtocol: false) { s in (try? s.command(name: name, argsJson: argsJSON)) ?? false } ?? false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private var renderer: BoxTextRenderer {
        BoxTextRenderer(tasks: tasks, pageTitles: pageTitles, width: layoutWidth, palette: palette, decor: decor)
    }

    // MARK: Content

    /// The box's width in page units; lays the text out again when it changes.
    func setWidth(_ width: CGFloat) {
        let w = max(width - Self.pad.left - Self.pad.right, 20)
        guard w != layoutWidth else { return }
        layoutWidth = w
        container.size = CGSize(width: w, height: .greatestFiniteMagnitude)
        rerender()
    }

    /// Read-only content (the core's typed box content). Ignored once an editor is attached.
    func show(content: [ContentNode]) {
        guard editor == nil, content != shownContent else { return }
        shownContent = content
        apply(renderer.render(BoxNode.document(content: content)))
    }

    /// Draw again (task titles or page titles changed, or the width).
    func rerender() {
        if editor != nil {
            shownDocJSON = nil
            reloadFromEngine(notify: isFirstResponder)
        } else if let content = shownContent {
            apply(renderer.render(BoxNode.document(content: content)))
        }
    }

    private func apply(_ r: BoxRendering) {
        rendering = r
        contentStorage.performEditingTransaction {
            contentStorage.textStorage?.setAttributedString(r.string)
        }
        layoutManager.ensureLayout(for: layoutManager.documentRange)
        setNeedsDisplay()
        let used = layoutManager.usageBoundsForTextContainer.height
        let h = max(ceil(used) + inset.top + inset.bottom, 41.2)
        if h != contentHeight {
            contentHeight = h
            onHeightChange?(self)
        }
    }

    // MARK: Drawing

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        let inset = self.inset
        let p = palette
        if chrome {
            let box = UIBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 6)
            p.bg.setFill()
            box.fill()
            p.borderStrong.setStroke()
            box.lineWidth = 1
            box.stroke()
        }
        for d in rendering.decorations { drawDecoration(d, inset: inset) }
        layoutManager.enumerateTextLayoutFragments(from: layoutManager.documentRange.location, options: [.ensuresLayout]) { fragment in
            let frame = fragment.layoutFragmentFrame.offsetBy(dx: inset.left, dy: inset.top)
            if frame.intersects(rect.insetBy(dx: -20, dy: -20)) {
                fragment.draw(at: frame.origin, in: ctx)
            }
            return true
        }
        for marker in rendering.markers {
            guard let line = lineBox(marker.offset) else { continue }
            let x = inset.left + marker.x
            switch marker.kind {
            case let .text(text):
                let font = text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont ?? .systemFont(ofSize: 16)
                let w = text.size().width
                text.draw(at: CGPoint(x: max(x - w - 5, 0), y: line.baseline - font.ascender))
            case let .checkbox(checked):
                let r = CGRect(x: x - 8 - 15, y: line.top + (line.height - 15) / 2, width: 15, height: 15)
                let path = UIBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 2.5)
                if checked {
                    p.accent.setFill()
                    path.fill()
                    UIImage.lucide("check", size: 11, color: .white)?.draw(at: CGPoint(x: r.minX + 2, y: r.minY + 2))
                } else {
                    p.bg.setFill()
                    path.fill()
                    p.textMuted.setStroke()
                    path.lineWidth = 1
                    path.stroke()
                }
            case let .bullet(depth):
                let cx = x - 12.5, cy = line.baseline - 4.6
                let r = CGRect(x: cx - 2.75, y: cy - 2.75, width: 5.5, height: 5.5)
                p.text.setFill()
                p.text.setStroke()
                switch depth {
                case 0: UIBezierPath(ovalIn: r).fill()
                case 1:
                    let c = UIBezierPath(ovalIn: r.insetBy(dx: 0.5, dy: 0.5))
                    c.lineWidth = 1
                    c.stroke()
                default: UIRectFill(r.insetBy(dx: 0.25, dy: 0.25))
                }
            case .fold:
                UIImage.lucide("chevron-down", size: 14, color: p.textMuted)?.draw(at: CGPoint(x: x - 21, y: line.top + 10))
            case let .toggle(open):
                let cy = line.top + line.height / 2
                let tri = UIBezierPath()
                if open {
                    tri.move(to: CGPoint(x: x - 19.5, y: cy - 1.5))
                    tri.addLine(to: CGPoint(x: x - 10.5, y: cy - 1.5))
                    tri.addLine(to: CGPoint(x: x - 15, y: cy + 4.5))
                } else {
                    tri.move(to: CGPoint(x: x - 17, y: cy - 4.5))
                    tri.addLine(to: CGPoint(x: x - 17, y: cy + 4.5))
                    tri.addLine(to: CGPoint(x: x - 11, y: cy))
                }
                tri.close()
                p.textMuted.setFill()
                tri.fill()
            }
        }
    }

    /// The line that starts at `offset`: its top, height and baseline in view coordinates.
    private func lineBox(_ offset: Int) -> (top: CGFloat, height: CGFloat, baseline: CGFloat)? {
        guard let loc = location(offset), let fragment = layoutManager.textLayoutFragment(for: loc),
              let line = fragment.textLineFragments.first else { return nil }
        let frame = fragment.layoutFragmentFrame
        let bounds = line.typographicBounds
        let top = inset.top + frame.minY + bounds.minY
        return (top, bounds.height, inset.top + frame.minY + bounds.minY + line.glyphOrigin.y)
    }

    /// The bottom of the line holding the character before `offset`, in view coordinates.
    private func lineBottom(_ offset: Int) -> CGFloat? {
        guard let loc = location(max(offset - 1, 0)), let fragment = layoutManager.textLayoutFragment(for: loc),
              let line = fragment.textLineFragments.last else { return nil }
        return inset.top + fragment.layoutFragmentFrame.minY + line.typographicBounds.maxY
    }

    private func drawDecoration(_ d: BoxDecoration, inset: UIEdgeInsets) {
        guard d.to > d.from, let first = lineBox(d.from), let bottom = lineBottom(d.to) else { return }
        let p = palette
        let left = inset.left + d.left
        let right = inset.left + layoutWidth - d.right
        switch d.kind {
        case let .callout(emoji):
            let r = CGRect(x: left, y: first.top - d.topPad, width: right - left, height: bottom - first.top + d.topPad + d.bottomPad)
            let path = UIBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 8)
            p.bgSubtle.setFill()
            path.fill()
            p.border.setStroke()
            path.lineWidth = 1
            path.stroke()
            let e = NSAttributedString(string: emoji, attributes: [.font: UIFont.systemFont(ofSize: 19)])
            let s = e.size()
            e.draw(at: CGPoint(x: left + 13 + (28 - s.width) / 2, y: r.minY + 13 + (28 - s.height) / 2))
        case let .code(language):
            let r = CGRect(x: left, y: first.top - d.topPad, width: right - left, height: bottom - first.top + d.topPad + d.bottomPad)
            let path = UIBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 8)
            p.bgSubtle.setFill()
            path.fill()
            p.border.setStroke()
            path.lineWidth = 1
            path.stroke()
            let names = ["ts": "TypeScript", "js": "JavaScript", "py": "Python", "swift": "Swift", "rust": "Rust", "json": "JSON",
                         "html": "HTML", "css": "CSS", "sh": "Shell", "bash": "Bash", "sql": "SQL", "go": "Go", "java": "Java"]
            let label = language.isEmpty ? "Plain text" : (names[language.lowercased()] ?? language)
            let attrs: [NSAttributedString.Key: Any] = [.font: WebType.ui(12), .foregroundColor: p.text2]
            NSAttributedString(string: label, attributes: attrs).draw(at: CGPoint(x: left + 14, y: r.minY + 9))
            let copy = NSAttributedString(string: "Copy", attributes: attrs)
            copy.draw(at: CGPoint(x: right - 14 - copy.size().width, y: r.minY + 9))
        case .quote:
            p.borderStrong.setFill()
            UIRectFill(CGRect(x: left, y: first.top - d.topPad, width: 3, height: bottom - first.top + d.topPad + d.bottomPad))
        case let .guide(done):
            let path = UIBezierPath()
            path.move(to: CGPoint(x: left + 1, y: first.top - 4))
            path.addLine(to: CGPoint(x: left + 1, y: bottom + 4))
            path.lineWidth = 2
            if done { path.setLineDash([4, 3], count: 2, phase: 0) }
            p.border.setStroke()
            path.stroke()
        case let .table(rows):
            let top = first.top - d.topPad
            let width = right - left
            let cols = max(rows.map(\.count).max() ?? 1, 1)
            let colW = width / CGFloat(cols)
            for (i, row) in rows.enumerated() {
                let y = top + CGFloat(i) * 40.2
                for (j, cell) in row.enumerated() {
                    let r = CGRect(x: left + CGFloat(j) * colW, y: y, width: colW, height: 40.2)
                    if cell.1 {
                        p.bgSubtle.setFill()
                        UIRectFill(r)
                    }
                    let style = NSMutableParagraphStyle()
                    style.lineBreakMode = .byTruncatingTail
                    let f = WebType.ui(16, cell.1 ? 600 : 400)
                    NSAttributedString(string: cell.0, attributes: [.font: f, .foregroundColor: p.text, .paragraphStyle: style])
                        .draw(in: CGRect(x: r.minX + 10, y: r.minY + (40.2 - f.lineHeight) / 2, width: colW - 20, height: f.lineHeight + 2))
                }
            }
            p.border.setFill()
            for i in 0...rows.count { UIRectFill(CGRect(x: left, y: top + CGFloat(i) * 40.2, width: width, height: 1)) }
            for j in 0...cols { UIRectFill(CGRect(x: min(left + CGFloat(j) * colW, right - 1), y: top, width: 1, height: CGFloat(rows.count) * 40.2 + 1)) }
        }
    }

    // MARK: Editing

    /// Make the box editable through `editor` (it stays attached and keeps drawing the
    /// session's state after editing ends).
    func attach(_ editor: BoxEditor) {
        self.editor = editor
        shownDocJSON = nil
        reloadFromEngine(notify: false)
    }

    override var canBecomeFirstResponder: Bool { editor != nil }

    /// Look mode (CI screenshots): an empty input view instead of the software keyboard.
    private lazy var lookInputView: UIView? = LookData.state == nil ? nil : UIView(frame: .zero)
    override var inputView: UIView? { lookInputView }

    override func becomeFirstResponder() -> Bool {
        guard editor != nil else { return false }
        if LookData.state != nil {
            inputAssistantItem.leadingBarButtonGroups = []
            inputAssistantItem.trailingBarButtonGroups = []
        }
        if interaction == nil {
            let i = UITextInteraction(for: .editable)
            i.textInput = self
            addInteraction(i)
            interaction = i
        }
        return super.becomeFirstResponder()
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned {
            // Losing focus ends an open composition (EDITOR.md 10.2).
            if marked != nil { engine(fromProtocol: false) { $0.finishComposition() } }
            if let i = interaction {
                removeInteraction(i)
                interaction = nil
            }
            suggestionLabel.isHidden = true
        }
        return resigned
    }

    override var undoManager: UndoManager? { editor == nil ? super.undoManager : engineUndoManager }

    /// Put the caret at `point` (view coordinates), as a tap does.
    func placeCaret(at point: CGPoint) {
        guard editor != nil, let p = closestPosition(to: point) as? BoxTextPosition else { return }
        selectByPlatform(BoxTextRange(p.offset, p.offset), notify: true)
    }

    /// Put the caret at the end of the box.
    func placeCaretAtEnd() {
        selectByPlatform(BoxTextRange(text.length, text.length), notify: true)
    }

    /// Someone else changed the page: the session already merged it; draw and tell the keyboard.
    func remoteChanged() {
        reloadFromEngine(notify: isFirstResponder)
    }

    /// Run an engine call. Calls made by UIKit through UITextInput (`fromProtocol`) don't notify
    /// `inputDelegate`; everything else (hardware keys the engine took, menu commands, undo,
    /// remote changes) does (EDITOR.md 10.2).
    @discardableResult
    private func engine<T>(fromProtocol: Bool, edits: Bool = true, _ work: (EditorSession) -> T) -> T? {
        guard let editor else { return nil }
        let notify = !fromProtocol && isFirstResponder
        if notify {
            inputDelegate?.selectionWillChange(self)
            inputDelegate?.textWillChange(self)
        }
        let result = work(editor.session)
        if edits { editor.edited() }
        reloadFromEngine(notify: false)
        if notify {
            inputDelegate?.textDidChange(self)
            inputDelegate?.selectionDidChange(self)
        }
        return result
    }

    /// Read the session's state: text, selection, composition; draw again if the tree changed.
    private func reloadFromEngine(notify: Bool) {
        guard let editor else { return }
        if notify {
            inputDelegate?.selectionWillChange(self)
            inputDelegate?.textWillChange(self)
        }
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
                    r = BoxRendering(string: NSAttributedString(string: text as String + "\u{200B}", attributes: [.font: UIFont.systemFont(ofSize: 16)]), markers: [], decorations: [], length: len, topMargin: 0)
                }
                if let m = marked, m.hi > m.lo, m.hi <= r.string.length {
                    let u = NSMutableAttributedString(attributedString: r.string)
                    u.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: NSRange(location: m.lo, length: m.hi - m.lo))
                    u.addAttribute(.underlineColor, value: UIColor.tintColor, range: NSRange(location: m.lo, length: m.hi - m.lo))
                    r = BoxRendering(string: u, markers: r.markers, decorations: r.decorations, length: r.length, topMargin: r.topMargin)
                }
                apply(r)
            }
        }
        updateSuggestion()
        if notify {
            inputDelegate?.textDidChange(self)
            inputDelegate?.selectionDidChange(self)
        }
        interaction?.textInput = self
        onCaretChange?(self)
    }

    /// The engine's open suggestion menu (`/`): no menu UI yet, so say what Enter picks.
    private func updateSuggestion() {
        guard isFirstResponder, let s = suggestion, s.trigger == .slash, let first = s.slashItems.first else {
            suggestionLabel.isHidden = true
            return
        }
        suggestionLabel.text = "  ↵ \(first)   ·   esc closes  "
        suggestionLabel.sizeToFit()
        let caret = caretRect(for: BoxTextPosition(sel.hi))
        suggestionLabel.frame.origin = CGPoint(x: max(caret.minX - 8, 0), y: caret.maxY + 4)
        suggestionLabel.isHidden = false
    }

    /// The platform set the selection (taps, handles, arrows, the IME).
    private func selectByPlatform(_ r: BoxTextRange, notify: Bool) {
        let len = text.length
        let lo = min(max(r.lo, 0), len), hi = min(max(r.hi, 0), len)
        engine(fromProtocol: !notify, edits: false) { s in
            if hi == lo + 1, isObjectLine(lo) {
                s.selectNode(pos: s.viewOffsetToPos(offset: UInt32(lo)))
            } else {
                s.setSelection(anchor: s.viewOffsetToPos(offset: UInt32(lo)), head: s.viewOffsetToPos(offset: UInt32(hi)))
            }
        }
    }

    /// One object line's U+FFFC (a task line, a rule, an image): selecting it selects the node.
    private func isObjectLine(_ o: Int) -> Bool {
        guard o < text.length, text.character(at: o) == 0xFFFC else { return false }
        let before = o == 0 || text.character(at: o - 1) == 0x0A
        let after = o + 1 == text.length || text.character(at: o + 1) == 0x0A
        return before && after
    }

    func engineUndo() {
        guard let editor else { return }
        engine(fromProtocol: false, edits: false) { _ in editor.undo() }
    }

    func engineRedo() {
        guard let editor else { return }
        engine(fromProtocol: false, edits: false) { _ in editor.redo() }
    }

    /// A key chord for the engine (EDITOR.md 4 and 10.2). False when the engine didn't use it.
    @discardableResult
    func sendKey(_ chord: String) -> Bool {
        guard let editor else { return false }
        let handled = engine(fromProtocol: false, edits: false) { $0.key(chord: chord) } ?? false
        editor.noteKey(chord, handled: handled)
        if handled { editor.send() }
        return handled
    }

    // MARK: UIKeyInput

    var hasText: Bool { text.length > 0 }

    func insertText(_ s: String) {
        engine(fromProtocol: true) { session in
            if s == "\n" {
                // The Return key is a key in disguise: lists, tasks and tables apply.
                if marked != nil { session.finishComposition() }
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

    func deleteBackward() {
        engine(fromProtocol: true) { _ = $0.key(chord: "Backspace") }
    }

    // MARK: UITextInput: text

    func text(in range: UITextRange) -> String? {
        guard let r = range as? BoxTextRange else { return nil }
        let len = text.length
        let lo = min(max(r.lo, 0), len), hi = min(max(r.hi, 0), len)
        return text.substring(with: NSRange(location: lo, length: hi - lo))
    }

    func replace(_ range: UITextRange, withText replacement: String) {
        guard let r = range as? BoxTextRange else { return }
        engine(fromProtocol: true) { s in
            let from = s.viewOffsetToPos(offset: UInt32(r.lo)), to = s.viewOffsetToPos(offset: UInt32(r.hi))
            if !s.replaceRange(from: from, to: to, text: replacement) {
                // Refused (the range isn't in text): type it over the range instead.
                s.setSelection(anchor: from, head: to)
                if replacement.isEmpty { _ = s.key(chord: "Backspace") } else { s.insertText(text: replacement) }
            }
        }
    }

    var selectedTextRange: UITextRange? {
        get { BoxTextRange(sel.lo, sel.hi) }
        set {
            guard let r = newValue as? BoxTextRange, r.lo != sel.lo || r.hi != sel.hi else { return }
            selectByPlatform(r, notify: false)
        }
    }

    var markedTextRange: UITextRange? {
        guard let m = marked else { return nil }
        return BoxTextRange(m.lo, m.hi)
    }

    func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        let t = markedText ?? ""
        let start = UInt32(max(selectedRange.location, 0))
        let end = UInt32(max(selectedRange.location + selectedRange.length, 0))
        engine(fromProtocol: true, edits: false) { $0.setComposition(text: t, selStart: start, selEnd: end) }
    }

    func unmarkText() {
        guard marked != nil else { return }
        engine(fromProtocol: true) { $0.finishComposition() }
    }

    // MARK: UITextInput: positions

    var beginningOfDocument: UITextPosition { BoxTextPosition(0) }
    var endOfDocument: UITextPosition { BoxTextPosition(text.length) }

    func textRange(from fromPosition: UITextPosition, to toPosition: UITextPosition) -> UITextRange? {
        guard let a = fromPosition as? BoxTextPosition, let b = toPosition as? BoxTextPosition else { return nil }
        return BoxTextRange(a.offset, b.offset)
    }

    func position(from position: UITextPosition, offset: Int) -> UITextPosition? {
        guard let p = position as? BoxTextPosition else { return nil }
        let o = p.offset + offset
        // Out of range is nil, as UIKit's own text views answer (the tokenizer relies on it).
        guard o >= 0, o <= text.length else { return nil }
        return BoxTextPosition(o)
    }

    func position(from position: UITextPosition, in direction: UITextLayoutDirection, offset: Int) -> UITextPosition? {
        guard let p = position as? BoxTextPosition else { return nil }
        switch direction {
        case .left: return self.position(from: p, offset: -offset)
        case .right: return self.position(from: p, offset: offset)
        case .up, .down:
            // Up and down ask the layout: the point a line above or below the caret.
            let caret = caretRect(for: p)
            let lineHeight = max(caret.height, 1)
            let lines = CGFloat(max(offset, 1) - 1)
            let y = direction == .up
                ? caret.minY - lineHeight * lines - lineHeight / 2
                : caret.maxY + lineHeight * lines + lineHeight / 2
            if y < inset.top { return BoxTextPosition(0) }
            if y > bounds.height - inset.bottom { return BoxTextPosition(text.length) }
            return closestPosition(to: CGPoint(x: caret.midX, y: y))
        @unknown default: return nil
        }
    }

    func compare(_ position: UITextPosition, to other: UITextPosition) -> ComparisonResult {
        guard let a = position as? BoxTextPosition, let b = other as? BoxTextPosition else { return .orderedSame }
        return a.offset < b.offset ? .orderedAscending : a.offset > b.offset ? .orderedDescending : .orderedSame
    }

    func offset(from: UITextPosition, to toPosition: UITextPosition) -> Int {
        guard let a = from as? BoxTextPosition, let b = toPosition as? BoxTextPosition else { return 0 }
        return b.offset - a.offset
    }

    func position(within range: UITextRange, farthestIn direction: UITextLayoutDirection) -> UITextPosition? {
        guard let r = range as? BoxTextRange else { return nil }
        switch direction {
        case .left, .up: return BoxTextPosition(r.lo)
        default: return BoxTextPosition(r.hi)
        }
    }

    func characterRange(byExtending position: UITextPosition, in direction: UITextLayoutDirection) -> UITextRange? {
        guard let p = position as? BoxTextPosition else { return nil }
        switch direction {
        case .left, .up: return BoxTextRange(max(p.offset - 1, 0), p.offset)
        default: return BoxTextRange(p.offset, min(p.offset + 1, text.length))
        }
    }

    func baseWritingDirection(for position: UITextPosition, in direction: UITextStorageDirection) -> NSWritingDirection {
        .natural
    }

    func setBaseWritingDirection(_ writingDirection: NSWritingDirection, for range: UITextRange) {
        // The schema has no direction attribute yet.
    }

    // MARK: UITextInput: geometry (TextKit 2, never the engine)

    private func location(_ offset: Int) -> NSTextLocation? {
        contentStorage.location(contentStorage.documentRange.location, offsetBy: min(max(offset, 0), rendering.string.length))
    }

    private func segments(_ lo: Int, _ hi: Int, type: NSTextLayoutManager.SegmentType) -> [CGRect] {
        guard let a = location(lo), let b = location(hi), let range = NSTextRange(location: a, end: b) else { return [] }
        var rects: [CGRect] = []
        layoutManager.enumerateTextSegments(in: range, type: type, options: [.rangeNotRequired]) { _, frame, _, _ in
            rects.append(frame.offsetBy(dx: inset.left, dy: inset.top))
            return true
        }
        return rects
    }

    func caretRect(for position: UITextPosition) -> CGRect {
        guard let p = position as? BoxTextPosition else { return .zero }
        let rects = segments(p.offset, p.offset, type: .standard)
        guard let r = rects.first else {
            return CGRect(x: inset.left, y: inset.top, width: 2, height: 20)
        }
        return CGRect(x: r.minX, y: r.minY, width: 2, height: max(r.height, 16))
    }

    func firstRect(for range: UITextRange) -> CGRect {
        guard let r = range as? BoxTextRange else { return .zero }
        if r.isEmpty { return caretRect(for: BoxTextPosition(r.lo)) }
        let rects = segments(r.lo, r.hi, type: .standard)
        guard let first = rects.first else { return caretRect(for: BoxTextPosition(r.lo)) }
        // The first line's segments, joined.
        return rects.filter { abs($0.minY - first.minY) < 1 }.reduce(first) { $0.union($1) }
    }

    func selectionRects(for range: UITextRange) -> [UITextSelectionRect] {
        guard let r = range as? BoxTextRange, !r.isEmpty else { return [] }
        let rects = segments(r.lo, r.hi, type: .selection)
        return rects.enumerated().map { i, rect in
            BoxSelectionRect(rect, first: i == 0, last: i == rects.count - 1)
        }
    }

    func closestPosition(to point: CGPoint) -> UITextPosition? {
        let p = CGPoint(x: point.x - inset.left, y: point.y - inset.top)
        let len = text.length
        if p.y < 0 { return BoxTextPosition(0) }
        if p.y > layoutManager.usageBoundsForTextContainer.maxY { return BoxTextPosition(len) }
        let selections = layoutManager.textSelectionNavigation.textSelections(
            interactingAt: p, inContainerAt: layoutManager.documentRange.location,
            anchors: [], modifiers: [], selecting: false, bounds: .zero)
        guard let loc = selections.first?.textRanges.first?.location else { return BoxTextPosition(len) }
        let o = contentStorage.offset(from: contentStorage.documentRange.location, to: loc)
        return BoxTextPosition(min(max(o, 0), len))
    }

    func closestPosition(to point: CGPoint, within range: UITextRange) -> UITextPosition? {
        guard let r = range as? BoxTextRange, let p = closestPosition(to: point) as? BoxTextPosition else { return nil }
        return BoxTextPosition(min(max(p.offset, r.lo), r.hi))
    }

    func characterRange(at point: CGPoint) -> UITextRange? {
        guard let p = closestPosition(to: point) as? BoxTextPosition else { return nil }
        let o = min(p.offset, max(text.length - 1, 0))
        return BoxTextRange(o, min(o + 1, text.length))
    }

    // MARK: Hardware keyboard (EDITOR.md 10.2)

    /// Cmd chords go to the engine, ahead of the system's menu commands (Cmd+Z must not also
    /// reach the undo manager).
    override var keyCommands: [UIKeyCommand]? {
        guard editor != nil, isFirstResponder else { return nil }
        let chords: [(String, UIKeyModifierFlags)] = [
            ("b", .command), ("i", .command), ("u", .command), ("e", .command),
            ("s", [.command, .shift]), ("b", [.command, .shift]),
            ("z", .command), ("z", [.command, .shift]), ("y", .command),
            (".", .command), ("8", [.command, .shift]), ("7", [.command, .shift]),
            ("0", [.command, .alternate]), ("1", [.command, .alternate]), ("2", [.command, .alternate]), ("3", [.command, .alternate]),
            ("c", [.command, .alternate]), ("1", .command), ("\r", .command), ("a", .command),
        ]
        return chords.map { input, flags in
            let c = UIKeyCommand(input: input, modifierFlags: flags, action: #selector(engineKeyCommand(_:)))
            c.wantsPriorityOverSystemBehavior = true
            return c
        }
    }

    @objc private func engineKeyCommand(_ command: UIKeyCommand) {
        guard let input = command.input else { return }
        let key = input == "\r" ? "Enter" : input
        sendKey(Self.chord(key, command.modifierFlags))
    }

    static func chord(_ key: String, _ flags: UIKeyModifierFlags) -> String {
        var parts: [String] = []
        if flags.contains(.command) { parts.append("Mod") }
        if flags.contains(.alternate) { parts.append("Alt") }
        if flags.contains(.shift) { parts.append("Shift") }
        parts.append(key)
        return parts.joined(separator: "+")
    }

    /// Keys that aren't text and aren't Cmd chords: Shift+Enter, Shift+Tab, Delete, Escape and
    /// Alt chords go to `key()`; what the engine doesn't take goes on to UIKit (arrows move the
    /// caret there). Plain Return, Tab and Backspace come through `insertText` / `deleteBackward`.
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard editor != nil, isFirstResponder, marked == nil else {
            super.pressesBegan(presses, with: event)
            return
        }
        var rest = Set<UIPress>()
        for press in presses {
            if let key = press.key, let chord = Self.engineChord(key), sendKey(chord) {
                handledPresses.insert(press)
            } else {
                rest.insert(press)
            }
        }
        if !rest.isEmpty { super.pressesBegan(rest, with: event) }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let rest = presses.subtracting(handledPresses)
        handledPresses.subtract(presses)
        if !rest.isEmpty { super.pressesEnded(rest, with: event) }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let rest = presses.subtracting(handledPresses)
        handledPresses.subtract(presses)
        if !rest.isEmpty { super.pressesCancelled(rest, with: event) }
    }

    private static func engineChord(_ key: UIKey) -> String? {
        let flags = key.modifierFlags
        if flags.contains(.command) || flags.contains(.control) { return nil } // key commands, or UIKit's (Ctrl+A …)
        let name: String
        switch key.keyCode {
        case .keyboardReturnOrEnter, .keypadEnter: name = "Enter"
        case .keyboardTab: name = "Tab"
        case .keyboardDeleteOrBackspace: name = "Backspace"
        case .keyboardDeleteForward: name = "Delete"
        case .keyboardEscape: name = "Escape"
        case .keyboardUpArrow: name = "ArrowUp"
        case .keyboardDownArrow: name = "ArrowDown"
        case .keyboardLeftArrow: name = "ArrowLeft"
        case .keyboardRightArrow: name = "ArrowRight"
        default:
            // Alt+letter types accents and symbols on Apple keyboards: that's text.
            return nil
        }
        let alt = flags.contains(.alternate), shift = flags.contains(.shift)
        switch name {
        case "Delete", "Escape": return chord(name, flags)
        case "Enter", "Tab": return shift || alt ? chord(name, flags) : nil
        case "Backspace": return alt ? chord(name, flags) : nil
        default: return alt ? chord(name, flags) : nil // Alt+Shift+ArrowUp moves a block; plain arrows are UIKit's
        }
    }

    // MARK: Edit menu and clipboard

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        guard editor != nil else { return super.canPerformAction(action, withSender: sender) }
        switch action {
        case #selector(UIResponderStandardEditActions.copy(_:)), #selector(UIResponderStandardEditActions.cut(_:)):
            return sel.hi > sel.lo
        case #selector(UIResponderStandardEditActions.paste(_:)):
            return UIPasteboard.general.hasStrings || UIPasteboard.general.contains(pasteboardTypes: ["public.html"])
        case #selector(UIResponderStandardEditActions.selectAll(_:)), #selector(UIResponderStandardEditActions.toggleBoldface(_:)), #selector(UIResponderStandardEditActions.toggleItalics(_:)), #selector(UIResponderStandardEditActions.toggleUnderline(_:)):
            return true
        default:
            return super.canPerformAction(action, withSender: sender)
        }
    }

    override func copy(_ sender: Any?) {
        guard let c = editor?.session.copy() else { return }
        Self.put(c)
    }

    override func cut(_ sender: Any?) {
        guard let c = engine(fromProtocol: false, { $0.cut() }) else { return }
        Self.put(c)
    }

    override func paste(_ sender: Any?) {
        let board = UIPasteboard.general
        let html = board.data(forPasteboardType: "public.html").flatMap { String(data: $0, encoding: .utf8) } ?? ""
        let plain = board.string ?? ""
        guard !html.isEmpty || !plain.isEmpty else { return }
        engine(fromProtocol: false) { _ = $0.paste(html: html, text: plain) }
    }

    override func selectAll(_ sender: Any?) { sendKey("Mod+a") }
    override func toggleBoldface(_ sender: Any?) { sendKey("Mod+b") }
    override func toggleItalics(_ sender: Any?) { sendKey("Mod+i") }
    override func toggleUnderline(_ sender: Any?) { sendKey("Mod+u") }

    private static func put(_ c: ClipboardData) {
        var item: [String: Any] = ["public.utf8-plain-text": c.text]
        if !c.html.isEmpty { item["public.html"] = c.html }
        UIPasteboard.general.items = [item]
    }
}
