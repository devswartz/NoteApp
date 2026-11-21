import Foundation
import NotiveloCore
#if canImport(UIKit)
import UIKit
typealias PlatformFont = UIFont
typealias PlatformColor = UIColor
#else
import AppKit
typealias PlatformFont = NSFont
typealias PlatformColor = NSColor
#endif

/// Turns a box's nodes into one attributed string, read-only, for TextKit 2. Covers every block
/// and mark in the page-format corpus; exact spacing, rule-line snapping, tables as grids and
/// images come with the native editor (M4).
struct PageTextRenderer {
    var bodySize: CGFloat = 16
    var tasks: [String: TaskLine] = [:]

    private struct Context {
        var indent = 0
        var marker: String?
        var quote = false
        var code = false
    }

    func render(_ nodes: [PageNode]) -> NSAttributedString {
        let out = NSMutableAttributedString()
        blocks(nodes, Context(), out)
        if out.string.hasSuffix("\n") { out.deleteCharacters(in: NSRange(location: out.length - 1, length: 1)) }
        return out
    }

    // MARK: Blocks

    private func blocks(_ nodes: [PageNode], _ ctx: Context, _ out: NSMutableAttributedString) {
        for (i, node) in nodes.enumerated() {
            var c = ctx
            if i > 0 { c.marker = nil } // a list item's marker goes on its first block only
            block(node, c, out)
        }
    }

    private func block(_ node: PageNode, _ ctx: Context, _ out: NSMutableAttributedString) {
        guard case let .element(type, attrs, content) = node else {
            if case .text = node { paragraph(inline([node], size: bodySize), ctx, out) }
            return
        }
        var inner = ctx
        inner.marker = nil
        switch type {
        case "paragraph", "detailsSummary":
            paragraph(inline(content, size: bodySize, prefix: type == "detailsSummary" ? "▾ " : ""), ctx, out)
        case "heading":
            let level = attrs["level"] as? Int ?? 1
            let size: CGFloat = [1: 26, 2: 21, 3: 18][level] ?? bodySize
            paragraph(inline(content, size: size, bold: true), ctx, out, spacingBefore: 6)
        case "codeBlock":
            var c = ctx
            c.code = true
            paragraph(inline(content, size: bodySize - 2, monospaced: true), c, out)
        case "bulletList":
            for item in content { block(item, with(ctx, marker: "•"), out) }
        case "orderedList":
            let start = attrs["start"] as? Int ?? 1
            let listType = attrs["type"] as? String
            let suffix = (attrs["paren"] as? Bool ?? false) ? ")" : "."
            for (i, item) in content.enumerated() {
                block(item, with(ctx, marker: listMarker(listType: listType, n: Int64(start + i)) + suffix), out)
            }
        case "taskList":
            for item in content {
                var checked = false
                if case let .element(_, a, _) = item { checked = a["checked"] as? Bool ?? false }
                block(item, with(ctx, marker: checked ? "☑" : "☐"), out)
            }
        case "listItem", "taskItem":
            var c = ctx
            c.indent += 1
            blocks(content, c, out)
        case "taskRef":
            taskRef(id: attrs["taskId"] as? String ?? "", notes: content, ctx, out)
        case "blockquote", "callout":
            var c = inner
            c.indent += 1
            c.quote = true
            if type == "callout", let emoji = attrs["emoji"] as? String, !emoji.isEmpty { c.marker = emoji }
            blocks(content, c, out)
        case "details", "detailsContent", "table":
            var c = inner
            if type == "detailsContent" { c.indent += 1 }
            blocks(content, c, out)
        case "tableRow":
            paragraph(tableRow(content), ctx, out)
        case "horizontalRule":
            paragraph(NSAttributedString(string: String(repeating: "─", count: 24),
                                         attributes: [.font: font(bodySize), .foregroundColor: secondaryColor]), ctx, out)
        case "image":
            let alt = attrs["alt"] as? String ?? ""
            paragraph(placeholder("🖼 " + (alt.isEmpty ? "Image" : alt)), ctx, out)
        case "fileAttachment":
            paragraph(placeholder("📎 " + (attrs["name"] as? String ?? "File")), ctx, out)
        default:
            paragraph(placeholder("[\(type)]"), ctx, out)
        }
    }

