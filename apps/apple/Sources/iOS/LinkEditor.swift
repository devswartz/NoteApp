import UIKit

/// Which addresses a tap may open: the web only follows http, https and mailto links.
enum LinkURL {
    static func openable(_ href: String) -> URL? {
        let trimmed = href.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme) else { return nil }
        return url
    }
}

/// A text field with the web's `.input` look: 34 high, padding 0 10, 1 pt `--border`, radius 8,
/// `--bg`; focused: accent border and a 3 pt `--accent-soft` ring.
private final class LinkField: UITextField {
    var onEscape: (() -> Void)?
    var ringColor = UIColor.clear
    private let ring = CALayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 8
        layer.borderWidth = 1
        ring.cornerRadius = 11
        ring.isHidden = true
        layer.addSublayer(ring)
        layer.masksToBounds = false
        autocapitalizationType = .none
        autocorrectionType = .no
        spellCheckingType = .no
        clearButtonMode = .never
        returnKeyType = .done
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func textRect(forBounds bounds: CGRect) -> CGRect { bounds.insetBy(dx: 10, dy: 0) }
    override func editingRect(forBounds bounds: CGRect) -> CGRect { bounds.insetBy(dx: 10, dy: 0) }
    override func placeholderRect(forBounds bounds: CGRect) -> CGRect { bounds.insetBy(dx: 10, dy: 0) }

    func setFocused(_ on: Bool, border: UIColor, accent: UIColor) {
        layer.borderColor = (on ? accent : border).cgColor
        ring.frame = bounds.insetBy(dx: -3, dy: -3)
        ring.borderWidth = 3
        ring.borderColor = ringColor.cgColor
        ring.isHidden = !on
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if presses.contains(where: { $0.key?.keyCode == .keyboardEscape }) {
            onEscape?()
            return
        }
        super.pressesBegan(presses, with: event)
    }
}

/// The link editor (LinkEditor.tsx; LOOK.md 4.9 popover): a card with two fields, "Text" and
/// "Address", and, when the selection is a link, Open link and Remove link buttons. Enter applies,
/// Escape or a tap elsewhere closes. `.link-editor`: padding 6, gap 4, 360 wide (screen − 16 at most),
/// labels 56 wide at 12 pt, 70 % opacity.
final class LinkEditorView: UIView, UITextFieldDelegate {
    /// Apply: the Text field and the Address field as typed (the engine normalises the address).
    var onApply: ((String, String) -> Void)?
    var onRemove: (() -> Void)?
    var onOpen: ((String) -> Void)?
    /// Escape: close without applying.
    var onCancel: (() -> Void)?

    private let textField = LinkField()
    private let addressField = LinkField()
    private var palette = Palette.light
    private var href = ""
    private(set) var size = CGSize(width: 360, height: 84)

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "link-editor"
        textField.accessibilityLabel = "Text to display"
        addressField.accessibilityLabel = "Address"
        for f in [textField, addressField] {
            f.delegate = self
            f.onEscape = { [weak self] in self?.onCancel?() }
            addSubview(f)
        }
        isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Does `point` (the superview's coordinates) fall on the editor?
    func covers(_ point: CGPoint) -> Bool { !isHidden && frame.contains(point) }

    var isShown: Bool { !isHidden }

    func present(palette p: Palette, text: String, address: String, maxWidth: CGFloat, phone: Bool) {
        palette = p
        href = address
        subviews.filter { $0 !== textField && $0 !== addressField }.forEach { $0.removeFromSuperview() }
        backgroundColor = p.bgElevated
        layer.cornerRadius = 12
        layer.borderWidth = 1
        layer.borderColor = p.border.cgColor
        layer.shadowColor = (p.isDark ? UIColor.black : UIColor(hex: 0x0F0F1E)).cgColor
        layer.shadowOpacity = p.isDark ? 0.55 : 0.18
        layer.shadowRadius = 16
        layer.shadowOffset = CGSize(width: 0, height: 12)

        let width = min(360, maxWidth)
        let fieldFont = WebType.ui(phone ? 16 : 14)
        let hasLink = !address.isEmpty
        let pad: CGFloat = 6, rowH: CGFloat = 34, gap: CGFloat = 4, label: CGFloat = 56

        func addLabel(_ title: String, row: Int) {
            let l = UILabel(frame: CGRect(x: pad, y: pad + CGFloat(row) * (rowH + gap), width: label, height: rowH))
            l.text = title
            l.font = WebType.ui(12)
            l.textColor = p.text.withAlphaComponent(0.7)
            l.isAccessibilityElement = false
            addSubview(l)
        }
        addLabel("Text", row: 0)
        addLabel("Address", row: 1)

        var addressRight = width - pad
        func addIcon(_ name: String, _ title: String, _ action: @escaping () -> Void) {
            let b = UIButton(type: .custom)
            b.setImage(UIImage.lucide(name, size: 15, color: p.text2), for: .normal)
            b.layer.cornerRadius = 8
            b.accessibilityLabel = title
            b.frame = CGRect(x: addressRight - 32, y: pad + rowH + gap + 1, width: 32, height: 32)
            b.addAction(UIAction { _ in action() }, for: .touchUpInside)
            addSubview(b)
            addressRight -= 32 + gap
        }
        if hasLink {
            addIcon("link-2-off", "Remove link") { [weak self] in self?.onRemove?() }
            addIcon("external-link", "Open link") { [weak self] in
                guard let self else { return }
                self.onOpen?(self.href)
            }
        }

        let fieldX = pad + label + gap
        for (f, row, value, ph, right) in [
            (textField, 0, text, "Text to display", width - pad),
            (addressField, 1, address, "Paste or type a link…", addressRight),
        ] as [(LinkField, Int, String, String, CGFloat)] {
            f.frame = CGRect(x: fieldX, y: pad + CGFloat(row) * (rowH + gap), width: right - fieldX, height: rowH)
            f.font = fieldFont
            f.textColor = p.text
            f.tintColor = p.accent
            f.backgroundColor = p.bg
            f.ringColor = p.accentSoft
            f.attributedPlaceholder = NSAttributedString(string: ph, attributes: [.font: fieldFont, .foregroundColor: p.textPlaceholder])
            f.text = value
            f.keyboardType = row == 1 ? .URL : .default
            f.setFocused(false, border: p.border, accent: p.accent)
        }
        size = CGSize(width: width, height: pad * 2 + rowH * 2 + gap)
        bounds = CGRect(origin: .zero, size: size)
        isHidden = false
    }

    /// An existing link or selected text: straight to the address; a new link with nothing
    /// selected: its text first (LinkEditor.tsx).
    func focusFirst() {
        let target = (!href.isEmpty || !(textField.text ?? "").isEmpty) ? addressField : textField
        target.becomeFirstResponder()
        target.selectAll(nil)
    }

    func dismiss() {
        textField.resignFirstResponder()
        addressField.resignFirstResponder()
        isHidden = true
    }

    func textFieldDidBeginEditing(_ f: UITextField) {
        (f as? LinkField)?.setFocused(true, border: palette.border, accent: palette.accent)
    }

    func textFieldDidEndEditing(_ f: UITextField) {
        (f as? LinkField)?.setFocused(false, border: palette.border, accent: palette.accent)
    }

    func textFieldShouldReturn(_ f: UITextField) -> Bool {
        onApply?(textField.text ?? "", addressField.text ?? "")
        return false
    }
}
