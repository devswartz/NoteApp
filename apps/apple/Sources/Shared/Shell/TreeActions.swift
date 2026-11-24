import NotiveloCore
import SwiftUI

/// Changes to the notebook tree: new page / section / notebook, rename, recolour, duplicate, move, delete.
///
/// They are the core's tree calls (`createPage`, `renameSection`, `movePage`, `copySection`, `deleteNotebook` …,
/// docs/rewrite/status/core.md "For apple: tree management"). `Shell.run` is the one place that calls them. After every
/// write the core fetches the workspace's tree again and stores it, and `SessionModel.changeTree` shows that tree.
/// In corpus mode (the CI look shots) the dialogs open and their buttons end in the "isn't in the native preview" toast.
extension SessionModel {
    /// Members and up may change the tree; a viewer only reads it. Corpus mode has no server.
    var canEditTree: Bool { !preview && workspace != nil && workspace?.role != "viewer" }
}

enum TreeKind: String, Equatable {
    case page, section, notebook
}

enum TreeOp: Equatable {
    case newPage(section: String)
    case newSection(notebook: String, parent: String?)
    case newNotebook(template: String)
    case rename(TreeKind, String)
    case duplicate(TreeKind, String)
    case move(TreeKind, String)
    case delete(TreeKind, String)
    case leaveShare(String)

    /// "New page", "Moving" … as the toast says it.
    var label: String {
        switch self {
        case .newPage: return "New page"
        case .newSection(_, let parent): return parent == nil ? "New section" : "New subsection"
        case .newNotebook: return "New notebook"
        case .rename: return "Renaming"
        case .duplicate: return "Duplicating"
        case .move: return "Moving"
        case .leaveShare: return "Removing"
        case .delete(let kind, _): return kind == .page ? "Deleting pages" : kind == .section ? "Deleting sections" : "Deleting notebooks"
        }
    }
}

/// The web's `promptDialog` / `confirmDialog` / `MoveDialog` / `NewNotebookDialog`, open in the shell.
struct TreeDialog: Equatable {
    enum Body: Equatable {
        case prompt(title: String, label: String, placeholder: String, confirm: String)
        case confirm(title: String, message: String, confirm: String)
        case move(TreeKind, String)
        case newNotebook
    }

    var body: Body
    var op: TreeOp
}

/// A starting structure for a new notebook (`notebookTemplates.ts`).
struct NotebookTemplate: Identifiable {
    let id: String
    let name: String
    let notebookName: String
    let description: String
    let icon: String
    let sections: [String]

    static let all = [
        NotebookTemplate(id: "blank", name: "Blank", notebookName: "", description: "One section, one empty page", icon: "📄", sections: ["General"]),
        NotebookTemplate(id: "personal", name: "Personal", notebookName: "Personal", description: "Journal, ideas and a reading list", icon: "🌱",
                         sections: ["Journal", "Ideas", "Reading"]),
        NotebookTemplate(id: "project", name: "Team project", notebookName: "Project", description: "Brief, meeting notes, specs and retros", icon: "🚀",
                         sections: ["Planning", "Docs", "Retros"]),
        NotebookTemplate(id: "meetings", name: "Meetings", notebookName: "Meetings", description: "Weekly syncs and one-on-ones", icon: "🗓️",
                         sections: ["Team", "1:1s"]),
        NotebookTemplate(id: "studies", name: "Studies", notebookName: "Studies", description: "Lectures, assignments and exam prep", icon: "🎓",
                         sections: ["Lectures", "Assignments", "Exams"]),
    ]
}

/// Where a section may be moved: the notebook's top level or under a section, never inside itself and
/// within three levels (`shared/sections.ts`, `canNestUnder`).
enum SectionRules {
    static let maxDepth = 3

    static func depth(_ id: String, _ tree: Tree) -> Int {
        var n = 1
        var current = tree.sections.first { $0.id == id }
        while let parent = current?.parentId, n < 12 {
            n += 1
            current = tree.sections.first { $0.id == parent }
        }
        return n
    }

    static func descendants(of id: String, _ tree: Tree) -> Set<String> {
        var out: Set<String> = [id]
        var grew = true
        while grew {
            grew = false
            for s in tree.sections where !out.contains(s.id) {
                if let parent = s.parentId, out.contains(parent) { out.insert(s.id); grew = true }
            }
        }
        return out
    }

    static func height(of id: String, _ tree: Tree) -> Int {
        1 + (tree.sections.filter { $0.parentId == id }.map { height(of: $0.id, tree) }.max() ?? 0)
    }

