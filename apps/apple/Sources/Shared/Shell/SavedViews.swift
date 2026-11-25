import NotiveloCore
import Observation
import SwiftUI

// Saved task views (src/pages/tasks/savedViews.ts, AllView.tsx): the filters, sort and group of All tasks, kept on the server
// (own ones, and ones an owner or admin shares with the workspace). The query is the web's JSON:
// {"filters": {...}, "sort": "due", "group": "none"}. Filters the app has no control for (assignedBy, notebook, section,
// "not" picks, tagsNone) are not read from a view made on the web and are written empty.

/// The conditions of a view, in the app's own terms (`TaskViewState`), and the web's JSON for them.
struct ViewQuery: Equatable {
    var status: TaskStatusFilter = .open
    var assignee: Set<String> = []
    var tags: Set<String> = []
    var teams: Set<String> = []
    var priority: Set<Int> = []
    var due: TaskDueFilter = .any
    var source: Set<String> = []
    var includeSubteams = true
    var q = ""
    var sort: TaskSort = .due
    var group: TaskGrouping = .none

    init() {}

    init(_ tv: TaskViewState) {
        status = tv.status
        assignee = tv.assignee
        tags = tv.tags
        teams = tv.teams
        priority = tv.priority
        due = tv.due
        source = tv.source
        includeSubteams = tv.includeSubteams
        q = tv.q.trimmingCharacters(in: .whitespaces)
        sort = tv.sort
        group = tv.group
    }

    init(json: String) {
        guard let data = json.data(using: .utf8), let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let f = root["filters"] as? [String: Any] ?? [:]
        func pick(_ key: String) -> [String] {
            if let s = f[key] as? String { return s == "any" ? [] : [s] }
            return ((f[key] as? [String: Any])?["values"] as? [String]) ?? []
        }
        assignee = Set(pick("assignee"))
        priority = Set(pick("priority").compactMap { Int($0) }.filter { (1...4).contains($0) })
        source = Set(pick("source").filter { $0 == "notes" || $0 == "standalone" })
        teams = Set(pick("teamId"))
        tags = Set((f["tagsAny"] as? [String]) ?? [])
        if let b = f["includeSubteams"] as? Bool { includeSubteams = b }
        if let s = f["q"] as? String, s.count <= 200 { q = s.trimmingCharacters(in: .whitespaces) }
        if let s = f["due"] as? String, let d = TaskDueFilter(rawValue: s) { due = d }
        if let s = f["status"] as? String, let d = TaskStatusFilter(rawValue: s) { status = d }
        if let s = root["sort"] as? String, let d = TaskSort(rawValue: s) { sort = d }
        if let s = root["group"] as? String, let d = TaskGrouping(rawValue: s) { group = d }
    }

    var json: String {
        func pick(_ values: [String]) -> [String: Any] { ["values": values.sorted(), "not": false] }
        let filters: [String: Any] = [
            "q": q, "assignee": pick(Array(assignee)), "assignedBy": pick([]), "priority": pick(priority.map { String($0) }),
            "due": due.rawValue, "source": pick(Array(source)), "notebookId": pick([]), "sectionId": pick([]),
            "teamId": pick(Array(teams)), "includeSubteams": includeSubteams, "tagsAny": tags.sorted(), "tagsNone": [String](),
            "status": status.rawValue,
        ]
        let root: [String: Any] = ["filters": filters, "sort": sort.rawValue, "group": group.rawValue]
        guard let data = try? JSONSerialization.data(withJSONObject: root, options: [.sortedKeys]) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    func apply(to tv: TaskViewState) {
        tv.reset()
        tv.status = status
        tv.assignee = assignee
        tv.tags = tags
        tv.teams = teams
        tv.priority = priority
        tv.due = due
        tv.source = source
        tv.includeSubteams = includeSubteams
        tv.q = q
        tv.sort = sort
        tv.group = group
    }

    /// No filters, default sort and group: plain All tasks (not worth saving, not "a view").
    var isPlain: Bool { self == ViewQuery() }
}

enum SavedViewDialog: Equatable {
    case save
    case rename(String)
    case delete(String)
}

/// The workspace's saved views, loaded from the server when a task view is first opened.
@Observable
final class SavedViewsModel {
    private(set) var views: [TaskViewInfo] = []
    private(set) var loadedFor: String?
    /// The view All tasks was opened from (stays while its filters are edited, as the web's ?view=).
    var openedId: String?
    /// The route change that opens a view must not reset Status to Open.
    var keepStatus = false

