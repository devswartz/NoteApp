import NotiveloCore
import SwiftUI

/// Changes to the notebook tree: new page / section / notebook, rename, duplicate, move, delete.
///
/// The core has no tree-writing calls yet (`Core` has `tree`, but no create/rename/move/copy/delete;
/// see "Requests" in docs/rewrite/status/apple.md). The dialogs and inline rename are built and look
/// like the web's; until the core has the calls, `canEditTree` is false: outside corpus mode a menu
/// item shows the "isn't in the native preview yet" toast, and in corpus mode (the CI look shots)
/// the dialogs open and their buttons end in the same toast. When the calls arrive, `Shell.run` is
/// the one place that changes: call the core, `await session.refresh()`, open the new page.
extension SessionModel {
    var canEditTree: Bool { false }
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

    /// "New page", "Moving" … as the toast says it.
    var label: String {
        switch self {
        case .newPage: return "New page"
        case .newSection(_, let parent): return parent == nil ? "New section" : "New subsection"
        case .newNotebook: return "New notebook"
        case .rename: return "Renaming"
        case .duplicate: return "Duplicating"
        case .move: return "Moving"
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
    /// Corpus mode shows the dialogs; the real app waits for the core's calls.
    private func available(_ op: TreeOp, _ session: SessionModel) -> Bool {
        if session.canEditTree || session.preview { return true }
        notYet(op.label)
        return false
    }

    func newPage(in sectionId: String, _ session: SessionModel) {
        menu = nil
        // The web makes an "Untitled" page and opens it; there is no dialog to show.
        guard session.canEditTree else { notYet("New page"); return }
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

    /// The dialog's confirm button.
    func submit(_ dialog: TreeDialog, text: String = "", destination: String? = nil, _ session: SessionModel) {
        self.dialog = nil
        run(dialog.op, session, name: text, to: destination)
    }

    /// The one place the tree is changed. No core call yet: say so.
    func run(_ op: TreeOp, _ session: SessionModel, name: String? = nil, to: String? = nil) {
        say("\(op.label) isn’t in the native preview yet.")
    }
}
