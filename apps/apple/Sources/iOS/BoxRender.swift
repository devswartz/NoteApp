import NotiveloCore
import UIKit

/// Something the view draws in a line's indent (markers aren't characters: the drawn string has
/// exactly the view's text, EDITOR.md 10.1). `x` is where the line's text starts (container coordinates).
struct BoxMarker {
    enum Kind {
        /// A list marker ("1.", "b)"), right-aligned just before the text.
        case text(NSAttributedString)
        /// A bullet by depth: disc, circle, square.
        case bullet(Int)
        /// A checklist box (15×15, accent when checked), 8 pt before the text.
        case checkbox(Bool)
        /// A task line's fold arrow, in the 26 pt gutter left of its circle.
        case fold(collapsed: Bool, taskId: String)
        /// A toggle's triangle (open or closed).
        case toggle(Bool)
    }

    let offset: Int
    let kind: Kind
    let x: CGFloat
}

/// A task line's title area: the line starts at `offset`; `x` and `width` are in the container.
struct BoxTaskTitle {
    let offset: Int
    let id: String
    let x: CGFloat
    let width: CGFloat
}

/// A block drawn behind its lines (from the first line at `from` to the line ending before `to`).
struct BoxDecoration {
    enum Kind {
        case callout(emoji: String)
        case code(language: String)
        case quote
        /// The guide line left of a task's notes (dashed when the task is done).
        case guide(done: Bool)
        /// A table, drawn in the space above its (hidden) cell lines: rows of (text, header).
        case table(rows: [[(String, Bool)]], heights: [CGFloat])
    }

    let kind: Kind
    let from: Int
    let to: Int
    /// The block's outer left and right edges in the container.
    let left: CGFloat
    let right: CGFloat
    /// Space between the block's edge and its first / last line's text.
    var topPad: CGFloat = 0
    var bottomPad: CGFloat = 0
}

extension NSAttributedString.Key {
    /// A link's address, on the text it covers (the link editor and taps read it back).
    static let nvHref = NSAttributedString.Key("nvHref")
}

struct BoxRendering {
    /// The view's text with attributes: the same UTF-16 length as `text_for_view()`, plus a
    /// zero-width space when the last line is empty (so TextKit lays out a line for the caret).
    let string: NSAttributedString
    let markers: [BoxMarker]
    let decorations: [BoxDecoration]
    /// Length of the view's text (without the zero-width space).
    let length: Int
    /// The first block's top margin (CSS keeps it inside the box): added to the text's top inset.
    let topMargin: CGFloat
    /// The last line's half-leading: added to the bottom inset.
    var bottomMargin: CGFloat = 0
    /// Where each task line's title is drawn (the title field of a task being edited goes there).
    var taskTitles: [BoxTaskTitle] = []

    static let empty = BoxRendering(string: NSAttributedString(), markers: [], decorations: [], length: 0, topMargin: 0)
}

/// Draws a box's tree as one attributed string that lines up with the engine's view text
/// character for character: every text block a line, `\n` between lines, a hard break as U+2028
/// (one unit, like the engine's `\n`), inline atoms (mentions, page links) and text-less blocks
/// (rules, images, files, task lines) as U+FFFC text attachments drawn as images. Styled as the
/// web app's `.ProseMirror` (LOOK.md 2.3, 2.4): 16 / 1.7 lines, block margins collapsed as CSS
/// does, headings, list markers by depth, checklists, quotes, callouts, code blocks, task rows.
struct BoxTextRenderer {
    /// 16, phones 16.5 (LOOK.md 2.3); headings are em-based and scale with it.
    var bodySize: CGFloat = BoxTextRenderer.phoneChips ? 16.5 : 16
    var tasks: [String: TaskLine] = [:]
    var pageTitles: [String: String] = [:]
    /// The text container's width (attachments and block backgrounds use it).
    var width: CGFloat = 600
    var palette: Palette = .light
    var decor: [String: TaskDecor] = [:]

