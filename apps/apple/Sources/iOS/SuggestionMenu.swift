import UIKit

/// The `/`, `[[` and `@` menus (SlashMenu.tsx, PageLink.tsx, collabMentions.ts; LOOK.md 4.7): a popover
/// next to the caret listing the engine's slash items, matching pages or people.
// MenuRow, MenuContent and MenuIcons live in Shared/Editor/MenuModels.swift.

final class SuggestionMenuView: UIView {
    var onPick: ((Int) -> Void)?
    private let scroll = UIScrollView()
    private var rowViews: [UIView] = []
    private var rowFrames: [CGRect] = []
    private var palette = Palette.light
    private var content: MenuContent?
    private(set) var contentSize = CGSize(width: 290, height: 60)

    override init(frame: CGRect) {
        super.init(frame: frame)
        scroll.showsVerticalScrollIndicator = false
        scroll.alwaysBounceVertical = false
        addSubview(scroll)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        addGestureRecognizer(tap)
        accessibilityIdentifier = "suggestion-menu"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func tapped(_ tap: UITapGestureRecognizer) {
        let p = tap.location(in: scroll)
        if let i = rowFrames.firstIndex(where: { $0.contains(p) }) { onPick?(i) }
    }

    /// Does `point` (this view's superview's coordinates) fall on the menu?
    func covers(_ point: CGPoint) -> Bool { !isHidden && frame.contains(point) }

    func show(_ c: MenuContent, palette p: Palette) {
        content = c
        palette = p
        rowViews.forEach { $0.removeFromSuperview() }
        rowViews = []
        rowFrames = []
        subviews.filter { $0 !== scroll }.forEach { $0.removeFromSuperview() }

        backgroundColor = p.bgElevated
        layer.cornerRadius = 12
        layer.borderWidth = 1
        layer.borderColor = p.border.cgColor
        layer.shadowColor = (p.isDark ? UIColor.black : UIColor(hex: 0x0F0F1E)).cgColor
        layer.shadowOpacity = p.isDark ? 0.55 : 0.18
        layer.shadowRadius = 16
        layer.shadowOffset = CGSize(width: 0, height: 12)

        let width: CGFloat = c.kind == .mention ? 300 : 290
        let inner = width - 12
        // Header (menu-label-row): the page link menu says "Link to page", the slash menu "Insert block".
        var y: CGFloat = 6
        let headerText: String? = c.kind == .slash ? "Insert block" : (c.kind == .page ? "Link to page" : nil)
        if let headerText {
            let h = UILabel()
            h.attributedText = NSAttributedString(string: headerText.uppercased(), attributes: [
                .font: WebType.ui(11, 600), .foregroundColor: p.textMuted, .kern: 0.44])
            h.frame = CGRect(x: 6 + 8, y: y + 4, width: inner - 16, height: 16)
            addSubview(h)
            y += 26
        }
        scroll.frame = CGRect(x: 0, y: y, width: width, height: 0)
        var cy: CGFloat = 0
        let gap: CGFloat = c.kind == .slash ? 3 : 1
        if c.rows.isEmpty {
            let l = UILabel()
            l.text = c.emptyText ?? ""
            l.font = WebType.ui(12.5)
            l.textColor = p.textMuted
            l.frame = CGRect(x: 6 + 10, y: 6, width: inner - 20, height: 20)
            scroll.addSubview(l)
            rowViews.append(l)
            cy = 32
        }
        for (i, row) in c.rows.enumerated() {
            let h: CGFloat = c.kind == .slash ? 48 : (c.kind == .page ? 36 : 30)
            let frame = CGRect(x: 6, y: cy, width: inner, height: h)
            let v = UIView(frame: frame)
            v.layer.cornerRadius = 7
            v.backgroundColor = i == c.highlighted ? p.bgHover : .clear
            let titleFont = WebType.ui(14, 500)
            switch c.kind {
            case .slash:
                let tile = UIView(frame: CGRect(x: 8, y: 6, width: 36, height: 36))
                tile.layer.cornerRadius = 8
                tile.layer.borderWidth = 1
                tile.layer.borderColor = p.border.cgColor
                tile.backgroundColor = p.bg
                if let icon = row.icon, let img = UIImage.lucide(MenuIcons.name(icon), size: 18, color: p.text2) {
                    let iv = UIImageView(image: img)
                    iv.frame = CGRect(x: 8, y: 8, width: 18, height: 18)
                    tile.addSubview(iv)
                }
                v.addSubview(tile)
                let t = UILabel(frame: CGRect(x: 54, y: 7, width: inner - 62, height: 19))
                t.text = row.title; t.font = titleFont; t.textColor = p.text
                v.addSubview(t)
                let d = UILabel(frame: CGRect(x: 54, y: 25, width: inner - 62, height: 16))
                d.text = row.detail; d.font = WebType.ui(12); d.textColor = p.textMuted
                v.addSubview(d)
            case .page:
                if let img = UIImage.lucide(row.icon ?? "file-text", size: 15, color: p.text2) {
                    let iv = UIImageView(image: img)
                    iv.frame = CGRect(x: 8 + 4.5, y: 10.5, width: 15, height: 15)
                    v.addSubview(iv)
                }
                let t = UILabel(frame: CGRect(x: 42, y: 3, width: inner - 50, height: 18))
                t.text = row.title; t.font = titleFont; t.textColor = p.text
                v.addSubview(t)
                let d = UILabel(frame: CGRect(x: 42, y: 19, width: inner - 50, height: 15))
                d.text = row.detail; d.font = WebType.ui(12); d.textColor = p.textMuted
                v.addSubview(d)
            case .mention:
                let dot = UIView(frame: CGRect(x: 10, y: 11, width: 8, height: 8))
                dot.layer.cornerRadius = 4
                dot.backgroundColor = row.dot ?? p.textMuted
                v.addSubview(dot)
                let t = UILabel(frame: CGRect(x: 26, y: 5, width: 110, height: 20))
                t.text = row.title; t.font = WebType.ui(14); t.textColor = p.text
                t.lineBreakMode = .byTruncatingTail
                v.addSubview(t)
                let d = UILabel(frame: CGRect(x: 140, y: 6, width: inner - 148, height: 18))
                d.text = row.detail; d.font = WebType.ui(12); d.textColor = p.textMuted
                d.lineBreakMode = .byTruncatingTail
                v.addSubview(d)
            }
            scroll.addSubview(v)
            rowViews.append(v)
            rowFrames.append(frame)
            cy += h + gap
        }
        cy += 6
        let maxHeight: CGFloat = 320 - y
        let listHeight = min(cy, maxHeight)
        scroll.frame = CGRect(x: 0, y: y, width: width, height: listHeight)
        scroll.contentSize = CGSize(width: width, height: cy)
        if let hi = c.highlighted, rowFrames.indices.contains(hi) {
            scroll.scrollRectToVisible(rowFrames[hi].insetBy(dx: 0, dy: -4), animated: false)
        }
        contentSize = CGSize(width: width, height: y + listHeight)
    }

    /// Put the menu 6 pt below `anchor` (above it when there is no room), kept inside `visible`
    /// (all in the coordinates of this view's superview).
    func place(anchor: CGRect, visible: CGRect) {
        let size = contentSize
        var x = anchor.minX
        x = min(x, visible.maxX - size.width - 8)
        x = max(x, visible.minX + 8)
        var y = anchor.maxY + 6
        if y + size.height > visible.maxY - 8 {
            y = max(visible.minY + 8, anchor.minY - 6 - size.height)
        }
        frame = CGRect(x: x, y: y, width: size.width, height: size.height)
    }
}