    static func canNest(_ id: String, under parent: String?, _ tree: Tree) -> Bool {
        guard let parent else { return true }
        if descendants(of: id, tree).contains(parent) { return false }
        return depth(parent, tree) + height(of: id, tree) <= maxDepth
    }
}

extension Shell {
    /// Why a change can't be made: the corpus preview has no server; a viewer may only read.
    private func refuse(_ op: TreeOp, _ session: SessionModel) {
        if session.preview { notYet(op.label) } else { say("You can only view this workspace.") }
    }

    private func available(_ op: TreeOp, _ session: SessionModel) -> Bool {
        if session.canEditTree || session.preview { return true }
        refuse(op, session)
        return false
    }

    func newPage(in sectionId: String, _ session: SessionModel) {
        menu = nil
        // The web makes an "Untitled" page and opens it; there is no dialog to show.
        guard session.canEditTree else { refuse(.newPage(section: sectionId), session); return }
        run(.newPage(section: sectionId), session)
    }

    func newSection(in notebookId: String, parent: CoreSection?, _ session: SessionModel) {
        menu = nil
        let op = TreeOp.newSection(notebook: notebookId, parent: parent?.id)
        guard available(op, session) else { return }
        if let parent, let tree = session.shownTree, SectionRules.depth(parent.id, tree) >= SectionRules.maxDepth {
            say("Sections can be nested \(SectionRules.maxDepth) levels deep.")
            return
        }
        let nb = session.shownTree?.notebooks.first { $0.id == notebookId }
        let title = parent.map { "New subsection in \($0.name)" } ?? "New section in \(nb?.name ?? "notebook")"
        dialog = TreeDialog(body: .prompt(title: title, label: "Name", placeholder: "", confirm: "Create"), op: op)
    }

    func newNotebook(_ session: SessionModel) {
        menu = nil
        let op = TreeOp.newNotebook(template: "blank")
        guard available(op, session) else { return }
        dialog = TreeDialog(body: .newNotebook, op: op)
    }

    /// Inline rename in the tree (the web's `RenameInput`).
    func rename(_ kind: TreeKind, _ id: String, _ session: SessionModel) {
        menu = nil
        guard available(.rename(kind, id), session) else { return }
        renaming = "\(kind.rawValue):\(id)"
    }

    func commitRename(_ kind: TreeKind, _ id: String, to value: String?, _ session: SessionModel) {
        renaming = nil
        guard let value else { return }
        run(.rename(kind, id), session, name: value)
    }

    func duplicate(_ kind: TreeKind, _ id: String, _ session: SessionModel) {
        menu = nil
        guard available(.duplicate(kind, id), session) else { return }
        run(.duplicate(kind, id), session)
    }

    func move(_ kind: TreeKind, _ id: String, _ session: SessionModel) {
        menu = nil
        let op = TreeOp.move(kind, id)
        guard available(op, session) else { return }
        dialog = TreeDialog(body: .move(kind, id), op: op)
    }

    /// Pages and sections go to the Trash with no question (and an Undo in the toast); a notebook asks first.
    func delete(_ kind: TreeKind, _ id: String, _ session: SessionModel) {
        menu = nil
        let op = TreeOp.delete(kind, id)
        guard available(op, session) else { return }
        if kind == .notebook {
            let name = session.shownTree?.notebooks.first { $0.id == id }?.name ?? "notebook"
            dialog = TreeDialog(body: .confirm(
                title: "Delete “\(name)”?",
                message: "It moves to the Trash with all its sections and pages, and stays there for 60 days. Its tasks stay in your task list. You can restore it from the Trash.",
                confirm: "Move to Trash"), op: op)
        } else {
            run(op, session)
        }
    }

    /// "Remove from Shared with me" asks first (the web's confirm).
    func leaveShare(_ pageId: String, _ session: SessionModel) {
        let title = session.sharedPages.first { $0.id == pageId }?.title ?? ""
        dialog = TreeDialog(body: .confirm(
            title: "Remove “\(title.isEmpty ? "Untitled" : title)” from Shared with me?",
            message: "You will lose access until it is shared with you again.",
            confirm: "Remove"), op: .leaveShare(pageId))
    }

    /// A notebook's or section's colour (the colour row of its menu).
    func recolour(_ kind: TreeKind, _ id: String, _ color: String, _ session: SessionModel) {
        menu = nil
        guard session.canEditTree else { refuse(.rename(kind, id), session); return }
        session.changeTree({ core, _ -> Void in
            if kind == .notebook {
                try core.setNotebookColor(notebookId: id, color: color)
            } else {
                try core.setSectionColor(sectionId: id, color: color)
            }
        }) { result in
            if case let .failure(e) = result { self.failed(e) }
        }
    }