    func reset() {
        views = []
        loadedFor = nil
        openedId = nil
    }

    func load(_ session: SessionModel, force: Bool = false) {
        if session.preview {
            if loadedFor == nil {
                loadedFor = "preview"
                views = LookData.savedViews
            }
            return
        }
        guard let ws = session.workspaceId, force || loadedFor != ws else { return }
        loadedFor = ws
        session.call({ try $0.taskViews(workspaceId: ws) }) { result in
            if case let .success(list) = result, ws == session.workspaceId { self.views = list.sorted { $0.position < $1.position } }
        }
    }

    /// "New view": All tasks from a clean slate, to build the filters, then Save view.
    func startNew(_ shell: Shell) {
        shell.tv.reset()
        openedId = nil
        shell.drawerOpen = false
        shell.route = .tasks(.all)
    }

    func view(_ id: String?) -> TaskViewInfo? { id.flatMap { id in views.first { $0.id == id } } }

    /// The saved view the current conditions are exactly (not "no filters", which All tasks is without any view).
    func current(_ tv: TaskViewState) -> TaskViewInfo? {
        let now = ViewQuery(tv)
        if now.isPlain { return nil }
        return views.first { ViewQuery(json: $0.queryJson) == now }
    }

    /// The view the manage items are about: the exact match, else the one opened.
    func managed(_ tv: TaskViewState) -> TaskViewInfo? { current(tv) ?? view(openedId) }

    func canManage(_ v: TaskViewInfo, _ session: SessionModel) -> Bool { v.ownerId == session.shownUser?.id || session.isAdmin }

    func open(_ v: TaskViewInfo, _ shell: Shell, _ session: SessionModel) {
        ViewQuery(json: v.queryJson).apply(to: shell.tv)
        if !shell.tv.teams.isEmpty || shell.tv.group == .team { session.loadAllDetails() }
        openedId = v.id
        shell.menu = nil
        keepStatus = shell.route != .tasks(.all)
        shell.drawerOpen = false
        shell.route = .tasks(.all)
    }

    private func fail(_ e: Error, _ shell: Shell) {
        if !(e is CancellationError) { shell.say(SessionModel.plainMessage(e)) }
    }

    func create(name: String, shared: Bool = false, _ shell: Shell, _ session: SessionModel) {
        let query = ViewQuery(shell.tv)
        if session.preview {
            let v = TaskViewInfo(id: UUID().uuidString, workspaceId: "look", ownerId: session.shownUser?.id ?? "", shared: shared, name: name,
                                 queryJson: query.json, position: Double(views.count + 1), createdAt: "")
            views.append(v)
            openedId = v.id
            return
        }
        guard let ws = session.workspaceId else { return }
        session.call({ try $0.createTaskView(workspaceId: ws, name: name, queryJson: query.json, shared: shared) }) { result in
            switch result {
            case let .success(v):
                self.views.append(v)
                self.openedId = v.id
                shell.say("View saved")
            case let .failure(e): self.fail(e, shell)
            }
        }
    }

    private func update(_ id: String, name: String? = nil, queryJson: String? = nil, shared: Bool? = nil, _ shell: Shell, _ session: SessionModel, done: String? = nil) {
        session.call({ try $0.updateTaskView(id: id, name: name, queryJson: queryJson, shared: shared, position: nil) }) { result in
            switch result {
            case let .success(v):
                if let i = self.views.firstIndex(where: { $0.id == id }) { self.views[i] = v }
                if let done { shell.say(done) }
            case let .failure(e): self.fail(e, shell)
            }
        }
    }

    func rename(_ v: TaskViewInfo, to name: String, _ shell: Shell, _ session: SessionModel) {
        if session.preview { return }
        update(v.id, name: name, shell, session)
    }

