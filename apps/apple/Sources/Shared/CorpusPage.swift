import Foundation
import NotiveloCore

/// A page from the page-format corpus (tests/corpus/cases, bundled as the `cases` folder), read
/// through the core: `readPage(update:)` gives the boxes, their geometry and the page settings.
/// Box content comes from the case's `expected.json` until the core can return it (see PageNode).
struct CorpusPage: Identifiable {
    let id: String
    let title: String
    let update: Data
    let info: PageInfo
    let tasks: [String: TaskLine]
    /// Boxes in reading order, each with its content.
    let boxes: [(box: PageBox, content: [PageNode])]

    static let bundleFolder = "cases"

    static var caseNames: [String] {
        guard let dir = Bundle.main.url(forResource: bundleFolder, withExtension: nil),
              let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.filter { !$0.hasPrefix(".") }.sorted()
    }

    static func load(_ name: String) throws -> CorpusPage {
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

        let expected = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("expected.json"))) as? [String: Any] ?? [:]
        var fragments: [String: [PageNode]] = [:]
        for f in expected["fragments"] as? [[String: Any]] ?? [] {
            if let fname = f["name"] as? String {
                fragments[fname] = (f["content"] as? [Any] ?? []).map(PageNode.init(json:))
            }
        }

        let boxes: [(box: PageBox, content: [PageNode])]
        switch info.kind {
        case .canvas:
            boxes = info.boxes.map { ($0, fragments["box:\($0.id)"] ?? []) }
        case .document:
            // An old single-column page: one wide box at the origin, as the web app shows it.
            boxes = [(PageBox(id: "default", x: 0, y: 0, w: 686, z: 0, wide: true), fragments["default"] ?? [])]
        }
        let title = input["title"] as? String ?? name
        return CorpusPage(id: name, title: title.isEmpty ? name : title, update: update, info: info, tasks: tasks, boxes: boxes)
    }

    /// The page as Markdown, from the core (the Mac preview shows this).
    func markdown() -> String {
        var lines: [String: TaskLineInput] = [:]
        for (id, line) in tasks {
            switch line {
            case .hidden: lines[id] = .hidden
            case let .shown(title, done, due): lines[id] = .shown(title: title, done: done, due: due)
            }
        }
        return (try? pageMarkdown(update: update, title: title, tasks: lines)) ?? "(could not read the page)"
    }
}
