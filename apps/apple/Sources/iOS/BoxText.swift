import NotiveloCore
import UIKit

/// A box's tree in one shape for drawing, read from the core's typed content (boxes not open in
/// the engine) or from an editor session's ProseMirror JSON (`EditorState.docJson`).
struct BoxNode {
    var type: String
    var attrs: [String: Any] = [:]
    var text = ""
    var marks: [BoxMark] = []
    var content: [BoxNode] = []
    /// Ordered lists read from the page: each item's marker from the core (continued numbering applied).
    var markers: [String]?

    /// Nodes whose content is inline: one line each in the view's text (EDITOR.md 10.1).
    static let textblocks: Set<String> = ["paragraph", "heading", "codeBlock", "detailsSummary"]
    /// Blocks without text of their own: one U+FFFC line each.
    static let leafBlocks: Set<String> = ["horizontalRule", "image", "fileAttachment"]

    func string(_ name: String) -> String? { attrs[name] as? String }
    func number(_ name: String) -> Double? {
        if let n = attrs[name] as? NSNumber { return n.doubleValue }
        return (attrs[name] as? String).flatMap(Double.init)
    }
    func bool(_ name: String) -> Bool? { attrs[name] as? Bool }

    // MARK: From the engine's JSON

    static func document(json: String) -> BoxNode? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return jsonNode(object)
    }

    private static func jsonNode(_ o: [String: Any]) -> BoxNode {
        var n = BoxNode(type: o["type"] as? String ?? "unknown")
        n.attrs = o["attrs"] as? [String: Any] ?? [:]
        n.text = o["text"] as? String ?? ""
        n.marks = (o["marks"] as? [[String: Any]] ?? []).map {
            BoxMark(type: $0["type"] as? String ?? "", attrs: $0["attrs"] as? [String: Any] ?? [:])
        }
        n.content = (o["content"] as? [[String: Any]] ?? []).map(jsonNode)
        return n
    }

    // MARK: From the core's typed content

    static func document(content: [ContentNode]) -> BoxNode {
        BoxNode(type: "doc", content: content.flatMap(contentNode))
    }

    private static func contentNode(_ c: ContentNode) -> [BoxNode] {
        if c.kind == .text {
            return c.runs.map { BoxNode(type: "text", text: $0.text, marks: $0.marks.map(mark)) }
        }
        var n = BoxNode(type: name(c.kind))
        for a in c.attrs {
            switch a.value {
            case .null: n.attrs[a.name] = NSNull()
            case let .bool(v): n.attrs[a.name] = v
            case let .number(v): n.attrs[a.name] = v
            case let .text(v): n.attrs[a.name] = v
            case let .json(v): n.attrs[a.name] = v
            }
        }
        n.content = c.children.flatMap(contentNode)
        if c.kind == .orderedList { n.markers = c.markers }
        return [n]
    }

    private static func mark(_ m: Mark) -> BoxMark {
        switch m {
        case .bold: return BoxMark(type: "bold")
        case .italic: return BoxMark(type: "italic")
        case .underline: return BoxMark(type: "underline")
        case .strike: return BoxMark(type: "strike")
        case .code: return BoxMark(type: "code")
        case let .link(href): return BoxMark(type: "link", attrs: ["href": href])
        case let .textColor(color): return BoxMark(type: "textStyle", attrs: ["color": color])
        case let .highlight(color): return BoxMark(type: "highlight", attrs: color.map { ["color": $0] as [String: Any] } ?? [:])
        case let .comment(threadId): return BoxMark(type: "comment", attrs: ["threadId": threadId])
        case let .unknown(name): return BoxMark(type: name)
        }
    }

    private static func name(_ kind: NodeKind) -> String {
        switch kind {
        case .text: return "text"
        case .paragraph: return "paragraph"
        case .heading: return "heading"
        case .blockquote: return "blockquote"
        case .codeBlock: return "codeBlock"
        case .horizontalRule: return "horizontalRule"
        case .hardBreak: return "hardBreak"
        case .bulletList: return "bulletList"
        case .orderedList: return "orderedList"
        case .listItem: return "listItem"
        case .taskList: return "taskList"
        case .taskItem: return "taskItem"
        case .taskRef: return "taskRef"
        case .callout: return "callout"
        case .details: return "details"
        case .detailsSummary: return "detailsSummary"
        case .detailsContent: return "detailsContent"
        case .table: return "table"
        case .tableRow: return "tableRow"
        case .tableCell: return "tableCell"
        case .tableHeader: return "tableHeader"
        case .image: return "image"
        case .fileAttachment: return "fileAttachment"
        case .mention: return "mention"
        case .pageLink: return "pageLink"
        case let .unknown(name): return name
        }
    }
}

