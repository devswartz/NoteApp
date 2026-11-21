import NotiveloCore
import SwiftUI

/// The sidebar panel (LOOK.md 4.3): the notes tree (notebook picker, RECENT, SECTIONS with pages
/// folded in) or, on Tasks, the task views.
struct Sidebar: View {
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        Group {
            if case .tasks = shell.route {
                TasksPanel()
            } else {
                NotesPanel()
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(theme.chrome.bgSidebar.color)
    }
}

/// Which notebook the sidebar shows: the open page's, else the one picked, else the first.
func currentNotebook(_ tree: Tree?, _ shell: Shell) -> Notebook? {
    guard let tree else { return nil }
    let index = TreeIndex(tree)
    var sectionId: String?
    switch shell.route {
    case let .page(id): sectionId = tree.pages.first(where: { $0.id == id })?.sectionId
    case let .section(id): sectionId = id
    default: break
    }
    if let sid = sectionId, let s = tree.sections.first(where: { $0.id == sid }),
       let nb = index.notebooks.first(where: { $0.id == s.notebookId }) {
        return nb
    }
    return index.notebooks.first { $0.id == shell.notebookId } ?? index.notebooks.first
}

struct NotesPanel: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let tree = session.shownTree
        let notebook = currentNotebook(tree, shell)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Button { shell.menu = .notebookPicker } label: {
                    HStack(spacing: 8) {
                        if let notebook {
                            LetterTile(letter: notebook.name, fill: AnyShapeStyle(UIColor(css: notebook.color).color), size: 22, radius: 6, fontSize: 12)
                            Text(notebook.name).font(.web(14, 650)).foregroundStyle(p.text.color).lineLimit(1).truncationMode(.tail)
                            if notebook.visibility == "private" { Icon("lock", 12, p.textMuted.color) }
                        } else {
                            Text("Notebooks").font(.web(14, 650)).foregroundStyle(p.text.color)
                        }
                        Spacer(minLength: 0)
                        Icon("chevron-down", 14, p.textMuted.color)
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 36)
                }
                .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
                .anchor("notebook-picker", shell)
                Button { shell.menu = .notebookOptions } label: {
                    Icon("ellipsis", 15, p.textMuted.color).frame(width: 24, height: 24)
                }
                .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                .anchor("notebook-options", shell)
            }
            .padding(.top, 10)
            .padding(.horizontal, 8)
            .padding(.bottom, 6)
            .frame(minHeight: 52)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let tree, let notebook {
                        let index = TreeIndex(tree)
                        let recents = shell.recents.compactMap { id in tree.pages.first { $0.id == id } }
                        if !recents.isEmpty {
                            VStack(alignment: .leading, spacing: 0) {
                                GroupHeading(title: "Recent", icon: "clock", open: shell.recentOpen, plus: nil) {
                                    shell.recentOpen.toggle()
                                }
                                if shell.recentOpen {
                                    ForEach(recents, id: \.id) { page in PageRowView(page: page, depth: -1) }
                                }
                            }
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            GroupHeading(title: "Sections", icon: nil, open: true, plus: { shell.notYet("New section") }, toggle: {})
                            let sections = index.sections(in: notebook)
                            if sections.isEmpty {
                                Text("No sections yet. Add one").font(.web(12.5)).foregroundStyle(p.textMuted.color).padding(.horizontal, 6).padding(.vertical, 4)
                            }
                            ForEach(sections, id: \.id) { section in
                                SectionNode(section: section, index: index, depth: 0)
                            }
                        }
                    } else if tree != nil {
                        HStack(spacing: 4) {
                            Text("No notebooks yet.").foregroundStyle(p.textMuted.color)
                            Text("Create one").foregroundStyle(p.accent.color)
                        }
                        .font(.web(12.5))
                        .padding(.horizontal, 6)
                    } else if session.loading {
                        Text("Loading…").font(.web(12.5)).foregroundStyle(p.textMuted.color).padding(.horizontal, 6)
                    }
                    if let error = session.loadError {
                        Text(error).font(.web(12.5)).foregroundStyle(p.danger.color).padding(.horizontal, 6)
                    }
                }
                .padding(.top, 4)
                .padding(.horizontal, 8)
                .padding(.bottom, 16)
            }
            .refreshable { await session.refresh() }
        }
    }
}

