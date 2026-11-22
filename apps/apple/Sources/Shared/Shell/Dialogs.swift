import NotiveloCore
import SwiftUI

// The web's dialogs (`ui.tsx` Dialog, `shell/dialogs.tsx`, `MoveDialog.tsx`, `NewNotebookDialog.tsx`), the
// offline banner (`Overlays.tsx`) and the loading skeletons (`ui.tsx`, `NotesPanel.tsx`).

// MARK: Dialog parts

/// `.btn`: 32 high, 0 12 padding, radius 8, 14/500. Ghost, primary or danger.
struct DialogButton: View {
    enum Style { case ghost, primary, danger }
    let title: String
    var style: Style = .ghost
    var enabled = true
    let action: () -> Void
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let fg: Color = style == .ghost ? p.text2.color : .white
        let bg: Color = style == .primary ? p.accentSolid.color : style == .danger ? p.danger.color : .clear
        Button(action: action) {
            Text(title).font(.web(14, 500)).foregroundStyle(fg)
                .padding(.horizontal, 12).frame(height: 32)
                .background(bg, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
    }
}

/// `.input` (34 high, 1 pt border, radius 8, accent ring when focused) under a `.field-label` (12.5/500 `--text-2`).
struct DialogField: View {
    let label: String?
    let placeholder: String
    @Binding var text: String
    var icon: String?
    var focused: FocusState<Bool>.Binding
    var onSubmit: () -> Void = {}
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        VStack(alignment: .leading, spacing: 6) {
            if let label { Text(label).font(.web(12.5, 500)).foregroundStyle(p.text2.color) }
            HStack(spacing: 8) {
                if let icon { Icon(icon, 15, p.textMuted.color) }
                TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(p.textPlaceholder.color))
                    .font(.web(14))
                    .foregroundStyle(p.text.color)
                    .tint(p.accent.color)
                    .focused(focused)
                    .submitLabel(.done)
                    .onSubmit(onSubmit)
            }
            .padding(.horizontal, 10)
            .frame(height: 34)
            .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(focused.wrappedValue ? p.accent.color : p.border.color, lineWidth: 1))
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(focused.wrappedValue ? p.accentSoft.color : .clear, lineWidth: 6))
        }
    }
}

/// `.modal.dialog`: `--bg-elevated`, 1 pt border, radius 14, `--shadow-lg`; head (title 17/600, close), description, body, footer.
struct DialogCard<Inner: View, Foot: View>: View {
    let title: String
    var description: String?
    let width: CGFloat
    let close: () -> Void
    var hasBody = true
    var hasFoot = true
    @ViewBuilder let content: () -> Inner
    @ViewBuilder let foot: () -> Foot
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(title).font(.web(17, 600)).tracking(-0.255).foregroundStyle(p.text.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(action: close) { Icon("x", 16, p.textMuted.color).frame(width: 28, height: 28) }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
            }
            .padding(.top, 16).padding(.trailing, 16).padding(.leading, 20)
            if let description {
                Text(description).font(.web(14)).foregroundStyle(p.text2.color).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 20).padding(.top, 4)
            }
            if hasBody { content().padding(.horizontal, 20).padding(.vertical, 16) }
            if hasFoot {
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    foot()
                }
                .padding(.horizontal, 20).padding(.top, hasBody ? 0 : 12).padding(.bottom, 16)
            }
        }
        .frame(width: width, alignment: .leading)
        .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(p.border.color, lineWidth: 1))
        .shadowLg(p)
    }
}

// MARK: The layer

/// Every tree dialog of the shell, over a dimmed screen (`--bg-overlay`) at 12 % of the height; a tap outside closes it.
struct DialogLayer: View {
    let width: CGFloat
    let height: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone
    let theme = Theme.shared

    var body: some View {
        if let dialog = shell.dialog {
            let p = theme.chrome
            ZStack(alignment: .top) {
                p.bgOverlay.color.contentShape(Rectangle()).onTapGesture { shell.dialog = nil }
                card(dialog)
                    .padding(.top, height * 0.12)
            }
            .frame(width: width, height: height)
        }
    }

