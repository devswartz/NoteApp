// The Core API from Swift, on corpus pages: proves the XCFramework links and the bindings work.
// Run with NV_CORPUS_DIR pointing at the repo's tests/corpus (CI: .github/workflows/rust.yml).
import Foundation
import XCTest
import NotiveloCore

final class CoreTests: XCTestCase {
    private func corpus(_ name: String, _ file: String) throws -> Data {
        guard let dir = ProcessInfo.processInfo.environment["NV_CORPUS_DIR"] else { throw XCTSkip("NV_CORPUS_DIR is not set") }
        return try Data(contentsOf: URL(fileURLWithPath: dir).appendingPathComponent("cases/\(name)/\(file)"))
    }

    private func text(_ name: String, _ file: String) throws -> String {
        String(decoding: try corpus(name, file), as: UTF8.self)
    }

    func testReadsACanvas() throws {
        let info = try readPage(update: corpus("canvas-boxes", "page.bin"))
        XCTAssertEqual(info.kind, .canvas)
        XCTAssertEqual(info.boxes.map(\.id), ["top", "a", "b", "c", "empty", "blank"])
        XCTAssertEqual(info.headings.first?.text, "Top box")
        XCTAssertEqual(info.text, try text("canvas-boxes", "page.txt"))
    }

    func testMarkdown() throws {
        let tasks: [String: TaskLineInput] = [
            "t1": .shown(title: "Write the plan", done: false, due: "2026-11-30"),
            "t2": .shown(title: "Ship it", done: true, due: nil),
            "t3": .shown(title: "Subtask", done: false, due: nil),
            "hidden": .hidden,
        ]
        XCTAssertEqual(try pageMarkdown(update: corpus("tasks", "page.bin"), title: "Tasks", tasks: tasks), try text("tasks", "page.md"))
    }

    func testErrorsAndMarkers() throws {
        XCTAssertThrowsError(try readPage(update: Data([1, 2, 3])))
        XCTAssertEqual(listMarker(listType: "I", n: 1994), "MCMXCIV")
        XCTAssertEqual(pageFormatVersion(), 2)
        XCTAssertFalse(coreVersion().isEmpty)
    }

    func testCoreNeedsASignIn() throws {
        let core = Core(serverUrl: "http://127.0.0.1:9")
        XCTAssertNil(core.user())
        XCTAssertThrowsError(try core.workspaces()) { error in
            XCTAssertEqual(error as? CoreError, .SignedOut)
        }
    }