/// A group heading: SECTIONS, RECENT … (11.5/600 uppercase muted, 26 high, optional "+").
struct GroupHeading: View {
    let title: String
    let icon: String?
    let open: Bool
    let plus: (() -> Void)?
    var toggle: () -> Void
    let theme = Theme.shared

    init(title: String, icon: String?, open: Bool, plus: (() -> Void)?, toggle: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.open = open
        self.plus = plus
        self.toggle = toggle
    }

    var body: some View {
        let p = theme.chrome
        HStack(spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 4) {
                    if let icon { Icon(icon, 12, p.textMuted.color) }
                    Text(title.uppercased()).font(.web(11.5, 600)).tracking(0.46).foregroundStyle(p.textMuted.color)
                    if !open { Icon("chevron-right", 12, p.textMuted.color) }
                }
                .padding(.horizontal, 6)
                .frame(height: 22)
            }
            .buttonStyle(PressStyle(radius: 4, pressed: p.bgPressed.color))
            Spacer(minLength: 0)
            if let plus {
                Button(action: plus) { Icon("plus", 15, p.text2.color).frame(width: 24, height: 24) }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
            }
        }
        .frame(minHeight: 26)
    }
}

/// A section row with its pages and subsections folded in (≤ 1199 pt: one sidebar panel).
struct SectionNode: View {
    let section: CoreSection
    let index: TreeIndex
    let depth: Int
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let open = shell.expanded.contains(section.id)
        let selected = isSelected
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Icon("chevron-down", 13, p.textMuted.color)
                    .rotationEffect(.degrees(open ? 0 : -90))
                    .frame(width: 14)
                RoundedRectangle(cornerRadius: 2).fill(UIColor(css: section.color).color).frame(width: 4, height: 14)
                Text(section.name)
                    .font(.web(14, selected ? 600 : 400))
                    .foregroundStyle(selected ? p.accent.color : p.text2.color)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.leading, 6 + 14 * CGFloat(depth))
            .padding(.trailing, 6)
            .frame(height: 30)
            .background(selected ? p.bgActive.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .contentShape(Rectangle())
            .onTapGesture {
                if open { shell.expanded.remove(section.id) } else { shell.expanded.insert(section.id) }
            }
            .onLongPressGesture(minimumDuration: 0.5) { shell.menu = .section(section.id) }
            .anchor("section:\(section.id)", shell)

            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(index.sections(in: section), id: \.id) { child in
                        SectionNode(section: child, index: index, depth: depth + 1)
                    }
                    let pages = index.pages(in: section)
                    ForEach(pages, id: \.id) { page in
                        PageRowView(page: page, depth: depth)
                    }
                    if pages.isEmpty && index.sections(in: section).isEmpty {
                        HStack(spacing: 6) {
                            Icon("plus", 14, p.textMuted.color)
                            Text("New page").font(.web(14)).foregroundStyle(p.text2.color)
                            Spacer(minLength: 0)
                        }
                        .padding(.leading, 6 + 14 * CGFloat(depth + 1) + 20)
                        .frame(height: 28)
                        .contentShape(Rectangle())
                        .onTapGesture { shell.notYet("New page") }
                    }
                }
                .padding(.leading, 4)
                .overlay(alignment: .leading) { Rectangle().fill(p.border.color).frame(width: 1) }
                .padding(.leading, 18)
            }
        }
    }

    /// The open page is in this section (or it is the open section).
    private var isSelected: Bool {
        switch shell.route {
        case let .page(id): return index.pages(in: section).contains { $0.id == id }
        case let .section(id): return id == section.id
        default: return false
        }
    }
}

