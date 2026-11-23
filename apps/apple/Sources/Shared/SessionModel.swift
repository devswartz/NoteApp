import Foundation
import Network
import NotiveloCore
import Observation

/// The signed-in session: one `Core` for the chosen server, the refresh token in the keychain,
/// and what the sidebar shows (workspaces, tree, tasks).
///
/// Core calls block until the server answers, so they run one at a time on `queue`; results come
/// back on the main thread. After every call the (rotating) refresh token is stored again.
/// `-previewSignedIn YES` on the command line skips sign-in with no network (CI screenshots).
@Observable
final class SessionModel {
    static let production = "https://app.notiveloapp.com"
    static let staging = "https://staging.notiveloapp.com"

    enum Phase { case restoring, signedOut, signedIn }

    /// Corpus mode: signed in as nobody, sample pages only.
    let preview: Bool
    private(set) var serverURL: String
    private(set) var phase: Phase = .signedOut
    private(set) var user: User?
    /// Shown on the sign-in screen.
    var error: String?
    private(set) var busy = false
    /// A kept sign-in that could not be resumed (e.g. offline): the sign-in screen offers to try again.
    private(set) var canRetryRestore = false

    private(set) var workspaces: [Workspace] = []
    private(set) var workspaceId: String?
    var tree: Tree?
    private(set) var tasks: [CoreTask] = []
    /// Ticks not yet confirmed by the server (task id → done).
    private(set) var pendingDone: [String: Bool] = [:]
    private(set) var loadError: String?
    private(set) var loading = false
    /// The device has a network path (the offline banner waits 30 s after this turns false).
    private(set) var online = true
    /// The workspace's members, tags and teams (what a task's assignee, tag and team ids point at).
    private(set) var members: [WorkspaceMember] = []
    private(set) var tags: [TaskTag] = []
    private(set) var teams: [TaskTeam] = []
    /// Tasks with every field, once a task sheet has asked for them (task id → task).
    private(set) var details: [String: TaskDetail] = [:]
    /// Your reminders on the tasks whose sheet was opened (task id → list).
    private(set) var reminders: [String: [TaskReminder]] = [:]
    /// What the search palette last found, and for which words.
    private(set) var searchResults: SearchResults?
    private(set) var searchedQuery = ""
    /// Pages shared with this person one by one ("Shared with me").
    var sharedPages: [SharedPageEntry] = []
    /// An invite link (its token) opened in the app: the shell offers to join once signed in.
    var pendingInvite: String?
    /// What the server says about the locked pages (password set, unlocked, tries).
    var lockStatus: LockedNotesStatus?
    /// This sign-in has unlocked the locked pages (they stay open until 5 minutes without activity).
    var locksOpen = false

    @ObservationIgnored fileprivate var searchWork: DispatchWorkItem?
    @ObservationIgnored fileprivate var core: Core
    @ObservationIgnored fileprivate var taskRefreshWork: DispatchWorkItem?
    @ObservationIgnored private var savedToken: String?
    @ObservationIgnored private var pathMonitor: NWPathMonitor?
    @ObservationIgnored private let queue = DispatchQueue(label: "com.devswartz.notivelo.core", qos: .userInitiated)

    init() {
        let defaults = UserDefaults.standard
        preview = defaults.bool(forKey: "previewSignedIn")
        let url = defaults.bool(forKey: "useStaging") ? Self.staging : Self.production
        serverURL = url
        core = preview ? Core(serverUrl: url) : Self.makeCore(url)
        if !preview { watchNetwork() }
        if preview {
            user = User(id: "preview", email: "preview@notivelo", name: "Preview", color: "#3b82f6", emailVerified: true)
            phase = .signedIn
        } else {
            restore()
        }
    }

    var isStaging: Bool { serverURL != Self.production }
    var host: String { URL(string: serverURL)?.host ?? serverURL }
    var workspace: Workspace? { workspaces.first { $0.id == workspaceId } }

    func isDone(_ task: CoreTask) -> Bool { pendingDone[task.id] ?? task.done }

