import NotiveloCore
import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

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
    /// The page's icon (an emoji), if it has one.
    var icon: String?
    /// The row above the title opens the icon picker here.
    var onIcon: ((CGRect) -> Void)?
    /// The title is a text field when this is set: (page id, new title), on Return or when the field loses focus.
    var onRename: ((String, String) -> Void)?
    /// Phones: boxes stacked in reading order, full width (LOOK.md 3.2).
    var stacked = false
    /// A short message for the user (the shell's toast).
    var notify: ((String) -> Void)?

    func makeUIView(context: Context) -> PageScrollView {
        PageScrollView()
    }

    func updateUIView(_ view: PageScrollView, context: Context) {
        view.stacked = stacked
        view.notify = notify
        BoxTextRenderer.phoneChips = stacked
        view.onIcon = onIcon
        view.onRename = onRename
        view.setHeader(title: title, subline: subline, palette: palette, showAddIcon: showAddIcon, icon: icon)
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
    private var ink: InkController!
    private let titleField = UITextView()
    private let titleHint = UILabel()
    private let titleDelegate = TitleFieldDelegate()
    /// The title being typed commits as (page id, title); nil: the title is read-only.
    var onRename: ((String, String) -> Void)? {
        didSet { titleField.isEditable = onRename != nil }
    }
    private var shownTitle = ""
    private var wantedTitle = ""
    private var titleAttrs: [NSAttributedString.Key: Any] = [:]
    private let subLabel = UILabel()
    private let addIcon = UILabel()
    private var palette = Palette.light
    private var paletteKey = ""
    var decor: [String: TaskDecor] = [:]
    var stacked = false
    /// Phones: the article's padding is 12 20, the title 28 pt.
    static let phoneOriginY: CGFloat = 12 + 44 + 4 + 33.6 + 6 + 18.75 + 22 + 6
    /// The page's icon, shown large (56 pt, 44 on phones, line 1.1, padding 2) in the row above the title: that row is taller
    /// than the empty one (28 pt, 44 on phones), so the title and the page's origin move down with it (`.page-icon-row`).
    private var icon: String?
    /// The icon row was tapped (its frame in this view's coordinates): the shell opens the icon picker there.
    var onIcon: ((CGRect) -> Void)?
    private var headerShift: CGFloat {
        guard icon != nil else { return 0 }
        return (stacked ? 44 * 1.1 + 4 : 56 * 1.1 + 4) - (stacked ? 44 : 28)
    }
    private var originYNow: CGFloat { Self.originY + headerShift }
    private var phoneOriginNow: CGFloat { Self.phoneOriginY + headerShift }
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
    private var needsInk = false
    private var demoDone = false
    private var lookDone = false
    private var laidOutWidth: CGFloat = 0
    private let singleTap = UITapGestureRecognizer()
    private let menu = SuggestionMenuView()
    private weak var menuOwner: BoxTextView?
    private let doubleTap = UITapGestureRecognizer()
    private let boxPan = BoxDragRecognizer()
    private let toolbar = FloatingToolbarView()
    private let linkEditor = LinkEditorView()
    var notify: ((String) -> Void)?
    private var geometry: BoxGeometryStore = LocalBoxGeometry()
    private var needsGeometry = true
    private var lastPage: PageSnapshot?
    private var lastCommit = Date.distantPast
    /// The boxes as the page document has them (before local changes).
    private var pageBoxes: [PageBox] = []
    private enum Drag {
        case move(id: String, start: CGPoint, x: Double, y: Double), resize(id: String, start: CGPoint, w: Double)
        /// A resize handle of the selected image (the shape stays: `aspect` is height over width).
        case image(id: String, handle: ImageHandle, start: CGPoint, w: CGFloat, aspect: CGFloat, maxW: CGFloat)
    }
    private var drag: Drag?
    /// The box selected as a whole (tap its top bar, or the context menu): the accent outline, and Delete, Cmd-C/X/V/D act on it.
    private var selected: String?
    /// The image being resized: the width last sent to the engine and the one the finger is at.
    private var imageSent: (at: Date, width: CGFloat) = (.distantPast, 0)
    private var imageWanted: CGFloat = 0

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
        ink = InkController(scroll: self, surface: surface)
        ink.notify = { [weak self] in self?.notify?($0) }
        PageHistory.shared.notify = { [weak self] in self?.notify?($0) }
        PageHistory.shared.beginStep = { [weak self] in self?.beginHistoryStep() }
        surface.onReorder = { [weak self] in self?.ink.layout() }
        NotificationCenter.default.addObserver(self, selector: #selector(inkToolChanged), name: InkTool.changed, object: nil)
        subLabel.numberOfLines = 1
        titleField.isScrollEnabled = false
        titleField.backgroundColor = .clear
        titleField.textContainerInset = .zero
        titleField.textContainer.lineFragmentPadding = 0
        titleField.returnKeyType = .next
        titleField.autocapitalizationType = .sentences
        titleField.isEditable = false
        titleField.delegate = titleDelegate
        titleDelegate.owner = self
        titleHint.numberOfLines = 1
        titleHint.isUserInteractionEnabled = false
        surface.addSubview(titleField)
        surface.addSubview(titleHint)
        surface.addSubview(subLabel)
        surface.addSubview(addIcon)
        doubleTap.addTarget(self, action: #selector(toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        singleTap.addTarget(self, action: #selector(tapped(_:)))
        singleTap.require(toFail: doubleTap)
        addGestureRecognizer(singleTap)
        addInteraction(UIDropInteraction(delegate: self))
        boxPan.addTarget(self, action: #selector(panned(_:)))
        boxPan.maximumNumberOfTouches = 1
        // Fails at touch-down unless the touch starts on the edited box's bar or width handle: otherwise it
        // recognized every swipe (even with `gestureRecognizerShouldBegin` returning false) and the page never scrolled.
        boxPan.accepts = { [weak self] touch in
            guard let self else { return false }
            return self.moveHit(touch.location(in: self.surface)) != nil
        }
        addGestureRecognizer(boxPan)
        addInteraction(UIContextMenuInteraction(delegate: self))
        // The page's own pan never waits on the box pan; `gestureRecognizerShouldBegin` and the box pan failing
        // at touch-down keep them apart: a pan that starts on a box's bar or handle is the box's.
        isScrollEnabled = true
        isUserInteractionEnabled = true
        accessibilityIdentifier = "page-scroll"
        titleField.accessibilityIdentifier = "page-title"
        toolbar.isHidden = true
        toolbar.onCommand = { [weak self] name, args in
            EditorFocus.shared.run(name, args)
            self?.updateToolbar()
        }
        toolbar.onLink = { [weak self] in self?.showLinkEditor() }
        toolbar.onComment = { [weak self] in self?.startComment() }
        toolbar.onTable = { EditorFocus.shared.onTableMenu?() }
        NotificationCenter.default.addObserver(self, selector: #selector(commentsChanged), name: CommentsModel.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(commentUnset(_:)), name: CommentsModel.unset, object: nil)
        EditorFocus.shared.onLink = { [weak self] in self?.showLinkEditor() }
        linkEditor.onApply = { [weak self] text, address in self?.applyLink(text: text, address: address) }
        linkEditor.onRemove = { [weak self] in self?.removeLink() }
        linkEditor.onOpen = { href in
            if let url = LinkURL.openable(href) { UIApplication.shared.open(url) }
        }
        linkEditor.onCancel = { [weak self] in self?.hideLinkEditor(refocus: true) }
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
    func setHeader(title: String, subline: String, palette: Palette, showAddIcon: Bool, icon: String?) {
        let iconChanged = self.icon != icon
        self.icon = icon
        let key = "\(palette.isDark)-\(palette.bg.hashValue)-\(palette.textMuted.hashValue)"
        if key != paletteKey {
            paletteKey = key
            self.palette = palette
            ink.dark = palette.isDark
            ink.accent = palette.accent
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
        let titleAttributes: [NSAttributedString.Key: Any] = [
            .font: titleFont, .kern: -0.025 * titleSize, .paragraphStyle: style,
            .foregroundColor: palette.text,
            .baselineOffset: (titleLine - titleFont.lineHeight) / BoxTextRenderer.baselineDivisor,
        ]
        titleField.typingAttributes = titleAttributes
        titleAttrs = titleAttributes
        wantedTitle = title
        titleField.tintColor = palette.accent
        // What the person is typing is not overwritten by a refresh.
        if !titleField.isFirstResponder {
            shownTitle = title
            titleField.attributedText = NSAttributedString(string: title, attributes: titleAttributes)
        }
        var hintAttributes = titleAttributes
        hintAttributes[.foregroundColor] = palette.borderStrong
        titleHint.attributedText = NSAttributedString(string: "Untitled", attributes: hintAttributes)
        titleHint.isHidden = !titleField.text.isEmpty
        subLabel.attributedText = NSAttributedString(string: subline, attributes: [.font: WebType.ui(12.5), .foregroundColor: palette.textMuted])
        if let icon, !icon.isEmpty {
            let size: CGFloat = stacked ? 44 : 56
            let style = NSMutableParagraphStyle()
            style.minimumLineHeight = size * 1.1
            style.maximumLineHeight = size * 1.1
            addIcon.attributedText = NSAttributedString(string: icon, attributes: [.font: UIFont.systemFont(ofSize: size), .paragraphStyle: style])
            addIcon.isHidden = false
        } else if showAddIcon {
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
        if iconChanged, shownID != nil { relayout() }
    }

    /// The title field changed text: the hint and the height follow.
    fileprivate func titleChanged() {
        titleHint.isHidden = !titleField.text.isEmpty
        layoutHeader()
    }

    /// Focus left the title: save it if it changed.
    fileprivate func titleEnded() {
        let text = titleField.text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        titleHint.isHidden = !text.isEmpty
        guard let id = shownID, text != shownTitle else { return }
        shownTitle = text
        onRename?(id, text)
    }

    /// Return in the title moves into the first box (the web's `onEnter`).
    fileprivate func titleReturned() {
        _ = titleField.resignFirstResponder()
        guard host != nil, let first = boxes.min(by: { ($0.y, $0.x) < ($1.y, $1.x) }), let view = boxViews[first.id] else { return }
        beginEditing(view, at: nil)
    }

    private func layoutHeader() {
        let left = stacked ? 20 : Self.originX + BoxTextView.pad.left
        let width = max(bounds.width / max(zoomScale, 0.01) - left - (stacked ? 20 : 40), 100)
        let titleSize = titleField.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let top: CGFloat = stacked ? 12 : 32
        let iconRow: CGFloat = (stacked ? 44 : 28) + headerShift
        titleField.frame = CGRect(x: left, y: top + iconRow + 4, width: width, height: max(titleSize.height, stacked ? 33.6 : 43.2))
        titleHint.frame = titleField.frame
        subLabel.frame = CGRect(x: left, y: titleField.frame.maxY + 6, width: width, height: 18.75)
        addIcon.frame = CGRect(x: left - (icon != nil ? 4 : (stacked ? 0 : 8)), y: top, width: icon != nil ? 240 : 160, height: iconRow)
    }

    func show(_ page: PageSnapshot, host: PageEditHost?) {
        Self.current = self
        if page.id != shownID {
            // A title being typed on the page that closes is saved to that page.
            if titleField.isFirstResponder {
                _ = titleField.resignFirstResponder()
                shownTitle = wantedTitle
                titleField.attributedText = NSAttributedString(string: wantedTitle, attributes: titleAttrs)
                titleHint.isHidden = !wantedTitle.isEmpty
            }
            stopEditing()
            boxViews.values.forEach { $0.removeFromSuperview() }
            boxViews = [:]
            editors = [:]
            shownID = page.id
            ink.reset()
            needsInk = true
            needsGeometry = true
            hideToolbar()
            demoDone = false
            lookDone = false
            zoomScale = 1
            contentOffset = .zero
        }
        if self.host !== host {
            self.host = host
            host?.onRemoteChange = { [weak self] in self?.remoteChanged() }
            host?.onSynced = { [weak self] in
                self?.reopenStaleEditors()
                self?.ink.reload()
            }
            ink.host = host
            needsInk = true
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
        ink.drawingAllowed = !stacked
        if needsInk {
            needsInk = false
            ink.reload()
        }
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
        view.onMenu = { [weak self] box, content in self?.showMenu(box, content) }
        view.onLinkKey = { [weak self] in self?.showLinkEditor() }
        view.onCaretChange = { [weak self] box in
            self?.keepCaretVisible(box)
            if box === self?.editing { EditorFocus.shared.refreshTable() }
            if box === self?.editing {
                self?.updateToolbar()
            }
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
        let ox = Self.originX, oy = originYNow
        var maxX: CGFloat = 0, maxY: CGFloat = 0
        var frames: [(String, CGRect, Double)] = []
        var separators: [CGFloat] = []
        // Phones: one under the other, padding 12 0, a hairline between (text 20 pt in).
        // The first of several boxes has 9 pt more above it than a lone box (a page's text).
        var y = phoneOriginNow - BoxTextView.pad.top + (boxes.count > 1 ? 9 : 0)
        for box in boxes {
            guard let view = boxViews[box.id] else { continue }
            let w = width(of: box)
            view.setWidth(w)
            let frame: CGRect
            if stacked {
                frame = CGRect(x: 20 - BoxTextView.pad.left, y: y, width: w, height: view.contentHeight)
                separators.append(frame.maxY + 12)
                y = frame.maxY + 12 + 1 + 5
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
        ink.origin = stacked ? CGPoint(x: 0, y: phoneOriginNow) : CGPoint(x: ox, y: oy)
        ink.layout()
        let visible = CGSize(width: max(bounds.width, 1) / max(zoomScale, 0.01), height: max(bounds.height, 1) / max(zoomScale, 0.01))
        let size = stacked
            ? CGSize(width: visible.width, height: max(maxY + visible.height * 0.4, visible.height))
            : CGSize(width: max(maxX + 240, visible.width), height: max(maxY + 320, oy + 320, visible.height))
        surface.bounds = CGRect(origin: .zero, size: size)
        surface.center = CGPoint(x: size.width * zoomScale / 2, y: size.height * zoomScale / 2)
        if let settings { surface.configure(rules: settings.rules, originY: oy) }
        contentSize = CGSize(width: size.width * zoomScale, height: size.height * zoomScale)
        layoutHeader()
        applySelection()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { surface }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) { updateToolbar() }

    // MARK: Editing

    @objc private func tapped(_ tap: UITapGestureRecognizer) {
        // With a pen tool chosen a finger only scrolls and zooms: it neither creates nor opens boxes.
        if InkTool.shared.inking { return }
        let p = tap.location(in: surface)
        // The icon row ("Add icon", or the icon): the shell's icon picker.
        if !addIcon.isHidden, host != nil, let onIcon, addIcon.frame.insetBy(dx: -6, dy: -4).contains(p) {
            let r = convert(addIcon.frame, from: surface)
            onIcon(CGRect(x: r.minX - contentOffset.x, y: r.minY - contentOffset.y, width: r.width, height: r.height))
            return
        }
        // A task's fold arrow (in the gutter, outside the box's own frame).
        for view in boxViews.values {
            if let id = view.foldTask(at: view.convert(p, from: surface)) {
                BoxTextRenderer.toggleCollapsed(id)
                view.rerender()
                return
            }
        }
        if linkEditor.isShown { hideLinkEditor(refocus: false) }
        // The top bar of a box that is not being edited selects the whole box.
        if host != nil, !stacked, let id = barHit(p) {
            select(id)
            return
        }
        if selected != nil { select(nil) }
        guard let box = box(at: p) else {
            if editing != nil || stacked || host == nil || p.y < originYNow || toolbar.covers(tap.location(in: self)) {
                stopEditing()
            } else {
                createBox(at: p)
            }
            return
        }
        // A link in a box that is not being edited opens (http, https, mailto), as the web's read-only text does.
        if box !== editing, let url = box.linkHref(at: tap.location(in: box)).flatMap(LinkURL.openable) {
            UIApplication.shared.open(url)
            return
        }
        // Text with a comment: its thread opens in the comments panel (the editing carries on).
        if let thread = box.commentThread(at: tap.location(in: box)) { CommentsModel.shared.focus(thread) }
        beginEditing(box, at: tap.location(in: box))
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

    /// Take a thread's mark off the page (a cancelled or deleted thread): in every box that carries it, opening
    /// the boxes that were never edited.
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

    /// A tap on empty canvas: a box 360 wide, 12 pt above the tap, in front (the web's click-to-create).
    /// On a live page the box exists on the server at once and is opened in the editor, so it can be typed in.
    private func createBox(at p: CGPoint) {
        let x = max(Double(p.x - Self.originX), 0)
        let y = max(Double(p.y - originYNow - 12), 0)
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
            // No server (look states): the box is drawn as the web draws a new one, without an editor.
            editing = view
            view.chrome = true
            surface.bringSubviewToFront(view)
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

    /// A box left empty goes away (the web removes an empty box on leaving it): at once on screen, on
    /// the server by `deleteBox`, which refuses a box that has anything in it.
    private func removeIfEmpty(_ box: BoxTextView) {
        guard !stacked, box.boxId != "default", box.shownText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
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
        guard !stacked, let mine = boxes.first(where: { $0.id == id }) else { return }
        let others = boxes.filter { $0.id != id }.map(\.z).max() ?? -1
        guard mine.z <= others else { return }
        geometry.bringToFront(id, z: others + 1)
        boxes = geometry.apply(to: pageBoxes)
        relayout()
    }

    private func moveHit(_ p: CGPoint) -> Drag? {
        guard let box = editing, box.superview != nil, let b = boxes.first(where: { $0.id == box.boxId }) else { return nil }
        let f = box.frame
        // A selected image's resize handles come first (they sit inside the box, on phones too).
        if let h = box.imageHandle(at: box.convert(p, from: surface)) {
            return .image(id: b.id, handle: h.handle, start: p, w: h.rect.width, aspect: h.aspect, maxW: h.maxWidth)
        }
        guard !stacked else { return nil }
        // The top bar (12 high in the web, a bigger target here) and the width handle on the right edge.
        if CGRect(x: f.minX, y: f.minY - 26, width: f.width, height: 34).contains(p) {
            return .move(id: b.id, start: p, x: b.x, y: b.y)
        }
        if CGRect(x: f.maxX - 14, y: f.midY - 40, width: 28, height: 80).contains(p) {
            return .resize(id: b.id, start: p, w: Double(f.width))
        }
        return nil
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        let p = pan.location(in: surface)
        switch pan.state {
        case .began:
            drag = moveHit(pan.location(in: surface))
            if let drag {
                hideToolbar()
                switch drag {
                case let .move(id, _, _, _), let .resize(id, _, _): bringToFront(id)
                case let .image(_, _, _, w, _, _): imageSent = (.distantPast, w); imageWanted = w
                }
            }
        case .changed:
            guard let drag else { return }
            if case let .image(id, handle, start, w, aspect, maxW) = drag {
                let dx = p.x - start.x
                imageWanted = min(max(w + (handle.growsLeft ? -dx : dx), 80), maxW).rounded()
                if abs(imageWanted - imageSent.width) >= 2, Date().timeIntervalSince(imageSent.at) > 0.08 {
                    imageSent = (Date(), imageWanted)
                    boxViews[id]?.resizeImage(width: imageWanted, aspect: aspect)
                }
                return
            }
            switch drag {
            case .image: break
            case let .move(id, start, x, y):
                geometry.moveBox(id, x: max(x + Double(p.x - start.x), 0), y: max(y + Double(p.y - start.y), 0))
            case let .resize(id, start, w):
                geometry.resizeBox(id, width: min(max(w + Double(p.x - start.x), 120), 2400))
            }
            boxes = geometry.apply(to: pageBoxes)
            relayout()
            if Date().timeIntervalSince(lastCommit) > 0.15 {
                lastCommit = Date()
                switch drag {
                case let .move(id, _, _, _), let .resize(id, _, _): geometry.commit(id)
                case .image: break
                }
            }
        case .ended, .cancelled, .failed:
            guard let finished = drag else { return }
            drag = nil
            switch finished {
            case let .move(id, _, _, _), let .resize(id, _, _): geometry.commit(id)
            case let .image(id, _, _, _, aspect, _):
                if imageWanted != imageSent.width { boxViews[id]?.resizeImage(width: imageWanted, aspect: aspect) }
            }
            updateToolbar()
        default: break
        }
    }

    // MARK: Floating toolbar

    private func hideToolbar() { toolbar.hide() }

    // MARK: Link editor

    /// Show the link editor under the selection or caret of the box being edited (the toolbar and
    /// ribbon Link buttons, Cmd+K): prefilled when the selection is in a link.
    private func showLinkEditor() {
        guard let box = editing, box.editor != nil, let ctx = box.prepareLink() else { return }
        hideToolbar()
        menu.isHidden = true
        if linkEditor.superview == nil { addSubview(linkEditor) }
        linkEditor.present(palette: palette, text: ctx.text, address: ctx.href, maxWidth: max(min(bounds.width - 16, 360), 200), phone: stacked)
        let anchor = convert(ctx.rect, from: box)
        let visible = CGRect(x: contentOffset.x, y: contentOffset.y, width: bounds.width, height: max(bounds.height - contentInset.bottom, 100))
        let size = linkEditor.size
        // Inside the canvas with the toolbar's 8 pt margin, measured from the safe edge so the shadow doesn't touch the window.
        let right = visible.maxX - max(adjustedContentInset.right, safeAreaInsets.right) - 8
        let x = min(max(anchor.minX, visible.minX + 8), max(right - size.width, visible.minX + 8))
        var y = anchor.maxY + 8
        if y + size.height > visible.maxY - 8 { y = max(anchor.minY - 8 - size.height, visible.minY + 8) }
        linkEditor.frame = CGRect(origin: CGPoint(x: x, y: y), size: size)
        bringSubviewToFront(linkEditor)
        if LookData.state == nil { linkEditor.focusFirst() } // look shots: no keyboard in the picture
    }

    private func hideLinkEditor(refocus: Bool) {
        guard linkEditor.isShown else { return }
        linkEditor.dismiss()
        if refocus, let box = editing { _ = box.becomeFirstResponder() }
        updateToolbar()
    }

    private func applyLink(text: String, address: String) {
        guard let box = editing else { return }
        linkEditor.dismiss()
        _ = box.becomeFirstResponder()
        EditorFocus.shared.run("editLink", ["text": text, "href": address])
        updateToolbar()
    }

    private func removeLink() {
        guard let box = editing else { return }
        linkEditor.dismiss()
        _ = box.becomeFirstResponder()
        EditorFocus.shared.run("unsetLink")
        updateToolbar()
    }

    /// Show the toolbar over the selected text of the box being edited, or hide it.
    private func updateToolbar() {
        guard let box = editing, drag == nil, !linkEditor.isShown, menu.superview == nil || menu.isHidden, let rect = box.selectionBounds else {
            hideToolbar()
            return
        }
        if toolbar.superview == nil { addSubview(toolbar) }
        toolbar.build(palette: palette, maxWidth: stacked ? bounds.width - 16 : .greatestFiniteMagnitude, table: EditorFocus.shared.table != nil)
        let visible = CGRect(x: contentOffset.x, y: contentOffset.y, width: bounds.width, height: max(bounds.height - contentInset.bottom, 100))
        toolbar.isHidden = false
        toolbar.place(over: convert(rect, from: box), visible: visible)
        bringSubviewToFront(toolbar)
    }

    /// The front-most box under a point of the surface.
    private func box(at p: CGPoint) -> BoxTextView? {
        surface.subviews.reversed().compactMap { $0 as? BoxTextView }.first { $0.frame.contains(p) }
    }

    /// Focus `box` with the caret at `point` (box coordinates; nil: at the end). Opens the box in
    /// the engine the first time.
    private func beginEditing(_ box: BoxTextView, at point: CGPoint?, restoreSelection: Bool = false, then: (() -> Void)? = nil) {
        if box === editing {
            if let point { box.placeCaret(at: point) }
            then?()
            return
        }
        stopEditing()
        if selected != nil { selected = nil; applySelection() }
        let focus = { [weak self, weak box] in
            guard let self, let box, box.superview != nil else { return }
            self.editing = box
            box.chrome = true
            self.surface.bringSubviewToFront(box)
            if !restoreSelection { self.bringToFront(box.boxId) }
            _ = box.becomeFirstResponder()
            if !restoreSelection { if let point { box.placeCaret(at: point) } else { box.placeCaretAtEnd() } }
            if let point { box.beginTitleEdit(at: point) }
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

    private func stopEditing(drop: Bool = true) {
        guard let box = editing else { return }
        editing = nil
        hideToolbar()
        if linkEditor.isShown { linkEditor.dismiss() }
        if drop { removeIfEmpty(box) }
        box.endTitleEdit()
        box.chrome = false
        _ = box.resignFirstResponder()
        EditorFocus.shared.set(nil)
        relayout()
    }

    /// Someone else changed the page: every open box merges the page document again (the
    /// read-only boxes redraw from the snapshot in `show`).
    private func remoteChanged() {
        ink.reload()
        // The open boxes' sessions are on the live page: they take others' changes at their next call.
        for id in editors.keys { boxViews[id]?.remoteChanged() }
    }

    /// After a reconnect that made a new live page, the boxes being edited open again on it (their sessions belong to the
    /// old page); what was typed is on the new page from the store.
    private func reopenStaleEditors() {
        guard let host, let token = host.pageToken else { return }
        for (id, editor) in editors where editor.pageToken != nil && editor.pageToken != token {
            BoxEditor.open(boxId: id, host: host) { [weak self] result in
                guard let self, let view = self.boxViews[id], self.editors[id] === editor, case let .success(fresh) = result else { return }
                self.editors[id] = fresh
                view.attach(fresh)
                if view === self.editing { EditorFocus.shared.set(view) }
            }
        }
    }

    /// The page's undo or redo is about to run (`PageHistory`): stop a pen stroke, note each open box's revision; the
    /// returned closure runs once core has taken the step.
    private func beginHistoryStep() -> (() -> Void)? {
        if ink.session.busy { ink.session.cancel() }
        let before = editors.mapValues { $0.session.revision() }
        return { [weak self] in self?.historyStepped(before) }
    }

    /// Core took an undo or redo step: draw what it changed again (strokes, boxes' text, geometry) and, when it was a box's
    /// text, put the caret back in that box (the session restored its selection), as the web does.
    private func historyStepped(_ before: [String: UInt64]) {
        ink.reload()
        geometry.pageUndone()
        var touched: BoxTextView?
        for (id, editor) in editors {
            guard let view = boxViews[id] else { continue }
            if editor.session.revision() != before[id], touched == nil || view === editing { touched = view }
            view.remoteChanged()
        }
        if let view = touched, view !== editing, !InkTool.shared.inking {
            beginEditing(view, at: nil, restoreSelection: true)
        }
    }

    /// The `/`, `[[` or `@` popover of the box being edited (nil content: close it).
    private func showMenu(_ box: BoxTextView, _ content: MenuContent?) {
        if content != nil { hideToolbar() }
        guard let content else {
            if menuOwner === box || menuOwner == nil { menu.isHidden = true }
            return
        }
        menuOwner = box
        if menu.superview == nil {
            menu.isHidden = true
            addSubview(menu)
        }
        menu.onPick = { [weak box] i in box?.pickMenuRow(i) }
        menu.show(content, palette: palette)
        let visible = CGRect(x: contentOffset.x, y: contentOffset.y, width: bounds.width, height: max(bounds.height - contentInset.bottom, 100))
        menu.place(anchor: convert(content.anchor, from: box), visible: visible)
        menu.isHidden = false
        bringSubviewToFront(menu)
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

    // MARK: Ink and undo

    /// A pen tool was chosen: no box is being edited then, and the page takes the keyboard's and the three-finger undo
    /// (`PageUndoManager`, Cmd-Z below), which reach the ink through `EditorFocus`.
    @objc private func inkToolChanged() {
        guard InkTool.shared.inking else { return }
        if editing != nil { stopEditing() }
        _ = becomeFirstResponder()
    }

    override var canBecomeFirstResponder: Bool { true }

    private let pageUndoManager = PageUndoManager()
    override var undoManager: UndoManager? { pageUndoManager }

    /// Cmd-Z and Shift-Cmd-Z on a hardware keyboard while the page (not a box) has the keyboard.
    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand(input: "z", modifierFlags: .command, action: #selector(undoKey)),
         UIKeyCommand(input: "z", modifierFlags: [.command, .shift], action: #selector(redoKey)),
         UIKeyCommand(input: "d", modifierFlags: .command, action: #selector(duplicateSelected)),
         UIKeyCommand(input: UIKeyCommand.inputDelete, modifierFlags: [], action: #selector(deleteSelected))]
    }

    // MARK: Selected box

    /// The top bar above a box that is not being edited (the band the web's move bar sits in).
    private func barHit(_ p: CGPoint) -> String? {
        for view in surface.subviews.reversed().compactMap({ $0 as? BoxTextView }) where view !== editing {
            let f = view.frame
            if CGRect(x: f.minX, y: f.minY - 26, width: f.width, height: 28).contains(p) { return view.boxId }
        }
        return nil
    }

    private func applySelection() {
        for (id, view) in boxViews { view.selectedBox = id == selected }
    }

    fileprivate func select(_ id: String?) {
        if id != nil { stopEditing() }
        selected = id
        applySelection()
        if id != nil { hideToolbar(); _ = becomeFirstResponder() }
    }

    private var selectedIds: [String] { selected.map { [$0] } ?? [] }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        let has = selected != nil && editing == nil && host != nil
        switch action {
        case #selector(copy(_:)), #selector(cut(_:)), #selector(delete(_:)), #selector(duplicateSelected), #selector(deleteSelected): return has
        case #selector(paste(_:)): return has && BoxClipboard.canPaste
        default: return super.canPerformAction(action, withSender: sender)
        }
    }

    override func copy(_ sender: Any?) {
        guard let host, !selectedIds.isEmpty else { return }
        BoxActions.copy(selectedIds, host: host) { [weak self] problem in self?.notify?(problem ?? "Box copied") }
    }

    override func cut(_ sender: Any?) {
        guard let host, !selectedIds.isEmpty else { return }
        BoxActions.cut(selectedIds, host: host) { [weak self] problem in
            if let problem { self?.notify?(problem) } else { self?.select(nil); self?.notify?("Box cut") }
        }
    }

    override func paste(_ sender: Any?) {
        guard let host else { return }
        BoxActions.paste(host: host) { [weak self] ids, problem in
            if let problem { self?.notify?(problem); return }
            if let last = ids.last { self?.selected = last; self?.applySelection() }
        }
    }

    override func delete(_ sender: Any?) { deleteSelected() }

    @objc fileprivate func deleteSelected() {
        guard let host, !selectedIds.isEmpty else { return }
        BoxActions.delete(selectedIds, host: host) { [weak self] problem in
            if let problem { self?.notify?(problem) } else { self?.select(nil); self?.notify?("Box deleted. Undo with Cmd-Z.") }
        }
    }

    @objc fileprivate func duplicateSelected() {
        guard let host, !selectedIds.isEmpty else { return }
        BoxActions.duplicate(selectedIds, host: host) { [weak self] ids, problem in
            if let problem { self?.notify?(problem); return }
            if let last = ids.last { self?.selected = last; self?.applySelection() }
        }
    }

    @objc private func undoKey() { EditorFocus.shared.undo() }
    @objc private func redoKey() { EditorFocus.shared.redo() }

    // MARK: Gestures

    override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        // Taps inside the box being edited are its text interaction's (caret, word selection).
        if g === boxPan { return moveHit(g.location(in: surface)) != nil }
        if g === panGestureRecognizer, moveHit(g.location(in: surface)) != nil { return false }
        if g === singleTap || g === doubleTap, titleField.isEditable, titleField.frame.contains(g.location(in: surface)) { return false }
        if g === singleTap || g === doubleTap, toolbar.covers(g.location(in: self)) { return false }
        if g === singleTap || g === doubleTap, linkEditor.covers(g.location(in: self)) { return false }
        if g === singleTap || g === doubleTap, menu.covers(g.location(in: self)) { return false }
        if g === singleTap || g === doubleTap, let box = editing, box.bounds.contains(g.location(in: box)) { return false }
        // A double tap on an image opens it (the box's own recognizer); it doesn't zoom the page.
        if g === doubleTap, let hit = box(at: g.location(in: surface)), hit.mediaItem(at: g.location(in: hit))?.kind == .image { return false }
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
              let state = LookData.state, ["edit-caret", "ribbon-page-active", "edit-selection", "slash-menu", "edit-new-box", "edit-link", "box-selected", "table-tools"].contains(state) else { return }
        if state == "box-selected" {
            // A box selected as a whole (no caret): the accent outline, as after a click on its top bar.
            guard let view = boxViews.values.first(where: { $0.shownText.contains("Box c") }) else { return }
            lookDone = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.selected = view.boxId
                self?.applySelection()
            }
            return
        }
        if state == "edit-new-box" {
            guard !boxViews.isEmpty else { return }
            lookDone = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let self else { return }
                self.createBox(at: CGPoint(x: Self.originX + 300, y: originYNow + 80))
                if let id = self.boxes.last?.id {
                    self.geometry.moveBox(id, x: 420, y: 110)
                    self.geometry.commit(id)
                    self.boxes = self.geometry.apply(to: self.pageBoxes)
                    self.relayout()
                }
            }
            return
        }
        guard let box = boxViews.values.first(where: { $0.shownText.contains("Box c") }) else { return }
        lookDone = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak box] in
            guard let self, let box else { return }
            self.beginEditing(box, at: nil) {
                if state == "slash-menu" {
                    box.insertText("\n")
                    box.insertText("/")
                }
                if state == "edit-link" {
                    // The last line ("Box c") made a link, then the editor opened on it (prefilled, with Open and Remove).
                    let shown = box.shownText as NSString
                    let nl = shown.range(of: "\n", options: .backwards).location
                    let start = nl == NSNotFound ? 0 : nl + 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        box.lookSelect(from: start)
                        EditorFocus.shared.run("editLink", ["text": shown.substring(from: start), "href": "example.com/notes"])
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.showLinkEditor() }
                }
                if state == "table-tools" {
                    // A 3 x 3 table after "Box c", the caret in its first cell: the ribbon's Table group (the phone: the table menu).
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                        EditorFocus.shared.run("insertTable", ["rows": 3, "cols": 3, "header": true])
                        if self.stacked { DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { EditorFocus.shared.onTableMenu?() } }
                    }
                }
                if state == "edit-selection" {
                    // The last line ("Box c"), as the web reference selects.
                    let shown = box.shownText as NSString
                    let nl = shown.range(of: "\n", options: .backwards).location
                    let start = nl == NSNotFound ? 0 : nl + 1
                    for t in [0.3, 1.0, 2.0] {
                        DispatchQueue.main.asyncAfter(deadline: .now() + t) {
                            box.lookSelect(from: start)
                            self.updateToolbar()
                        }
                    }
                }
            }
        }
    }
}

/// The page surface: rule lines or grid, 28 points apart, as the web app draws them (LOOK.md 1.3):
/// a 1 pt line on the last point of every band, the pattern starting 7 pt below the surface origin.
/// The pan that moves or resizes the box being edited. Fails at touch-down when the touch is not on its bar or handle
/// (`accepts`), so it never competes with the page's own scrolling.
final class BoxDragRecognizer: UIPanGestureRecognizer {
    var accepts: ((UITouch) -> Bool)?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if let accepts, let touch = touches.first, !accepts(touch) {
            state = .failed
            return
        }
        super.touchesBegan(touches, with: event)
    }
}

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
    /// The ink layers keep their places (highlighters at the back, pens in front of the boxes) when a box is brought forward.
    var onReorder: (() -> Void)?

    override func bringSubviewToFront(_ view: UIView) {
        super.bringSubviewToFront(view)
        onReorder?()
    }

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

// MARK: Dropping pictures and files

/// Pictures and files dropped on a box (Photos, Files, another app, split view): uploaded and inserted at the drop point.
extension PageScrollView: UIDropInteractionDelegate {
    func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
        host != nil && session.items.contains { PlatformMedia.wants($0.itemProvider) }
    }

    func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: UIDropSession) -> UIDropProposal {
        let p = session.location(in: surface)
        return UIDropProposal(operation: box(at: p) != nil || editing != nil ? .copy : .cancel)
    }

    func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
        let p = session.location(in: surface)
        guard let target = box(at: p) ?? editing else { return }
        let providers = session.items.map(\.itemProvider).filter(PlatformMedia.wants)
        guard !providers.isEmpty else { return }
        let local = target.convert(p, from: surface)
        beginEditing(target, at: target.bounds.contains(local) ? local : nil) {
            PlatformMedia.load(providers) { MediaHub.shared.upload($0, into: target) }
        }
    }
}

/// The page title's text view: Return goes to the first box, a pasted line break is flattened, the end of editing saves the title.
final class TitleFieldDelegate: NSObject, UITextViewDelegate {
    weak var owner: PageScrollView?

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        if text == "\n" {
            owner?.titleReturned()
            return false
        }
        if text.contains("\n") {
            let flat = text.replacingOccurrences(of: "\n", with: " ")
            textView.textStorage.replaceCharacters(in: range, with: NSAttributedString(string: flat, attributes: textView.typingAttributes))
            owner?.titleChanged()
            return false
        }
        return true
    }

    func textViewDidChange(_ textView: UITextView) { owner?.titleChanged() }
    func textViewDidEndEditing(_ textView: UITextView) { owner?.titleEnded() }
}

// MARK: Context menu of a box

extension PageScrollView: UIContextMenuInteractionDelegate {
    /// Long-press (or right-click) on a box that is not being edited: Copy, Cut, Duplicate, Paste, Delete.
    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard host != nil, !InkTool.shared.inking else { return nil }
        let p = interaction.location(in: surface)
        if let editing, editing.frame.contains(p) { return nil }
        let views = surface.subviews.reversed().compactMap { $0 as? BoxTextView }
        guard let view = views.first(where: { $0 !== editing && $0.frame.insetBy(dx: 0, dy: -26).contains(p) }) else { return nil }
        select(view.boxId)
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            guard let self else { return nil }
            var items: [UIAction] = [
                UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc")) { _ in self.copy(nil) },
                UIAction(title: "Cut", image: UIImage(systemName: "scissors")) { _ in self.cut(nil) },
                UIAction(title: "Duplicate", image: UIImage(systemName: "plus.square.on.square")) { _ in self.duplicateSelected() },
            ]
            if BoxClipboard.canPaste {
                items.append(UIAction(title: "Paste", image: UIImage(systemName: "doc.on.clipboard")) { _ in self.paste(nil) })
            }
            items.append(UIAction(title: "Delete", image: UIImage(systemName: "trash"), attributes: .destructive) { _ in self.deleteSelected() })
            return UIMenu(children: items)
        }
    }
}

// MARK: Print and Save as PDF

extension PageScrollView {
    /// The canvas on screen now (the page being shown), for Print and Save as PDF.
    static weak var current: PageScrollView?

    /// The page as a PDF: the canvas (title, boxes, ink) laid on pages 612 × 792 pt with 36 pt margins, scaled down to the page's
    /// width and cut into pages. White paper; with the page colour (or in the dark theme, so the text can be read) on its colour.
    func pdfData(colour: Bool) -> Data? {
        stopEditing()
        _ = titleField.resignFirstResponder()
        let content = surface.bounds
        guard content.width > 1, content.height > 1 else { return nil }
        let page = CGRect(x: 0, y: 0, width: 612, height: 792)
        let inner = page.insetBy(dx: 36, dy: 36)
        let scale = min(1, inner.width / content.width)
        let span = inner.height / scale
        let pages = max(1, Int(ceil(content.height / span)))
        let fill: UIColor? = (colour || palette.isDark) ? palette.bg : nil
        // "Add icon" is an editing hint, not part of the page.
        let hideAdd = !addIcon.isHidden && (icon ?? "").isEmpty
        if hideAdd { addIcon.isHidden = true }
        defer { if hideAdd { addIcon.isHidden = false } }
        return UIGraphicsPDFRenderer(bounds: page).pdfData { ctx in
            for i in 0..<pages {
                ctx.beginPage()
                let cg = ctx.cgContext
                if let fill {
                    fill.setFill()
                    cg.fill(page)
                }
                cg.saveGState()
                cg.clip(to: inner)
                cg.translateBy(x: inner.minX, y: inner.minY)
                cg.scaleBy(x: scale, y: scale)
                cg.translateBy(x: 0, y: -CGFloat(i) * span)
                surface.layer.render(in: cg)
                cg.restoreGState()
            }
        }
    }
}

/// Print and Save as PDF of the page on screen (the page menu and the ribbon).
enum PagePrinter {
    /// The print sheet (AirPrint) for the page. False: no page to print.
    @discardableResult
    static func print(title: String, colour: Bool) -> Bool {
        guard let data = PageScrollView.current?.pdfData(colour: colour) else { return false }
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .general
        info.jobName = title.isEmpty ? "Untitled" : title
        let controller = UIPrintInteractionController.shared
        controller.printInfo = info
        controller.printingItem = data
        guard let top = FileExport.topViewController() else { return false }
        // On the iPad the print sheet is a popover: anchor it in the middle of the screen.
        controller.present(from: CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1), in: top.view, animated: true, completionHandler: nil)
        return true
    }

    /// A PDF of the page to the share sheet (Save to Files, AirDrop, Mail …).
    @discardableResult
    static func savePDF(title: String, colour: Bool) -> Bool {
        guard let data = PageScrollView.current?.pdfData(colour: colour) else { return false }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(FileExport.fileName(title, ext: "pdf"))
        do { try data.write(to: url, options: .atomic) } catch { return false }
        FileExport.share(file: url)
        return true
    }
}
