#if os(iOS)
import Foundation
import NotiveloCore
import WidgetKit

// The iPhone/iPad extras of today's app (apps/mobile/ios/App/ShareExtension and TodayWidget), over the App Group
// `group.com.devswartz.notivelo` (Extensions/Shared/SharedStore.swift):
//   - the Share Extension only queues what was shared (kind, text, url, title); the app makes the task or note when it is in
//     front and the workspace is loaded (`Shell.takeShares`), as today's app does (src/platform/capacitor.ts `capture`);
//   - the app writes the Today widget's snapshot (same JSON as today's `widgetSnapshot`) whenever the task list changes.
// No token is shared with the extensions.

// MARK: Today widget

enum TodayWidgetFeed {
    /// My open tasks due today or overdue, sorted like the Today view, as the widget's JSON (`TodaySnapshot`).
    static func json(_ session: SessionModel) -> String {
        let today = SessionModel.todayString
        var snap: [String: Any] = ["v": 1, "date": today, "signedIn": session.user != nil, "locked": false, "total": 0,
                                   "items": [[String: Any]]()]
        if session.user != nil, let ws = session.workspaceId {
            let due = TaskBuckets(tasks: session.tasks, session: session).list(.today).sorted { a, b in
                let k1 = (a.dueDate ?? "", a.dueTime ?? "99", a.priority, a.createdAt)
                let k2 = (b.dueDate ?? "", b.dueTime ?? "99", b.priority, b.createdAt)
                return k1 < k2
            }
            let base = "/w/\(escape(ws))/tasks/today"
            snap["path"] = base
            snap["total"] = due.count
            snap["items"] = due.prefix(8).map { t -> [String: Any] in
                var item: [String: Any] = ["id": t.id, "title": String(t.title.prefix(200)),
                                           "overdue": (t.dueDate ?? today) < today, "priority": Int(t.priority),
                                           "path": "\(base)?task=\(escape(t.id))"]
                if let time = t.dueTime { item["time"] = time }
                return item
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: snap, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    private static func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s
    }

    private static var last = ""

    static func publish(_ json: String) {
        guard json != last else { return }
        last = json
        SharedStore.saveSnapshot(json)
        WidgetCenter.shared.reloadAllTimelines()
    }
}

// MARK: Shares

/// What a shared item becomes (today's `shareContent`): a quick-add line, or a note's title and paragraphs.
struct ShareContent {
    var quickAdd: String
    var title: String
    var paragraphs: [String]
    var url: String?

    init(_ item: [String: String]) {
        let raw = item["url"] ?? ""
        url = raw.lowercased().hasPrefix("http://") || raw.lowercased().hasPrefix("https://") ? raw : nil
        let lines = (item["text"] ?? "").components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let explicit = (item["title"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var host = ""
        if let url, let h = URL(string: url)?.host { host = h.hasPrefix("www.") ? String(h.dropFirst(4)) : h }
        let first = lines.first ?? ""
        let pick = !explicit.isEmpty ? explicit : !first.isEmpty ? first : !host.isEmpty ? host : "Shared note"
        title = String(pick.prefix(120))
        paragraphs = explicit.isEmpty ? Array(lines.dropFirst()) : lines
        if explicit.isEmpty, first.count > 120 { paragraphs.insert(first, at: 0) }
        let head = explicit.isEmpty ? first : explicit
        quickAdd = [String(head.prefix(200)), url].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// The note's body as editor JSON (a document template: one box), or nil when there is nothing but a title.
    var bodyJson: String? {
        var blocks: [[String: Any]] = paragraphs.map { ["type": "paragraph", "content": [["type": "text", "text": $0]]] }
        if let url {
            blocks.append(["type": "paragraph", "content": [["type": "text", "text": url,
                                                              "marks": [["type": "link", "attrs": ["href": url]]]]]])
        }
        guard !blocks.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: ["type": "doc", "content": blocks]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
}

extension Shell {
    /// "Inbox" if there is a section by that name, else the first section (today's `inboxSection`).
    private func inboxSection(_ tree: Tree) -> String? {
        let pos = Dictionary(tree.notebooks.map { ($0.id, $0.position) }, uniquingKeysWith: { a, _ in a })
        let sections = tree.sections.filter { pos[$0.notebookId] != nil }.sorted {
            (pos[$0.notebookId]!, $0.position) < (pos[$1.notebookId]!, $1.position)
        }
        return (sections.first { $0.name.trimmingCharacters(in: .whitespaces).lowercased() == "inbox" } ?? sections.first)?.id
    }

    /// Take what the Share Extension queued: a note becomes a page in the Inbox section (the last one opens); a task opens
    /// quick add with the text filled in (earlier tasks of a batch are added as they are).
    func takeShares(_ session: SessionModel) {
        guard !session.preview, session.phase == .signedIn, let tree = session.tree else { return }
        let items = SharedStore.takeShares()
        guard !items.isEmpty else { return }
        guard session.canEditTree else { say("You can only view this workspace."); return }
        let lastTask = items.lastIndex { $0["kind"] != "note" }
        let lastNote = items.lastIndex { $0["kind"] == "note" }
        for (i, item) in items.enumerated() {
            let c = ShareContent(item)
            if item["kind"] == "note", let section = inboxSection(tree) {
                let body = c.bodyJson
                session.changeTree({ core, _ in try core.createPage(sectionId: section, title: c.title) }) { r in
                    switch r {
                    case let .success(id):
                        if let body { TemplatesModel.shared.pending[id] = .body(body) }
                        self.expanded.insert(section)
                        if i == lastNote { self.open(page: id) }
                        self.say("Saved to Inbox")
                    case let .failure(e):
                        if !(e is CancellationError) { self.say(SessionModel.plainMessage(e)) }
                    }
                }
            } else if i == lastTask || item["kind"] == "note" {
                // A task, or a note with nowhere to go: quick add, filled in, on Today.
                route = .tasks(.today)
                openQuickAdd(session, text: c.quickAdd)
            } else {
                var f = SessionModel.NewTaskFields(title: c.quickAdd)
                f.assigneeId = session.user?.id
                session.addTask(f) { _ in }
            }
        }
    }
}
#endif