    /// Follows the device's connection; back online, the tree and tasks are read again.
    private func watchNetwork() {
        let monitor = NWPathMonitor()
        pathMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self else { return }
                let now = path.status == .satisfied
                let wasOffline = !self.online
                self.online = now
                if now && wasOffline && self.phase == .signedIn { self.reload() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.devswartz.notivelo.path"))
    }

    // MARK: Sign-in

    /// Resume the sign-in kept in the keychain for this server, if any.
    func restore() {
        guard let token = Keychain.read(account: serverURL) else {
            phase = .signedOut
            canRetryRestore = false
            return
        }
        phase = .restoring
        error = nil
        let core = self.core
        queue.async {
            let result = Result { try core.restoreSession(refreshToken: token) }
            let latest = core.refreshToken()
            DispatchQueue.main.async {
                guard core === self.core else { return }
                switch result {
                case let .success(s):
                    self.didSignIn(s.user, token: latest ?? s.refreshToken)
                case let .failure(e):
                    self.phase = .signedOut
                    if Self.tokenRejected(e) {
                        Keychain.delete(account: self.serverURL)
                        self.canRetryRestore = false
                        self.error = "You were signed out. Sign in again."
                    } else {
                        self.canRetryRestore = true
                        self.error = CoreBridge.message(e)
                    }
                }
            }
        }
    }

    func signIn(email: String, password: String) {
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.isEmpty, !password.isEmpty else {
            error = "Enter your email and password."
            return
        }
        busy = true
        error = nil
        let core = self.core
        queue.async {
            let result = Result { try core.signIn(email: email, password: password) }
            let latest = core.refreshToken()
            DispatchQueue.main.async {
                guard core === self.core else { return }
                self.busy = false
                switch result {
                case let .success(s): self.didSignIn(s.user, token: latest ?? s.refreshToken)
                case let .failure(e): self.error = CoreBridge.message(e, signingIn: true)
                }
            }
        }
    }

    /// Create an account (`Core.register`) and sign in to it. The server then wants the address confirmed first
    /// (`needsEmailCheck`: the "Check your email" screen).
    func register(name: String, email: String, password: String) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !email.isEmpty, !password.isEmpty else {
            error = "Enter your name, email and a password."
            return
        }
        guard password.count >= 8, password.count <= 72 else {
            error = "Use a password of 8 to 72 characters."
            return
        }
        busy = true
        error = nil
        let core = self.core
        queue.async {
            let result = Result { try core.register(name: name, email: email, password: password) }
            let latest = core.refreshToken()
            DispatchQueue.main.async {
                guard core === self.core else { return }
                self.busy = false
                switch result {
                case let .success(s): self.didSignIn(s.user, token: latest ?? s.refreshToken)
                case let .failure(e): self.error = SessionModel.plainMessage(e)
                }
            }
        }
    }

    /// Signed in, but the address isn't confirmed yet: the shell shows "Check your email" instead of the app.
    var needsEmailCheck: Bool { phase == .signedIn && !preview && user?.emailVerified == false }

    /// "I've verified, continue": ask the server again (the refresh token's session carries the user as it is now).
    func recheckEmail(then done: @escaping (String?) -> Void) {
        guard let token = savedToken ?? Keychain.read(account: serverURL) else { done("Sign in again."); return }
        let core = self.core
        queue.async {
            let result = Result { try core.restoreSession(refreshToken: token) }
            let latest = core.refreshToken()
            DispatchQueue.main.async {
                guard core === self.core else { return }
                switch result {
                case let .success(s):
                    self.didSignIn(s.user, token: latest ?? s.refreshToken)
                    done(s.user.emailVerified ? nil : "Not confirmed yet. Open the link in the email we sent, then try again.")
                case let .failure(e):
                    done(SessionModel.plainMessage(e))
                }
            }
        }
    }

    func signOut() {
        if !preview {
            let core = self.core
            queue.async { core.signOut() }
            Keychain.delete(account: serverURL)
        }
        endSession(message: nil)
    }

    /// The profile as the server has it now (Settings > Profile): the signed-in copy follows.
    func profileChanged(_ updated: User) {
        guard phase == .signedIn else { return }
        user = updated
    }

