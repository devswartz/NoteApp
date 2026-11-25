import Foundation
import NotiveloCore
import Observation

/// What a task line shows, from the task list (live) or the corpus case's `input.json`.
enum TaskLine: Equatable {
    case shown(title: String, done: Bool, due: String?)
    /// Left out with its notes (the task is not visible to this person).
    case hidden
}

/// A box with its content, as the page view draws it.
struct ShownBox {
    let box: PageBox
    let content: [ContentNode]
}

/// One state of a page: everything the page view needs to draw it.
/// A page the `[[` menu can link to: its title and where it lives ("Notebook › Section").
struct PageChoice: Equatable {
    let id: String
    let title: String
    let crumb: String
}

/// A person the `@` menu can mention.
struct PageMember: Equatable {
    let id: String
    let name: String
    let email: String
    let color: String
}

struct PageSnapshot {
    let id: String
    let title: String
    let info: PageInfo
    /// Task id → what its line shows. A task not in here shows its notes only.
    let tasks: [String: TaskLine]
    /// Page id → title, for page links.
    let pageTitles: [String: String]
    /// The page document (a Yjs update), for the Mac's Markdown preview.
    let document: Data?
    /// Pages the `[[` menu offers (newest first), without this page.
    var pageChoices: [PageChoice] = []
    /// People the `@` menu offers.
    var people: [PageMember] = []

    /// The boxes in reading order with their content (core's typed box content).
    var boxes: [ShownBox] {
        switch info.kind {
        case .canvas:
            return info.boxes.map { box in
                ShownBox(box: box, content: info.content.first { $0.boxId == box.id }?.nodes ?? [])
            }
        case .document:
            // An old single-column page: one wide box at the origin, as the web app shows it.
            return [ShownBox(box: PageBox(id: "default", x: 0, y: 0, w: 686, z: 0, wide: true),
                             content: info.content.first { $0.boxId == nil }?.nodes ?? [])]
        }
    }

    /// The page as Markdown, from the core (the Mac preview shows this).
    func markdown() -> String {
        guard let document else { return info.text }
        var lines: [String: TaskLineInput] = [:]
        for (id, line) in tasks {
            switch line {
            case .hidden: lines[id] = .hidden
            case let .shown(title, done, due): lines[id] = .shown(title: title, done: done, due: due)
            }
        }
        return (try? pageMarkdown(update: document, title: title, tasks: lines)) ?? info.text
    }
}

/// Where a page's content comes from: a live page on the server (`LivePageModel`) or a bundled
/// corpus page (`CorpusPage`). Nil while there is nothing to show yet.
protocol PageSource {
    var snapshot: PageSnapshot? { get }
}

extension SessionModel {
    /// Task lines for live pages, from the workspace's task list.
    var taskLines: [String: TaskLine] {
        var out: [String: TaskLine] = [:]
        for t in tasks {
            out[t.id] = t.locked ? .hidden : .shown(title: t.title, done: isDone(t), due: t.dueDate)
        }
        return out
    }

    var pageTitles: [String: String] {
        var out: [String: String] = [:]
        for p in tree?.pages ?? [] { out[p.id] = p.title.isEmpty ? "Untitled" : p.title }
        return out
    }
}

/// A page open live: `Core.openPage` with a listener; every change (anyone's edit, e.g. in the
/// web app) replaces `info` and the view redraws. Reconnects with a growing delay when the
/// connection drops; on 4401 (token expired) it reopens at once. As a `PageEditHost` it gives box
/// editors the page document and sends their edits (`LivePage.applyUpdate`, on `editQueue`).
@Observable
final class LivePageModel: PageSource {
    enum State: Equatable {
        case connecting
        case live
        case offline(String)
        case ended(String)
    }

    let pageId: String
    let title: String
    private(set) var info: PageInfo?
    private(set) var state: State = .connecting
    /// Everyone else who has the page open (the page bar's avatars): polled from the core's presence while the page is live.
    private(set) var people: [PagePerson] = []
    @ObservationIgnored private var presenceToken = 0
    @ObservationIgnored private var carets: [BoxCursor] = []
    @ObservationIgnored var onCursors: (([BoxCursor]) -> Void)?
    @ObservationIgnored private var cursorPending: (boxId: String, anchor: UInt32, head: UInt32)?
    @ObservationIgnored private var cursorSent: (boxId: String, anchor: UInt32, head: UInt32)?