    func updateToCurrent(_ v: TaskViewInfo, _ shell: Shell, _ session: SessionModel) {
        if session.preview { return }
        update(v.id, queryJson: ViewQuery(shell.tv).json, shell, session, done: "View updated")
    }

    func setShared(_ v: TaskViewInfo, _ shared: Bool, _ shell: Shell, _ session: SessionModel) {
        if session.preview { return }
        update(v.id, shared: shared, shell, session, done: shared ? "Shared with the workspace" : "Only you see this view")
    }

    func delete(_ v: TaskViewInfo, _ shell: Shell, _ session: SessionModel) {
        if session.preview {
            views.removeAll { $0.id == v.id }
            return
        }
        session.call({ try $0.deleteTaskView(id: v.id) }) { result in
            switch result {
            case .success:
                self.views.removeAll { $0.id == v.id }
                if self.openedId == v.id { self.openedId = nil }
                shell.say("View deleted")
            case let .failure(e): self.fail(e, shell)
            }
        }
    }
}

extension LookData {
    static let savedViews: [TaskViewInfo] = {
        func query(priority: Set<Int> = [], assignee: Set<String> = [], due: TaskDueFilter = .any, sort: TaskSort, group: TaskGrouping) -> String {
            var q = ViewQuery()
            q.priority = priority
            q.assignee = assignee
            q.due = due
            q.sort = sort
            q.group = group
            return q.json
        }
        return [
            TaskViewInfo(id: "v-urgent", workspaceId: "look", ownerId: "demo", shared: false, name: "Urgent this week",
                         queryJson: query(priority: [1, 2], due: .week, sort: .priority, group: .none), position: 1, createdAt: ""),
            TaskViewInfo(id: "v-mine", workspaceId: "look", ownerId: "demo", shared: true, name: "Mine, by page",
                         queryJson: query(assignee: ["me"], sort: .due, group: .note), position: 2, createdAt: ""),
            TaskViewInfo(id: "v-unassigned", workspaceId: "look", ownerId: "ana", shared: true, name: "Unassigned",
                         queryJson: query(assignee: ["unassigned"], sort: .created, group: .none), position: 3, createdAt: ""),
        ]
    }()
}

// MARK: Menu and dialog

/// The ribbon's "Saved views" menu (and the phone's sheet).
struct SavedViewsMenu: View {
    let palette: Palette
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session

    var body: some View {
        let p = palette
        let model = shell.views
        let current = model.current(shell.tv)
        let managed = model.managed(shell.tv)
        MenuCard(palette: p, width: 260, maxHeight: 420) {
            if model.views.isEmpty {
                Text("No saved views yet. Filter All tasks, then Save view.").font(.web(12.5)).foregroundStyle(p.textMuted.color)
                    .padding(.horizontal, 10).padding(.vertical, 8).frame(width: 236, alignment: .leading)
            }
            ForEach(model.views, id: \.id) { v in
                MenuItem(palette: p, title: v.name, icon: v.shared ? "users" : "bookmark", checked: current?.id == v.id) { model.open(v, shell, session) }
            }
            if let managed, model.canManage(managed, session) {
                MenuSeparator(palette: p)
                MenuLabel(palette: p, text: managed.name)
                if current?.id != managed.id {
                    MenuItem(palette: p, title: "Update to current filters", icon: "rotate-cw") {
                        shell.menu = nil
                        model.updateToCurrent(managed, shell, session)
                    }
                }
                MenuItem(palette: p, title: "Rename…", icon: "pencil") { shell.menu = nil; shell.sheet = .savedView(.rename(managed.id)) }
                if session.isAdmin {
                    MenuItem(palette: p, title: "Shared with workspace", icon: "users", checked: managed.shared) {
                        shell.menu = nil
                        model.setShared(managed, !managed.shared, shell, session)
                    }
                }
                MenuSeparator(palette: p)
                MenuItem(palette: p, title: "Delete view", icon: "trash", danger: true) { shell.menu = nil; shell.sheet = .savedView(.delete(managed.id)) }
            }
        }
    }
}

/// Save view, rename and delete (the web's prompt and confirm dialogs).
struct SavedViewCard: View {
    let kind: SavedViewDialog
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var text = ""
    @State private var shared = false
    @FocusState private var focused: Bool
    let theme = Theme.shared