    /// Change the sign-in password. The server signs out every other device and gives this one a fresh session: its refresh
    /// token is kept like a sign-in's, and the locked pages lock again.
    func changePassword(current: String, new: String, then done: @escaping (Result<Void, Error>) -> Void) {
        call({ core -> (SignedIn, String?) in
            let signedIn = try core.changePassword(currentPassword: current, newPassword: new)
            return (signedIn, core.refreshToken())
        }) { result in
            switch result {
            case let .success((signedIn, latest)):
                self.store(latest ?? signedIn.refreshToken)
                self.user = signedIn.user
                self.locksOpen = false
                self.loadLockStatus()
                self.refreshTasks()
                done(.success(()))
            case let .failure(e):
                done(.failure(e))
            }
        }
    }

    /// The hidden staging switch (long-press the version line on the sign-in screen).
    func toggleStaging() {
        guard phase != .signedIn else { return }
        let staging = !isStaging
        UserDefaults.standard.set(staging, forKey: "useStaging")
        serverURL = staging ? Self.staging : Self.production
        core = Self.makeCore(serverURL)
        error = nil
        restore()
    }

    private func didSignIn(_ user: User, token: String) {
        store(token)
        self.user = user
        error = nil
        canRetryRestore = false
        phase = .signedIn
        loadWorkspaces()
    }

    private func endSession(message: String?) {
        core = preview ? Core(serverUrl: serverURL) : Self.makeCore(serverURL)
        savedToken = nil
        user = nil
        workspaces = []
        workspaceId = nil
        tree = nil
        tasks = []
        pendingDone = [:]
        members = []
        tags = []
        teams = []
        details = [:]
        reminders = [:]
        searchResults = nil
        sharedPages = []
        lockStatus = nil
        locksOpen = false
        loadError = nil
        loading = false
        busy = false
        canRetryRestore = false
        error = message
        phase = .signedOut
    }

    /// A core with the on-device store (nv-store): reads fall back to the stored copies offline,
    /// and `cached*` give the last copy at once. One file per server, in Application Support,
    /// excluded from backups. Without a usable folder, a core without a store.
    private static func makeCore(_ url: String) -> Core {
        let fm = FileManager.default
        guard var dir = try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Store", isDirectory: true) else { return Core(serverUrl: url) }
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        let file = dir.appendingPathComponent("notivelo-\(URL(string: url)?.host ?? "server").sqlite")
        return Core.withStore(serverUrl: url, dbPath: file.path)
    }

    private func store(_ token: String?) {
        guard let token, token != savedToken else { return }
        Keychain.write(token, account: serverURL)
        savedToken = token
    }

    private static func tokenRejected(_ e: Error) -> Bool {
        switch e as? CoreError {
        case .SignedOut?: return true
        case let .Server(status, _, _)?: return status == 401 || status == 403
        default: return false
        }
    }

    // MARK: Core calls

    /// Run `work` on the core queue; `done` gets the result on the main thread. A call that
    /// finds the session gone ends it here too.
    func call<T>(_ work: @escaping (Core) throws -> T, then done: @escaping (Result<T, Error>) -> Void) {
        guard !preview, phase == .signedIn else {
            done(.failure(CancellationError()))
            return
        }
        let core = self.core
        queue.async {
            let result = Result { try work(core) }
            let latest = core.refreshToken()
            DispatchQueue.main.async {
                guard core === self.core, self.phase == .signedIn else {
                    done(.failure(CancellationError()))
                    return
                }
                self.store(latest)
                if case let .failure(e) = result, (e as? CoreError) == .SignedOut {
                    Keychain.delete(account: self.serverURL)
                    self.endSession(message: CoreBridge.message(e))
                }
                done(result)
            }
        }
    }

    // MARK: Workspace, tree, tasks

    private var workspaceKey: String { "workspaceId \(serverURL)" }