    /// "Make private" / "Share with workspace" in the notebook's menu (only its creator may; the server says so otherwise).
    func setVisibility(_ notebookId: String, private makePrivate: Bool, _ session: SessionModel) {
        menu = nil
        guard session.canEditTree else { refuse(.rename(.notebook, notebookId), session); return }
        session.changeTree({ core, _ in
            try core.setNotebookVisibility(notebookId: notebookId, visibility: makePrivate ? "private" : "shared")
        }) { result in
            switch result {
            case let .success(ended):
                var text = makePrivate ? "Notebook is now private." : "Notebook is shared with the workspace."
                if makePrivate, ended > 0 { text += " \(ended) page \(ended == 1 ? "share" : "shares") ended." }
                self.say(text)
            case let .failure(e):
                self.failed(e)
            }
        }
    }

    /// The dialog's confirm button.
    func submit(_ dialog: TreeDialog, text: String = "", destination: String? = nil, _ session: SessionModel) {
        self.dialog = nil
        run(dialog.op, session, name: text, to: destination)
    }

    /// A page's icon (an emoji, nil clears it): core's `setPageIcon`; the tree comes back with it, so the sidebar row and the
    /// page's own icon row follow. The web's `setPageIcon` (src/pages/PageView.tsx).
    func setPageIcon(_ id: String, _ icon: String?, _ session: SessionModel) {
        guard session.canEditTree || session.preview else {
            say("You can only view this workspace.")
            return
        }
        if session.preview {
            notYet("Page icons")
            return
        }
        session.changeTree({ core, _ -> Void in try core.setPageIcon(pageId: id, icon: icon) }) { result in
            if case let .failure(e) = result { self.failed(e) }
        }
    }

    fileprivate func failed(_ error: Error) {
        if error is CancellationError { return }
        say(SessionModel.plainMessage(error))
    }

    /// After a delete: leave a page or section that is no longer in the tree.
    fileprivate func settleRoute(openPage: String?, _ session: SessionModel) {
        guard let tree = session.tree else { return }
        switch route {
        case let .page(id) where id == openPage:
            if !tree.pages.contains(where: { $0.id == id }) { route = .notes }
        case let .section(id):
            if !tree.sections.contains(where: { $0.id == id }) { route = .notes }
        default:
            break
        }
        if let nb = phoneNotebook, !tree.notebooks.contains(where: { $0.id == nb }) { phoneNotebook = nil }
        if let nb = notebookId, !tree.notebooks.contains(where: { $0.id == nb }) { notebookId = nil }
    }

    /// Undo of a delete: out of the Trash again.
    func restoreFromTrash(_ kind: TreeKind, _ id: String, _ session: SessionModel) {
        let trashKind: TrashKind = kind == .page ? .page : kind == .section ? .section : .notebook
        session.changeTree({ core, ws in try core.restoreFromTrash(workspaceId: ws, kind: trashKind, id: id) }) { result in
            switch result {
            case let .success(place):
                self.say(place.map { "Restored to \($0)" } ?? "Restored")
                session.scheduleTaskRefresh()
            case let .failure(e):
                self.failed(e)
            }
        }
    }

