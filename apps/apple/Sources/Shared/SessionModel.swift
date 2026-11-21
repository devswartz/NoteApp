import Foundation
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
    private(set) var tree: Tree?
    private(set) var tasks: [CoreTask] = []
    /// Ticks not yet confirmed by the server (task id → done).
    private(set) var pendingDone: [String: Bool] = [:]
    private(set) var loadError: String?
    private(set) var loading = false

    @ObservationIgnored private var core: Core
    @ObservationIgnored private var savedToken: String?
    @ObservationIgnored private let queue = DispatchQueue(label: "com.devswartz.notivelo.core", qos: .userInitiated)

    init() {
        let defaults = UserDefaults.standard
        preview = defaults.bool(forKey: "previewSignedIn")
        let url = defaults.bool(forKey: "useStaging") ? Self.staging : Self.production
        serverURL = url
        core = preview ? Core(serverUrl: url) : Self.makeCore(url)
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

    func signOut() {
        if !preview {
            let core = self.core
            queue.async { core.signOut() }
            Keychain.delete(account: serverURL)
        }
        endSession(message: nil)
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

    func selectWorkspace(_ id: String) {
        guard id != workspaceId || tree == nil else { return }
        workspaceId = id
        UserDefaults.standard.set(id, forKey: workspaceKey)
        tree = nil
        tasks = []
        pendingDone = [:]
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
