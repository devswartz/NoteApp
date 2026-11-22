import NotiveloCore
import SwiftUI

/// The shell: sidebar (workspace picker, Tasks, the notebook tree; in corpus mode the sample
/// pages) and a detail area with the selected page or the task list.
struct MainView: View {
    @Environment(SessionModel.self) private var session
    /// Corpus mode: `-page <case>` on the command line opens that sample page (CI screenshots).
    @State private var selection: SidebarItem? = UserDefaults.standard.bool(forKey: "previewSignedIn")
        ? (UserDefaults.standard.string(forKey: "page") ?? CorpusPage.caseNames.first).map(SidebarItem.sample)
        : nil

    var body: some View {
        NavigationSplitView {
            SidebarView(selection: $selection)
                .toolbar {
                    ToolbarItem {
                        Menu {
                            if let user = session.user {
                                Text(user.name.isEmpty ? user.email : "\(user.name) (\(user.email))")
                            }
                            if session.isStaging { Text("Server: \(session.host)") }
                            Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") {
                                session.signOut()
                            }
                        } label: {
                            Label("Account", systemImage: "person.crop.circle")
                        }
                    }
                }
        } detail: {
            NavigationStack {
                switch selection {
                case .tasks?:
                    TasksView()
                case let .page(id)?:
                    if let meta = session.tree?.pages.first(where: { $0.id == id }) {
                        LivePageScreen(meta: meta).id(id)
                    } else {
                        ContentUnavailableView("Page not found", systemImage: "doc.questionmark")
                    }
                case let .sample(name)?:
                    SamplePageScreen(name: name).id(name)
                case nil:
                    ContentUnavailableView("Pick a page", systemImage: "sidebar.left",
                                           description: Text("Choose a page in the sidebar, or open Tasks."))
                }
            }
        }
        .onChange(of: session.workspaceId) {
            if case .page? = selection { selection = nil }
        }
    }
}

enum SidebarItem: Hashable {
    case tasks
    /// A page on the server (live).
    case page(String)
    /// A bundled corpus page (corpus mode only).
    case sample(String)
}

struct SidebarView: View {
    @Environment(SessionModel.self) private var session
    @Binding var selection: SidebarItem?

    var body: some View {
        List(selection: $selection) {
            if session.workspaces.count > 1 {
                Picker(selection: Binding(get: { session.workspaceId ?? "" }, set: { session.selectWorkspace($0) })) {
                    ForEach(session.workspaces) { ws in
                        Text(ws.name).tag(ws.id)
                    }
                } label: {
                    Label("Workspace", systemImage: "square.stack")
                }
                .pickerStyle(.menu)
            }

            Label("Tasks", systemImage: "checklist").tag(SidebarItem.tasks)

            if let tree = session.tree {
                let index = TreeIndex(tree)
                if index.notebooks.isEmpty {
                    Text("No notebooks yet.").foregroundStyle(.secondary)
                }
                ForEach(index.notebooks) { notebook in
                    NotebookRow(notebook: notebook, index: index)
                }
            } else if session.loading {
                HStack {
                    ProgressView()
                    Text("Loading…").foregroundStyle(.secondary)
                }
            }
            if let error = session.loadError {
                Text(error).font(.footnote).foregroundStyle(.red)
            }

            if session.preview {
                SwiftUI.Section("Sample pages (corpus)") {
                    ForEach(CorpusPage.caseNames, id: \.self) { name in
                        Label(name, systemImage: "doc.text").tag(SidebarItem.sample(name))
                    }
                }
            }
        }
        .refreshable { await session.refresh() }
        .navigationTitle(session.workspace?.name ?? "Notivelo")
    }
}

/// The tree in the server's order (`position`), for the sidebar.
struct TreeIndex {
    let notebooks: [Notebook]
    private let sections: [String: [CoreSection]]
    private let pages: [String: [PageMeta]]

    init(_ tree: Tree) {
        notebooks = tree.notebooks.sorted { ($0.position, $0.name) < ($1.position, $1.name) }
        var sections: [String: [CoreSection]] = [:]
        for s in tree.sections {
            sections[s.parentId.map { "s:\($0)" } ?? "n:\(s.notebookId)", default: []].append(s)
        }
        self.sections = sections.mapValues { list in list.sorted { ($0.position, $0.name) < ($1.position, $1.name) } }
        pages = Dictionary(grouping: tree.pages, by: { $0.sectionId })
            .mapValues { list in list.sorted { ($0.position, $0.title) < ($1.position, $1.title) } }
    }