    @ObservationIgnored private weak var session: SessionModel?
    @ObservationIgnored private var live: LivePage?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var attempts = 0
    @ObservationIgnored private var isClosed = false
    /// Moves bytes between box editors and the live page, off the main thread: `LivePage` calls
    /// take the page's lock, which `close()` holds while it waits for the socket thread.
    @ObservationIgnored private let editQueue = DispatchQueue(label: "com.devswartz.notivelo.page-edits", qos: .userInitiated)
    /// The editor's task store: the core's own (`Core.pageTasks`), so a task made on the iPad is
    /// made on the server, renamed there and deleted there; `LocalTaskCallbacks` without a server.
    @ObservationIgnored private let tasksStore: PageTaskStore
    /// Moves when this page changed a task (the page redraws its task lines).
    private(set) var tasksRevision = 0
    @ObservationIgnored var onRemoteChange: (() -> Void)?
    @ObservationIgnored var onSynced: (() -> Void)?

    init(pageId: String, title: String, session: SessionModel) {
        self.pageId = pageId
        self.title = title
        self.session = session
        tasksStore = PageTaskStore(inner: session.coreTasks(pageId: pageId) ?? LocalTaskCallbacks())
        tasksStore.onChange = { [weak self] in
            DispatchQueue.main.async {
                self?.tasksRevision += 1
                self?.session?.scheduleTaskRefresh()
            }
        }
    }

    var snapshot: PageSnapshot? {
        guard let info else { return nil }
        _ = tasksRevision
        let lines = tasksStore.overlay(session?.taskLines ?? [:])
        (tasksStore.inner as? LocalTaskCallbacks)?.update(from: lines)
        #if os(macOS)
        let document = live?.document()
        #else
        let document: Data? = nil
        #endif
        return PageSnapshot(id: pageId, title: title, info: info, tasks: lines,
                            pageTitles: session?.pageTitles ?? [:], document: document,
                            pageChoices: session?.pageChoices(excluding: pageId) ?? [], people: session?.people ?? [])
    }

    /// The page's outline (`LivePage.outline()`), read on the page's queue; `done` on the main thread.
    func outlineRead(_ done: @escaping ([OutlineItem]) -> Void) {
        guard let page = live else { return done([]) }
        editQueue.async {
            let items = page.outline()
            DispatchQueue.main.async { done(items) }
        }
    }

    func open() {
        guard let session, live == nil, !isClosed else { return }
        generation += 1
        let gen = generation
        let listener = Listener(model: self, generation: gen)
        if case .offline = state {} else { state = .connecting }
        let pageId = self.pageId
        session.call({ try $0.openPage(pageId: pageId, listener: listener) }) { [weak self] result in
            guard let self, !self.isClosed, gen == self.generation else {
                if case let .success(page) = result { Self.closeInBackground(page) }
                return
            }
            switch result {
            case let .success(page):
                self.live = page
                // Synced may have been heard before this hop (an empty page sends no change).
                if self.info == nil, self.state == .live { self.info = page.info() }
            case let .failure(e):
                if e is CancellationError { return }
                if case let .Server(status, _, _)? = e as? CoreError, status == 403 || status == 404 {
                    self.state = .ended(status == 404 ? "This page was deleted." : "You don't have access to this page.")
                    return
                }
                self.state = .offline(CoreBridge.message(e))
                self.retryLater()
            }
        }
    }

    /// Leave the page: close the connection (off the main thread; it may wait for the socket).
    func close() {
        isClosed = true
        presenceToken += 1
        tasksStore.flush()
        generation += 1
        if let live { Self.closeInBackground(live) }
        live = nil
    }

    private static func closeInBackground(_ page: LivePage) {
        DispatchQueue.global(qos: .utility).async { page.close() }
    }

