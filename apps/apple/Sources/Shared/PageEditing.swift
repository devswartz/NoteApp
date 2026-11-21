import Foundation
import NotiveloCore

/// Where a page's box editors get the page document from and send their edits to: a live page
/// (`LivePageModel`) or a bundled corpus page (`CorpusEditHost`, local only). Main thread only.
protocol PageEditHost: AnyObject {
    /// The page document now (a full Yjs update), to open a box; nil when there is none (offline
    /// before the first sync). `done` runs on the main thread.
    func fetchDocument(_ done: @escaping (Data?) -> Void)
    /// Send a local edit (a Yjs update) to everyone on the page; `done(true)` once the live page
    /// took it. Runs `done` on the main thread.
    func send(_ update: Data, _ done: @escaping (Bool) -> Void)
    /// The task store behind task lines.
    var taskCallbacks: TaskCallbacks { get }
    /// Someone else changed the page (main thread): editors apply the page document again.
    var onRemoteChange: (() -> Void)? { get set }
    /// The page is in sync again after a (re)connect (main thread): editors send all they have.
    var onSynced: (() -> Void)? { get set }
}

enum BoxEditorError: Error {
    case noDocument
}

/// One box of a page open in the editor engine (`EditorSession`, nv-core).
///
/// Threading: `EditorSession` calls are local (a mutex around the engine's state and its own
/// yrs doc; no I/O), so they run on the main thread. Moving bytes to and from the live page
/// (`LivePage.applyUpdate`, `LivePage.document`) happens on the host's own queue.
///
/// Sync: the session has its own copy of the page document. After every local change the editor
/// sends `encodeUpdateSince(confirmed)`, where `confirmed` is the session's state vector at the
/// last send the live page took (empty at first: the first send is the whole document, which the
/// live page mostly already has). A send that fails (offline, reconnecting) is folded into the
/// next one; after a reconnect everything is sent again (`onSynced`). Others' changes come back
/// as the live page's whole document, which `applyUpdate` merges (yrs skips what it has).
final class BoxEditor {
    let boxId: String
    let session: EditorSession
    private weak var host: PageEditHost?
    private var confirmed = Data()
    /// The engine has no `canUndo` / `canRedo` yet (requested): the view's undo manager asks these.
    private(set) var canUndo = false
    private(set) var canRedo = false

    /// The engine field of a box: `box:<id>`, or `default` for an old single-column page.
    static func field(for boxId: String) -> String { boxId == "default" ? "default" : "box:\(boxId)" }

    private init(boxId: String, session: EditorSession, host: PageEditHost) {
        self.boxId = boxId
        self.session = session
        self.host = host
    }

    /// Open `boxId` of the host's page. `done` runs on the main thread.
    static func open(boxId: String, host: PageEditHost, _ done: @escaping (Result<BoxEditor, Error>) -> Void) {
        host.fetchDocument { [weak host] document in
            guard let host, let document else {
                done(.failure(BoxEditorError.noDocument))
                return
            }
            do {
                let session = try EditorSession.open(update: document, field: field(for: boxId), tasks: host.taskCallbacks)
                let editor = BoxEditor(boxId: boxId, session: session, host: host)
                // Opening may add the box's trailing paragraph: send it like any edit.
                editor.send()
                done(.success(editor))
            } catch {
                done(.failure(error))
            }
        }
    }

    /// After a local change (typing, a key, a command, a paste): send it.
    func edited() {
        canUndo = true
        canRedo = false
        send()
    }

    func undo() -> Bool {
        let done = session.undo()
        if done { canRedo = true; send() } else { canUndo = false }
        return done
    }

    func redo() -> Bool {
        let done = session.redo()
        if done { canUndo = true; send() } else { canRedo = false }
        return done
    }

    /// Engine undo/redo through a key (`Mod+z`, `Mod+Shift+z`, `Mod+y`) also moves these.
    func noteKey(_ chord: String, handled: Bool) {
        switch chord {
        case "Mod+z": if handled { canRedo = true } else { canUndo = false }
        case "Mod+Shift+z", "Mod+y": if handled { canUndo = true } else { canRedo = false }
        default: if handled { canUndo = true; canRedo = false }
        }
    }

    /// Send what the live page may not have yet (`all`: everything, after a reconnect).
    func send(all: Bool = false) {
        guard let host else { return }
        let since = all ? Data() : confirmed
        guard let update = try? session.encodeUpdateSince(stateVector: since) else { return }
        // An update with no structs and no deletes (nothing new) is two zero bytes.
        if !all && update == Data([0, 0]) { return }
        let sv = session.stateVector()
        host.send(update) { [weak self] ok in
            if ok { self?.confirmed = sv }
        }
    }

    /// Merge someone else's change (the live page's whole document). The selection follows.
    func applyRemote(_ document: Data) {
        try? session.applyUpdate(update: document)
    }
}

/// The task store behind a box's task lines, for the engine. Titles come from the workspace's
/// task list (live) or the corpus case. Creating, deleting and renaming tasks from the iPad isn't
/// wired to the server yet (the Core API can't create a task with the engine's id, nor delete or
/// rename one: requested), so those stay on this device for now.
final class LocalTaskCallbacks: TaskCallbacks, @unchecked Sendable {
    private let lock = NSLock()
    private var titles: [String: String] = [:]
    private var deleted: [String: String] = [:]

    func update(from lines: [String: TaskLine]) {
        lock.lock()
        defer { lock.unlock() }
        for (id, line) in lines {
            if case let .shown(title, _, _) = line { titles[id] = title }
        }
    }

    func newId() -> String { UUID().uuidString.lowercased() }

    func create(id: String, title: String, done: Bool) {
        lock.lock()
        titles[id] = title
        lock.unlock()
    }

    func delete(id: String) {
        lock.lock()
        if let t = titles.removeValue(forKey: id) { deleted[id] = t }
        lock.unlock()
    }

    func restore(id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let t = deleted.removeValue(forKey: id) else { return false }
        titles[id] = t
        return true
    }

    func title(id: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return titles[id]
    }

    func setTitle(id: String, title: String) {
        lock.lock()
        titles[id] = title
        lock.unlock()
    }
}

/// A corpus page edited on this device only (corpus mode, CI screenshots): edits stay in the
/// box's session, nothing is sent anywhere.
final class CorpusEditHost: PageEditHost {
    private let document: Data
    let taskCallbacks: TaskCallbacks
    var onRemoteChange: (() -> Void)?
    var onSynced: (() -> Void)?

    init(document: Data, tasks: [String: TaskLine]) {
        self.document = document
        let callbacks = LocalTaskCallbacks()
        callbacks.update(from: tasks)
        taskCallbacks = callbacks
    }

    func fetchDocument(_ done: @escaping (Data?) -> Void) { done(document) }
    func send(_ update: Data, _ done: @escaping (Bool) -> Void) { done(true) }
}