    func loadWorkspaces() {
        loading = true
        // The stored copy first (instant), then the server's answer.
        if workspaces.isEmpty, let cached = core.cachedWorkspaces(), !cached.isEmpty {
            workspaces = cached
            let saved = UserDefaults.standard.string(forKey: workspaceKey)
            if let pick = cached.first(where: { $0.id == saved }) ?? cached.first { selectWorkspace(pick.id) }
        }
        call({ try $0.workspaces() }) { result in
            self.loading = false
            switch result {
            case let .success(list):
                self.workspaces = list
                self.loadError = list.isEmpty ? "No workspaces yet. Create one in the web app." : nil
                let saved = UserDefaults.standard.string(forKey: self.workspaceKey)
                if let pick = list.first(where: { $0.id == saved }) ?? list.first {
                    self.selectWorkspace(pick.id)
                }
            case let .failure(e):
                if !(e is CancellationError) { self.loadError = CoreBridge.message(e) }
            }
        }
    }

    /// An invite was accepted: the workspace list again, then that workspace (or the shared page's).
    func joined(_ a: AcceptedInvite) {
        call({ try $0.workspaces() }) { result in
            guard case let .success(list) = result else { return }
            self.workspaces = list
            if list.contains(where: { $0.id == a.workspaceId }) { self.selectWorkspace(a.workspaceId) }
            self.loadShared()
        }
    }

    /// You left a workspace: the list again, and the first one that is left.
    func leftWorkspace(_ id: String) {
        call({ try $0.workspaces() }) { result in
            guard case let .success(list) = result else { return }
            self.workspaces = list
            if self.workspaceId == id {
                if let next = list.first {
                    self.selectWorkspace(next.id)
                } else {
                    self.workspaceId = nil
                    self.tree = nil
                    self.tasks = []
                    self.loadError = "No workspaces yet. Create one in the web app."
                }
            }
        }
    }

    func selectWorkspace(_ id: String) {
        guard id != workspaceId || tree == nil else { return }
        workspaceId = id
        UserDefaults.standard.set(id, forKey: workspaceKey)
        tree = nil
        tasks = []
        pendingDone = [:]
        members = []
        tags = []
        teams = []
        details = [:]
        reminders = [:]
        reload()
    }

    /// Tree and tasks of the current workspace again.
    func reload(then done: (() -> Void)? = nil) {
        guard let ws = workspaceId else {
            if workspaces.isEmpty && phase == .signedIn && !preview { loadWorkspaces() }
            done?()
            return
        }
        loading = true
        if tree == nil, !preview, let cached = core.cachedTree(workspaceId: ws) {
            tree = cached
            tasks = core.cachedTasks(workspaceId: ws) ?? []
        }
        call({ core -> (Tree, [CoreTask]) in try (core.tree(workspaceId: ws), core.tasks(workspaceId: ws)) }) { result in
            defer { done?() }
            guard ws == self.workspaceId else { return }
            self.loading = false
            switch result {
            case let .success((tree, tasks)):
                self.tree = tree
                self.tasks = tasks
                self.loadError = nil
                self.loadLookups()
                self.loadShared()
                self.loadLockStatus()
            case let .failure(e):
                if !(e is CancellationError) { self.loadError = CoreBridge.message(e) }
            }
        }
    }

    @MainActor
    func refresh() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            reload { c.resume() }
        }
    }

    fileprivate func setTasksFromStore(_ list: [CoreTask]) { tasks = list }

    /// A task just made, shown at once (the list is read again soon after).
    func appendTask(_ t: CoreTask) { if !tasks.contains(where: { $0.id == t.id }) { tasks.append(t) } }

    func refreshTasks() {
        guard let ws = workspaceId else { return }
        call({ try $0.tasks(workspaceId: ws) }) { result in
            guard ws == self.workspaceId, case let .success(tasks) = result else { return }
            self.tasks = tasks
        }
    }

    /// Tick or untick: shown at once, sent to the server, then the list is fetched again.
    func setDone(_ task: CoreTask, _ done: Bool) {
        let id = task.id
        pendingDone[id] = done
        call({ try $0.setTaskDone(taskId: id, done: done) }) { result in
            switch result {
            case let .success(updated):
                if let i = self.tasks.firstIndex(where: { $0.id == id }) { self.tasks[i] = updated }
                self.pendingDone[id] = nil
                self.refreshTasks()
            case let .failure(e):
                self.pendingDone[id] = nil
                if !(e is CancellationError) { self.loadError = CoreBridge.message(e) }
            }
        }
    }
}