struct BoxMark {
    var type: String
    var attrs: [String: Any] = [:]
}

/// A list marker, drawn by the view in the indent of the line that starts at `offset` (markers
/// aren't characters: the drawn string has exactly the view's text, EDITOR.md 10.1).
struct BoxMarker {
    let offset: Int
    let text: NSAttributedString
    /// Left edge of the marker in the text container.
    let x: CGFloat
}

struct BoxRendering {
    /// The view's text with attributes: the same UTF-16 length as `text_for_view()`, plus a
    /// zero-width space when the last line is empty (so TextKit lays out a line for the caret).
    let string: NSAttributedString
    let markers: [BoxMarker]
    /// Length of the view's text (without the zero-width space).
    let length: Int

    static let empty = BoxRendering(string: NSAttributedString(), markers: [], length: 0)
}

/// Draws a box's tree as one attributed string that lines up with the engine's view text
/// character for character: every text block a line, `\n` between lines, a hard break as U+2028
/// (one unit, like the engine's `\n`), inline atoms (mentions, page links) and text-less blocks
/// (rules, images, files, task lines) as U+FFFC text attachments drawn as small images. List
/// markers and task circles hang in the indent and are drawn by the view.
struct BoxTextRenderer {
    var bodySize: CGFloat = 16
    var tasks: [String: TaskLine] = [:]
    var pageTitles: [String: String] = [:]
    /// The text container's width (attachments wrap to it).
    var width: CGFloat = 600

    static let step: CGFloat = 24
    static let object = "\u{FFFC}"

    private struct Context {
        var indent = 0
        var marker: String?
        var quote = false
    }

    private final class Output {
        let string = NSMutableAttributedString()
        var markers: [BoxMarker] = []
        var lastStyle: NSParagraphStyle?
        var lastLineEmpty = true
        var lines = 0
    }

    func render(_ doc: BoxNode) -> BoxRendering {
        let out = Output()
        blocks(doc, Context(), out)
        let length = out.string.length
        if out.lines == 0 || out.lastLineEmpty {
            var attrs: [NSAttributedString.Key: Any] = [.font: font(bodySize)]
            if let style = out.lastStyle { attrs[.paragraphStyle] = style }
            out.string.append(NSAttributedString(string: "\u{200B}", attributes: attrs))
        }
        return BoxRendering(string: out.string, markers: out.markers, length: length)
    }

    // MARK: Blocks (the same walk as nv-editor's `ViewText::blocks`)

    private func blocks(_ node: BoxNode, _ ctx: Context, _ out: Output) {
        for (i, c) in node.content.enumerated() {
            var cx = ctx
            if i > 0 { cx.marker = nil } // a list item's marker goes on its first block only
            block(c, cx, out)
        }
    }

    private func block(_ c: BoxNode, _ ctx: Context, _ out: Output) {
        var inner = ctx
        inner.marker = nil
        if BoxNode.textblocks.contains(c.type) {
            textblock(c, ctx, out)
            return
        }
        if BoxNode.leafBlocks.contains(c.type) {
            let label: NSAttributedString
            switch c.type {
            case "horizontalRule":
                label = NSAttributedString(string: String(repeating: "─", count: 24), attributes: [.font: font(bodySize), .foregroundColor: UIColor.separator])
            case "image":
                let alt = c.string("alt") ?? ""
                label = placeholder("🖼 " + (alt.isEmpty ? "Image" : alt))
            default:
                label = placeholder("📎 " + (c.string("name") ?? "File"))
            }
            line(attachment(label, indent: ctx.indent), ctx, out)
            return
        }
        switch c.type {
        case "bulletList":
            for item in c.content { block(item, with(ctx, marker: "•"), out) }
        case "orderedList":
            let start = Int(c.number("start") ?? 1)
            for (i, item) in c.content.enumerated() {
                let marker: String
                if let markers = c.markers, i < markers.count {
                    marker = markers[i]
                } else {
                    let type = c.string("type")
                    let m = listMarker(listType: type, n: Int64(start + i))
                    marker = m + ((c.bool("paren") ?? false) ? ")" : ".")
                }
                block(item, with(ctx, marker: marker), out)
            }
        case "taskList":
            for item in c.content {
                block(item, with(ctx, marker: (item.bool("checked") ?? false) ? "☑" : "☐"), out)
            }
        case "listItem", "taskItem":
            var cx = ctx
            cx.indent += 1
            blocks(c, cx, out)
        case "taskRef":
            taskRef(c, ctx, out)
        case "blockquote", "callout":
            var cx = inner
            cx.indent += 1
            cx.quote = true
            if c.type == "callout", let emoji = c.string("emoji"), !emoji.isEmpty { cx.marker = emoji }
            blocks(c, cx, out)
        case "detailsContent":
            var cx = inner
            cx.indent += 1
            blocks(c, cx, out)
        default:
            // details, table, rows, cells, unknown nodes: their blocks, one line each.
            blocks(c, inner, out)
        }
    }

