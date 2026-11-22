import NotiveloCore
import Foundation

/// A box's tree in one shape for drawing, read from the core's typed content (boxes not open in
/// the engine) or from an editor session's ProseMirror JSON (`EditorState.docJson`).
struct BoxNode {
    var type: String
    var attrs: [String: Any] = [:]
    var text = ""
    var marks: [BoxMark] = []
    var content: [BoxNode] = []
    /// Ordered lists read from the page: each item's marker from the core (continued numbering applied).
    var markers: [String]?

    /// Nodes whose content is inline: one line each in the view's text (EDITOR.md 10.1).
    static let textblocks: Set<String> = ["paragraph", "heading", "codeBlock", "detailsSummary"]
    /// Blocks without text of their own: one U+FFFC line each.
    static let leafBlocks: Set<String> = ["horizontalRule", "image", "fileAttachment"]

    func string(_ name: String) -> String? { attrs[name] as? String }
    func number(_ name: String) -> Double? {
        if let n = attrs[name] as? NSNumber { return n.doubleValue }
        return (attrs[name] as? String).flatMap(Double.init)
    }
    func bool(_ name: String) -> Bool? { attrs[name] as? Bool }

    // MARK: From the engine's JSON

    static func document(json: String) -> BoxNode? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return jsonNode(object)
    }

    private static func jsonNode(_ o: [String: Any]) -> BoxNode {
        var n = BoxNode(type: o["type"] as? String ?? "unknown")
        n.attrs = o["attrs"] as? [String: Any] ?? [:]
        n.text = o["text"] as? String ?? ""
        n.marks = (o["marks"] as? [[String: Any]] ?? []).map {
            BoxMark(type: $0["type"] as? String ?? "", attrs: $0["attrs"] as? [String: Any] ?? [:])
        }
        n.content = (o["content"] as? [[String: Any]] ?? []).map(jsonNode)
        return n
    }

    // MARK: From the core's typed content

    static func document(content: [ContentNode]) -> BoxNode {
        BoxNode(type: "doc", content: content.flatMap(contentNode))
    }

    private static func contentNode(_ c: ContentNode) -> [BoxNode] {
        if c.kind == .text {
            return c.runs.map { BoxNode(type: "text", text: $0.text, marks: $0.marks.map(mark)) }
        }
        var n = BoxNode(type: name(c.kind))
        for a in c.attrs {
            switch a.value {
            case .null: n.attrs[a.name] = NSNull()
            case let .bool(v): n.attrs[a.name] = v
            case let .number(v): n.attrs[a.name] = v
            case let .text(v): n.attrs[a.name] = v
            case let .json(v): n.attrs[a.name] = v
            }
        }
        n.content = c.children.flatMap(contentNode)
        if c.kind == .orderedList { n.markers = c.markers }
        return [n]
    }

    private static func mark(_ m: Mark) -> BoxMark {
        switch m {
        case .bold: return BoxMark(type: "bold")
        case .italic: return BoxMark(type: "italic")
        case .underline: return BoxMark(type: "underline")
        case .strike: return BoxMark(type: "strike")
        case .code: return BoxMark(type: "code")
        case let .link(href): return BoxMark(type: "link", attrs: ["href": href])
        case let .textColor(color): return BoxMark(type: "textStyle", attrs: ["color": color])
        case let .highlight(color): return BoxMark(type: "highlight", attrs: color.map { ["color": $0] as [String: Any] } ?? [:])
        case let .comment(threadId): return BoxMark(type: "comment", attrs: ["threadId": threadId])
        case let .unknown(name): return BoxMark(type: name)
        }
    }

    private static func name(_ kind: NodeKind) -> String {
        switch kind {
        case .text: return "text"
        case .paragraph: return "paragraph"
        case .heading: return "heading"
        case .blockquote: return "blockquote"
        case .codeBlock: return "codeBlock"
        case .horizontalRule: return "horizontalRule"
        case .hardBreak: return "hardBreak"
        case .bulletList: return "bulletList"
        case .orderedList: return "orderedList"
        case .listItem: return "listItem"
        case .taskList: return "taskList"
        case .taskItem: return "taskItem"
        case .taskRef: return "taskRef"
        case .callout: return "callout"
        case .details: return "details"
        case .detailsSummary: return "detailsSummary"
        case .detailsContent: return "detailsContent"
        case .table: return "table"
        case .tableRow: return "tableRow"
        case .tableCell: return "tableCell"
        case .tableHeader: return "tableHeader"
        case .image: return "image"
        case .fileAttachment: return "fileAttachment"
        case .mention: return "mention"
        case .pageLink: return "pageLink"
        case let .unknown(name): return name
        }
    }
}

struct BoxMark {
    var type: String
    var attrs: [String: Any] = [:]
}