// MARK: Tasks written on pages, and the menus' data

extension SessionModel {
    /// The core's task store for a page (`Core.pageTasks`): a task line made in the editor is made on
    /// the server (with the id the engine chose), renamed and deleted there too. Nil without a server.
    func coreTasks(pageId: String) -> TaskCallbacks? {
        guard !preview, let ws = workspaceId else { return nil }
        return core.pageTasks(workspaceId: ws, pageId: pageId)
    }

    /// Pages the `[[` menu offers: newest first, with "Notebook › Section" for each.
    func pageChoices(excluding pageId: String) -> [PageChoice] {
        guard let tree else { return [] }
        let notebooks = Dictionary(uniqueKeysWithValues: tree.notebooks.map { ($0.id, $0.name) })
        let sections = Dictionary(uniqueKeysWithValues: tree.sections.map { ($0.id, $0) })
        func crumb(_ sectionId: String) -> String {
            var names: [String] = []
            var current = sections[sectionId]
            var guardCount = 0
            while let s = current, guardCount < 12 {
                names.insert(s.name, at: 0)
                if let parent = s.parentId { current = sections[parent] } else {
                    if let n = notebooks[s.notebookId] { names.insert(n, at: 0) }
                    current = nil
                }
                guardCount += 1
            }
            return names.joined(separator: " › ")
        }
        return tree.pages.filter { $0.id != pageId }
            .sorted { $0.updatedAt > $1.updatedAt }
            .map { PageChoice(id: $0.id, title: $0.title, crumb: crumb($0.sectionId)) }
    }

    /// People the `@` menu offers: the workspace's members (`Core.members`); until they are loaded (or
    /// offline), only the signed-in person.
    var people: [PageMember] {
        if !members.isEmpty {
            return members.map { PageMember(id: $0.id, name: $0.name, email: $0.email, color: $0.color) }
        }
        guard let user else { return [] }
        return [PageMember(id: user.id, name: user.name, email: user.email, color: user.color)]
    }

    /// The task list again, soon: from the device's store first (the core writes a task there when it
    /// makes it), then from the server.
    func scheduleTaskRefresh() {
        guard !preview, let ws = workspaceId else { return }
        taskRefreshWork?.cancel()
        let core = self.core
        let work = DispatchWorkItem { [weak self] in
            DispatchQueue.global(qos: .utility).async {
                let cached = core.cachedTasks(workspaceId: ws)
                DispatchQueue.main.async {
                    guard let self, ws == self.workspaceId, core === self.core else { return }
                    if let cached { self.setTasksFromStore(cached) }
                    self.refreshTasks()
                }
            }
        }
        taskRefreshWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
    }
}

// MARK: Task detail edits

extension SessionModel {
    /// Rename a task: shown at once, sent with `Core.setTaskTitle` (the server trims it).
    func rename(task: CoreTask, to title: String) {
        let id = task.id
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t != task.title else { return }
        if let i = tasks.firstIndex(where: { $0.id == id }) { tasks[i].title = t }
        call({ try $0.setTaskTitle(taskId: id, title: t) }) { result in
            switch result {
            case let .success(updated):
                if let i = self.tasks.firstIndex(where: { $0.id == id }) { self.tasks[i] = updated }
            case let .failure(e):
                if !(e is CancellationError) { self.loadError = CoreBridge.message(e) }
                self.refreshTasks()
            }
        }
    }

    /// Delete a task (its subtasks go with it): gone from the list at once, then `Core.deleteTask`.
    func delete(taskId id: String) {
        tasks.removeAll { $0.id == id || $0.parentId == id }
        call({ try $0.deleteTask(taskId: id) }) { result in
            if case let .failure(e) = result {
                if !(e is CancellationError) { self.loadError = CoreBridge.message(e) }
            }
            self.refreshTasks()
        }
    }