    /// Tasks whose notes are folded away (the arrow left of the task; kept on this device, as the web does).
    static var collapsedTasks: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "collapsedTasks") ?? [])

    static func toggleCollapsed(_ id: String) {
        if collapsedTasks.contains(id) { collapsedTasks.remove(id) } else { collapsedTasks.insert(id) }
        UserDefaults.standard.set(Array(collapsedTasks), forKey: "collapsedTasks")
    }

    static let object = "\u{FFFC}"
    /// Mention ids that are the signed-in person (drawn yellow, as "yourself").
    static var selfMentionIds: Set<String> = []
    /// Phones: task lines show only the checklist count, due chip, the Add checklist icon and open (LOOK.md 2.4).
    static var phoneChips = false
    /// List indent: 1.6 em.
    static let listIndent: CGFloat = 25.6
    /// CSS puts half the leading above the text; TextKit puts it all above. The baseline is raised
    /// by (line height − font height) / this.
    static let baselineDivisor: CGFloat = 2

    private struct Context {
        var left: CGFloat = 0
        var right: CGFloat = 0
        var marker: BoxMarker.Kind?
        var color: UIColor?
        var checked = false
        var hidden = false
        var bulletDepth = 0
    }

    private final class Output {
        let string = NSMutableAttributedString()
        var markers: [BoxMarker] = []
        var decorations: [BoxDecoration] = []
        var taskTitles: [BoxTaskTitle] = []
        var lastStyle: NSParagraphStyle?
        var lastLineEmpty = true
        var lines = 0
        /// Collapsing margins waiting for the next line (CSS: the larger wins).
        var pendingTop: CGFloat = 0
        var pendingBottom: CGFloat = 0
        /// Padding of closed blocks (added below the last line) and of opened ones (added above the next).
        var addAfter: CGFloat = 0
        var addBefore: CGFloat = 0
        /// Spacing already settled (padding of an opened callout, a table's height): added as is.
        var base: CGFloat = 0
        /// The previous line's half-leading (CSS puts it below the text).
        var prevHalf: CGFloat = 0
        var topMargin: CGFloat = 0
        /// The spacing above the next line, inside a just-opened padded block (for its background).
        var capture = false
        var captured: CGFloat = 0

        /// Settle the collapsed margins so far and add `pad` (a block's own padding starts here).
        func flush(pad: CGFloat) {
            base += addAfter + max(pendingTop, pendingBottom) + addBefore + pad
            addAfter = 0
            pendingTop = 0
            pendingBottom = 0
            addBefore = 0
        }
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
        return BoxRendering(string: out.string, markers: out.markers, decorations: out.decorations, length: length, topMargin: out.topMargin,
                            bottomMargin: max(out.pendingBottom, 0) + out.addAfter - out.prevHalf, taskTitles: out.taskTitles)
    }

    // MARK: Blocks (the same walk as nv-editor's `ViewText::blocks`)

    private func blocks(_ node: BoxNode, _ ctx: Context, _ out: Output) {
        for (i, c) in node.content.enumerated() {
            var cx = ctx
            if i > 0 { cx.marker = nil } // a list item's marker goes on its first block only
            block(c, cx, out)
        }
    }

    /// CSS margins (top, bottom) of a block at 16 pt.
    private func margins(_ c: BoxNode) -> (CGFloat, CGFloat) {
        switch c.type {
        case "heading":
            switch Int(c.number("level") ?? 1) {
            case 1: return (33.6, 8.4)
            case 2: return (23.76, 5.4)
            default: return (17.92, 3.58)
            }
        case "bulletList", "orderedList", "taskList": return (4.8, 4.8)
        case "blockquote", "callout", "codeBlock", "image": return (9.6, 9.6)
        case "table": return (12.8, 12.8)
        case "fileAttachment": return (6.4, 6.4)
        default: return (0, 0)
        }
    }

    private func open(_ c: BoxNode, _ out: Output, _ ctx: Context) {
        guard !ctx.hidden else { return }
        let (top, _) = margins(c)
        out.pendingTop = max(out.pendingTop, top)
    }

    private func close(_ c: BoxNode, _ out: Output, _ ctx: Context) {
        guard !ctx.hidden else { return }
        let (_, bottom) = margins(c)
        out.pendingBottom = max(out.pendingBottom, bottom)
    }

    private func block(_ c: BoxNode, _ ctx: Context, _ out: Output) {
        var inner = ctx
        inner.marker = nil
        open(c, out, ctx)
        defer { close(c, out, ctx) }
        if BoxNode.textblocks.contains(c.type) {
            textblock(c, ctx, out)
            return
        }
        if BoxNode.leafBlocks.contains(c.type) {
            leaf(c, ctx, out)
            return
        }
        switch c.type {
        case "bulletList":
            var cx = ctx
            cx.bulletDepth += 1
            let bullet = (cx.bulletDepth - 1) % 3
            for item in c.content { block(item, with(cx, marker: .bullet(bullet)), out) }
        case "orderedList":
            let start = Int(c.number("start") ?? 1)
            var cx = ctx
            cx.bulletDepth += 1
            for (i, item) in c.content.enumerated() {
                let marker: String
                if let markers = c.markers, i < markers.count {
                    marker = markers[i]
                } else {
                    let m = listMarker(listType: c.string("type"), n: Int64(start + i))
                    marker = m + ((c.bool("paren") ?? false) ? ")" : ".")
                }
                block(item, with(cx, marker: .text(markerText(marker))), out)
            }
        case "taskList":
            for item in c.content {
                var cx = ctx
                cx.checked = item.bool("checked") ?? false
                cx.marker = .checkbox(cx.checked)
                block(item, cx, out)
            }
        case "listItem":
            var cx = ctx
            cx.left += Self.listIndent
            blocks(c, cx, out)
        case "taskItem":
            // Checklist: padding-left 0.2 em, a 15 pt box, gap 8.
            var cx = ctx
            cx.left += 3.2 + 15 + 8
            blocks(c, cx, out)
        case "taskRef":
            taskRef(c, ctx, out)
        case "blockquote":
            var cx = inner
            cx.left += 3 + 16
            cx.color = palette.text2
            let from = out.string.length + (out.lines > 0 ? 1 : 0)
            blocks(c, cx, out)
            out.decorations.append(BoxDecoration(kind: .quote, from: from, to: out.string.length, left: ctx.left, right: ctx.right,
                                                 topPad: 5.6, bottomPad: 5.6))
        case "callout":
            var cx = inner
            cx.left += 1 + 12 + 28 + 10
            cx.right += 1 + 14
            let from = out.string.length + (out.lines > 0 ? 1 : 0)
            if !ctx.hidden {
                out.flush(pad: 13)
                out.capture = true
            }
            blocks(c, cx, out)
            var bottomPad: CGFloat = 13
            if !ctx.hidden {
                let tail = out.pendingBottom + out.addAfter
                bottomPad = 13 + tail + out.prevHalf
                out.addAfter = tail + 13
                out.pendingBottom = 0
            }
            var d = BoxDecoration(kind: .callout(emoji: c.string("emoji").flatMap { $0.isEmpty ? nil : $0 } ?? "💡"),
                                  from: from, to: out.string.length, left: ctx.left, right: ctx.right)
            d.topPad = 13 + out.captured
            d.bottomPad = bottomPad
            out.decorations.append(d)
        case "details":
            let isOpen = c.bool("open") ?? false
            for part in c.content {
                var cx = inner
                if part.type == "detailsSummary" {
                    cx.left += 26
                    cx.marker = .toggle(isOpen)
                } else {
                    cx.left += 26
                    if !isOpen { cx.hidden = true }
                }
                block(part, cx, out)
            }
        case "detailsContent":
            blocks(c, inner, out)
        case "table" where !ctx.hidden:
            // TextKit 2 can't set paragraphs side by side: the table is drawn in the space above
            // its cell lines, which are kept (for the view text's offsets) but hidden.
            let rows = c.content.map { row in row.content.map { cell in (plainText(cell), cell.type == "tableHeader") } }
            // Cells wrap inside their column: a row is 40.2 for one line, 27.2 more for each further line.
            let cols = max(rows.map(\.count).max() ?? 1, 1)
            let colW = max(width - ctx.left - ctx.right, 20) / CGFloat(cols)
            let heights: [CGFloat] = rows.map { row in
                var lines = 1
                for cell in row {
                    let a = Self.cellText(cell.0, header: cell.1, color: palette.text)
                    let h = a.boundingRect(with: CGSize(width: max(colW - 20, 10), height: .greatestFiniteMagnitude), options: .usesLineFragmentOrigin, context: nil).height
                    lines = max(lines, Int(((h + Self.cellLeading) / 27.2).rounded()))
                }
                return 40.2 + CGFloat(lines - 1) * 27.2
            }
            let height = heights.reduce(0, +) + 1
            out.flush(pad: height)
            var cx = inner
            cx.hidden = true
            let from = out.string.length + (out.lines > 0 ? 1 : 0)
            blocks(c, cx, out)
            var d = BoxDecoration(kind: .table(rows: rows, heights: heights), from: from, to: out.string.length, left: ctx.left, right: ctx.right)
            d.topPad = height
            out.decorations.append(d)
        default:
            // table, rows, unknown nodes: their blocks, one line each.
            blocks(c, inner, out)
        }
    }

    /// The extra leading that makes wrapped cell lines 27.2 apart (16 pt text, line-height 1.7).
    static var cellLeading: CGFloat { 27.2 - WebType.ui(16, 400).lineHeight }

    /// A table cell's text (wraps inside its column).
    static func cellText(_ text: String, header: Bool, color: UIColor) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byWordWrapping
        style.lineSpacing = cellLeading
        return NSAttributedString(string: text, attributes: [.font: WebType.ui(16, header ? 600 : 400), .foregroundColor: color, .paragraphStyle: style])
    }

    private func plainText(_ n: BoxNode) -> String {
        if n.type == "text" { return n.text }
        return n.content.map(plainText).joined(separator: n.content.first.map { BoxNode.textblocks.contains($0.type) } == true ? " " : "")
    }

    private func markerText(_ s: String) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [.font: font(bodySize), .foregroundColor: palette.text])
    }

    private func leaf(_ c: BoxNode, _ ctx: Context, _ out: Output) {
        let avail = max(width - ctx.left - ctx.right, 40)
        switch c.type {
        case "horizontalRule":
            let h: CGFloat = 22.4 * 2 + 1
            let image = Self.image(CGSize(width: avail, height: h)) { _ in
                palette.border.setFill()
                UIRectFill(CGRect(x: 0, y: 22.4, width: avail, height: 1))
            }
            line(attachment(image, height: h), ctx, out, lineHeight: h, raise: false)
        case "image":
            let alt = c.string("alt") ?? ""
            let label = NSMutableAttributedString(string: alt.isEmpty ? "Image" : alt,
                                                  attributes: [.font: font(bodySize), .foregroundColor: palette.textMuted])
            let size = CGSize(width: min(avail, label.size().width + 22), height: 27.2)
            let image = Self.image(size) { _ in
                UIImage.lucide("image", size: 16, color: palette.textMuted)?.draw(at: CGPoint(x: 0, y: 5.6))
                label.draw(at: CGPoint(x: 22, y: (27.2 - font(bodySize).lineHeight) / 2))
            }
            line(attachment(image, height: 27.2), ctx, out, lineHeight: 27.2, raise: false)
        default:
            let image = fileCard(c, width: min(avail, 520))
            line(attachment(image, height: image.size.height), ctx, out, lineHeight: image.size.height, raise: false)
        }
    }

    private func taskRef(_ c: BoxNode, _ ctx: Context, _ out: Output) {
        let id = c.string("taskId") ?? ""
        let avail = max(width - ctx.left - ctx.right, 60)
        let image: UIImage
        var titleWidth: CGFloat?
        var done = false
        switch tasks[id] {
        case let .shown(title, isDone, due)?:
            done = isDone
            let row = taskRow(title: title, done: isDone, due: due, decor: decor[id], width: avail)
            image = row.image
            titleWidth = row.titleWidth
        default:
            image = missingTask(width: avail)
        }
        var lineCtx = ctx
        let folded = Self.collapsedTasks.contains(id)
        if !c.content.isEmpty && tasks[id] != nil && tasks[id] != .hidden { lineCtx.marker = .fold(collapsed: folded, taskId: id) }
        // Task rows sat about 11 pt higher in their line than the web's (chips over the heading above).
        line(attachment(image, height: image.size.height, drop: titleWidth == nil ? 0 : 11), lineCtx, out, lineHeight: image.size.height, raise: false)
        if let titleWidth, !ctx.hidden { out.taskTitles.append(BoxTaskTitle(offset: out.string.length - 1, id: id, x: ctx.left + 26, width: titleWidth)) }
        guard !c.content.isEmpty else { return }
        var notes = ctx
        notes.marker = nil
        notes.left += 38
        if tasks[id] == nil || tasks[id] == .hidden || folded { notes.hidden = true }
        let from = out.string.length + 1
        blocks(c, notes, out)
        // Hidden notes (missing task, folded) draw no guide line (it showed as a dot in the gutter).
        if !notes.hidden {
            out.decorations.append(BoxDecoration(kind: .guide(done: done), from: from, to: out.string.length, left: ctx.left + 26, right: ctx.right))
        }
    }

    private func textblock(_ c: BoxNode, _ ctx: Context, _ out: Output) {
        switch c.type {
        case "heading":
            let level = Int(c.number("level") ?? 1)
            let size: CGFloat = ([1: 28, 2: 21.6, 3: 17.92][level] ?? 16) * bodySize / 16 * (level == 1 && bodySize > 16 ? 1.045 : 1)
            let lh: CGFloat = [1: 1.3, 2: 1.35, 3: 1.7][level] ?? 1.7
            let text = NSMutableAttributedString(attributedString: inline(c.content, size: size, weight: 700, ctx: ctx))
            let kern: CGFloat = level == 1 ? -0.02 * size : level == 2 ? -0.01 * size : 0
            if kern != 0 { text.addAttribute(.kern, value: kern, range: NSRange(location: 0, length: text.length)) }
            line(text, ctx, out, lineHeight: size * lh, font: font(size, weight: 700))
        case "codeBlock":
            var cx = ctx
            let from = out.string.length + (out.lines > 0 ? 1 : 0)
            cx.left += 15
            cx.right += 15
            if !ctx.hidden { out.flush(pad: 35) }
            line(inline(c.content, size: 13.5, mono: true, ctx: cx), cx, out, lineHeight: 13.5 * 1.7, font: WebType.mono(13.5))
            if !ctx.hidden { out.addAfter += 13 }
            var d = BoxDecoration(kind: .code(language: c.string("language") ?? ""), from: from, to: out.string.length,
                                  left: ctx.left, right: ctx.right)
            d.topPad = 35 + out.prevHalf
            d.bottomPad = 13 + out.prevHalf
            out.decorations.append(d)
        case "detailsSummary":
            line(inline(c.content, size: bodySize, weight: 500, ctx: ctx), ctx, out, lineHeight: bodySize * 1.7)
        default:
            line(inline(c.content, size: bodySize, ctx: ctx), ctx, out, lineHeight: bodySize * 1.7)
        }
    }

    // MARK: Lines

    private func with(_ ctx: Context, marker: BoxMarker.Kind) -> Context {
        var c = ctx
        c.marker = marker
        return c
    }

    /// Append one line: `\n` before it (with the previous line's style), the text with its
    /// paragraph style (fixed line height, indents, the collapsed spacing above it).
    private func line(_ text: NSAttributedString, _ ctx: Context, _ out: Output, lineHeight: CGFloat, font lineFont: UIFont? = nil, raise: Bool = true) {
        let style = NSMutableParagraphStyle()
        let f = lineFont ?? font(bodySize)
        // CSS line-height: the leading is split above and below the text. TextKit gets the natural
        // line height, the half-leading as spacing before/after, and the full leading between wrapped lines.
        let half: CGFloat = (raise && !ctx.hidden) ? max(lineHeight - f.lineHeight, 0) / 2 : 0
        let inner = out.addAfter + max(out.pendingTop, out.pendingBottom) + out.addBefore
        if out.capture {
            out.captured = inner + half
            out.capture = false
        }
        var spacing = out.base + inner
        if out.lines == 0 {
            out.topMargin = spacing + half
            spacing = 0
        } else {
            // The previous line's lineSpacing (its full leading) already sits below it: CSS wants
            // half of it there and this line's half above, so the difference goes before this line.
            spacing = max(spacing + half - out.prevHalf, 0)
        }
        out.pendingTop = 0
        out.pendingBottom = 0
        out.addAfter = 0
        out.addBefore = 0
        out.base = 0
        if ctx.hidden {
            style.minimumLineHeight = 0.01
            style.maximumLineHeight = 0.01
        } else if !raise {
            style.minimumLineHeight = lineHeight
            style.maximumLineHeight = lineHeight
        }
        style.lineSpacing = half * 2
        style.paragraphSpacingBefore = spacing
        style.firstLineHeadIndent = ctx.left
        style.headIndent = ctx.left
        if ctx.right > 0 { style.tailIndent = -ctx.right }
        if out.lines > 0 {
            var attrs: [NSAttributedString.Key: Any] = [.font: font(bodySize)]
            if let last = out.lastStyle { attrs[.paragraphStyle] = last }
            out.string.append(NSAttributedString(string: "\n", attributes: attrs))
        }
        let start = out.string.length
        let line = NSMutableAttributedString(attributedString: text)
        let all = NSRange(location: 0, length: line.length)
        line.addAttribute(.paragraphStyle, value: style, range: all)
        if ctx.hidden {
            line.addAttribute(.foregroundColor, value: UIColor.clear, range: all)
            line.addAttribute(.font, value: font(1), range: all)
            line.removeAttribute(.attachment, range: all)
        }
        out.string.append(line)
        if let marker = ctx.marker, !ctx.hidden {
            out.markers.append(BoxMarker(offset: start, kind: marker, x: ctx.left))
        }
        out.prevHalf = half
        out.lastStyle = style
        out.lastLineEmpty = line.length == 0
        out.lines += 1
    }

    /// One U+FFFC drawn as `image`, sitting at the top of a line as tall as the image.
    private func attachment(_ image: UIImage, height: CGFloat, drop: CGFloat = 0) -> NSAttributedString {
        let a = NSTextAttachment(image: image)
        a.allowsTextAttachmentView = false
        let body = font(bodySize)
        a.bounds = CGRect(x: 0, y: body.descender - drop, width: image.size.width, height: height)
        let s = NSMutableAttributedString(attributedString: NSAttributedString(attachment: a))
        s.addAttribute(.font, value: body, range: NSRange(location: 0, length: s.length))
        return s
    }

    /// An inline atom (mention, page link): a pill image on the baseline.
    private func inlineAttachment(_ image: UIImage, size: CGFloat) -> NSAttributedString {
        let a = NSTextAttachment(image: image)
        a.allowsTextAttachmentView = false
        let f = font(size)
        a.bounds = CGRect(x: 0, y: f.descender - 1, width: image.size.width, height: image.size.height)
        let s = NSMutableAttributedString(attributedString: NSAttributedString(attachment: a))
        s.addAttribute(.font, value: f, range: NSRange(location: 0, length: s.length))
        return s
    }

    static func image(_ size: CGSize, _ draw: (UIGraphicsImageRendererContext) -> Void) -> UIImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        return UIGraphicsImageRenderer(size: CGSize(width: max(size.width, 1), height: max(size.height, 1)), format: format).image(actions: draw)
    }

    // MARK: Task rows (TaskRef.tsx, LOOK.md 2.4)

    private func taskRow(title: String, done: Bool, due: String?, decor d: TaskDecor?, width: CGFloat) -> (image: UIImage, titleWidth: CGFloat) {
        let p = palette
        let rowHeight: CGFloat = 34
        let chipFont = WebType.ui(11.5, 500)
        // Meta chips, right to left: open, Add checklist, assignee, due, priority, checklist count.
        var items: [(width: CGFloat, draw: (CGFloat) -> Void)] = []
        let chipY: CGFloat = 6
        func chip(_ w: CGFloat, _ x: CGFloat) {
            p.bgHover.setFill()
            UIBezierPath(roundedRect: CGRect(x: x, y: chipY, width: w, height: 22), cornerRadius: 6).fill()
        }
        items.append((24, { x in UIImage.lucide("maximize-2", size: 13, color: p.text2)?.draw(at: CGPoint(x: x + 5.5, y: chipY + 4.5)) }))
        let phone = Self.phoneChips
        let add = NSAttributedString(string: phone ? "" : "Add checklist", attributes: [.font: chipFont, .foregroundColor: p.text2])
        let addTextWidth: CGFloat = add.size().width
        let addW: CGFloat = 25 + addTextWidth
        items.append((addW, { x in
            UIImage.lucide("list-plus", size: 13, color: p.text2)?.draw(at: CGPoint(x: x + 4, y: chipY + 4.5))
            add.draw(at: CGPoint(x: x + 21, y: chipY + (22 - chipFont.lineHeight) / 2))
        }))
        if phone {
            // no assignee on phones
        } else if let name = d?.assignee, let color = d?.assigneeColor {
            let ini = NSAttributedString(string: initials(name), attributes: [.font: WebType.ui(8.4, 600), .foregroundColor: color.initialsColor])
            items.append((20, { x in
                color.setFill()
                UIBezierPath(ovalIn: CGRect(x: x, y: chipY + 1, width: 20, height: 20)).fill()
                let s = ini.size()
                ini.draw(at: CGPoint(x: x + (20 - s.width) / 2, y: chipY + 1 + (20 - s.height) / 2))
            }))
        } else {
            items.append((20, { x in
                p.borderStrong.setStroke()
                let path = UIBezierPath(ovalIn: CGRect(x: x + 0.75, y: chipY + 1.75, width: 18.5, height: 18.5))
                path.lineWidth = 1.5
                path.setLineDash([3, 2], count: 2, phase: 0)
                path.stroke()
            }))
        }
        let dueText = Due.words(due).map { NSAttributedString(string: $0, attributes: [.font: chipFont, .foregroundColor: Due.tone(due, p)]) }
        let dueTextWidth: CGFloat = dueText?.size().width ?? 0
        let dueW: CGFloat = dueText == nil ? 26 : 31 + dueTextWidth
        items.append((dueW, { x in
            chip(dueW, x)
            let tone = dueText == nil ? p.text2 : Due.tone(due, p)
            UIImage.lucide("calendar-days", size: 13, color: tone)?.draw(at: CGPoint(x: x + (dueText == nil ? 6.5 : 7), y: chipY + 4.5))
            dueText?.draw(at: CGPoint(x: x + 24, y: chipY + (22 - chipFont.lineHeight) / 2))
        }))
        let priority = d?.priority ?? 4
        if !phone || priority < 4 { items.append((26, { x in
            chip(26, x)
            if priority < 4 {
                UIImage.lucide("flag-filled", size: 13, color: priorityColor(priority, p))?.draw(at: CGPoint(x: x + 6.5, y: chipY + 4.5))
            } else {
                UIImage.lucide("flag", size: 13, color: p.text2)?.draw(at: CGPoint(x: x + 6.5, y: chipY + 4.5))
            }
        })) }
        if let list = d?.checklist {
            let complete = list.done >= list.total
            let t = NSAttributedString(string: "\(list.done)/\(list.total)", attributes: [.font: chipFont, .foregroundColor: complete ? p.success : p.text2])
            let tWidth: CGFloat = t.size().width
            let w: CGFloat = 30 + tWidth
            items.append((w, { x in
                chip(w, x)
                UIImage.lucide("square-check", size: 12, color: complete ? p.success : p.text2)?.draw(at: CGPoint(x: x + 7, y: chipY + 5))
                t.draw(at: CGPoint(x: x + 23, y: chipY + (22 - chipFont.lineHeight) / 2))
            }))
        }
        var metaWidth: CGFloat = CGFloat(items.count - 1) * 4
        for item in items { metaWidth += item.width }
        let titleX: CGFloat = 26
        let titleWidth: CGFloat = width - 14 - metaWidth - titleX
        // A box too narrow for the chips lets them run past its edge, 34 pt from the circle's left, as the web does.
        let rowStart = max(width - 6, 34 + metaWidth)
        let image = Self.image(CGSize(width: rowStart + 6, height: rowHeight)) { _ in
            // The circle: 18, 1.6 ring; done: filled with a white check.
            let ring = priorityColor(priority, p)
            let circle = CGRect(x: 0.8, y: 8.8, width: 16.4, height: 16.4)
            if done {
                (priority < 4 ? ring : p.textMuted).setFill()
                UIBezierPath(ovalIn: circle.insetBy(dx: -0.8, dy: -0.8)).fill()
                UIImage.lucide("check", size: 11, color: .white)?.draw(at: CGPoint(x: 3.5, y: 11.5))
            } else {
                if priority < 4 {
                    ring.withAlphaComponent(0.10).setFill()
                    UIBezierPath(ovalIn: circle).fill()
                }
                ring.setStroke()
                let path = UIBezierPath(ovalIn: circle)
                path.lineWidth = 1.6
                path.stroke()
            }
            if titleWidth > 24 {
                let style = NSMutableParagraphStyle()
                style.lineBreakMode = .byTruncatingTail
                var attrs: [NSAttributedString.Key: Any] = [.font: font(bodySize), .foregroundColor: done ? p.textMuted : p.text, .paragraphStyle: style]
                if done { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
                NSAttributedString(string: title, attributes: attrs)
                    .draw(in: CGRect(x: titleX, y: 5 + (24 - font(bodySize).lineHeight) / 2, width: titleWidth, height: 24))
            }
            var x = rowStart
            for item in items {
                x -= item.width
                item.draw(x)
                x -= 4
            }
        }
        return (image, titleWidth)
    }

    private func missingTask(width: CGFloat) -> UIImage {
        let p = palette
        let text = NSAttributedString(string: "This task was deleted or is not visible to you.",
                                      attributes: [.font: WebType.ui(12.5), .foregroundColor: p.textMuted])
        let remove = NSAttributedString(string: "Remove from page", attributes: [.font: WebType.ui(13, 500), .foregroundColor: p.text2])
        return Self.image(CGSize(width: width, height: 40)) { _ in
            UIImage.lucide("file-x-corner", size: 15, color: p.textMuted)?.draw(at: CGPoint(x: 0, y: 6))
            text.draw(at: CGPoint(x: 23, y: 6 + (15 - WebType.ui(12.5).lineHeight) / 2 + 1))
            remove.draw(at: CGPoint(x: 23 + text.size().width + 18, y: 12 + (15 - WebType.ui(13).lineHeight) / 2 + 1))
        }
    }

    private func fileCard(_ c: BoxNode, width: CGFloat) -> UIImage {
        let p = palette
        let name = NSAttributedString(string: c.string("name") ?? "File", attributes: [.font: font(bodySize, weight: 500), .foregroundColor: p.text])
        let sizeText: String = {
            guard let n = c.number("size") else { return "" }
            if n >= 1_048_576 { return String(format: "%.1f MB", n / 1_048_576) }
            return "\(Int((n / 1024).rounded())) KB"
        }()
        let size = NSAttributedString(string: sizeText, attributes: [.font: WebType.ui(12), .foregroundColor: p.textMuted])
        let h: CGFloat = 52
        return Self.image(CGSize(width: width, height: h)) { _ in
            let card = UIBezierPath(roundedRect: CGRect(x: 0.5, y: 0.5, width: width - 1, height: h - 1), cornerRadius: 8)
            p.bg.setFill()
            card.fill()
            p.border.setStroke()
            card.lineWidth = 1
            card.stroke()
            p.accentSoft.setFill()
            UIBezierPath(roundedRect: CGRect(x: 11, y: 9, width: 34, height: 34), cornerRadius: 7).fill()
            UIImage.lucide("file-text", size: 18, color: p.accent)?.draw(at: CGPoint(x: 19, y: 17))
            name.draw(at: CGPoint(x: 55, y: (h - name.size().height) / 2))
            let sw = size.size().width
            size.draw(at: CGPoint(x: width - 11 - 28 - 8 - sw, y: (h - size.size().height) / 2))
            UIImage.lucide("download", size: 16, color: p.text2)?.draw(at: CGPoint(x: width - 11 - 22, y: 18))
        }
    }

    // MARK: Inline

    private func inline(_ content: [BoxNode], size: CGFloat, weight: Int = 400, mono: Bool = false, ctx: Context) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for node in content {
            switch node.type {
            case "text":
                out.append(textRun(node, size: size, weight: weight, mono: mono, ctx: ctx))
            case "hardBreak":
                // The engine's view text has `\n` here; U+2028 breaks the line without starting a paragraph.
                out.append(NSAttributedString(string: "\u{2028}", attributes: [.font: font(size)]))
            case "mention":
                let label = node.string("label") ?? ""
                let mine = Self.selfMentionIds.contains(node.string("id") ?? "")
                out.append(inlineAttachment(pill("@" + label, size: size, fg: mine ? palette.text : palette.accent,
                                                 bg: mine ? UIColor(red: 250 / 255, green: 204 / 255, blue: 21 / 255, alpha: 0.35) : palette.accentSoft,
                                                 underline: false), size: size))
            case "pageLink":
                let id = node.string("pageId") ?? ""
                out.append(inlineAttachment(pill(pageTitles[id] ?? "Page", size: size, fg: palette.text, bg: .clear, underline: true, icon: "file-text"), size: size))
            default:
                // Any other inline atom is one U+FFFC in the engine's text.
                out.append(inlineAttachment(pill("◻︎", size: size, fg: palette.textMuted, bg: .clear, underline: false), size: size))
            }
        }
        return out
    }

    /// A mention or page-link pill: padding 0 3, radius 4, weight 500.
    private func pill(_ text: String, size: CGFloat, fg: UIColor, bg: UIColor, underline: Bool, icon: String? = nil) -> UIImage {
        let f = font(size, weight: 500)
        let s = NSAttributedString(string: text, attributes: [.font: f, .foregroundColor: fg])
        let iconW: CGFloat = icon == nil ? 0 : size * 0.95 + 3
        let textWidth: CGFloat = s.size().width
        let w: CGFloat = 6 + iconW + textWidth
        let h: CGFloat = ceil(f.lineHeight) + 2
        return Self.image(CGSize(width: w, height: h)) { _ in
            bg.setFill()
            UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: w, height: h), cornerRadius: 4).fill()
            if let icon {
                UIImage.lucide(icon, size: size * 0.95, color: palette.textMuted)?.draw(at: CGPoint(x: 3, y: (h - size * 0.95) / 2))
            }
            s.draw(at: CGPoint(x: 3 + iconW, y: 1))
            if underline {
                palette.borderStrong.setFill()
                UIRectFill(CGRect(x: 0, y: h - 1, width: w, height: 1))
            }
        }
    }

    private func textRun(_ node: BoxNode, size: CGFloat, weight: Int, mono: Bool, ctx: Context) -> NSAttributedString {
        var w = weight
        var italic = false
        var code = mono
        var attrs: [NSAttributedString.Key: Any] = [.foregroundColor: ctx.color ?? palette.text]
        if ctx.checked {
            attrs[.foregroundColor] = palette.textMuted
            attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        }
        for mark in node.marks {
            switch mark.type {
            case "bold": w = 700
            case "italic": italic = true
            case "code": code = true
            case "underline": attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            case "strike": attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            case "textStyle":
                if let name = mark.attrs["color"] as? String, let c = palette.textColor(name) { attrs[.foregroundColor] = c }
            case "highlight":
                attrs[.backgroundColor] = palette.highlight(mark.attrs["color"] as? String)
            case "link":
                if let href = mark.attrs["href"] as? String { attrs[.nvHref] = href }
                attrs[.foregroundColor] = palette.accent
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            case "comment":
                attrs[.backgroundColor] = UIColor(red: 250 / 255, green: 204 / 255, blue: 21 / 255, alpha: 0.28)
                attrs[.underlineStyle] = NSUnderlineStyle.thick.rawValue
                attrs[.underlineColor] = UIColor(red: 234 / 255, green: 179 / 255, blue: 8 / 255, alpha: 0.8)
            default:
                break
            }
        }
        if code && !mono {
            attrs[.font] = WebType.mono(size * 0.88, w)
            if attrs[.backgroundColor] == nil { attrs[.backgroundColor] = palette.bgHover }
        } else {
            attrs[.font] = font(size, weight: w, italic: italic, mono: code)
        }
        return NSAttributedString(string: node.text, attributes: attrs)
    }

    func font(_ size: CGFloat, weight: Int = 400, italic: Bool = false, mono: Bool = false) -> UIFont {
        let base: UIFont = mono ? WebType.mono(size, weight) : WebType.ui(size, weight)
        guard italic, let d = base.fontDescriptor.withSymbolicTraits(base.fontDescriptor.symbolicTraits.union(.traitItalic)) else { return base }
        return UIFont(descriptor: d, size: size)
    }
}