    private func taskRef(_ c: BoxNode, _ ctx: Context, _ out: Output) {
        var lineCtx = ctx
        lineCtx.indent += 1
        let id = c.string("taskId") ?? ""
        let label = NSMutableAttributedString()
        switch tasks[id] {
        case let .shown(title, done, due)?:
            label.append(NSAttributedString(string: title.isEmpty ? " " : title, attributes: [
                .font: font(bodySize), .foregroundColor: done ? UIColor.secondaryLabel : UIColor.label,
                .strikethroughStyle: done ? NSUnderlineStyle.single.rawValue : 0,
            ]))
            if let due {
                label.append(NSAttributedString(string: "  \(due)", attributes: [.font: font(bodySize - 3), .foregroundColor: UIColor.systemBlue]))
            }
            lineCtx.marker = done ? "✓" : "◯"
        case .hidden?:
            label.append(placeholder("Task not shown"))
            lineCtx.marker = "◯"
        case nil:
            label.append(placeholder("Task"))
            lineCtx.marker = "◯"
        }
        line(attachment(label, indent: lineCtx.indent), lineCtx, out)
        var notes = ctx
        notes.marker = nil
        notes.indent += 1
        blocks(c, notes, out)
    }

    private func textblock(_ c: BoxNode, _ ctx: Context, _ out: Output) {
        switch c.type {
        case "heading":
            let level = Int(c.number("level") ?? 1)
            let size: CGFloat = [1: 26, 2: 21, 3: 18][level] ?? bodySize
            line(inline(c.content, size: size, bold: true), ctx, out, spacingBefore: 6)
        case "codeBlock":
            let text = NSMutableAttributedString(attributedString: inline(c.content, size: bodySize - 2, monospaced: true))
            text.addAttribute(.backgroundColor, value: UIColor.gray.withAlphaComponent(0.12), range: NSRange(location: 0, length: text.length))
            line(text, ctx, out)
        default:
            line(inline(c.content, size: bodySize), ctx, out)
        }
    }

    // MARK: Lines

    private func with(_ ctx: Context, marker: String) -> Context {
        var c = ctx
        c.marker = marker
        return c
    }

