import Foundation

/// A box's content as nodes: an element (`paragraph`, `bulletList`, `taskRef`…) with attributes and
/// children, or a run of text with its marks. Same shape as the corpus' `expected.json` fragments
/// (tests/corpus/README.md), which is how y-prosemirror stores the editor's document.
///
/// Interim: the core has no per-box content call yet (asked in docs/rewrite/STATUS.md), so the
/// prototype reads box content from the corpus JSON and everything else from `readPage(update:)`.
indirect enum PageNode {
    case element(type: String, attrs: [String: Any], content: [PageNode])
    case text([TextRun])
    case other

    struct TextRun {
        let insert: String
        let marks: [String: Any]
    }

    init(json: Any) {
        guard let obj = json as? [String: Any] else { self = .other; return }
        if let runs = obj["text"] as? [[String: Any]] {
            self = .text(runs.map {
                TextRun(insert: $0["insert"] as? String ?? "", marks: $0["attributes"] as? [String: Any] ?? [:])
            })
        } else if let type = obj["type"] as? String {
            let content = (obj["content"] as? [Any] ?? []).map(PageNode.init(json:))
            self = .element(type: type, attrs: obj["attrs"] as? [String: Any] ?? [:], content: content)
        } else {
            self = .other
        }
    }
}

/// What a task line shows, from the task store (here: the corpus case's `input.json`).
enum TaskLine {
    case shown(title: String, done: Bool, due: String?)
    /// Left out with its notes (the task is not visible to this person).
    case hidden
}