    func sections(in notebook: Notebook) -> [CoreSection] { sections["n:\(notebook.id)"] ?? [] }
    func sections(in section: CoreSection) -> [CoreSection] { sections["s:\(section.id)"] ?? [] }
    func pages(in section: CoreSection) -> [PageMeta] { pages[section.id] ?? [] }
}

struct NotebookRow: View {
    let notebook: Notebook
    let index: TreeIndex
    @State private var expanded = true

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ForEach(index.sections(in: notebook)) { section in
                SectionRow(section: section, index: index)
            }
        } label: {
            Label(notebook.name, systemImage: notebook.visibility == "private" ? "book.closed.fill" : "book.closed")
        }
    }
}

/// A section with its subsections (up to three levels on the server) and pages.
struct SectionRow: View {
    let section: CoreSection
    let index: TreeIndex
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ForEach(index.sections(in: section)) { child in
                SectionRow(section: child, index: index)
            }
            ForEach(index.pages(in: section)) { page in
                Label(page.title.isEmpty ? "Untitled" : page.title, systemImage: page.locked ? "lock" : "doc.text")
                    .tag(SidebarItem.page(page.id))
            }
        } label: {
            Label(section.name, systemImage: "folder")
        }
    }
}

/// A page on the server, open live: tap a box to edit it (iPad/iPhone); web edits show up as they happen.
struct LivePageScreen: View {
    let meta: PageMeta
    @Environment(SessionModel.self) private var session
    @State private var model: LivePageModel?

    var body: some View {
        content
            .navigationTitle(meta.title.isEmpty ? "Untitled" : meta.title)
            .onAppear {
                guard !meta.locked, model == nil else { return }
                let m = LivePageModel(pageId: meta.id, title: meta.title, session: session)
                model = m
                m.open()
                session.refreshTasks()
            }
            .onDisappear {
                model?.close()
                model = nil
            }
    }

    @ViewBuilder
    private var content: some View {
        if meta.locked {
            ContentUnavailableView("Locked page", systemImage: "lock",
                                   description: Text("Locked pages open in the web app for now."))
        } else if let model, let page = model.snapshot {
            PageContent(page: page, host: model)
                .overlay(alignment: .top) { SyncBadge(state: model.state) }
        } else if let model, case let .ended(message) = model.state {
            ContentUnavailableView("Can't open this page", systemImage: "exclamationmark.triangle", description: Text(message))
        } else if let model, case let .offline(message) = model.state {
            ContentUnavailableView("Offline", systemImage: "wifi.slash", description: Text("\(message)\nTrying again…"))
        } else {
            ProgressView("Opening…")
        }
    }
}

/// Connection state over a shown page; nothing while it is live.
struct SyncBadge: View {
    let state: LivePageModel.State

    var body: some View {
        switch state {
        case .live:
            EmptyView()
        case .connecting:
            badge("Connecting…", "arrow.triangle.2.circlepath")
        case .offline:
            badge("Offline: showing the last version", "wifi.slash")
        case let .ended(message):
            badge(message, "exclamationmark.triangle")
        }
    }

    private func badge(_ text: String, _ symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.footnote)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.thinMaterial, in: Capsule())
            .padding(.top, 8)
    }
}

/// A bundled corpus page (corpus mode), editable on this device only.
struct SamplePageScreen: View {
    let name: String
    @State private var sample: Sample

    init(name: String) {
        self.name = name
        _sample = State(initialValue: Sample(name: name))
    }

    /// Loaded once, so box editors keep their host while the screen is shown.
    final class Sample {
        let page: Result<CorpusPage, Error>
        let host: CorpusEditHost?

        init(name: String) {
            page = Result { try CorpusPage.load(name) }
            if case let .success(p) = page, let s = p.snapshot, let document = s.document {
                host = CorpusEditHost(document: document, tasks: s.tasks)
            } else {
                host = nil
            }
        }
    }

    var body: some View {
        switch sample.page {
        case let .success(page):
            if let snapshot = page.snapshot {
                PageContent(page: snapshot, host: sample.host)
                    .navigationTitle(snapshot.title)
            }
        case let .failure(error):
            ContentUnavailableView("Can't open this page", systemImage: "exclamationmark.triangle",
                                   description: Text(String(describing: error)))
        }
    }
}

/// One page. iPad/iPhone: the native canvas. Mac: the core's Markdown for now (M6).
struct PageContent: View {
    let page: PageSnapshot
    /// Where edits go (iPad/iPhone); the Mac preview is read-only.
    var host: PageEditHost?

    var body: some View {
        #if os(iOS)
        PageCanvasView(page: page, host: host, title: page.title, subline: "", palette: .light)
            .ignoresSafeArea(edges: .bottom)
        #else
        ScrollView {
            Text(page.markdown())
                .font(.body.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
        #endif
    }
}