    private func retryLater() {
        attempts += 1
        let delay = min(30, pow(2, Double(min(attempts, 5))))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.isClosed, self.live == nil else { return }
            self.open()
        }
    }

    private func dropConnection() {
        if let live { Self.closeInBackground(live) }
        live = nil
        generation += 1
    }

    fileprivate func heard(_ status: SyncStatus, generation gen: Int) {
        guard gen == generation, !isClosed else { return }
        switch status {
        case .connected:
            break
        case .synced:
            attempts = 0
            state = .live
            if info == nil, let live { info = live.info() }
            startPresence()
            onSynced?()
        case let .closed(code, reason):
            dropConnection()
            switch code {
            case 4403:
                state = .ended("You no longer have access to this page.")
            case 4401 where attempts < 3:
                // The access token expired: open again (the core refreshes the session first).
                attempts += 1
                open()
            default:
                state = .offline(reason.isEmpty ? "Disconnected (\(code))." : reason)
                retryLater()
            }
        case let .failed(message):
            dropConnection()
            state = .offline(message)
            retryLater()
        }
    }

    /// Show this person to the others on the page, and read who is there every 3 seconds (on the edit queue: the core's page
    /// lock is held while a call runs). Stops when the page closes or the connection drops (the next sync starts it again).
    private func startPresence() {
        guard let live, let session else { return }
        presenceToken += 1
        let token = presenceToken
        let canEdit = session.workspace?.role != "viewer"
        editQueue.async { live.announcePresence(canEdit: canEdit) }
        pollPresence(token, generation)
    }

    private func pollPresence(_ token: Int, _ gen: Int) {
        guard let live, token == presenceToken, gen == generation, !isClosed else { return }
        let me = session?.user?.id
        editQueue.async { [weak self] in
            let list = PagePerson.from(states: live.presence(), excluding: me)
            let carets = live.remoteCursors()
            DispatchQueue.main.async {
                guard let self, token == self.presenceToken, gen == self.generation, !self.isClosed else { return }
                if list != self.people { self.people = list }
                if carets != self.carets {
                    self.carets = carets
                    self.onCursors?(carets)
                }
                // Faster while someone else is here (their carets move), as the web follows awareness.
                let delay = list.isEmpty ? 3.0 : 0.5
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.pollPresence(token, gen) }
            }
        }
    }

    fileprivate func changed(_ page: PageInfo, generation gen: Int) {
        guard gen == generation, !isClosed else { return }
        info = page
        if state == .connecting { state = .live }
        onRemoteChange?()
    }
}

extension LivePageModel {
    /// Put an earlier version back (`Core.restoreVersion`): the core saves the page as it is now ("before restore"), then
    /// replaces its content in one edit. `done` gets the id of that "before restore" version (the way to undo), nil for an
    /// empty page. The page shows the restored content at once.
    func restore(versionId: String, then done: @escaping (Result<String?, Error>) -> Void) {
        guard let session, let live, !isClosed else {
            done(.failure(BoxError.Closed))
            return
        }
        session.call({ core -> (String?, PageInfo) in
            let before = try core.restoreVersion(page: live, versionId: versionId)
            return (before, live.info())
        }) { [weak self] result in
            switch result {
            case let .success((before, info)):
                if let self, !self.isClosed, self.live === live {
                    self.info = info
                    self.onRemoteChange?()
                }
                done(.success(before))
            case let .failure(e):
                done(.failure(e))
            }
        }
    }
}

extension LivePageModel: PageEditHost {
    var taskCallbacks: TaskCallbacks { tasksStore }

    func fetchDocument(_ done: @escaping (Data?) -> Void) {
        guard let live, !isClosed else {
            done(nil)
            return
        }
        editQueue.async {
            let document = live.document()
            DispatchQueue.main.async { done(document) }
        }
    }

    var savesBoxes: Bool { true }

    func loadInk(_ done: @escaping ([InkStrokeInfo]?) -> Void) {
        guard let live, !isClosed else {
            done(nil)
            return
        }
        editQueue.async {
            let strokes = live.inkStrokes()
            DispatchQueue.main.async { done(strokes) }
        }
    }

