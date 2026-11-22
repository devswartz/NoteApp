import Foundation
import NotiveloCore

/// A page from the page-format corpus (tests/corpus/cases, bundled as the `cases` folder), read
/// through the core like a live page: `readPage(update:)` gives the boxes, the page settings and
/// the typed box content. Task lines and the title come from the case's `input.json`.
/// Only shown in corpus mode (`-previewSignedIn YES`, CI screenshots).
struct CorpusPage: PageSource {
    let snapshot: PageSnapshot?

    static let bundleFolder = "cases"

    static var caseNames: [String] {
        guard let dir = Bundle.main.url(forResource: bundleFolder, withExtension: nil),
              let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.filter { !$0.hasPrefix(".") }.sorted()
    }

    /// Look-only pages built in code (the corpus has no case for them): one box with only a task line (open,
    /// done, or one the person can't see), and one empty box. Read-only (no page document).
    private static func synthetic(_ name: String) throws -> CorpusPage? {
        let tasks: [String: TaskLine]
        let nodes: [ContentNode]
        func node(_ kind: NodeKind, _ attrs: [Attr] = []) -> ContentNode {
            ContentNode(kind: kind, attrs: attrs, runs: [], children: [], markers: [])
        }
        let ref = node(.taskRef, [Attr(name: "taskId", value: .text(value: "t-only"))])
        switch name {
        case "box-task-open":
            tasks = ["t-only": .shown(title: "Add ChatGPT app connection", done: false, due: nil)]
            nodes = [ref]
        case "box-task-done":
            tasks = ["t-only": .shown(title: "Add ChatGPT app connection", done: true, due: nil)]
            nodes = [ref]
        case "box-task-hidden":
            tasks = ["t-only": .hidden]
            nodes = [ref]
        case "box-empty":
            tasks = [:]
            nodes = [node(.paragraph)]
        default:
            return nil
        }
        guard let dir = Bundle.main.url(forResource: bundleFolder, withExtension: nil)?.appendingPathComponent("empty") else {
            throw CocoaError(.fileNoSuchFile)
        }
        var info = try readPage(update: Data(contentsOf: dir.appendingPathComponent("page.bin")))
        info.kind = .canvas
        info.boxes = [PageBox(id: "only", x: 20, y: 20, w: 400, z: 1, wide: false)]
        info.content = [BoxContent(boxId: "only", nodes: nodes)]
        return CorpusPage(snapshot: PageSnapshot(id: "corpus:\(name)", title: "Notivelo", info: info, tasks: tasks, pageTitles: [:], document: nil))
    }

    static func load(_ name: String) throws -> CorpusPage {
        if let page = try synthetic(name) { return page }
        guard let dir = Bundle.main.url(forResource: bundleFolder, withExtension: nil)?.appendingPathComponent(name) else {
            throw CocoaError(.fileNoSuchFile)
        }
        let update = try Data(contentsOf: dir.appendingPathComponent("page.bin"))
        let info = try readPage(update: update)

        let input = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("input.json"))) as? [String: Any] ?? [:]
        var tasks: [String: TaskLine] = [:]
        for (id, value) in input["tasks"] as? [String: Any] ?? [:] {
            if let t = value as? [String: Any] {
                tasks[id] = .shown(title: t["title"] as? String ?? "", done: t["done"] as? Bool ?? false, due: t["due"] as? String)
            } else {
                tasks[id] = .hidden
            }
        }
        let title = input["title"] as? String ?? name
        return CorpusPage(snapshot: PageSnapshot(id: "corpus:\(name)", title: title.isEmpty ? name : title, info: info,
                                                 tasks: tasks, pageTitles: [:], document: update))
    }
}
