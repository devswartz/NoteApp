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

    @ObservationIgnored private weak var session: SessionModel?
    @ObservationIgnored private var live: LivePage?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var attempts = 0
    @ObservationIgnored private var isClosed = false
    /// Moves bytes between box editors and the live page, off the main thread: `LivePage` calls
    /// take the page's lock, which `close()` holds while it waits for the socket thread.
    @ObservationIgnored private let editQueue = DispatchQueue(label: "com.devswartz.notivelo.page-edits", qos: .userInitiated)
    @ObservationIgnored private let tasksStore = LocalTaskCallbacks()
    @ObservationIgnored var onRemoteChange: (() -> Void)?
    @ObservationIgnored var onSynced: (() -> Void)?

    init(pageId: String, title: String, session: SessionModel) {
        self.pageId = pageId
        self.title = title
        self.session = session
    }

    var snapshot: PageSnapshot? {
        guard let info else { return nil }
        let lines = session?.taskLines ?? [:]
        tasksStore.update(from: lines)
        #if os(macOS)
        let document = live?.document()
        #else
        let document: Data? = nil
        #endif
        return PageSnapshot(id: pageId, title: title, info: info, tasks: lines,
                            pageTitles: session?.pageTitles ?? [:], document: document)
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

    fileprivate func changed(_ page: PageInfo, generation gen: Int) {
        guard gen == generation, !isClosed else { return }
        info = page
        if state == .connecting { state = .live }
        onRemoteChange?()
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