    var pageToken: ObjectIdentifier? { live.map { ObjectIdentifier($0) } }

    func openLiveSession(field: String, _ done: @escaping (Result<EditorSession?, Error>) -> Void) {
        guard let live, !isClosed else {
            done(.failure(BoxEditorError.noDocument))
            return
        }
        let tasks = tasksStore
        // On the page's queue: a box made a moment ago is there by then, as for any box call.
        editQueue.async {
            let result: Result<EditorSession?, Error>
            do { result = .success(try EditorSession.openLive(page: live, field: field, tasks: tasks)) } catch { result = .failure(error) }
            DispatchQueue.main.async { done(result) }
        }
    }

    func pageFlags(_ done: @escaping ((Bool, Bool)) -> Void) {
        guard let live, !isClosed else { return }
        editQueue.async {
            let flags = (live.canUndo(), live.canRedo())
            DispatchQueue.main.async { done(flags) }
        }
    }

    func boxCall(_ call: @escaping (LivePage) throws -> Void, _ done: @escaping (Error?) -> Void) {
        guard let live, !isClosed else {
            done(BoxError.Closed)
            return
        }
        editQueue.async {
            var failure: Error?
            do { try call(live) } catch { failure = error }
            // A local call doesn't tell the page's listener: show the page as it is now.
            let page = live.info()
            // Every box call is a write (or a read the flags don't care about): the undo flags come with it.
            let flags = (live.canUndo(), live.canRedo())
            DispatchQueue.main.async { [weak self] in
                if let self, !self.isClosed, self.live === live {
                    self.info = page
                    if PageHistory.shared.host === self { PageHistory.shared.set(undo: flags.0, redo: flags.1) }
                }
                done(failure)
            }
        }
    }

    func send(_ update: Data, _ done: @escaping (Bool) -> Void) {
        guard let live, !isClosed else {
            done(false)
            return
        }
        editQueue.async {
            let ok = (try? live.applyUpdate(update: update)) != nil
            DispatchQueue.main.async { done(ok) }
        }
    }
}

/// Hears a live page on the core's sync thread and hands over to the main thread. Changes are
/// coalesced: while one is waiting for the main thread, a newer one replaces it.
private final class Listener: PageListener, @unchecked Sendable {
    private weak var model: LivePageModel?
    private let generation: Int
    private let lock = NSLock()
    private var pending: PageInfo?

    init(model: LivePageModel, generation: Int) {
        self.model = model
        self.generation = generation
    }

    func onStatus(status: SyncStatus) {
        let gen = generation
        DispatchQueue.main.async { [weak self] in
            self?.flush()
            self?.model?.heard(status, generation: gen)
        }
    }

    func onChange(page: PageInfo) {
        lock.lock()
        let schedule = pending == nil
        pending = page
        lock.unlock()
        if schedule {
            DispatchQueue.main.async { [weak self] in self?.flush() }
        }
    }

    /// Main thread: deliver the newest change, if any.
    private func flush() {
        lock.lock()
        let page = pending
        pending = nil
        lock.unlock()
        if let page { model?.changed(page, generation: generation) }
    }
}

extension LivePageModel {
    /// Our caret for the others' screens: sent at most every 100 ms (the latest wins), on the page's queue.
    func setLocalCursor(boxId: String, anchor: UInt32, head: UInt32) {
        guard live != nil, !isClosed else { return }
        let schedule = cursorPending == nil
        cursorPending = (boxId, anchor, head)
        guard schedule else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self, let live = self.live, !self.isClosed, let c = self.cursorPending else { return }
            self.cursorPending = nil
            if let sent = self.cursorSent, sent == c { return }
            self.cursorSent = c
            self.editQueue.async { live.setLocalCursor(boxId: c.boxId, anchor: c.anchor, head: c.head) }
        }
    }

    /// Editing stopped: take the caret off the others' screens.
    func clearLocalCursor() {
        cursorPending = nil
        cursorSent = nil
        guard let live, !isClosed else { return }
        editQueue.async { live.clearLocalCursor() }
    }
}
