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

/// Turns a box's content (the core's typed `ContentNode`s) into one attributed string, read-only,
/// for TextKit 2. Covers every block and mark in the page-format corpus; exact spacing,
/// rule-line snapping, tables as grids and images come with the native editor.
struct PageTextRenderer {
    var bodySize: CGFloat = 16
    var tasks: [String: TaskLine] = [:]
    /// Page id → title, for page links.
    var pageTitles: [String: String] = [:]

    private struct Context {
        var indent = 0
        var marker: String?
        var quote = false
        var code = false
    }

    func render(_ nodes: [ContentNode]) -> NSAttributedString {
        let out = NSMutableAttributedString()
        blocks(nodes, Context(), out)
        if out.string.hasSuffix("\n") { out.deleteCharacters(in: NSRange(location: out.length - 1, length: 1)) }
        return out
    }

    // MARK: Blocks

    private func blocks(_ nodes: [ContentNode], _ ctx: Context, _ out: NSMutableAttributedString) {
        for (i, node) in nodes.enumerated() {
            var c = ctx
            if i > 0 { c.marker = nil } // a list item's marker goes on its first block only
            block(node, c, out)
        }
    }

    private func block(_ node: ContentNode, _ ctx: Context, _ out: NSMutableAttributedString) {
        var inner = ctx
        inner.marker = nil
        let attrs = node.attrs
        let content = node.children
        switch node.kind {
        case .text, .mention, .pageLink, .hardBreak:
            paragraph(inline([node], size: bodySize), ctx, out)
        case .paragraph:
            paragraph(inline(content, size: bodySize), ctx, out)
        case .detailsSummary:
            paragraph(inline(content, size: bodySize, prefix: "▾ "), ctx, out)
        case .heading:
            let level = Int(attrs.number("level") ?? 1)
            let size: CGFloat = [1: 26, 2: 21, 3: 18][level] ?? bodySize
            paragraph(inline(content, size: size, bold: true), ctx, out, spacingBefore: 6)
        case .codeBlock:
            var c = ctx
            c.code = true
            paragraph(inline(content, size: bodySize - 2, monospaced: true), c, out)
        case .bulletList:
            for item in content { block(item, with(ctx, marker: "•"), out) }
        case .orderedList:
            // The core numbers the items as exports do ("1.", "b)", "iv."), continued lists included.
            for (i, item) in content.enumerated() {
                let marker = i < node.markers.count ? node.markers[i] : "\(i + 1)."
                block(item, with(ctx, marker: marker), out)
            }
        case .taskList:
            for item in content {
                let checked = item.attrs.bool("checked") ?? false
                block(item, with(ctx, marker: checked ? "☑" : "☐"), out)
            }
        case .listItem, .taskItem:
            var c = ctx
            c.indent += 1
            blocks(content, c, out)
        case .taskRef:
            taskRef(id: attrs.string("taskId") ?? "", notes: content, ctx, out)
        case .blockquote, .callout:
            var c = inner
            c.indent += 1
            c.quote = true
            if node.kind == .callout, let emoji = attrs.string("emoji"), !emoji.isEmpty { c.marker = emoji }
            blocks(content, c, out)
        case .details, .detailsContent, .table:
            var c = inner
            if node.kind == .detailsContent { c.indent += 1 }
            blocks(content, c, out)
        case .tableRow:
            paragraph(tableRow(content), ctx, out)
        case .tableCell, .tableHeader:
            blocks(content, inner, out)
        case .horizontalRule:
            paragraph(NSAttributedString(string: String(repeating: "─", count: 24),
                                         attributes: [.font: font(bodySize), .foregroundColor: secondaryColor]), ctx, out)
        case .image:
            let alt = attrs.string("alt") ?? ""
            paragraph(placeholder("🖼 " + (alt.isEmpty ? "Image" : alt)), ctx, out)
        case .fileAttachment:
            paragraph(placeholder("📎 " + (attrs.string("name") ?? "File")), ctx, out)
        case .unknown:
            // Written by a newer app: show what is inside, or say an update is needed.
            if content.isEmpty {
                paragraph(placeholder("Update Notivelo to see this."), ctx, out)
            } else {
                blocks(content, inner, out)
            }
        }
    }

    private func tableRow(_ cells: [ContentNode]) -> NSAttributedString {
        let row = NSMutableAttributedString()
        for (i, cell) in cells.enumerated() {
            if i > 0 { row.append(NSAttributedString(string: "  │  ", attributes: [.font: font(bodySize), .foregroundColor: secondaryColor])) }
            for (j, block) in cell.children.enumerated() {
                if j > 0 { row.append(NSAttributedString(string: " ")) }
                row.append(inline(block.children, size: bodySize, bold: cell.kind == .tableHeader))
            }
        }
        return row
    }

    private func taskRef(id: String, notes: [ContentNode], _ ctx: Context, _ out: NSMutableAttributedString) {
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

    private func inline(_ content: [ContentNode], size: CGFloat, bold: Bool = false, monospaced: Bool = false, prefix: String = "") -> NSAttributedString {
        let out = NSMutableAttributedString(string: prefix, attributes: [.font: font(size, bold: bold), .foregroundColor: secondaryColor])
        for node in content {
            switch node.kind {
            case .text:
                for run in node.runs { out.append(textRun(run, size: size, bold: bold, monospaced: monospaced)) }
            case .hardBreak:
                out.append(NSAttributedString(string: "\u{2028}", attributes: [.font: font(size)]))
            case .mention:
                let label = node.attrs.string("label") ?? ""
                out.append(NSAttributedString(string: "@" + (label.isEmpty ? "someone" : label),
                                              attributes: [.font: font(size, bold: true), .foregroundColor: PlatformColor.systemBlue]))
            case .pageLink:
                let id = node.attrs.string("pageId") ?? ""
                out.append(NSAttributedString(string: "↗ " + (pageTitles[id] ?? "Page"),
                                              attributes: [.font: font(size), .foregroundColor: PlatformColor.systemBlue]))
            default:
                out.append(inline(node.children, size: size, bold: bold, monospaced: monospaced))
            }
        }
        return out
    }

    private func textRun(_ run: TextRun, size: CGFloat, bold: Bool, monospaced: Bool) -> NSAttributedString {
        var isBold = bold
        var italic = false
        var code = monospaced
        var attrs: [NSAttributedString.Key: Any] = [.foregroundColor: textColor]
        for mark in run.marks {
            switch mark {
            case .bold: isBold = true
            case .italic: italic = true
            case .code: code = true
            case .underline: attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            case .strike: attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            case let .textColor(color):
                if let c = Self.palette[color] { attrs[.foregroundColor] = c }
            case let .highlight(color):
                attrs[.backgroundColor] = (Self.palette[color ?? "yellow"] ?? PlatformColor.systemYellow).withAlphaComponent(0.3)
            case let .link(href):
                if let url = URL(string: href), ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                    attrs[.link] = url
                }
            case .comment:
                if attrs[.backgroundColor] == nil { attrs[.backgroundColor] = PlatformColor.systemOrange.withAlphaComponent(0.18) }
            case .unknown:
                break
            }
        }
        attrs[.font] = font(size, bold: isBold, italic: italic, monospaced: code)
        return NSAttributedString(string: run.text, attributes: attrs)
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