    /// A subtask on the same page as its parent (`Core.createTaskWith` with a parent).
    func addSubtask(to parent: CoreTask, title: String) {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let ws = workspaceId else { return }
        let input = NewTaskInput(id: nil, title: t, pageId: parent.pageId, parentId: parent.id, done: false)
        call({ try $0.createTaskWith(workspaceId: ws, task: input) }) { result in
            switch result {
            case let .success(created):
                if !self.tasks.contains(where: { $0.id == created.id }) { self.tasks.append(created) }
                self.scheduleTaskRefresh()
            case let .failure(e):
                if !(e is CancellationError) { self.loadError = CoreBridge.message(e) }
            }
        }
    }
}

// MARK: Task fields, lookups, reminders (the full task model of the core)

extension SessionModel {
    /// Today as the core's local date, YYYY-MM-DD.
    static var todayString: String { dayString(Date()) }

    /// A date as the core's local date, YYYY-MM-DD.
    static func dayString(_ date: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }

    /// Members, tags and teams of the workspace (the core keeps no stored copy: needs the network).
    func loadLookups() {
        guard !preview, let ws = workspaceId else { return }
        call({ core -> ([WorkspaceMember], [TaskTag], [TaskTeam]) in
            (try core.members(workspaceId: ws), try core.tags(workspaceId: ws), try core.teams(workspaceId: ws))
        }) { result in
            guard ws == self.workspaceId, case let .success((members, tags, teams)) = result else { return }
            self.members = members
            self.tags = tags
            self.teams = teams
        }
    }

    func member(_ id: String?) -> WorkspaceMember? {
        guard let id else { return nil }
        return members.first { $0.id == id }
    }

    /// A person's name for the footer lines: a member, "a deleted user", or "someone".
    func personName(_ id: String?) -> String {
        guard let id else { return "someone" }
        if let m = member(id) { return m.name }
        if id == user?.id, let name = user?.name { return name }
        return id == "deleted-user" ? "a deleted user" : "someone"
    }

    /// The task with every field: the stored copy at once, then the server's.
    func loadDetail(_ id: String) {
        guard !preview, let ws = workspaceId else { return }
        if details[id] == nil, let cached = core.cachedTaskDetail(taskId: id) { details[id] = cached }
        call({ try $0.taskDetails(workspaceId: ws) }) { result in
            guard ws == self.workspaceId, case let .success(list) = result else { return }
            for d in list { self.details[d.id] = d }
        }
        loadReminders(id)
    }

    /// Show a changed task: its full copy, and the fields the list shows.
    fileprivate func merge(_ d: TaskDetail) {
        details[d.id] = d
        guard let i = tasks.firstIndex(where: { $0.id == d.id }) else { return }
        tasks[i].title = d.title
        tasks[i].description = d.description
        tasks[i].done = d.done
        tasks[i].priority = d.priority
        tasks[i].dueDate = d.dueDate
        tasks[i].dueTime = d.dueTime
        tasks[i].assigneeId = d.assigneeId
        tasks[i].tagIds = d.tagIds
        tasks[i].completedAt = d.completedAt
        tasks[i].updatedAt = d.updatedAt
    }

