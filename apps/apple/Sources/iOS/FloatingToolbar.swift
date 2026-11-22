import UIKit

/// The floating formatting toolbar over a text selection (FormattingMenu in src/editor/NoteEditor.tsx;
/// LOOK.md 4.6): Heading 1-3, Quote | Bold, Italic, Underline, Strikethrough, Code, Link, Text colour,
/// Highlight | Task, Comment. Padding 3, gap 1, `--bg-elevated`, 1 pt border, radius 10, buttons 30x30.
/// Buttons run the same engine commands as the ribbon (`EditorFocus.run`).
final class FloatingToolbarView: UIView {
    /// An engine command: name and arguments.
    var onCommand: ((String, [String: Any]) -> Void)?
    /// The Link button: the canvas shows the link editor.
    var onLink: (() -> Void)?
    /// The Comment button: the canvas marks the selection and asks for the comment in the panel.
    var onComment: (() -> Void)?
    private var palette = Palette.light
    private let swatches = UIView()
    private let bar = UIView()
    private var swatchKind: String?
    private var buttons: [(UIButton, CGFloat)] = []
    private(set) var barSize = CGSize.zero
    /// The widest the bar may be (phones: 100 vw - 16); buttons wrap onto a second row beyond it.
    private var limit: CGFloat = .greatestFiniteMagnitude

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "floating-toolbar"
        addSubview(bar)
        addSubview(swatches)
        swatches.isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Does `point` (the superview's coordinates) fall on the toolbar or its colour popover?
    func covers(_ point: CGPoint) -> Bool { !isHidden && frame.contains(point) }

    func build(palette p: Palette, maxWidth: CGFloat = .greatestFiniteMagnitude) {
        guard p.bg != palette.bg || buttons.isEmpty || p.isDark != palette.isDark || maxWidth != limit else { return }
        palette = p
        limit = maxWidth
        bar.subviews.forEach { $0.removeFromSuperview() }
        buttons = []
        var x: CGFloat = 3
        var y: CGFloat = 3
        var right: CGFloat = 0
        let h: CGFloat = 30
        func gap() { x += 1 }
        func wrap(_ w: CGFloat) {
            if x > 3 && x + w + 3 > maxWidth { right = max(right, x); x = 3; y += h + 1 }
        }
        func icon(_ name: String, _ label: String, _ action: @escaping () -> Void) {
            let b = UIButton(type: .custom)
            b.setImage(UIImage.lucide(name, size: 16, color: p.text2), for: .normal)
            b.layer.cornerRadius = 6
            b.accessibilityLabel = label
            wrap(30)
            b.frame = CGRect(x: x, y: y, width: 30, height: h)
            b.addAction(UIAction { _ in action() }, for: .touchUpInside)
            bar.addSubview(b)
            buttons.append((b, x))
            x += 30
            gap()
        }
        func word(_ name: String, _ text: String, _ action: @escaping () -> Void) {
            let b = UIButton(type: .custom)
            let font = WebType.ui(13, 500)
            let w = ceil((text as NSString).size(withAttributes: [.font: font]).width)
            let width = 8 + 16 + 4 + w + 8
            b.setImage(UIImage.lucide(name, size: 16, color: p.text2), for: .normal)
            b.setAttributedTitle(NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: p.text2]), for: .normal)
            b.imageEdgeInsets = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 4)
            b.titleEdgeInsets = UIEdgeInsets(top: 0, left: 4, bottom: 0, right: 0)
            b.layer.cornerRadius = 6
            b.accessibilityLabel = text
            wrap(width)
            b.frame = CGRect(x: x, y: y, width: width, height: h)
            b.addAction(UIAction { _ in action() }, for: .touchUpInside)
            bar.addSubview(b)
            buttons.append((b, x))
            x += width
            gap()
        }
        func separator() {
            wrap(8)
            if x == 3 { return }
            x += 3
            let s = UIView(frame: CGRect(x: x, y: y + 6, width: 1, height: 18))
            s.backgroundColor = p.border
            bar.addSubview(s)
            x += 1 + 3
            gap()
        }
        icon("heading-1", "Heading 1") { [weak self] in self?.run("setHeading", ["level": 1]) }
        icon("heading-2", "Heading 2") { [weak self] in self?.run("setHeading", ["level": 2]) }
        icon("heading-3", "Heading 3") { [weak self] in self?.run("setHeading", ["level": 3]) }
        icon("quote", "Quote") { [weak self] in self?.run("toggleQuote") }
        separator()
        icon("letter-b", "Bold") { [weak self] in self?.run("toggleMark", ["mark": "bold"]) }
        icon("italic", "Italic") { [weak self] in self?.run("toggleMark", ["mark": "italic"]) }
        icon("underline", "Underline") { [weak self] in self?.run("toggleMark", ["mark": "underline"]) }
        icon("strikethrough", "Strikethrough") { [weak self] in self?.run("toggleMark", ["mark": "strike"]) }
        icon("code-xml", "Code") { [weak self] in self?.run("toggleMark", ["mark": "code"]) }
        icon("link-2", "Link") { [weak self] in self?.onLink?() }
        icon("baseline", "Text colour") { [weak self] in self?.toggleSwatches("color") }
        icon("highlighter", "Highlight") { [weak self] in self?.toggleSwatches("highlight") }
        separator()
        word("circle-check", "Task") { [weak self] in self?.run("convertToTask") }
        word("message-square", "Comment") { [weak self] in self?.onComment?() }
        x += 2
        right = max(right, x)
        barSize = CGSize(width: y > 3 ? min(maxWidth, right + 1) : right, height: y + h + 3)
        bar.backgroundColor = p.bgElevated
        bar.layer.cornerRadius = 10
        bar.layer.borderWidth = 1
        bar.layer.borderColor = p.border.cgColor
        bar.layer.shadowColor = (p.isDark ? UIColor.black : UIColor(hex: 0x0F0F1E)).cgColor
        bar.layer.shadowOpacity = p.isDark ? 0.55 : 0.2
        bar.layer.shadowRadius = 20
        bar.layer.shadowOffset = CGSize(width: 0, height: 12)
        bar.layer.masksToBounds = false
        bar.frame = CGRect(origin: .zero, size: barSize)
        frame.size = barSize
        swatches.isHidden = true
        swatchKind = nil
    }

    private func run(_ name: String, _ args: [String: Any] = [:]) {
        onCommand?(name, args)
    }

    /// The colour grid (the ribbon's colour menus): a card under the toolbar.
    private func toggleSwatches(_ kind: String) {
        if swatchKind == kind {
            swatches.isHidden = true
            swatchKind = nil
            frame.size = barSize
            return
        }
        swatchKind = kind
        swatches.subviews.forEach { $0.removeFromSuperview() }
        let p = palette
        let names: [String?] = [nil] + Palette.colorNames.map { Optional($0) }
        let card = CGRect(x: 0, y: barSize.height + 6, width: 120, height: 4 + 18 + 3 * 36 + 4)
        swatches.frame = card
        swatches.backgroundColor = p.bgElevated
        swatches.layer.cornerRadius = 10
        swatches.layer.borderWidth = 1
        swatches.layer.borderColor = p.border.cgColor
        swatches.layer.shadowColor = (p.isDark ? UIColor.black : UIColor(hex: 0x0F0F1E)).cgColor
        swatches.layer.shadowOpacity = 0.2
        swatches.layer.shadowRadius = 12
        swatches.layer.shadowOffset = CGSize(width: 0, height: 8)
        let title = UILabel(frame: CGRect(x: 8, y: 6, width: 100, height: 16))
        title.text = kind == "color" ? "Text colour" : "Highlight"
        title.font = WebType.ui(12, 500)
        title.textColor = p.textMuted
        swatches.addSubview(title)
        for (i, name) in names.enumerated() {
            let b = UIButton(type: .custom)
            b.frame = CGRect(x: 8 + CGFloat(i % 3) * 36, y: 26 + CGFloat(i / 3) * 36, width: 32, height: 32)
            b.layer.cornerRadius = 7
            b.layer.borderWidth = 1
            b.layer.borderColor = p.border.cgColor
            if kind == "highlight", name != nil {
                b.backgroundColor = p.highlight(name)
            } else {
                b.backgroundColor = p.bgElevated
                if kind == "color" {
                    b.setAttributedTitle(NSAttributedString(string: "A", attributes: [
                        .font: WebType.ui(15, 600), .foregroundColor: name.flatMap { p.textColor($0) } ?? p.text]), for: .normal)
                } else if let img = UIImage.lucide("minus", size: 16, color: p.textMuted) {
                    b.setImage(img, for: .normal)
                }
            }
            b.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                if kind == "color" {
                    if let name { self.run("setColor", ["color": name]) } else { self.run("unsetColor") }
                } else if let name {
                    self.run("setHighlight", ["color": name])
                } else {
                    self.run("unsetHighlight")
                }
                self.toggleSwatches(kind)
            }, for: .touchUpInside)
            swatches.addSubview(b)
        }
        swatches.isHidden = false
        frame.size = CGSize(width: barSize.width, height: card.maxY)
    }

    /// Placed over `selection` (the scroll view's coordinates): centred on it, 8 pt above, kept inside
    /// `visible`; below the selection when there's no room above.
    func place(over selection: CGRect, visible: CGRect) {
        let w = barSize.width
        var x = selection.midX - w / 2
        x = min(max(x, visible.minX + 8), max(visible.maxX - w - 8, visible.minX + 8))
        var y = selection.minY - 8 - barSize.height
        var below = false
        if y < visible.minY + 8 {
            y = selection.maxY + 40
            below = true
        }
        _ = below
        frame = CGRect(x: x, y: y, width: w, height: bounds.height)
    }

    func hide() {
        isHidden = true
        swatches.isHidden = true
        swatchKind = nil
        bar.frame = CGRect(origin: .zero, size: barSize)
        frame.size = barSize
    }
}
