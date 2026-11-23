import NotiveloCore
import SwiftUI

/// What a task line draws besides its title (the web's chips): priority, assignee, checklist count.
struct TaskDecor: Equatable {
    var priority: UInt8 = 4
    var assignee: String?
    var assigneeColor: PlatformColor?
    var checklist: (done: UInt32, total: UInt32)?

    static func == (a: TaskDecor, b: TaskDecor) -> Bool {
        a.priority == b.priority && a.assignee == b.assignee && a.checklist?.done == b.checklist?.done && a.checklist?.total == b.checklist?.total
    }
}

/// A page: the top bar, then the canvas (title, sub-line, boxes) on the page's colour. In Hybrid
/// the page is inset 6 pt with rounded top corners and a shadow (LOOK.md 0.3).
struct PageScreen: View {
    let pageId: String
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    @Environment(\.phoneLayout) private var phone
    @State var live: LivePageModel?
    @State var sample: SamplePageScreen.Sample?
    let theme = Theme.shared
    private let comments = CommentsModel.shared

    private var meta: PageMeta? { session.shownTree?.pages.first { $0.id == pageId } }

    var body: some View {
        let snapshot = currentSnapshot
        let palette = theme.page.tinted(snapshot?.info.settings.color ?? "none")
        let hybrid = theme.isHybrid && !phone
        let shape = UnevenRoundedRectangle(cornerRadii: .init(topLeading: hybrid ? 12 : 0, bottomLeading: 0, bottomTrailing: 0, topTrailing: hybrid ? 12 : 0), style: .continuous)
        VStack(spacing: 0) {
            PageTopBar(meta: meta, palette: palette, status: status, taskCount: taskCount, phone: phone)
            HStack(spacing: 0) {
                ZStack(alignment: .topTrailing) {
                    content(snapshot, palette)
                    if let snapshot, !snapshot.info.headings.isEmpty, !phone {
                        OutlineBars(count: snapshot.info.headings.count, palette: palette).padding(.top, 33).padding(.trailing, 18)
                    }
                }
                // The comments panel: the iPad's side panel (320 wide).
                if comments.open && !phone { CommentsPanel(palette: theme.chrome, phone: false) }
            }
            // The phone's bottom sheet (max 55 % of the height).
            .overlay(alignment: .bottom) {
                if comments.open && phone { CommentsPanel(palette: theme.chrome, phone: true, maxHeight: mainScreenSize.height * 0.55) }
            }
        }
        .background(palette.bg.color)
        .clipShape(shape)
        .background(
            shape.fill(palette.bg.color)
                .shadow(color: hybrid ? Color.black.opacity(0.45) : .clear, radius: 12, x: 0, y: 6)
                .overlay(shape.stroke(hybrid ? Color.black.opacity(0.55) : .clear, lineWidth: 1).padding(-0.5))
        )
        .padding(.top, hybrid ? 6 : 0).padding(.horizontal, hybrid ? 6 : 0)
        .onAppear(perform: openPage)
        .onChange(of: session.locksOpen) { _, open in
            if open {
                openPage()
            } else if meta?.locked == true {
                // Locked again: the page closes and the unlock prompt comes back.
                comments.detach(pageId: pageId)
                live?.close()
                live = nil
            }
        }
        // While a locked page is open, ask the server about once a minute so it stays unlocked.
        .task(id: session.locksOpen && meta?.locked == true) {
            guard session.locksOpen, meta?.locked == true else { return }
            while !_Concurrency.Task.isCancelled {
                try? await _Concurrency.Task.sleep(nanoseconds: 60_000_000_000)
                if _Concurrency.Task.isCancelled { break }
                session.keepLocksAlive()
            }
        }
        .onDisappear {
            comments.detach(pageId: pageId)
            if shell.openLive === live { shell.openLive = nil }
            live?.close()
            live = nil
            EditorFocus.shared.set(nil)
        }
    }

    private var currentSnapshot: PageSnapshot? {
        if let sample, case let .success(page) = sample.page, let s = page.snapshot {
            // The look seed points the corpus page link at the first page ("Canvas").
            return PageSnapshot(id: s.id, title: s.title, info: s.info, tasks: s.tasks, pageTitles: ["page-2": "Canvas"], document: s.document)
        }
        return live?.snapshot
    }

    private var editHost: PageEditHost? {
        if let host = sample?.host { return host }
        return live
    }

    private var taskCount: Int {
        if let s = currentSnapshot {
            return s.tasks.values.filter { line in
                if case let .shown(_, done, _) = line { return !done }
                return false
            }.count
        }
        return session.openTaskCount(page: pageId)
    }