    @ViewBuilder private func card(_ dialog: TreeDialog) -> some View {
        switch dialog.body {
        case let .prompt(title, label, placeholder, confirm):
            PromptCard(dialog: dialog, title: title, label: label, placeholder: placeholder, confirm: confirm, width: min(400, width - 32))
        case let .confirm(title, message, confirm):
            ConfirmCard(dialog: dialog, title: title, message: message, confirm: confirm, width: min(400, width - 32))
        case let .move(kind, id):
            MoveCard(dialog: dialog, kind: kind, id: id, width: min(400, width - 32), listHeight: height * 0.5)
        case .newNotebook:
            NewNotebookCard(dialog: dialog, width: min(560, width - 32))
        }
    }
}

/// `promptDialog`: one named field; "Create" / "Save", disabled while empty.
struct PromptCard: View {
    let dialog: TreeDialog
    let title: String
    let label: String
    let placeholder: String
    let confirm: String
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        let ok = !text.trimmingCharacters(in: .whitespaces).isEmpty
        DialogCard(title: title, width: width, close: { shell.dialog = nil }) {
            DialogField(label: label, placeholder: placeholder, text: $text, focused: $focused) { if ok { send() } }
        } foot: {
            DialogButton(title: "Cancel") { shell.dialog = nil }
            DialogButton(title: confirm, style: .primary, enabled: ok) { send() }
        }
        .onAppear { if LookData.state == nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { focused = true } } }
    }

    private func send() { shell.submit(dialog, text: text.trimmingCharacters(in: .whitespaces), session) }
}

/// `confirmDialog`: a question, "Cancel" and the (danger) action.
struct ConfirmCard: View {
    let dialog: TreeDialog
    let title: String
    let message: String
    let confirm: String
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session

    var body: some View {
        DialogCard(title: title, description: message, width: width, close: { shell.dialog = nil }, hasBody: false) {
            EmptyView()
        } foot: {
            DialogButton(title: "Cancel") { shell.dialog = nil }
            DialogButton(title: confirm, style: .danger) { shell.submit(dialog, session) }
        }
    }
}

/// `MoveDialog`: filter box, then the destinations by notebook (a page: sections; a section: "Top level" or a parent section).
struct MoveCard: View {
    let dialog: TreeDialog
    let kind: TreeKind
    let id: String
    let width: CGFloat
    let listHeight: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var query = ""
    @FocusState private var focused: Bool
    let theme = Theme.shared

    private struct Option: Identifiable {
        let id: String
        let notebook: String
        let section: String?
        let label: String
        let level: Int
        let color: String?
    }