    /// Show the change at once (the server's answer replaces it).
    fileprivate func showLocally(_ id: String, _ c: TaskChanges) {
        if let i = tasks.firstIndex(where: { $0.id == id }) {
            if let v = c.description { tasks[i].description = v }
            if let v = c.priority { tasks[i].priority = v }
            if let v = c.dueDate { tasks[i].dueDate = v } else if c.clearDueDate { tasks[i].dueDate = nil }
            if let v = c.dueTime { tasks[i].dueTime = v } else if c.clearDueTime { tasks[i].dueTime = nil }
            if let v = c.assigneeId { tasks[i].assigneeId = v } else if c.clearAssignee { tasks[i].assigneeId = nil }
            if let v = c.tagIds { tasks[i].tagIds = v }
        }
        guard var d = details[id] else { return }
        if let v = c.description { d.description = v }
        if let v = c.priority { d.priority = v }
        if let v = c.dueDate { d.dueDate = v } else if c.clearDueDate { d.dueDate = nil }
        if let v = c.dueTime { d.dueTime = v } else if c.clearDueTime { d.dueTime = nil }
        if let v = c.recurrence { d.recurrence = v } else if c.clearRecurrence { d.recurrence = nil }
        if let v = c.reminderAt { d.reminderAt = v } else if c.clearReminderAt { d.reminderAt = nil }
        if let v = c.assigneeId {
            d.assigneeId = v
        } else if c.clearAssignee {
            d.assigneeId = nil
            d.assignedBy = nil
        }
        if let v = c.teamId { d.teamId = v } else if c.clearTeam { d.teamId = nil }
        if let v = c.tagIds { d.tagIds = v }
        details[id] = d
    }

    /// Change fields of a task (`Core.updateTask`): shown at once, then sent; `failed` gets the message when it is refused.
    func update(_ id: String, _ changes: TaskChanges, failed: ((String) -> Void)? = nil) {
        showLocally(id, changes)
        call({ try $0.updateTask(taskId: id, changes: changes) }) { result in
            switch result {
            case let .success(d):
                self.merge(d)
                // A new date or a tick can move the task between lists: fetch them again soon.
                self.scheduleTaskRefresh()
            case let .failure(e):
                if e is CancellationError { return }
                failed?(CoreBridge.message(e))
                self.refreshTasks()
                self.loadDetail(id)
            }
        }
    }

    /// A tag by name (made when it doesn't exist), added to the list the sheet shows.
    func createTag(_ name: String, then done: @escaping (TaskTag?) -> Void) {
        guard let ws = workspaceId else { return done(nil) }
        call({ try $0.createTag(workspaceId: ws, name: name, color: nil) }) { result in
            if case let .success(tag) = result {
                if !self.tags.contains(where: { $0.id == tag.id }) { self.tags.append(tag) }
                done(tag)
            } else {
                done(nil)
            }
        }
    }

    // MARK: Reminders

    func loadReminders(_ taskId: String) {
        call({ try $0.taskReminders(taskId: taskId) }) { result in
            if case let .success(list) = result { self.reminders[taskId] = list }
        }
    }

    func addReminder(_ taskId: String, _ spec: ReminderSpec, failed: ((String) -> Void)? = nil) {
        call({ try $0.addReminder(taskId: taskId, spec: spec) }) { result in
            switch result {
            case let .success(r): self.reminders[taskId, default: []].append(r)
            case let .failure(e): if !(e is CancellationError) { failed?(CoreBridge.message(e)) }
            }
        }
    }

    func deleteReminder(_ taskId: String, _ reminderId: String, failed: ((String) -> Void)? = nil) {
        let before = reminders[taskId]
        reminders[taskId]?.removeAll { $0.id == reminderId }
        call({ try $0.deleteReminder(reminderId: reminderId) }) { result in
            if case let .failure(e) = result {
                if !(e is CancellationError) { failed?(CoreBridge.message(e)) }
                self.reminders[taskId] = before
            }
        }
    }

    // MARK: Search (the core's content search)

    /// Ask the server what the words match in page text and task descriptions, 150 ms after the last call (the web's delay).
    func search(_ query: String) {
        searchWork?.cancel()
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !preview, let ws = workspaceId, !q.isEmpty else {
            searchResults = nil
            searchedQuery = ""
            return
        }
        let work = DispatchWorkItem { [weak self] in
            self?.call({ try $0.search(workspaceId: ws, query: q, limit: nil) }) { result in
                guard let self, ws == self.workspaceId else { return }
                switch result {
                case let .success(r):
                    self.searchResults = r
                    self.searchedQuery = q
                case .failure:
                    // Offline or refused: the title matches of the tree stay.
                    self.searchResults = nil
                    self.searchedQuery = ""
                }
            }
        }
        searchWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    func clearSearch() {
        searchWork?.cancel()
        searchResults = nil
        searchedQuery = ""
    }
}