    private var status: String {
        if LookData.state == "offline-banner" { return "Offline" }
        guard let live else { return "Saved" }
        switch live.state {
        case .live: return "Saved"
        case .connecting: return "Connecting…"
        case .offline: return "Offline"
        case .ended: return "Offline"
        }
    }

    private func openPage() {
        EditorMarks.selfMentionIds = session.preview ? ["u1"] : Set([session.shownUser?.id ?? ""])
        if let name = LookData.caseName(pageId) {
            if sample == nil { sample = SamplePageScreen.Sample(name: name) }
            return
        }
        // A page of the tree, or one shared with this person from another workspace ("Shared with me").
        let shared = session.sharedPages.first { $0.id == pageId }
        guard meta != nil || shared != nil, meta?.locked != true || session.locksOpen, live == nil else { return }
        let m = LivePageModel(pageId: pageId, title: meta?.title ?? shared?.title ?? "", session: session)
        live = m
        shell.openLive = m
        m.open()
        session.refreshTasks()
        if !session.preview { comments.attach(session, pageId: pageId) }
    }

    private var decor: [String: TaskDecor] {
        var out: [String: TaskDecor] = [:]
        let me = session.shownUser
        for t in session.shownTasks {
            var d = TaskDecor(priority: t.priority)
            if session.preview || (t.assigneeId != nil && t.assigneeId == me?.id) {
                d.assignee = me?.name
                d.assigneeColor = me.map { PlatformColor(css: $0.color) }
            }
            if let total = t.checklistTotal, total > 0 { d.checklist = (t.checklistDone ?? 0, total) }
            out[t.id] = d
        }
        if session.preview {
            // Corpus task ids (t1, tb …) aren't the demo tasks: the look seed assigns them all to the demo user.
            for id in ["t1", "t2", "t3", "tb"] {
                out[id] = TaskDecor(priority: 4, assignee: me?.name, assigneeColor: me.map { PlatformColor(css: $0.color) },
                                    checklist: id == "t1" ? (done: UInt32(1), total: UInt32(2)) : nil)
            }
        }
        return out
    }