    private func paragraphStyle(_ ctx: Context, spacingBefore: CGFloat) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.paragraphSpacingBefore = spacingBefore
        style.paragraphSpacing = 4
        style.lineHeightMultiple = 1.15
        let head: CGFloat = ctx.marker != nil
            ? CGFloat(max(ctx.indent, 1)) * Self.step
            : CGFloat(ctx.indent) * Self.step
        style.firstLineHeadIndent = head
        style.headIndent = head
        return style
    }

    private func line(_ text: NSAttributedString, _ ctx: Context, _ out: Output, spacingBefore: CGFloat = 0) {
        let style = paragraphStyle(ctx, spacingBefore: spacingBefore)
        if out.lines > 0 {
            var attrs: [NSAttributedString.Key: Any] = [.font: font(bodySize)]
            if let last = out.lastStyle { attrs[.paragraphStyle] = last }
            out.string.append(NSAttributedString(string: "\n", attributes: attrs))
        }
        let start = out.string.length
        let line = NSMutableAttributedString(attributedString: text)
        let all = NSRange(location: 0, length: line.length)
        line.addAttribute(.paragraphStyle, value: style, range: all)
        if ctx.quote { line.addAttribute(.foregroundColor, value: UIColor.secondaryLabel, range: all) }
        out.string.append(line)
        if let marker = ctx.marker {
            let m = NSAttributedString(string: marker, attributes: [.font: font(bodySize), .foregroundColor: UIColor.secondaryLabel])
            out.markers.append(BoxMarker(offset: start, text: m, x: style.firstLineHeadIndent - Self.step))
        }
        out.lastStyle = style
        out.lastLineEmpty = line.length == 0
        out.lines += 1
    }

    private func placeholder(_ s: String) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [.font: font(bodySize - 1), .foregroundColor: UIColor.secondaryLabel])
    }

    /// One U+FFFC drawn as `label` (an image attachment, so TextKit draws it with the text).
    private func attachment(_ label: NSAttributedString, indent: Int) -> NSAttributedString {
        let maxWidth = max(width - CGFloat(indent) * Self.step - 4, 40)
        let bounds = label.boundingRect(with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
                                        options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        let size = CGSize(width: max(ceil(bounds.width), 1), height: max(ceil(bounds.height), 1))
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            label.draw(with: CGRect(origin: .zero, size: size), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        }
        let a = NSTextAttachment(image: image)
        a.allowsTextAttachmentView = false
        let body = font(bodySize)
        // Single-line labels sit on the baseline like text; taller ones grow upwards from it.
        a.bounds = CGRect(x: 0, y: body.descender, width: size.width, height: size.height)
        let s = NSMutableAttributedString(attributedString: NSAttributedString(attachment: a))
        s.addAttribute(.font, value: body, range: NSRange(location: 0, length: s.length))
        return s
    }

    // MARK: Inline

    private func inline(_ content: [BoxNode], size: CGFloat, bold: Bool = false, monospaced: Bool = false) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for node in content {
            switch node.type {
            case "text":
                out.append(textRun(node, size: size, bold: bold, monospaced: monospaced))
            case "hardBreak":
                // The engine's view text has `\n` here; U+2028 breaks the line without starting a paragraph.
                out.append(NSAttributedString(string: "\u{2028}", attributes: [.font: font(size)]))
            case "mention":
                let label = node.string("label") ?? ""
                out.append(attachment(NSAttributedString(string: "@" + (label.isEmpty ? "someone" : label),
                                                         attributes: [.font: font(size, bold: true), .foregroundColor: UIColor.systemBlue]), indent: 0))
            case "pageLink":
                let id = node.string("pageId") ?? ""
                out.append(attachment(NSAttributedString(string: "↗ " + (pageTitles[id] ?? "Page"),
                                                         attributes: [.font: font(size), .foregroundColor: UIColor.systemBlue]), indent: 0))
            default:
                // Any other inline atom is one U+FFFC in the engine's text.
                out.append(attachment(placeholder("◻︎"), indent: 0))
            }
        }
        return out
    }

    private func textRun(_ node: BoxNode, size: CGFloat, bold: Bool, monospaced: Bool) -> NSAttributedString {
        var isBold = bold
        var italic = false
        var code = monospaced
        var attrs: [NSAttributedString.Key: Any] = [.foregroundColor: UIColor.label]
        for mark in node.marks {
            switch mark.type {
            case "bold": isBold = true
            case "italic": italic = true
            case "code": code = true
            case "underline": attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            case "strike": attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            case "textStyle":
                if let name = mark.attrs["color"] as? String, let c = PageTextRenderer.palette[name] { attrs[.foregroundColor] = c }
            case "highlight":
                let name = mark.attrs["color"] as? String ?? "yellow"
                attrs[.backgroundColor] = (PageTextRenderer.palette[name] ?? .systemYellow).withAlphaComponent(0.3)
            case "link":
                attrs[.foregroundColor] = UIColor.systemBlue
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            case "comment":
                if attrs[.backgroundColor] == nil { attrs[.backgroundColor] = UIColor.systemOrange.withAlphaComponent(0.18) }
            default:
                break
            }
        }
        attrs[.font] = font(size, bold: isBold, italic: italic, monospaced: code)
        return NSAttributedString(string: node.text, attributes: attrs)
    }

    func font(_ size: CGFloat, bold: Bool = false, italic: Bool = false, monospaced: Bool = false) -> UIFont {
        let base: UIFont = monospaced
            ? .monospacedSystemFont(ofSize: size, weight: bold ? .semibold : .regular)
            : .systemFont(ofSize: size, weight: bold ? .semibold : .regular)
        guard italic, let d = base.fontDescriptor.withSymbolicTraits(base.fontDescriptor.symbolicTraits.union(.traitItalic)) else { return base }
        return UIFont(descriptor: d, size: size)
    }
}