    private func tableRow(_ cells: [PageNode]) -> NSAttributedString {
        let row = NSMutableAttributedString()
        for (i, cell) in cells.enumerated() {
            if i > 0 { row.append(NSAttributedString(string: "  │  ", attributes: [.font: font(bodySize), .foregroundColor: secondaryColor])) }
            guard case let .element(cellType, _, blocks) = cell else { continue }
            for (j, block) in blocks.enumerated() {
                guard case let .element(_, _, inlineContent) = block else { continue }
                if j > 0 { row.append(NSAttributedString(string: " ")) }
                row.append(inline(inlineContent, size: bodySize, bold: cellType == "tableHeader"))
            }
        }
        return row
    }

    private func taskRef(id: String, notes: [PageNode], _ ctx: Context, _ out: NSMutableAttributedString) {
        var c = ctx
        c.marker = nil
        switch tasks[id] {
        case .hidden:
            return
        case let .shown(title, done, due):
            let line = NSMutableAttributedString(string: title, attributes: [
                .font: font(bodySize), .foregroundColor: done ? secondaryColor : textColor,
            ])
            if done {
                line.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: NSRange(location: 0, length: line.length))
            }
            if let due {
                line.append(NSAttributedString(string: "  \(due)", attributes: [.font: font(bodySize - 3), .foregroundColor: PlatformColor.systemBlue]))
            }
            // Like a list item: the circle hangs in this level's indent, notes go one level in.
            c.indent += 1
            paragraph(line, with(c, marker: done ? "✓" : "◯"), out)
            blocks(notes, c, out)
        case nil:
            // A task nobody can see here: its notes only, as the Markdown export does.
            blocks(notes, c, out)
        }
    }

    // MARK: Paragraphs

    private func with(_ ctx: Context, marker: String) -> Context {
        var c = ctx
        c.marker = marker
        return c
    }

    private func paragraph(_ text: NSAttributedString, _ ctx: Context, _ out: NSMutableAttributedString, spacingBefore: CGFloat = 0) {
        let step: CGFloat = 24
        let style = NSMutableParagraphStyle()
        style.paragraphSpacingBefore = spacingBefore
        style.paragraphSpacing = 4
        style.lineHeightMultiple = 1.15
        let line = NSMutableAttributedString()
        if let marker = ctx.marker {
            // The marker hangs in the indent; the text starts at the next tab stop.
            let head = CGFloat(max(ctx.indent - 1, 0)) * step
            style.firstLineHeadIndent = head
            style.headIndent = head + step
            style.tabStops = [NSTextTab(textAlignment: .left, location: head + step)]
            line.append(NSAttributedString(string: marker + "\t", attributes: [.font: font(bodySize), .foregroundColor: secondaryColor]))
        } else {
            style.firstLineHeadIndent = CGFloat(ctx.indent) * step
            style.headIndent = CGFloat(ctx.indent) * step
        }
        line.append(text)
        if line.length == 0 { line.append(NSAttributedString(string: " ", attributes: [.font: font(bodySize)])) }
        line.append(NSAttributedString(string: "\n", attributes: [.font: font(bodySize)]))
        let all = NSRange(location: 0, length: line.length)
        line.addAttribute(.paragraphStyle, value: style, range: all)
        if ctx.quote { line.addAttribute(.foregroundColor, value: secondaryColor, range: all) }
        if ctx.code { line.addAttribute(.backgroundColor, value: PlatformColor.gray.withAlphaComponent(0.12), range: all) }
        out.append(line)
    }

    private func placeholder(_ s: String) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [.font: font(bodySize - 1), .foregroundColor: secondaryColor])
    }

    // MARK: Inline

    private func inline(_ content: [PageNode], size: CGFloat, bold: Bool = false, monospaced: Bool = false, prefix: String = "") -> NSAttributedString {
        let out = NSMutableAttributedString(string: prefix, attributes: [.font: font(size, bold: bold), .foregroundColor: secondaryColor])
        for node in content {
            switch node {
            case let .text(runs):
                for run in runs { out.append(textRun(run, size: size, bold: bold, monospaced: monospaced)) }
            case .element("hardBreak", _, _):
                out.append(NSAttributedString(string: "\u{2028}", attributes: [.font: font(size)]))
            case let .element("mention", attrs, _):
                let label = attrs["label"] as? String ?? ""
                out.append(NSAttributedString(string: "@" + (label.isEmpty ? "someone" : label),
                                              attributes: [.font: font(size, bold: true), .foregroundColor: PlatformColor.systemBlue]))
            case let .element("pageLink", attrs, _):
                out.append(NSAttributedString(string: "↗ " + (attrs["pageId"] as? String ?? "page"),
                                              attributes: [.font: font(size), .foregroundColor: PlatformColor.systemBlue]))
            case let .element(_, _, children):
                out.append(inline(children, size: size, bold: bold, monospaced: monospaced))
            case .other:
                break
            }
        }
        return out
    }

    private func textRun(_ run: PageNode.TextRun, size: CGFloat, bold: Bool, monospaced: Bool) -> NSAttributedString {
        let m = run.marks
        var attrs: [NSAttributedString.Key: Any] = [
            .font: font(size, bold: bold || m["bold"] != nil, italic: m["italic"] != nil, monospaced: monospaced || m["code"] != nil),
            .foregroundColor: textColor,
        ]
        if m["underline"] != nil { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if m["strike"] != nil { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if let style = m["textStyle"] as? [String: Any], let name = style["color"] as? String, let color = Self.palette[name] {
            attrs[.foregroundColor] = color
        }
        if let hl = m["highlight"] as? [String: Any] {
            attrs[.backgroundColor] = (Self.palette[hl["color"] as? String ?? "yellow"] ?? PlatformColor.systemYellow).withAlphaComponent(0.3)
        }
        if let link = m["link"] as? [String: Any], let href = link["href"] as? String, let url = URL(string: href),
           ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            attrs[.link] = url
        }
        if m.keys.contains(where: { $0.hasPrefix("comment--") }) {
            attrs[.backgroundColor] = PlatformColor.systemOrange.withAlphaComponent(0.18)
        }
        return NSAttributedString(string: run.insert, attributes: attrs)
    }

    // MARK: Style

    static let palette: [String: PlatformColor] = [
        "red": .systemRed, "orange": .systemOrange, "yellow": .systemYellow, "green": .systemGreen,
        "blue": .systemBlue, "purple": .systemPurple, "pink": .systemPink, "gray": .systemGray, "grey": .systemGray,
    ]

    private var textColor: PlatformColor {
        #if canImport(UIKit)
        .label
        #else
        .labelColor
        #endif
    }

    private var secondaryColor: PlatformColor {
        #if canImport(UIKit)
        .secondaryLabel
        #else
        .secondaryLabelColor
        #endif
    }

    private func font(_ size: CGFloat, bold: Bool = false, italic: Bool = false, monospaced: Bool = false) -> PlatformFont {
        let base: PlatformFont = monospaced
            ? .monospacedSystemFont(ofSize: size, weight: bold ? .semibold : .regular)
            : .systemFont(ofSize: size, weight: bold ? .semibold : .regular)
        guard italic else { return base }
        #if canImport(UIKit)
        guard let d = base.fontDescriptor.withSymbolicTraits(base.fontDescriptor.symbolicTraits.union(.traitItalic)) else { return base }
        return UIFont(descriptor: d, size: size)
        #else
        let d = base.fontDescriptor.withSymbolicTraits(base.fontDescriptor.symbolicTraits.union(.italic))
        return NSFont(descriptor: d, size: size) ?? base
        #endif
    }
}