    @ViewBuilder
    private func content(_ snapshot: PageSnapshot?, _ palette: Palette) -> some View {
        if let meta, meta.locked, !session.locksOpen {
            UnlockPrompt(palette: palette)
        } else if let snapshot {
            let title = meta?.title ?? snapshot.title
            let edited = meta.map { "Edited \(Due.ago($0.updatedAt))" + (session.preview ? " by you" : "") } ?? "Edited just now by you"
            // "Add icon" above the title: for a page of the tree that can be edited (the look states keep their own).
            let canEditIcon = meta != nil && sample == nil && LookData.state == nil && !session.preview && session.canEditTree && (editHost?.savesBoxes ?? false)
            let onIcon: ((CGRect) -> Void)? = canEditIcon ? { iconTapped($0) } : nil
            PageCanvas(page: snapshot, host: editHost, title: title, subline: edited, palette: palette,
                       decor: decor, showAddIcon: phone || canEditIcon || ((LookData.state?.hasPrefix("edit") ?? false)), icon: meta?.icon,
                       onIcon: onIcon, stacked: phone, notify: { shell.say($0) })
                .anchor("page-canvas", shell)
        } else if let sample, case .failure = sample.page {
            notFound(palette)
        } else if let live, case .ended = live.state {
            notFound(palette)
        } else if let live, case let .offline(text) = live.state {
            message("Offline", "\(text)\nTrying again…", palette)
        } else {
            // `.page-loading`: an empty page until the document is there.
            Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// The icon row was tapped (its frame in the canvas): the emoji picker opens under it.
    private func iconTapped(_ r: CGRect) {
        let c = shell.frames["page-canvas"] ?? .zero
        shell.frames["page-icon"] = r.offsetBy(dx: c.minX, dy: c.minY)
        shell.menu = .pageIcon(pageId)
    }

    /// `.empty-page`: "Page not found", why, and a way out (PageView.tsx).
    private func notFound(_ p: Palette) -> some View {
        VStack(spacing: 8) {
            Text("Page not found").font(.web(20, 700)).foregroundStyle(p.text.color)
            Text("It may have been deleted, moved to a private notebook, or you don’t have access.")
                .font(.web(14)).foregroundStyle(p.textMuted.color).multilineTextAlignment(.center)
            Button { shell.route = .tasks(.today) } label: {
                Text("Go to Today").font(.web(14, 500)).foregroundStyle(p.text.color)
                    .padding(.horizontal, 12).frame(height: 32)
                    .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                    .shadowSm(p)
            }
            .buttonStyle(.plain)
            .padding(.top, 8)
        }
        .padding(.horizontal, 24).padding(.top, 80)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private func message(_ title: String, _ text: String, _ p: Palette) -> some View {
        VStack(spacing: 8) {
            Icon("file-text", 28, p.textMuted.color)
            Text(title).font(.web(22, 700)).foregroundStyle(p.text.color)
            Text(text).font(.web(14)).foregroundStyle(p.textMuted.color).multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The page's top bar (LOOK.md 4.4): crumbs on the left; save status, tasks, comments, Share, ⋯ on the right.
struct PageTopBar: View {
    let meta: PageMeta?
    let palette: Palette
    let status: String
    let taskCount: Int
    var phone = false
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell

    var body: some View {
        let p = palette
        let tree = session.shownTree
        let section = meta.flatMap { m in tree?.sections.first { $0.id == m.sectionId } }
        let notebook = section.flatMap { s in tree?.notebooks.first { $0.id == s.notebookId } }
        HStack(spacing: 12) {
            if phone {
                Spacer(minLength: 0)
                Group {
                    Icon("undo-2", 18, p.text2.color).opacity(EditorFocus.shared.canUndo ? 1 : 0.4)
                        .frame(width: 32, height: 32).onTapGesture { EditorFocus.shared.undo() }
                    Icon("redo-2", 18, p.text2.color).opacity(EditorFocus.shared.canRedo ? 1 : 0.4)
                        .frame(width: 32, height: 32).onTapGesture { EditorFocus.shared.redo() }
                }
            } else {
            HStack(spacing: 6) {
                if let notebook {
                    Circle().fill(PlatformColor(css: notebook.color).color).frame(width: 8, height: 8)
                    Text(notebook.name).lineLimit(1)
                    Icon("chevron-right", 14, p.textMuted.color)
                }
                if let section { Text(section.name).lineLimit(1) }
            }
            .font(.web(13))
            .foregroundStyle(p.text2.color)
            Spacer(minLength: 0)
            }
            HStack(spacing: 6) {
                if !phone {
                HStack(spacing: 5) {
                    Icon(status == "Saved" ? "check" : status == "Offline" ? "cloud-off" : "loader", 14, statusColor.color)
                    Text(status).font(.web(12))
                }
                .foregroundStyle(statusColor.color)
                .padding(.horizontal, 6)
                }
                iconButton("list-todo", badge: taskCount) { shell.notYet("Tasks on this page") }
                iconButton("message-square", badge: CommentsModel.shared.openThreads.count, active: CommentsModel.shared.open) {
                    let model = CommentsModel.shared
                    if model.pageId == nil {
                        shell.notYet("Comments")
                    } else if model.open {
                        model.cancel()
                        model.open = false
                    } else {
                        model.open = true
                        model.reload()
                    }
                }
                Button {
                    if case let .page(id) = shell.route { shell.openSheet(.sharePage(id), session, "Sharing") }
                } label: {
                    HStack(spacing: 6) {
                        Icon("user-plus", 14, p.text.color)
                        Text("Share").font(.web(13, 500)).foregroundStyle(p.text.color)
                    }
                    .padding(.horizontal, 10).frame(height: 28)
                    .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                    .shadowSm(p)
                }
                .buttonStyle(.plain)
                Button { shell.menu = .pageOptions } label: {
                    Icon("ellipsis", 18, p.text2.color).frame(width: 32, height: 32)
                }
                .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
                .anchor("page-options", shell)
            }
        }
        .padding(.leading, phone ? 16 : 20).padding(.trailing, phone ? 8 : 16)
        .frame(height: phone ? 44 : 48)
        .background(p.bg.withAlphaComponent(0.88).color)
    }

    private var statusColor: PlatformColor {
        status == "Offline" ? PlatformColor.mix(palette.warn, 0.65, palette.text) : palette.text2
    }

    private func iconButton(_ icon: String, badge: Int, active: Bool = false, _ action: @escaping () -> Void) -> some View {
        let p = palette
        return Button(action: action) {
            Icon(icon, 18, (active ? p.accent : p.text2).color)
                .frame(width: 32, height: 32)
                .background(active ? p.accentSoft.color : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        Text("\(badge)").font(.web(10, 600)).foregroundStyle(.white)
                            .padding(.horizontal, 4).frame(minWidth: 16, minHeight: 16)
                            .background(p.accentSolid.color, in: Capsule())
                            .offset(x: 2, y: -1)
                    }
                }
        }
        .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
    }
}

/// The outline rail at the page's top right: a 16×2 bar per heading, the first in the accent.
struct OutlineBars: View {
    let count: Int
    let palette: Palette

    var body: some View {
        VStack(alignment: .trailing, spacing: 10) {
            ForEach(0..<min(count, 14), id: \.self) { i in
                RoundedRectangle(cornerRadius: 1).fill((i == 0 ? palette.accent : palette.borderStrong).color).frame(width: 16, height: 2)
            }
        }
        .frame(width: 28)
        .allowsHitTesting(false)
    }
}

/// No page selected: the Notes overview (recently edited cards, then every notebook).
struct NotesHome: View {
    @Environment(\.phoneLayout) private var phone
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        #if os(iOS)
        if phone { PhoneNotes() } else { overview }
        #else
        overview
        #endif
    }

    @ViewBuilder private var overview: some View {
        let p = theme.chrome
        let tree = session.shownTree
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Notes").font(.web(26, 700)).tracking(-0.52).foregroundStyle(p.text.color)
                if let tree {
                    let index = TreeIndex(tree)
                    let recent = tree.pages.sorted { $0.updatedAt > $1.updatedAt }.prefix(8)
                    if !recent.isEmpty {
                        heading("Recently edited", p).padding(.top, 14)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 10)], spacing: 10) {
                            ForEach(Array(recent), id: \.id) { page in
                                Button { shell.open(page: page.id) } label: {
                                    VStack(alignment: .leading, spacing: 0) {
                                        if let icon = page.icon, !icon.isEmpty { Text(icon).font(.system(size: 14)) } else { Icon("file-text", 16, p.text2.color) }
                                        Text(page.title.isEmpty ? "Untitled" : page.title).font(.web(14, 650)).foregroundStyle(p.text.color)
                                            .lineLimit(1).padding(.top, 10)
                                        Text(Due.ago(page.updatedAt)).font(.web(12.5)).foregroundStyle(p.textMuted.color).padding(.top, 8)
                                    }
                                    .padding(14)
                                    .frame(maxWidth: .infinity, minHeight: 100, alignment: .topLeading)
                                    .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(p.border.color, lineWidth: 1))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.top, 10)
                    }
                    ForEach(index.notebooks, id: \.id) { nb in
                        HStack(spacing: 8) {
                            LetterTile(letter: nb.name, fill: AnyShapeStyle(PlatformColor(css: nb.color).color), size: 18, radius: 5, fontSize: 10)
                            Text(nb.name).font(.web(14, 650)).foregroundStyle(p.text.color)
                        }
                        .padding(.top, 30).padding(.bottom, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
                        ForEach(index.sections(in: nb), id: \.id) { s in
                            HStack(spacing: 8) {
                                RoundedRectangle(cornerRadius: 2).fill(PlatformColor(css: s.color).color).frame(width: 3, height: 14)
                                Text(s.name).font(.web(13, 600)).foregroundStyle(p.text2.color)
                            }
                            .padding(.top, 14).padding(.bottom, 6)
                            ForEach(index.pages(in: s), id: \.id) { page in
                                Button { shell.open(page: page.id) } label: {
                                    HStack(spacing: 10) {
                                        Icon("file-text", 15, p.textMuted.color)
                                        Text(page.title.isEmpty ? "Untitled" : page.title).font(.web(14)).foregroundStyle(p.text.color)
                                        Spacer(minLength: 0)
                                        Text(Due.ago(page.updatedAt)).font(.web(12.5)).foregroundStyle(p.textMuted.color)
                                    }
                                    .padding(.horizontal, 12).frame(height: 42)
                                    .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .padding(.top, 36).padding(.horizontal, 40).padding(.bottom, 120)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .refreshable { await session.refresh() }
    }

    private func heading(_ text: String, _ p: Palette) -> some View {
        Text(text).font(.web(13.5, 650)).foregroundStyle(p.text.color)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
    }
}

/// A section with no page open: empty → "This section has no pages yet."
struct SectionScreen: View {
    let sectionId: String
    @Environment(\.phoneLayout) private var phone
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        #if os(iOS)
        if phone { PhoneSectionScreen(sectionId: sectionId) } else { empty }
        #else
        empty
        #endif
    }

    @ViewBuilder private var empty: some View {
        let p = theme.chrome
        let section = session.shownTree?.sections.first { $0.id == sectionId }
        VStack(spacing: 8) {
            Icon("file-text", 28, p.textMuted.color)
            Text(section?.name ?? "Section").font(.web(22, 700)).foregroundStyle(p.text.color)
            Text("This section has no pages yet.").font(.web(14)).foregroundStyle(p.textMuted.color)
            Button { shell.newPage(in: sectionId, session) } label: {
                HStack(spacing: 6) {
                    Icon("file-plus", 15, .white)
                    Text("New page").font(.web(14, 500)).foregroundStyle(.white)
                }
                .padding(.horizontal, 12).frame(height: 32)
                .background(p.accentSolid.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
