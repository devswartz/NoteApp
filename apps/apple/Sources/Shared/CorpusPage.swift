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
        let title = input["title"] as? String ?? name
        return CorpusPage(snapshot: PageSnapshot(id: "corpus:\(name)", title: title.isEmpty ? name : title, info: info,
                                                 tasks: tasks, pageTitles: [:], document: update))
    }
}