    var body: some View {
        let p = theme.chrome
        let tree = session.shownTree ?? Tree(notebooks: [], sections: [], pages: [])
        let index = TreeIndex(tree)
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let current: String? = kind == .page
            ? tree.pages.first { $0.id == id }?.sectionId
            : tree.sections.first { $0.id == id }.map { $0.parentId ?? $0.notebookId }
        DialogCard(title: kind == .page ? "Move page to…" : "Move section to…", width: width, close: { shell.dialog = nil }, hasFoot: false) {
            VStack(alignment: .leading, spacing: 12) {
                DialogField(label: nil, placeholder: "Filter…", text: $query, icon: "search", focused: $focused)
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(index.notebooks, id: \.id) { nb in
                            let opts = options(nb, tree, index, needle)
                            if !opts.isEmpty {
                                Text(nb.name).font(.web(11.5, 600)).foregroundStyle(p.textMuted.color)
                                    .padding(.horizontal, 8).padding(.top, 8).padding(.bottom, 4)
                                ForEach(opts) { o in
                                    Button { shell.submit(dialog, destination: o.section ?? o.notebook, session) } label: {
                                        let selected = (o.section ?? o.notebook) == current
                                        HStack(spacing: 8) {
                                            if let color = o.color {
                                                RoundedRectangle(cornerRadius: 2).fill(PlatformColor(css: color).color).frame(width: 4, height: 14)
                                            } else {
                                                LetterTile(letter: nb.name, fill: AnyShapeStyle(PlatformColor(css: nb.color).color), size: 18, radius: 5, fontSize: 10)
                                            }
                                            Text(o.label).font(.web(14)).foregroundStyle((selected ? p.accent : p.text).color).lineLimit(1)
                                            Spacer(minLength: 0)
                                            if selected { Icon("check", 14, p.accent.color) }
                                        }
                                        .padding(.leading, o.level > 1 ? CGFloat(o.level - 1) * 16 + 8 : 8).padding(.trailing, 8)
                                        .frame(height: 34)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
                                }
                            }
                        }
                    }
                }
                .frame(maxHeight: listHeight)
            }
        } foot: {
            EmptyView()
        }
        .onAppear { if LookData.state == nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { focused = true } } }
    }

    private func options(_ nb: Notebook, _ tree: Tree, _ index: TreeIndex, _ needle: String) -> [Option] {
        var out: [Option] = []
        if kind == .section, needle.isEmpty || nb.name.lowercased().contains(needle) {
            out.append(Option(id: "nb-\(nb.id)", notebook: nb.id, section: nil, label: "Top level", level: 1, color: nil))
        }
        func visit(_ sections: [CoreSection], _ level: Int, _ path: [String]) {
            for s in sections {
                let names = path + [s.name]
                let label = ([nb.name] + names).joined(separator: " › ").lowercased()
                let allowed = kind == .page || SectionRules.canNest(id, under: s.id, tree)
                if allowed, needle.isEmpty || label.contains(needle) {
                    out.append(Option(id: s.id, notebook: nb.id, section: s.id, label: s.name, level: level, color: s.color))
                }
                visit(index.sections(in: s), level + 1, names)
            }
        }
        visit(index.sections(in: nb), 1, [])
        return out
    }
}