    /// The one place the tree is changed: the core's calls, then the tree it stored.
    func run(_ op: TreeOp, _ session: SessionModel, name: String? = nil, to: String? = nil) {
        guard !session.preview else {
            say("\(op.label) isn’t in the native preview yet.")
            return
        }
        if case let .leaveShare(pageId) = op {
            session.leaveShare(pageId: pageId) { problem in
                if let problem { self.say(problem) } else { self.say("Removed from Shared with me") }
                if self.route == .page(pageId) { self.route = .notes }
            }
            return
        }
        guard session.canEditTree else {
            say("You can only view this workspace.")
            return
        }
        let text = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let openPage: String? = {
            if case let .page(id) = route, session.tree?.pages.contains(where: { $0.id == id }) == true { return id }
            return nil
        }()
        switch op {
        case let .newPage(section):
            // A section (or a parent) can have a default template: the server remembers it on the page and this device fills the page
            // when it opens (TemplatesModel.consume). Offline, a blank page as before.
            session.changeTree({ core, _ -> (String, Bool) in
                do {
                    let c = try core.createPageFromTemplate(sectionId: section, title: nil, template: "default")
                    return (c.id, c.pendingTemplate != nil)
                } catch let e as CoreError {
                    if case .Network = e { return (try core.createPage(sectionId: section, title: nil), false) }
                    throw e
                }
            }) { result in
                switch result {
                case let .success((id, claim)):
                    if claim { TemplatesModel.shared.pending[id] = .claim }
                    self.expanded.insert(section)
                    self.open(page: id)
                case let .failure(e):
                    self.failed(e)
                }
            }

        case let .newSection(notebook, parent):
            guard !text.isEmpty else { return }
            session.changeTree({ core, _ in
                try core.createSection(notebookId: notebook, name: text, parentId: parent, color: nil)
            }) { result in
                switch result {
                case let .success(id):
                    if let parent { self.expanded.insert(parent) }
                    self.expanded.insert(id)
                    self.notebookId = notebook
                    self.route = .section(id)
                case let .failure(e):
                    self.failed(e)
                }
            }

        case let .newNotebook(template):
            guard !text.isEmpty else { return }
            let t = NotebookTemplate.all.first { $0.id == (to ?? template) } ?? NotebookTemplate.all[0]
            session.changeTree({ core, ws -> [String] in
                // The server makes the notebook with one section ("General"); the starting structure is ours.
                let nb = try core.createNotebook(workspaceId: ws, name: text, color: nil, visibility: nil)
                if t.id != "blank", let first = t.sections.first {
                    try core.renameSection(sectionId: nb.sectionId, name: first)
                    for extra in t.sections.dropFirst() {
                        _ = try core.createSection(notebookId: nb.id, name: extra, parentId: nil, color: nil)
                    }
                }
                let page = try core.createPage(sectionId: nb.sectionId, title: nil)
                return [nb.id, nb.sectionId, page]
            }) { result in
                switch result {
                case let .success(ids):
                    self.notebookId = ids[0]
                    self.phoneNotebook = nil
                    self.expanded.insert(ids[1])
                    self.open(page: ids[2])
                case let .failure(e):
                    self.failed(e)
                }
            }

        case let .rename(kind, id):
            if text.isEmpty && kind != .page { return }
            session.changeTree({ core, _ -> Void in
                switch kind {
                case .page: try core.renamePage(pageId: id, title: text)
                case .section: try core.renameSection(sectionId: id, name: text)
                case .notebook: try core.renameNotebook(notebookId: id, name: text)
                }
            }) { result in
                if case let .failure(e) = result { self.failed(e) }
            }

        case let .duplicate(kind, id):
            session.changeTree({ core, _ -> String in
                if kind == .page { return try core.copyPage(pageId: id, sectionId: nil, title: nil) }
                return try core.copySection(sectionId: id, notebookId: nil, name: nil)
            }) { result in
                switch result {
                case let .success(copy):
                    session.scheduleTaskRefresh()
                    if kind == .page {
                        self.say("Page duplicated")
                        self.open(page: copy)
                    } else {
                        self.say("Section duplicated")
                        self.expanded.insert(copy)
                    }
                case let .failure(e):
                    self.failed(e)
                }
            }

        case let .move(kind, id):
            guard let destination = to, let tree = session.tree else { return }
            // A page goes to a section. A section goes under a section (that one's notebook wins) or to a notebook's top level.
            let parent = tree.sections.first { $0.id == destination }
            session.changeTree({ core, _ -> Void in
                if kind == .page {
                    _ = try core.movePage(pageId: id, sectionId: destination, index: nil)
                } else if let parent {
                    _ = try core.moveSection(sectionId: id, notebookId: parent.notebookId, parentId: parent.id, index: nil)
                } else {
                    _ = try core.moveSection(sectionId: id, notebookId: destination, parentId: nil, index: nil)
                }
            }) { result in
                switch result {
                case .success:
                    if parent != nil { self.expanded.insert(destination) }
                    self.say(kind == .page ? "Page moved" : "Section moved")
                case let .failure(e):
                    self.failed(e)
                }
            }

        case let .delete(kind, id):
            session.changeTree({ core, _ -> Trashed in
                switch kind {
                case .page: return try core.deletePage(pageId: id)
                case .section: return try core.deleteSection(sectionId: id)
                case .notebook: return try core.deleteNotebook(notebookId: id)
                }
            }) { result in
                switch result {
                case let .success(trashed):
                    self.settleRoute(openPage: openPage, session)
                    let noun = kind == .page ? "Page" : kind == .section ? "Section" : "Notebook"
                    var message = "\(noun) moved to Trash"
                    if trashed.tasks > 0 {
                        message += ". \(trashed.tasks == 1 ? "Its task stays" : "Its \(trashed.tasks) tasks stay") in your task list."
                    }
                    self.say(message, undo: { self.restoreFromTrash(kind, id, session) })
                    session.scheduleTaskRefresh()
                case let .failure(e):
                    self.failed(e)
                }
            }

        case .leaveShare:
            break
        }
    }
}
