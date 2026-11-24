import NotiveloCore
import SwiftUI

/// Drag in the sidebar tree (the Mac): a page onto another page goes just before it (also in another section), a page onto a
/// section goes to its end, a section onto a section nests inside it, a section onto the notebook name moves it to that notebook's
/// top level. Core: `movePage`, `moveSection`. The payload is "page:<id>" or "section:<id>". The iPad and iPhone keep the
/// "Move to…" dialog (a touch drag would take the long press that opens a row's menu).
enum DropTarget: Equatable {
    case page(String)
    case section(String)
    case notebook(String)
}

extension Shell {
    func dropped(_ items: [String], on target: DropTarget, _ session: SessionModel) -> Bool {
        guard let item = items.first, session.canEditTree, !session.preview, let tree = session.tree else { return false }
        let parts = item.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return false }
        let kind = parts[0], id = parts[1]
        switch (kind, target) {
        case let ("page", .page(over)):
            guard id != over, let dest = tree.pages.first(where: { $0.id == over }) else { return false }
            let siblings = tree.pages.filter { $0.sectionId == dest.sectionId && $0.id != id }.sorted { $0.position < $1.position }
            let at = UInt32(siblings.firstIndex { $0.id == over } ?? siblings.count)
            treeMove(session, "Page moved", expand: dest.sectionId) { _ = try $0.movePage(pageId: id, sectionId: dest.sectionId, index: at) }
        case let ("page", .section(section)):
            guard tree.pages.first(where: { $0.id == id })?.sectionId != section else { return false }
            treeMove(session, "Page moved", expand: section) { _ = try $0.movePage(pageId: id, sectionId: section, index: nil) }
        case let ("section", .section(parent)):
            guard id != parent, SectionRules.canNest(id, under: parent, tree),
                  let dest = tree.sections.first(where: { $0.id == parent }) else {
                say("A section can’t go there.")
                return false
            }
            treeMove(session, "Section moved", expand: parent) {
                _ = try $0.moveSection(sectionId: id, notebookId: dest.notebookId, parentId: parent, index: nil)
            }
        case let ("section", .notebook(notebook)):
            treeMove(session, "Section moved", expand: nil) { _ = try $0.moveSection(sectionId: id, notebookId: notebook, parentId: nil, index: nil) }
        default:
            return false
        }
        return true
    }

    private func treeMove(_ session: SessionModel, _ done: String, expand: String?, _ work: @escaping (Core) throws -> Void) {
        session.changeTree({ core, _ -> Void in try work(core) }) { result in
            switch result {
            case .success:
                if let expand { self.expanded.insert(expand) }
                self.say(done)
            case let .failure(e):
                if !(e is CancellationError) { self.say(SessionModel.plainMessage(e)) }
            }
        }
    }
}

/// Makes a sidebar row draggable (Mac) and a place to drop (`drag` nil: a drop target only).
struct TreeDnD: ViewModifier {
    let drag: String?
    let target: DropTarget?
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session

    func body(content: Content) -> some View {
        #if os(macOS)
        Group {
            if let drag {
                content.draggable(drag)
            } else {
                content
            }
        }
        .dropDestination(for: String.self) { items, _ in
            guard let target else { return false }
            return shell.dropped(items, on: target, session)
        }
        #else
        content
        #endif
    }
}

extension View {
    func treeDnD(drag: String?, target: DropTarget?) -> some View { modifier(TreeDnD(drag: drag, target: target)) }
}
