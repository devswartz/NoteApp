import NotiveloCore
import SwiftUI

/// One row of the search palette.
struct SearchHit: Identifiable {
    enum Kind { case page(String), task(String), create }
    let id: String
    let kind: Kind
    var icon: String
    var title: String
    /// Right-aligned, muted: "Notebook › Section", a due date, or the path and snippet of a content hit.
    var sub: String?
    var done = false
}

/// What the web's palette finds (CommandPalette.tsx): pages by title (and, from the server's search, by their text),
/// tasks by title, and "Create task …". The core has no search call yet (requested), so page text isn't searched.
enum SearchLogic {
    static func crumb(_ sectionId: String, _ tree: Tree) -> String {
        let notebooks = Dictionary(tree.notebooks.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        let sections = Dictionary(tree.sections.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var names: [String] = []
        var current = sections[sectionId]
        var guardCount = 0
        while let s = current, guardCount < 12 {
            names.insert(s.name, at: 0)
            if let parent = s.parentId {
                current = sections[parent]
            } else {
                if let n = notebooks[s.notebookId] { names.insert(n, at: 0) }
                current = nil
            }
            guardCount += 1
        }
        return names.joined(separator: " › ")
    }

    static func groups(query q: String, session: SessionModel) -> [(title: String, hits: [SearchHit])] {
        let tree = session.shownTree ?? Tree(notebooks: [], sections: [], pages: [])
        let needle = q.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        func pageHit(_ p: PageMeta) -> SearchHit {
            SearchHit(id: "p:\(p.id)", kind: .page(p.id), icon: "file-text", title: p.title.isEmpty ? "Untitled" : p.title,
                      sub: crumb(p.sectionId, tree))
        }
        if needle.isEmpty {
            let recent = tree.pages.filter { !$0.locked }.sorted { $0.updatedAt > $1.updatedAt }.prefix(6)
            return recent.isEmpty ? [] : [("Recent pages", recent.map { pageHit($0) })]
        }
        var pages = tree.pages.filter { !$0.locked && (($0.title.isEmpty ? "untitled" : $0.title).lowercased().contains(needle)) }
            .prefix(8).map { pageHit($0) }
        var tasks: [SearchHit] = []
        func taskHit(id: String, title: String, due: String?, done: Bool) -> SearchHit {
            SearchHit(id: "t:\(id)", kind: .task(id), icon: "circle-check", title: title.isEmpty ? "Untitled task" : title,
                      sub: Due.words(due), done: done)
        }
        if session.preview {
            // Corpus mode: the look seed's pages and tasks (what the search reference finds).
            for e in LookData.searchPages where e.title.lowercased().contains(needle) {
                pages.append(SearchHit(id: "p:\(e.id)", kind: .page(e.id), icon: "file-text", title: e.title, sub: e.crumb))
            }
            for e in LookData.searchPages {
                guard let snippet = e.snippet, !e.title.lowercased().contains(needle) else { continue }
                let plain = snippet.replacingOccurrences(of: "«", with: "").replacingOccurrences(of: "»", with: "").lowercased()
                guard plain.contains(needle) else { continue }
                pages.append(SearchHit(id: "p:\(e.id)", kind: .page(e.id), icon: "file-text", title: e.title, sub: "\(e.crumb) · \(snippet)"))
            }
            for e in LookData.searchTasks where e.title.lowercased().contains(needle) {
                tasks.append(taskHit(id: e.id, title: e.title, due: LookData.day(e.due), done: false))
            }
        } else {
            let found = session.shownTasks.filter { !$0.locked && $0.title.lowercased().contains(needle) }
            let ordered = found.filter { !session.isDone($0) } + found.filter { session.isDone($0) }
            tasks = ordered.prefix(8).map { taskHit(id: $0.id, title: $0.title, due: $0.dueDate, done: session.isDone($0)) }
        }
        var out: [(title: String, hits: [SearchHit])] = []
        if !pages.isEmpty { out.append(("Pages", pages)) }
        if !tasks.isEmpty { out.append(("Tasks", tasks)) }
        out.append(("", [SearchHit(id: "create", kind: .create, icon: "plus", title: q)]))
        return out
    }

    /// "…text «hit» text…" as a run with the hits marked (the web's `mark`).
    static func marked(_ s: String, mark: Color) -> AttributedString {
        var out = AttributedString()
        var rest = Substring(s)
        while let open = rest.firstIndex(of: "«"), let close = rest[open...].firstIndex(of: "»") {
            out += AttributedString(String(rest[..<open]))
            var m = AttributedString(String(rest[rest.index(after: open)..<close]))
            m.backgroundColor = mark
            out += m
            rest = rest[rest.index(after: close)...]
        }
        out += AttributedString(String(rest))
        return out
    }
}

/// The search palette (CommandPalette.tsx, LOOK.md 4.12): a card at 12 % of the height on the iPad, a top sheet on phones.
struct SearchLayer: View {
    let width: CGFloat
    let height: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone
    @State private var index = 0
    @State private var contentHeight: CGFloat = 0
    @FocusState private var focused: Bool
    let theme = Theme.shared

    var body: some View {
        if shell.searchOpen {
            let p = theme.chrome
            ZStack(alignment: .top) {
                p.bgOverlay.color.contentShape(Rectangle()).onTapGesture { shell.closeSearch() }
                palette(p).padding(.top, phone ? 0 : height * 0.12)
            }
            .frame(width: width, height: height)
        }
    }

    private func palette(_ p: Palette) -> some View {
        let groups = SearchLogic.groups(query: shell.searchQuery, session: session)
        let flat = groups.flatMap { $0.hits }
        let w: CGFloat = phone ? width : min(620, width - 32)
        let radii: RectangleCornerRadii = phone
            ? .init(topLeading: 0, bottomLeading: 16, bottomTrailing: 16, topTrailing: 0)
            : .init(topLeading: 14, bottomLeading: 14, bottomTrailing: 14, topTrailing: 14)
        let shape = UnevenRoundedRectangle(cornerRadii: radii, style: .continuous)
        let maxList: CGFloat = phone ? height - 120 : min(420, height * 0.55)
        let query = Binding(get: { shell.searchQuery }, set: { shell.searchQuery = $0 })
        return VStack(spacing: 0) {
            HStack(spacing: 10) {
                Icon("search", 18, p.textMuted.color)
                TextField("", text: query, prompt: Text("Search pages and tasks, or type a command…").foregroundStyle(p.textPlaceholder.color))
                    .font(.web(16))
                    .foregroundStyle(p.text.color)
                    .tint(p.accent.color)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .focused($focused)
                    .onSubmit { if flat.indices.contains(index) { run(flat[index]) } }
                    .onKeyPress(.downArrow) { index = min(flat.count - 1, index + 1); return .handled }
                    .onKeyPress(.upArrow) { index = max(0, index - 1); return .handled }
                    .onKeyPress(.escape) { shell.closeSearch(); return .handled }
                    .frame(height: 52)
            }
            .padding(.horizontal, 16)
            .frame(height: 53, alignment: .top)
            .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(groups.enumerated()), id: \.offset) { _, g in
                            if !g.title.isEmpty {
                                Text(g.title.uppercased()).font(.web(11.5, 600)).tracking(0.35).foregroundStyle(p.textMuted.color)
                                    .padding(.horizontal, 10).padding(.bottom, 4).frame(height: 30, alignment: .bottom)
                            }
                            ForEach(g.hits) { hit in
                                row(hit, active: flat.firstIndex(where: { $0.id == hit.id }) == index, p: p, rowWidth: w - 12 - 20 - 26)
                                    .id(hit.id)
                            }
                        }
                    }
                    .padding(6)
                    .background(GeometryReader { g in Color.clear.preference(key: SearchHeightKey.self, value: g.size.height) })
                }
                .onPreferenceChange(SearchHeightKey.self) { contentHeight = $0 }
                .frame(height: min(max(contentHeight, 1), maxList))
                .onChange(of: index) { _, i in if flat.indices.contains(i) { proxy.scrollTo(flat[i].id) } }
            }

