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
}
