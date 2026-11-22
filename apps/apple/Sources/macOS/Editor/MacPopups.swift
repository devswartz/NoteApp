import AppKit
import SwiftUI

// The editing popups of the Mac canvas, as SwiftUI views the canvas hosts over the page: the floating formatting toolbar
// (FormattingMenu in src/editor/NoteEditor.tsx; LOOK.md 4.6), the `/`, `[[` and `@` menu (SlashMenu.tsx, PageLink.tsx,
// collabMentions.ts; LOOK.md 4.7) and the link editor (LinkEditor.tsx; LOOK.md 4.9). The sizes are the iPad's (they are the web's).

// MARK: Floating toolbar

/// Heading 1-3, Quote | Bold, Italic, Underline, Strikethrough, Code, Link, Text colour, Highlight | Task, Comment.
/// Padding 3, gap 1, `--bg-elevated`, 1 pt border, radius 10, buttons 30 × 30. The colour grid opens under it.
struct MacFormatToolbar: View {
    let palette: Palette
    /// "color" or "highlight" while that grid is open.
    let swatch: String?
    let run: (String, [String: Any]) -> Void
    let onLink: () -> Void
    let onComment: () -> Void
    let onSwatch: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            bar
            if let kind = swatch { grid(kind) }
        }
        .fixedSize()
    }

    private var bar: some View {
        HStack(spacing: 1) {
            icon("heading-1", "Heading 1") { run("setHeading", ["level": 1]) }
            icon("heading-2", "Heading 2") { run("setHeading", ["level": 2]) }
            icon("heading-3", "Heading 3") { run("setHeading", ["level": 3]) }
            icon("quote", "Quote") { run("toggleQuote", [:]) }
            separator
            icon("letter-b", "Bold") { run("toggleMark", ["mark": "bold"]) }
            icon("italic", "Italic") { run("toggleMark", ["mark": "italic"]) }
            icon("underline", "Underline") { run("toggleMark", ["mark": "underline"]) }
            icon("strikethrough", "Strikethrough") { run("toggleMark", ["mark": "strike"]) }
            icon("code-xml", "Code") { run("toggleMark", ["mark": "code"]) }
            icon("link-2", "Link") { onLink() }
            icon("baseline", "Text colour") { onSwatch("color") }
            icon("highlighter", "Highlight") { onSwatch("highlight") }
            separator
            word("circle-check", "Task") { run("convertToTask", [:]) }
            word("message-square", "Comment") { onComment() }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(palette.bgElevated.color))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(palette.border.color, lineWidth: 1))
        .shadowLg(palette)
    }

    private func icon(_ name: String, _ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name, 16, palette.text2.color).frame(width: 30, height: 30).contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(radius: 6, pressed: palette.bgPressed.color))
        .accessibilityLabel(label)
        .help(label)
    }

    private func word(_ name: String, _ text: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Icon(name, 16, palette.text2.color)
                Text(text).font(.web(13, 500)).foregroundStyle(palette.text2.color)
            }
            .padding(.horizontal, 8).frame(height: 30).contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(radius: 6, pressed: palette.bgPressed.color))
        .accessibilityLabel(text)
    }

    private var separator: some View {
        Rectangle().fill(palette.border.color).frame(width: 1, height: 18).padding(.horizontal, 3)
    }

    /// The colour grid (the ribbon's colour menus): a card under the toolbar, 3 across.
    private func grid(_ kind: String) -> some View {
        let names: [String?] = [nil] + Palette.colorNames.map { Optional($0) }
        return VStack(alignment: .leading, spacing: 4) {
            Text(kind == "color" ? "Text colour" : "Highlight").font(.web(12, 500)).foregroundStyle(palette.textMuted.color)
                .frame(height: 16).padding(.leading, 2)
            ForEach(0..<3, id: \.self) { row in
                HStack(spacing: 4) {
                    ForEach(0..<3, id: \.self) { col in
                        swatchButton(kind, names[row * 3 + col])
                    }
                }
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(palette.bgElevated.color))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(palette.border.color, lineWidth: 1))
        .shadowMd(palette)
    }

    private func swatchButton(_ kind: String, _ name: String?) -> some View {
        Button {
            if kind == "color" {
                if let name { run("setColor", ["color": name]) } else { run("unsetColor", [:]) }
            } else if let name {
                run("setHighlight", ["color": name])
            } else {
                run("unsetHighlight", [:])
            }
            onSwatch(kind)
        } label: {
            ZStack {
                if kind == "highlight", let name {
                    palette.highlight(name).color
                } else {
                    palette.bgElevated.color
                    if kind == "color" {
                        Text("A").font(.web(15, 600)).foregroundStyle((name.flatMap { palette.textColor($0) } ?? palette.text).color)
                    } else {
                        Icon("minus", 16, palette.textMuted.color)
                    }
                }
            }
            .frame(width: 32, height: 32)
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(palette.border.color, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: Suggestion menu

/// The `/` (Insert block), `[[` (Link to page) and `@` (people) menu: a card next to the caret.
struct MacSuggestionMenu: View {
    let content: MenuContent
    let palette: Palette
    let onPick: (Int) -> Void

    private static func rowHeight(_ kind: MenuContent.Kind) -> CGFloat { kind == .slash ? 48 : (kind == .page ? 36 : 30) }
    private static func header(_ kind: MenuContent.Kind) -> String? { kind == .slash ? "Insert block" : (kind == .page ? "Link to page" : nil) }

    /// Width, list height and total height (header 26, rows, 6 below; at most 320 in all).
    static func metrics(_ c: MenuContent) -> (width: CGFloat, list: CGFloat, total: CGFloat) {
        let width: CGFloat = c.kind == .mention ? 300 : 290
        let top: CGFloat = header(c.kind) == nil ? 6 : 32
        let gap: CGFloat = c.kind == .slash ? 3 : 1
        var inner: CGFloat = c.rows.isEmpty ? 32 : 0
        for _ in c.rows { inner += rowHeight(c.kind) + gap }
        inner += 6
        let list = min(inner, 320 - top)
        return (width, list, top + list)
    }

    var body: some View {
        let m = Self.metrics(content)
        VStack(alignment: .leading, spacing: 0) {
            if let h = Self.header(content.kind) {
                Text(h.uppercased()).font(.web(11, 600)).tracking(0.44).foregroundStyle(palette.textMuted.color)
                    .padding(.leading, 14).padding(.top, 10).frame(height: 26, alignment: .topLeading)
            } else {
                Color.clear.frame(height: 6)
            }
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: content.kind == .slash ? 3 : 1) {
                        if content.rows.isEmpty {
                            Text(content.emptyText ?? "").font(.web(12.5)).foregroundStyle(palette.textMuted.color)
                                .padding(.leading, 10).padding(.top, 6).frame(height: 32, alignment: .topLeading)
                        }
                        ForEach(Array(content.rows.enumerated()), id: \.offset) { i, row in
                            Button { onPick(i) } label: { rowView(row, highlighted: i == content.highlighted) }
                                .buttonStyle(.plain)
                                .id(i)
                        }
                    }
                    .padding(.horizontal, 6).padding(.bottom, 6)
                }
                .onChange(of: content.highlighted) { _, h in
                    if let h { proxy.scrollTo(h) }
                }
            }
            .frame(height: m.list)
        }
        .frame(width: m.width, height: m.total, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(palette.bgElevated.color))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(palette.border.color, lineWidth: 1))
        .shadowLg(palette)
    }

    @ViewBuilder
    private func rowView(_ row: MenuRow, highlighted: Bool) -> some View {
        let fill = highlighted ? palette.bgHover.color : Color.clear
        switch content.kind {
        case .slash:
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(palette.bg.color)
                    RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(palette.border.color, lineWidth: 1)
                    if let icon = row.icon { Icon(MenuIcons.name(icon), 18, palette.text2.color) }
                }
                .frame(width: 36, height: 36)
                VStack(alignment: .leading, spacing: 0) {
                    Text(row.title).font(.web(14, 500)).foregroundStyle(palette.text.color).lineLimit(1)
                    Text(row.detail ?? "").font(.web(12)).foregroundStyle(palette.textMuted.color).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).frame(height: 48)
            .background(fill, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(Rectangle())
        case .page:
            HStack(spacing: 10) {
                Icon(row.icon ?? "file-text", 15, palette.text2.color).frame(width: 24)
                VStack(alignment: .leading, spacing: 0) {
                    Text(row.title).font(.web(14, 500)).foregroundStyle(palette.text.color).lineLimit(1)
                    Text(row.detail ?? "").font(.web(12)).foregroundStyle(palette.textMuted.color).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).frame(height: 36)
            .background(fill, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(Rectangle())
        case .mention:
            HStack(spacing: 8) {
                Circle().fill((row.dot ?? palette.textMuted).color).frame(width: 8, height: 8)
                Text(row.title).font(.web(14)).foregroundStyle(palette.text.color).lineLimit(1).frame(width: 110, alignment: .leading)
                Text(row.detail ?? "").font(.web(12)).foregroundStyle(palette.textMuted.color).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).frame(height: 30)
            .background(fill, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(Rectangle())
        }
    }
}

// MARK: Link editor

/// A card with two fields, "Text" and "Address", and, when the selection is a link, Open link and Remove link. Enter applies,
/// Escape or a click elsewhere closes. `.link-editor`: padding 6, gap 4, 360 wide, labels 56 wide at 12 pt, 70 % opacity.
struct MacLinkEditor: View {
    static let height: CGFloat = 6 * 2 + 34 * 2 + 4

    let palette: Palette
    let hasLink: Bool
    let width: CGFloat
    let onApply: (String, String) -> Void
    let onRemove: () -> Void
    let onOpen: (String) -> Void
    let onCancel: () -> Void
    @State private var text: String
    @State private var address: String
    @FocusState private var focus: Field?

    private enum Field { case text, address }

    init(palette: Palette, text: String, address: String, width: CGFloat,
         onApply: @escaping (String, String) -> Void, onRemove: @escaping () -> Void,
         onOpen: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.palette = palette
        self.hasLink = !address.isEmpty
        self.width = width
        self.onApply = onApply
        self.onRemove = onRemove
        self.onOpen = onOpen
        self.onCancel = onCancel
        _text = State(initialValue: text)
        _address = State(initialValue: address)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                label("Text")
                field("Text to display", $text, .text)
            }
            HStack(spacing: 4) {
                label("Address")
                field("Paste or type a link…", $address, .address)
                if hasLink {
                    iconButton("external-link", "Open link") { onOpen(address) }
                    iconButton("link-2-off", "Remove link") { onRemove() }
                }
            }
        }
        .padding(6)
        .frame(width: width, height: Self.height, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(palette.bgElevated.color))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(palette.border.color, lineWidth: 1))
        .shadowLg(palette)
        .onExitCommand { onCancel() }
        .onAppear {
            // An existing link or selected text: straight to the address; a new link with nothing selected: its text first.
            DispatchQueue.main.async { focus = (hasLink || !text.isEmpty) ? .address : .text }
        }
    }

    private func label(_ s: String) -> some View {
        Text(s).font(.web(12)).foregroundStyle(palette.text.color.opacity(0.7)).frame(width: 56, height: 34, alignment: .leading)
    }

    private func field(_ placeholder: String, _ binding: Binding<String>, _ f: Field) -> some View {
        let on = focus == f
        return TextField("", text: binding, prompt: Text(placeholder).foregroundColor(palette.textPlaceholder.color))
            .textFieldStyle(.plain)
            .font(.web(14))
            .foregroundStyle(palette.text.color)
            .focused($focus, equals: f)
            .onSubmit { onApply(text, address) }
            .onExitCommand { onCancel() }
            .padding(.horizontal, 10).frame(height: 34)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(palette.bg.color))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(on ? palette.accent.color : palette.border.color, lineWidth: 1))
            .overlay(
                RoundedRectangle(cornerRadius: 11, style: .continuous).stroke(palette.accentSoft.color, lineWidth: 3)
                    .padding(-3).opacity(on ? 1 : 0).allowsHitTesting(false))
    }

    private func iconButton(_ name: String, _ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name, 15, palette.text2.color).frame(width: 32, height: 32).contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(radius: 8, pressed: palette.bgPressed.color))
        .accessibilityLabel(title)
        .help(title)
    }
}
