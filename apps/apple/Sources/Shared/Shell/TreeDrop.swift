import NotiveloCore
import SwiftUI
#if os(iOS)
import UIKit
#endif

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

/// The tree drag on the iPad (the Mac has `draggable`): press and hold, then move to drag a row; press, hold and let go opens
/// the row's menu (as the long press did before). Targets come from the rows' frames (`Shell.frames`), the drops are the
/// Mac's (`Shell.dropped`). The iPhone keeps "Move to…" (the web's phone has no drag).
struct TreeDragState: Equatable {
    var payload: String
    var label: String
    var point: CGPoint
    var over: DropTarget?
}

/// Long press on a tree row: the row's menu, and on the iPad also the drag (`drag`: "page:<id>" or "section:<id>").
struct TreeRowPress: ViewModifier {
    let drag: String?
    let label: String
    let menu: () -> Void
    @Environment(\.phoneLayout) private var phone

    func body(content: Content) -> some View {
        #if os(iOS)
        if phone || drag == nil {
            content.onLongPressGesture(minimumDuration: 0.5) { menu() }
        } else if let drag {
            content.modifier(TouchTreeDrag(drag: drag, label: label, menu: menu))
        }
        #else
        content.onLongPressGesture(minimumDuration: 0.5) { menu() }
        #endif
    }
}

#if os(iOS)
struct TouchTreeDrag: ViewModifier {
    let drag: String
    let label: String
    let menu: () -> Void
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var start: CGPoint?
    @State private var moved = false

    func body(content: Content) -> some View {
        content.simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5)
                .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("shell")))
                .onChanged { value in
                    guard case let .second(true, d?) = value else { return }
                    if start == nil { start = d.location }
                    if !moved, let s = start, hypot(d.location.x - s.x, d.location.y - s.y) > 8 {
                        moved = true
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    }
                    if moved { shell.treeDrag = TreeDragState(payload: drag, label: label, point: d.location, over: target(at: d.location)) }
                }
                .onEnded { _ in
                    let wasDrag = moved
                    let over = shell.treeDrag?.over
                    start = nil
                    moved = false
                    shell.treeDrag = nil
                    if !wasDrag { menu() } else if let over { _ = shell.dropped([drag], on: over, session) }
                }
        )
    }

    /// The row under the finger that takes this drag.
    private func target(at p: CGPoint) -> DropTarget? {
        let isPage = drag.hasPrefix("page:")
        for (id, f) in shell.frames where f.contains(p) {
            if id.hasPrefix("section:") { return .section(String(id.dropFirst("section:".count))) }
            if id.hasPrefix("page:"), isPage {
                let over = String(id.dropFirst("page:".count))
                if "page:" + over != drag { return .page(over) }
            }
            if id == "notebook-picker", !isPage, let nb = currentNotebook(session.shownTree, shell) { return .notebook(nb.id) }
        }
        return nil
    }
}
#endif

/// The row being dragged, under the finger.
struct TreeDragPreview: View {
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        if let d = shell.treeDrag {
            let p = theme.chrome
            HStack(spacing: 6) {
                Icon(d.payload.hasPrefix("page:") ? "file-text" : "folder", 14, p.text2.color)
                Text(d.label).font(.web(14, 500)).foregroundStyle(p.text.color).lineLimit(1)
            }
            .padding(.horizontal, 10).frame(height: 32).frame(maxWidth: 220)
            .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.accent.color, lineWidth: 1))
            .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
            .position(x: d.point.x + 70, y: d.point.y - 24)
            .allowsHitTesting(false)
        }
    }
}

extension View {
    /// The row's long press: menu, and the touch drag on the iPad.
    func treeRowPress(drag: String?, label: String, menu: @escaping () -> Void) -> some View {
        modifier(TreeRowPress(drag: drag, label: label, menu: menu))
    }

    /// A ring around the row a drag would drop on.
    func dropRing(_ target: DropTarget, _ shell: Shell) -> some View {
        overlay {
            if shell.treeDrag?.over == target {
                RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(Theme.shared.chrome.accent.color, lineWidth: 2)
            }
        }
    }
}
