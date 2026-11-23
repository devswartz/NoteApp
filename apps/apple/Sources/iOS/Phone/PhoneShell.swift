import NotiveloCore
import SwiftUI

/// Phones (≤ 760 pt, LOOK.md 3.2, `MobileChrome.tsx`): a top bar, the screen, a tab bar with the
/// floating "Add task" button; the sidebar is a drawer. Notes drill down notebook → section → page.
struct PhoneShell: View {
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        VStack(spacing: 0) {
            topBar(p)
            MainArea(width: width)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .bottomTrailing) { if showsFab { fab(p) } }
            tabBar(p)
        }
        .overlay {
            if shell.drawerOpen {
                ZStack(alignment: .leading) {
                    p.bgOverlay.color.onTapGesture { shell.drawerOpen = false }
                    PhoneDrawer()
                        .frame(width: min(width * 0.86, 320))
                        .frame(maxHeight: .infinity)
                        .shadowLg(p)
                }
            }
        }
        .environment(\.phoneLayout, true)
    }

    // MARK: Top bar

    private var isTasks: Bool {
        if case .tasks = shell.route { return true }
        return false
    }

    private var isCalendar: Bool { shell.route == .calendar }

    private var isPage: Bool {
        if case .page = shell.route { return true }
        return false
    }

    private var showsFab: Bool {
        switch shell.route {
        case .page, .settings: return false
        default: return true
        }
    }

    private var workspaceName: String { session.shownWorkspace?.name ?? "Notes" }

    /// A screen whose own heading has scrolled away shows its title over the workspace; the section
    /// screens (heading and Back link) do.
    private var subtitled: Bool {
        if case .section = shell.route { return true }
        return false
    }

    private func goBack() {
        if case let .page(id) = shell.route {
            if let sec = session.shownTree?.pages.first(where: { $0.id == id })?.sectionId {
                shell.route = .section(sec)
            } else {
                shell.route = .notes
            }
        }
    }

    private func topBar(_ p: Palette) -> some View {
        HStack(spacing: 0) {
            Group {
                if isPage {
                    Button { goBack() } label: { Icon("chevron-left", 22, p.text2.color).frame(width: 44, height: 44) }
                } else {
                    Button { shell.drawerOpen = true } label: { Icon("menu", 21, p.text2.color).frame(width: 44, height: 44) }
                }
            }
            .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
            .frame(width: 88, alignment: .leading)
            Spacer(minLength: 0)
            VStack(spacing: 0) {
                if subtitled {
                    Text("Notes").font(.web(15, 600)).foregroundStyle(p.text.color).lineLimit(1)
                    Text(workspaceName).font(.web(15)).foregroundStyle(p.text2.color).lineLimit(1)
                } else {
                    Text(workspaceName).font(.web(15, 600)).foregroundStyle(p.text.color).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: 0) {
                Button { shell.notYet("Notifications") } label: { Icon("bell", 20, p.text2.color).frame(width: 44, height: 44) }
                    .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
                Button { shell.openSearch() } label: { Icon("search", 20, p.text2.color).frame(width: 44, height: 44) }
                    .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
            }
            .frame(width: 88, alignment: .trailing)
        }
        .padding(.horizontal, 4)
        .frame(height: 48)
        .background(p.bg.withAlphaComponent(0.92).color)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
    }

    // MARK: Tab bar and the Add task button

    private func tabBar(_ p: Palette) -> some View {
        HStack(spacing: 0) {
            tab("Notes", "book-open", active: !isTasks && !isCalendar && !shell.searchOpen) {
                shell.route = .notes
                shell.phoneNotebook = nil
            }
            tab("Tasks", "list-checks", active: isTasks && !shell.searchOpen) { if !isTasks { shell.route = .tasks(.today) } }
            tab("Calendar", "calendar-days", active: isCalendar && !shell.searchOpen) { shell.route = .calendar }
            tab("Search", "search", active: shell.searchOpen) { shell.openSearch() }
        }
        .frame(height: 60)
        .background(p.bg.withAlphaComponent(0.9).color)
        .overlay(alignment: .top) { Rectangle().fill(p.border.color).frame(height: 1) }
    }

    private func fab(_ p: Palette) -> some View {
        Button { shell.openQuickAdd(session) } label: {
            Icon("plus", 26, .white)
                .frame(width: 56, height: 56)
                .background(p.accentSolid.color, in: Circle())
        }
        .buttonStyle(.plain)
        .shadow(color: p.accentSolid.withAlphaComponent(0.45).color, radius: 12, x: 0, y: 8)
        .shadowMd(p)
        .padding(.trailing, 16)
        .padding(.bottom, 16)
        .accessibilityLabel("Add task")
    }

    private func tab(_ label: String, _ icon: String, active: Bool, _ action: @escaping () -> Void) -> some View {
        let p = theme.chrome
        let c = active ? p.accent.color : p.textMuted.color
        return Button(action: action) {
            VStack(spacing: 3) {
                Icon(icon, 22, c)
                Text(label).font(.web(10.5, 500)).foregroundStyle(c)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The drawer (the sidebar on phones): workspace switcher, the notes panel (or the task views),
/// the user row above a 1 pt border.
struct PhoneDrawer: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let ws = session.shownWorkspace
        VStack(spacing: 0) {
            Button { shell.menu = .workspace } label: {
                HStack(spacing: 8) {
                    LetterTile(letter: ws?.name ?? "W",
                               fill: AnyShapeStyle(LinearGradient(colors: [Color(uiColor: UIColor(hex: 0x6366F1)), Color(uiColor: UIColor(hex: 0x8B5CF6))],
                                                                  startPoint: .topLeading, endPoint: .bottomTrailing)),
                               size: 24, radius: 7, fontSize: 13)
                    Text(ws?.name ?? "").font(.web(15, 600)).foregroundStyle(p.text.color).lineLimit(1)
                    Icon("chevron-down", 14, p.textMuted.color)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .frame(height: 36)
            }
            .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
            .background(shell.menu == .workspace ? p.bgPressed.color : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .anchor("drawer-workspace", shell)
            .padding(.horizontal, 8).padding(.top, 10).padding(.bottom, 6)

            Sidebar()
                .frame(maxHeight: .infinity)

            Button { shell.menu = .account } label: {
                HStack(spacing: 10) {
                    AvatarView(name: session.shownUser?.name ?? "?", color: UIColor(css: session.shownUser?.color ?? "#6366f1"), size: 22)
                    Text(session.shownUser?.name ?? "").font(.web(15, 500)).foregroundStyle(p.text.color).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10)
                .frame(height: 44)
            }
            .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
            .background(shell.menu == .account ? p.bgPressed.color : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .anchor("drawer-account", shell)
            .padding(8)
            .overlay(alignment: .top) { Rectangle().fill(p.border.color).frame(height: 1) }
        }
        .background(p.bgSidebar.color.ignoresSafeArea())
    }
}

// MARK: Notes drill-down (NotesHome.tsx on phones)

/// A phone screen: Back link, heading row, content (`.tasks-inner` padding 20 16, 96 below for the button).
struct PhoneScreen<Content: View, Lead: View, Action: View>: View {
    let title: String
    var back: (() -> Void)?
    @ViewBuilder var lead: () -> Lead
    @ViewBuilder var action: () -> Action
    @ViewBuilder var content: () -> Content
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let back {
                    Button(action: back) {
                        HStack(spacing: 2) {
                            Icon("chevron-left", 18, p.accent.color)
                            Text("Back").font(.web(15, 500)).foregroundStyle(p.accent.color)
                        }
                        .padding(6)
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, -6)
                    .padding(.top, 2.4)
                    .padding(.bottom, 8)
                }
                HStack(spacing: 8) {
                    lead()
                    Text(title).font(.web(24, 700)).tracking(-0.48).foregroundStyle(p.text.color).lineLimit(1)
                    Spacer(minLength: 0)
                    action()
                }
                .frame(minHeight: back == nil ? 38 : 41.6)
                .padding(.bottom, back == nil ? 12 : 13.5)
                content()
            }
            .padding(.top, 20).padding(.horizontal, 16).padding(.bottom, 96)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .noEdgeEffect()
    }
}

/// A group title: 13.5/650 with a hairline under it.
private func groupTitle(_ text: String, _ p: Palette) -> some View {
    Text(text).font(.web(13.5, 650)).foregroundStyle(p.text.color)
        .padding(.top, 9.5).padding(.bottom, 7.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
}

/// A drill row: 44 high, gap 12, hairline under it.
private func drillRow<Leading: View, Trailing: View>(_ p: Palette, _ title: String, @ViewBuilder leading: () -> Leading, @ViewBuilder trailing: () -> Trailing,
                                                     _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
        HStack(spacing: 12) {
            leading()
            Text(title).font(.web(15)).foregroundStyle(p.text.color).lineLimit(1)
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.leading, 12).padding(.trailing, 6)
        .frame(minHeight: 44)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
}

/// Notes on a phone: all notebooks, a notebook's sections, or a section's pages, by the shell's state.
struct PhoneNotes: View {
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let tree = session.shownTree
        let index = tree.map(TreeIndex.init)
        if let id = shell.phoneNotebook, let nb = index?.notebooks.first(where: { $0.id == id }), let index {
            PhoneScreen(title: nb.name, back: { shell.phoneNotebook = nil },
                        lead: { LetterTile(letter: nb.name, fill: AnyShapeStyle(UIColor(css: nb.color).color), size: 26, radius: 7, fontSize: 14) },
                        action: { EmptyView() }) {
                let sections = index.sections(in: nb)
                ForEach(sections, id: \.id) { s in
                    drillRow(p, s.name, leading: {
                        RoundedRectangle(cornerRadius: 2).fill(UIColor(css: s.color).color).frame(width: 4, height: 18)
                    }, trailing: {
                        Text("\(index.pages(in: s).count)").font(.web(12.5)).foregroundStyle(p.textMuted.color)
                        Icon("chevron-right", 17, p.textMuted.color)
                    }) { shell.route = .section(s.id) }
                }
                if sections.isEmpty { Text("No sections in this notebook.").font(.web(15)).foregroundStyle(p.textMuted.color).padding(.top, 6) }
            }
        } else {
            PhoneScreen(title: "Notes", back: nil, lead: { EmptyView() }, action: { EmptyView() }) {
                if let index, !index.notebooks.isEmpty {
                    groupTitle("My notebooks", p)
                    ForEach(index.notebooks.filter { $0.visibility != "shared-with-me" }, id: \.id) { nb in
                        drillRow(p, nb.name, leading: {
                            LetterTile(letter: nb.name, fill: AnyShapeStyle(UIColor(css: nb.color).color), size: 18, radius: 5, fontSize: 10)
                        }, trailing: {
                            if nb.visibility == "private" { Icon("lock", 13, p.textMuted.color) }
                            Icon("chevron-right", 17, p.textMuted.color)
                        }) { shell.phoneNotebook = nb.id }
                    }
                } else if tree != nil {
                    Text("No notebooks yet.").font(.web(15)).foregroundStyle(p.textMuted.color)
                }
                if !session.preview && !session.sharedPages.isEmpty {
                    groupTitle("Shared with me", p)
                    ForEach(session.sharedPages, id: \.id) { e in
                        drillRow(p, e.title.isEmpty ? "Untitled" : e.title, leading: {
                            Icon("file-text", 15, p.textMuted.color)
                        }, trailing: {
                            Icon("chevron-right", 17, p.textMuted.color)
                        }) { shell.open(page: e.id) }
                    }
                }
            }
        }
    }
}

/// A section on a phone: sub-sections and pages as rows; "No pages in this section yet." when empty.
struct PhoneSectionScreen: View {
    let sectionId: String
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let tree = session.shownTree
        let index = tree.map(TreeIndex.init)
        let section = tree?.sections.first { $0.id == sectionId }
        let pages = section.flatMap { s in index?.pages(in: s) } ?? []
        let subs = section.flatMap { s in index?.sections(in: s) } ?? []
        PhoneScreen(title: section?.name ?? "Section", back: back(section),
                    lead: { RoundedRectangle(cornerRadius: 2).fill(UIColor(css: section?.color ?? "#6366f1").color).frame(width: 4, height: 22) },
                    action: {
                        Button { shell.newPage(in: sectionId, session) } label: {
                            HStack(spacing: 6) {
                                Icon("plus", 15, p.text.color)
                                Text("New page").font(.web(13, 500)).foregroundStyle(p.text.color)
                            }
                            .padding(.horizontal, 10).frame(height: 28)
                            .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                            .shadowSm(p)
                        }
                        .buttonStyle(.plain)
                    }) {
            ForEach(subs, id: \.id) { s in
                drillRow(p, s.name, leading: {
                    RoundedRectangle(cornerRadius: 2).fill(UIColor(css: s.color).color).frame(width: 4, height: 18)
                }, trailing: {
                    Text("\(index?.pages(in: s).count ?? 0)").font(.web(12.5)).foregroundStyle(p.textMuted.color)
                    Icon("chevron-right", 17, p.textMuted.color)
                }) { shell.route = .section(s.id) }
            }
            ForEach(pages, id: \.id) { page in
                drillRow(p, page.title.isEmpty ? "Untitled" : page.title, leading: {
                    if let icon = page.icon, !icon.isEmpty { Text(icon).font(.system(size: 15)) }
                    else { Icon(page.locked ? "lock" : "file-text", 15, p.textMuted.color) }
                }, trailing: {
                    Text(Due.ago(page.updatedAt)).font(.web(12.5)).foregroundStyle(p.textMuted.color)
                }) { shell.open(page: page.id) }
            }
            if pages.isEmpty {
                Text("No pages in this section yet.").font(.web(15)).foregroundStyle(p.textMuted.color).padding(.top, 2)
            }
        }
    }

    private func back(_ section: CoreSection?) -> () -> Void {
        {
            if let parent = section?.parentId {
                shell.route = .section(parent)
            } else {
                shell.phoneNotebook = section?.notebookId
                shell.route = .notes
            }
        }
    }
}