    private var existing: TaskViewInfo? {
        switch kind {
        case .save: return nil
        case let .rename(id), let .delete(id): return shell.views.view(id)
        }
    }

    @ViewBuilder
    var body: some View {
        let name = text.trimmingCharacters(in: .whitespaces)
        switch kind {
        case .save, .rename:
            nameCard(name)
        case .delete:
            DialogCard(title: "Delete view?", description: "Delete the saved view “\(existing?.name ?? "")”\(existing?.shared == true ? " for everyone" : "")?",
                       width: width, close: { shell.sheet = nil }, hasBody: false) {
                EmptyView()
            } foot: {
                DialogButton(title: "Cancel") { shell.sheet = nil }
                DialogButton(title: "Delete", style: .danger) {
                    if let v = existing { shell.views.delete(v, shell, session) }
                    shell.sheet = nil
                }
            }
        }
    }

    private func nameCard(_ name: String) -> some View {
        let p = theme.chrome
        let saving = kind == .save
        return DialogCard(title: saving ? "Save view" : "Rename view", width: width, close: { shell.sheet = nil }) {
            VStack(alignment: .leading, spacing: 12) {
                DialogField(label: "Name", placeholder: "", text: $text, focused: $focused) { if !name.isEmpty { send(name) } }
                if saving && session.isAdmin {
                    Button { shared.toggle() } label: {
                        HStack(spacing: 8) {
                            if shared {
                                Icon("square-check", 16, p.accent.color)
                            } else {
                                RoundedRectangle(cornerRadius: 3).stroke(p.textMuted.color, lineWidth: 1.5).frame(width: 14, height: 14).padding(1)
                            }
                            Text("Share with the workspace").font(.web(14)).foregroundStyle(p.text.color)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        } foot: {
            DialogButton(title: "Cancel") { shell.sheet = nil }
            DialogButton(title: saving ? "Save" : "Rename", style: .primary, enabled: !name.isEmpty) { send(name) }
        }
        .onAppear {
            if case .rename = kind { text = existing?.name ?? "" }
            if LookData.state == nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { focused = true } }
        }
    }

    private func send(_ name: String) {
        let clipped = String(name.prefix(60))
        switch kind {
        case .save: shell.views.create(name: clipped, shared: shared, shell, session)
        case .rename: if let v = existing, v.name != clipped { shell.views.rename(v, to: clipped, shell, session) }
        case .delete: break
        }
        shell.sheet = nil
    }
}

/// The phone's strip of saved views above All tasks (the web's `.saved-views` chips), and Save view.
struct SavedViewChips: View {
    let palette: Palette
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session

    var body: some View {
        let p = palette
        let model = shell.views
        let current = model.current(shell.tv)
        let managed = model.managed(shell.tv)
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.views, id: \.id) { v in
                    let active = current?.id == v.id
                    Button { model.open(v, shell, session) } label: {
                        HStack(spacing: 5) {
                            Icon(v.shared ? "users" : "bookmark", 13, active ? p.accent.color : p.text2.color)
                            Text(v.name).font(.web(13, 500)).foregroundStyle(active ? p.accent.color : p.text.color).lineLimit(1)
                        }
                        .padding(.horizontal, 10).frame(height: 30)
                        .background(active ? p.accentSoft.color : p.bg.color, in: Capsule())
                        .overlay(Capsule().stroke(active ? p.accent.color : p.border.color, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
                if current == nil, !ViewQuery(shell.tv).isPlain {
                    Button { shell.sheet = .savedView(.save) } label: {
                        HStack(spacing: 5) {
                            Icon("bookmark-plus", 14, p.text2.color)
                            Text("Save view").font(.web(13, 500)).foregroundStyle(p.text.color)
                        }
                        .padding(.horizontal, 10).frame(height: 30)
                        .overlay(Capsule().stroke(p.border.color, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
                if let managed, model.canManage(managed, session) {
                    Button { shell.menu = .savedViews } label: {
                        Icon("ellipsis", 15, p.text2.color).frame(width: 30, height: 30).overlay(Circle().stroke(p.border.color, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .onAppear { model.load(session) }
    }
}