/// A page row: 28 high, FileText 14 (or the page's emoji), title, open task count.
struct PageRowView: View {
    let page: PageMeta
    /// The section's depth; -1 in RECENT (no indent).
    let depth: Int
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let active = shell.route == .page(page.id)
        let count = session.openTaskCount(page: page.id)
        HStack(spacing: 6) {
            if let icon = page.icon, !icon.isEmpty {
                Text(icon).font(.system(size: 13)).frame(width: 14)
            } else {
                Icon(page.locked ? "lock" : "file-text", 14, p.textMuted.color)
            }
            Text(page.title.isEmpty ? "Untitled" : page.title)
                .font(.web(14, active ? 500 : 400))
                .foregroundStyle(active ? p.accent.color : p.text2.color)
                .lineLimit(1)
            Spacer(minLength: 0)
            if count > 0 {
                HStack(spacing: 3) {
                    Icon("circle-check", 11, p.textMuted.color)
                    Text("\(count)").font(.web(11))
                }
                .foregroundStyle(p.textMuted.color)
                .opacity(0.8)
            }
        }
        .padding(.leading, depth < 0 ? 26 : 6 + 14 * CGFloat(depth + 1) + 20)
        .padding(.trailing, 6)
        .frame(height: 28)
        .background(active ? p.bgActive.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { shell.open(page: page.id) }
        .onLongPressGesture(minimumDuration: 0.5) { shell.menu = .pageRow(page.id) }
        .anchor("page:\(page.id)", shell)
    }
}

/// The Tasks panel: title, "Add task", the views with counts, VIEWS.
struct TasksPanel: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let counts = TaskBuckets(tasks: session.shownTasks, session: session)
        VStack(alignment: .leading, spacing: 0) {
            Text("Tasks").font(.web(15, 650)).foregroundStyle(p.text.color)
                .padding(.horizontal, 16).frame(height: 52, alignment: .center)
            VStack(alignment: .leading, spacing: 2) {
                Button { shell.notYet("Adding tasks") } label: {
                    HStack(spacing: 10) {
                        Icon("plus", 16, p.accent.color)
                        Text("Add task").font(.web(14, 500)).foregroundStyle(p.accent.color)
                        Spacer(minLength: 0)
                        Text("Q").font(.web(11, 500)).foregroundStyle(p.textMuted.color)
                            .frame(minWidth: 18, minHeight: 18).padding(.horizontal, 4)
                            .background(p.bg.color, in: RoundedRectangle(cornerRadius: 4))
                            .overlay(RoundedRectangle(cornerRadius: 4).stroke(p.border.color, lineWidth: 1))
                    }
                    .padding(.horizontal, 10).frame(height: 32)
                }
                .buttonStyle(PressStyle(radius: 7, pressed: p.bgPressed.color))
                .padding(.bottom, 12)
                ForEach(Shell.TaskList.allCases, id: \.self) { list in
                    let active = shell.route == .tasks(list)
                    let n = counts.count(list)
                    Button { shell.route = .tasks(list) } label: {
                        HStack(spacing: 10) {
                            Icon(list.icon, 16, active ? p.accent.color : p.text2.color)
                            Text(list.title).font(.web(14, 500)).foregroundStyle(active ? p.accent.color : p.text2.color)
                            Spacer(minLength: 0)
                            if n > 0 {
                                let alarm = list == .today && counts.overdue > 0
                                Text("\(n)").font(.web(10.5, 600)).monospacedDigit()
                                    .foregroundStyle(alarm ? p.danger.color : p.text2.color)
                                    .padding(.horizontal, 6).frame(minWidth: 18, minHeight: 18)
                                    .background(alarm ? p.dangerSoft.color : p.bgHover.color, in: Capsule())
                            }
                        }
                        .padding(.horizontal, 10).frame(height: 32)
                        .background(active ? p.bgActive.color : Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }
                    .buttonStyle(PressStyle(radius: 7, pressed: p.bgPressed.color))
                }
                GroupHeading(title: "Views", icon: nil, open: true, plus: nil, toggle: {})
                    .padding(.top, 16)
                Button { shell.notYet("Saved views") } label: {
                    HStack(spacing: 10) {
                        Icon("plus", 16, p.text2.color)
                        Text("New view").font(.web(14, 500)).foregroundStyle(p.text2.color)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).frame(height: 32)
                }
                .buttonStyle(PressStyle(radius: 7, pressed: p.bgPressed.color))
            }
            .padding(.horizontal, 8)
        }
    }
}