    func testCoreWithAStore() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("nv-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let core = Core.withStore(serverUrl: "http://127.0.0.1:9", dbPath: dir.appendingPathComponent("store.db").path)
        XCTAssertTrue(core.hasStore())
        XCTAssertNil(core.cachedWorkspaces())
        XCTAssertNil(core.cachedTree(workspaceId: "w1"))
        XCTAssertNil(core.cachedTasks(workspaceId: "w1"))
        XCTAssertNil(core.cachedPageDocument(pageId: "p1"))
        XCTAssertThrowsError(try core.workspaces()) { error in
            XCTAssertEqual(error as? CoreError, .SignedOut)
        }
        core.signOut()
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("store.db").path))
        XCTAssertFalse(Core(serverUrl: "http://127.0.0.1:9").hasStore())
    }

    func testBoxContent() throws {
        let content = try pageContent(update: corpus("lists", "page.bin"))
        XCTAssertNil(content.first?.boxId)
        XCTAssertEqual(content.last?.boxId, "b1")
        XCTAssertEqual(content.last?.nodes.first?.kind, .bulletList)
        let ordered = try XCTUnwrap(content.last?.nodes.first { $0.kind == .orderedList })
        XCTAssertEqual(ordered.markers, ["1.", "2.", "3."])
        let info = try readPage(update: corpus("document-page", "page.bin"))
        let runs = info.content[0].nodes.flatMap(\.children).flatMap(\.runs)
        XCTAssertTrue(runs.contains { $0.text == "bold" && $0.marks == [.bold] })
    }

    func testALivePageWithoutASessionEnds() throws {
        final class Heard: LivePageListener, @unchecked Sendable {
            let ended = XCTestExpectation(description: "ended")
            private let lock = NSLock()
            private(set) var statuses: [LiveStatus] = []
            func onStatus(status: LiveStatus) {
                lock.lock(); statuses.append(status); lock.unlock()
                if case .ended = status { ended.fulfill() }
            }
            func onChange(page: PageInfo) {}
        }
        let core = Core(serverUrl: "http://127.0.0.1:9")
        let heard = Heard()
        let page = try core.openLivePage(pageId: "p1", listener: heard)
        wait(for: [heard.ended], timeout: 10)
        XCTAssertEqual(heard.statuses.first, .connecting(attempt: 0))
        XCTAssertEqual(heard.statuses.last, .ended(reason: .signedOut, message: "signed out"))
        XCTAssertEqual(page.unsentUpdates(), 0)
        page.close()
        XCTAssertEqual(core.unsentPages(), [])
    }

    func testBoxCallsOnALivePage() throws {
        final class Quiet: LivePageListener, @unchecked Sendable {
            func onStatus(status: LiveStatus) {}
            func onChange(page: PageInfo) {}
        }
        let core = Core(serverUrl: "http://127.0.0.1:9")
        let page = try core.openLivePage(pageId: "p1", listener: Quiet())
        let id = try page.createBox(x: 40, y: 60, w: 360, z: 1)
        XCTAssertEqual(id.count, 16)
        XCTAssertEqual(newBoxId().count, 16)
        try page.moveBox(id: id, x: 100, y: 200)
        try page.resizeBox(id: id, w: 500)
        XCTAssertEqual(try page.bringToFront(id: id), 1)
        let box = try XCTUnwrap(page.info().boxes.first { $0.id == id })
        XCTAssertEqual([box.x, box.y, box.w, box.z], [100, 200, 500, 1])
        XCTAssertFalse(box.wide)
        XCTAssertThrowsError(try page.moveBox(id: "nope", x: 1, y: 1)) { error in
            guard case BoxError.NoSuchBox(let missing) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(missing, "nope")
        }
        try page.deleteBox(id: id)
        XCTAssertTrue(page.info().boxes.isEmpty)
        page.close()
        XCTAssertThrowsError(try page.createBox(x: 0, y: 0, w: 300, z: 1)) { error in
            guard case BoxError.Closed = error else { return XCTFail("\(error)") }
        }
    }

    func testQuickAddAndTaskFields() throws {
        let q = parseQuickAdd(text: "Call Sam tomorrow 3pm p1 @sam #waiting +elders every week", today: "2026-11-05")
        XCTAssertEqual(q.title, "Call Sam")
        XCTAssertEqual([q.dueDate, q.dueTime], ["2026-11-06", "15:00"])
        XCTAssertEqual(q.priority, 1)
        XCTAssertEqual([q.assignee, q.team], ["sam", "elders"])
        XCTAssertEqual(q.tags, ["waiting"])
        XCTAssertEqual(q.recurrence?.freq, "week")
        XCTAssertEqual(Set(q.tokens.map(\.kind)), [.date, .time, .priority, .assignee, .tag, .team, .recurrence])
        let rule = TaskRecurrence(freq: "week", interval: 2, byWeekday: [4, 1])
        XCTAssertEqual(describeRecurrence(rule: rule, dueDate: nil), "Every 2 weeks on Mon, Thu")
        XCTAssertEqual(firstOccurrence(rule: TaskRecurrence(freq: "week", interval: 1, byWeekday: [1]), from: "2026-11-05"), "2026-11-09")
        let members = [WorkspaceMember(id: "u2", name: "Samuel Jones", email: "sam@x.org", color: "#123456", role: "member")]
        XCTAssertEqual(resolveMember(mention: "sam", members: members, me: "u1"), "u2")
        // A bad value is refused before anything is sent (this core has no server).
        let core = Core(serverUrl: "http://127.0.0.1:9")
        XCTAssertThrowsError(try core.updateTask(taskId: "t1", changes: TaskChanges(priority: 5))) { error in
            guard case CoreError.Server(let status, let message, _) = error else { return XCTFail("\(error)") }
            XCTAssertEqual([String(status), message], ["400", "Invalid priority"])
        }
        XCTAssertNil(core.cachedTaskDetail(taskId: "t1"))
    }

    func testSnippetRunsAndThreadIds() throws {
        let runs = parseSnippet(snippet: "the \u{AB}plan\u{BB} for Q4")
        XCTAssertEqual(runs.map(\.text), ["the ", "plan", " for Q4"])
        XCTAssertEqual(runs.map(\.matched), [false, true, false])
        XCTAssertTrue(parseSnippet(snippet: "").isEmpty)
        XCTAssertEqual(newCommentThreadId().count, 36)
        // A blank search asks nothing (this core has no server).
        let core = Core(serverUrl: "http://127.0.0.1:9")
        let none = try core.search(workspaceId: "w1", query: "  ")
        XCTAssertTrue(none.pages.isEmpty && none.tasks.isEmpty)
    }
}