            if !phone {
                Text("↑↓ navigate · ↵ open · ⌘↵ complete task · esc close").font(.web(12.5)).foregroundStyle(p.textMuted.color)
                    .padding(.horizontal, 14).frame(height: 36, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .top) { Rectangle().fill(p.border.color).frame(height: 1) }
            }
        }
        .frame(width: w)
        .background(p.bgElevated.color, in: shape)
        .overlay(shape.stroke(p.border.color, lineWidth: 1))
        .clipShape(shape)
        .shadowLg(p)
        .onChange(of: shell.searchQuery) { index = 0 }
        .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { focused = true } }
        .background {
            Button("") {
                if flat.indices.contains(index), case let .task(id) = flat[index].kind, let t = session.shownTasks.first(where: { $0.id == id }) {
                    session.setDone(t, !session.isDone(t))
                }
            }
            .keyboardShortcut(.return, modifiers: .command).opacity(0).accessibilityHidden(true)
        }
    }

    private func row(_ hit: SearchHit, active: Bool, p: Palette, rowWidth: CGFloat) -> some View {
        let size: CGFloat = phone ? 15 : 14
        return Button { run(hit) } label: {
            HStack(spacing: 10) {
                Icon(hit.icon, 16, (hit.done ? p.success : p.textMuted).color).frame(width: 16)
                label(hit, p, size)
                    .lineLimit(1)
                    .frame(maxWidth: rowWidth * 0.6, alignment: .leading)
                if let sub = hit.sub {
                    Text(SearchLogic.marked(sub, mark: Color(red: 250 / 255, green: 204 / 255, blue: 21 / 255).opacity(0.35)))
                        .font(.web(12.5)).foregroundStyle(p.textMuted.color)
                        .lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                } else {
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: phone ? 44 : 38)
            .background(active ? p.bgHover.color : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func label(_ hit: SearchHit, _ p: Palette, _ size: CGFloat) -> Text {
        if case .create = hit.kind {
            var a = AttributedString("Create task “")
            var b = AttributedString(hit.title)
            b.font = .web(size, 700)
            a += b
            a += AttributedString("”")
            return Text(a).font(.web(size)).foregroundStyle(p.text.color)
        }
        return Text(hit.title).font(.web(size)).strikethrough(hit.done).foregroundStyle(p.text.color)
    }

    private func run(_ hit: SearchHit) {
        switch hit.kind {
        case let .page(id):
            shell.closeSearch()
            if let page = session.shownTree?.pages.first(where: { $0.id == id }) {
                shell.expanded.insert(page.sectionId)
                shell.open(page: id)
            } else {
                shell.say("That page isn’t in the native preview.")
            }
        case let .task(id):
            if session.shownTasks.contains(where: { $0.id == id }) {
                shell.openTask(id)
            } else {
                shell.closeSearch()
                shell.say("That task isn’t in the native preview.")
            }
        case .create:
            shell.closeSearch()
            shell.notYet("Adding tasks")
        }
    }
}

private struct SearchHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