/// `NewNotebookDialog`: a name and a starting structure.
struct NewNotebookCard: View {
    let dialog: TreeDialog
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var name = ""
    @State private var touched = false
    @State private var templateId = "blank"
    @FocusState private var focused: Bool
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let ok = !name.trimmingCharacters(in: .whitespaces).isEmpty
        let template = NotebookTemplate.all.first { $0.id == templateId } ?? NotebookTemplate.all[0]
        let columns = [GridItem(.adaptive(minimum: 150), spacing: 8, alignment: .top)]
        DialogCard(title: "New notebook", width: width, close: { shell.dialog = nil }) {
            VStack(alignment: .leading, spacing: 12) {
                DialogField(label: "Name", placeholder: "e.g. Projects", text: Binding(get: { name }, set: { name = $0; touched = true }), focused: $focused) { if ok { send() } }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Start with").font(.web(12.5, 500)).foregroundStyle(p.text2.color)
                    LazyVGrid(columns: columns, spacing: 8) {
                        ForEach(NotebookTemplate.all) { t in
                            let active = t.id == templateId
                            Button {
                                templateId = t.id
                                if !touched { name = t.notebookName }
                            } label: {
                                HStack(alignment: .center, spacing: 8) {
                                    Text(t.icon).font(.system(size: 22))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(t.name).font(.web(14, 600)).foregroundStyle(p.text.color)
                                        Text(t.description).font(.web(11.5)).lineSpacing(2).foregroundStyle(p.textMuted.color)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(active ? p.accentSoft.color : p.bg.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .stroke(active ? p.accent.color : p.border.color, lineWidth: active ? 2 : 1))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    if template.id != "blank" {
                        Text("Creates \(template.sections.joined(separator: ", ")). Each page offers page templates when you open it.")
                            .font(.web(11.5)).foregroundStyle(p.textMuted.color).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        } foot: {
            DialogButton(title: "Cancel") { shell.dialog = nil }
            DialogButton(title: "Create", style: .primary, enabled: ok) { send() }
        }
        .onAppear { if LookData.state == nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { focused = true } } }
    }

    private func send() { shell.submit(dialog, text: name.trimmingCharacters(in: .whitespaces), destination: templateId, session) }
}

// MARK: Offline banner

/// `OfflineBanner`: a small pill at the bottom centre after 30 s without a connection; its X keeps it away until
/// the next reconnect (`.offline-banner`: padding 5 6 5 12, border, `--bg-elevated`, 11.5 muted, warn dot 7).
struct OfflineBanner: View {
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone
    @State private var late = false
    @State private var dismissed = false
    let theme = Theme.shared

    /// CI's `offline-banner` look state is offline from the start, with no wait.
    private var offline: Bool { LookData.state == "offline-banner" || !session.online }

    var body: some View {
        let p = theme.chrome
        ZStack {
            Color.clear.frame(width: 0, height: 0)
            if offline && (late || LookData.state == "offline-banner") && !dismissed {
                HStack(spacing: 8) {
                    Circle().fill(p.warn.color).frame(width: 7, height: 7)
                    Text("Offline. Changes sync when you reconnect.").font(.web(11.5)).foregroundStyle(p.textMuted.color).lineLimit(1)
                    Button { dismissed = true } label: {
                        Icon("x", 12, p.textMuted.color).frame(width: 20, height: 20)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss")
                }
                .padding(.leading, 12).padding(.trailing, 6).padding(.vertical, 5)
                .background(p.bgElevated.color, in: Capsule())
                .overlay(Capsule().stroke(p.border.color, lineWidth: 1))
                .shadow(color: .black.opacity(0.12), radius: 4, y: 2)
                .padding(.bottom, phone ? 72 : 12)
                .transition(.opacity)
            }
        }
        .task(id: offline) {
            if offline {
                try? await _Concurrency.Task.sleep(nanoseconds: 30_000_000_000)
                if !_Concurrency.Task.isCancelled { late = true }
            } else {
                late = false
                dismissed = false
            }
        }
    }
}

// MARK: Loading

/// `.skeleton`: a 4 pt bar with the shimmering `--skeleton` gradient.
struct SkeletonBar: View {
    var width: CGFloat?
    var height: CGFloat
    @State private var moved = false
    let theme = Theme.shared

    var body: some View {
        let dark = theme.chrome.isDark
        let base = dark ? Color.white.opacity(0.06) : Color(red: 15 / 255, green: 15 / 255, blue: 30 / 255).opacity(0.06)
        let shine = dark ? Color.white.opacity(0.10) : Color(red: 15 / 255, green: 15 / 255, blue: 30 / 255).opacity(0.02)
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(LinearGradient(stops: [.init(color: base, location: 0), .init(color: base, location: 0.25), .init(color: shine, location: 0.5),
                                         .init(color: base, location: 0.75), .init(color: base, location: 1)],
                                 startPoint: UnitPoint(x: moved ? -1 : 1, y: 0.5), endPoint: UnitPoint(x: moved ? 1 : 3, y: 0.5)))
            .frame(width: width, height: height)
            .onAppear { withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: false)) { moved = true } }
    }
}

/// `TreeSkeleton`: four rows (a section, then three pages) while the tree loads.
struct TreeSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array([70, 55, 62, 48].enumerated()), id: \.offset) { i, w in
                HStack(spacing: 8) {
                    SkeletonBar(width: 14, height: 14)
                    GeometryReader { g in SkeletonBar(width: max(0, (g.size.width) * CGFloat(w) / 100), height: 10).frame(maxHeight: .infinity, alignment: .center) }
                        .frame(height: 10)
                }
                .padding(.leading, i == 0 ? 8 : 28)
            }
        }
        .padding(.vertical, 6)
        .accessibilityHidden(true)
    }
}
