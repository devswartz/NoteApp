import Foundation
import NotiveloCore

/// Creating, moving and resizing boxes of a canvas page (docs/PLAN_CANVAS.md: `boxes` map, box id →
/// { x, y, w, z, wide }). `LiveBoxGeometry` sends each change to the server through the core's box
/// calls (`LivePage.createBoxWithId` …); `LocalBoxGeometry` keeps changes on this device only (the
/// look states and corpus pages, which have no server). Both show a change at once, over what the
/// page document says, until the page document has it. (Box calls: crates/nv-core/src/boxes.rs.)
protocol BoxGeometryStore: AnyObject {
    /// Do changes reach the server?
    var savesToServer: Bool { get }
    /// A change the server refused (main thread): the store has already taken the change back.
    /// `message` is for the toast; nil: take it back without saying anything.
    var onFailure: ((_ id: String, _ message: String?) -> Void)? { get set }
    /// A new box with its top-left at (x, y) (page points from the surface origin), `width` wide, in front.
    func createBox(x: Double, y: Double, width: Double, front: Double) -> String
    /// Shown at once; sent by `commit`.
    func moveBox(_ id: String, x: Double, y: Double)
    func resizeBox(_ id: String, width: Double)
    /// Send the box's moved or resized geometry (during a drag every so often, and at its end).
    func commit(_ id: String)
    func bringToFront(_ id: String, z: Double)
    /// Remove a box that holds nothing (the server refuses one that does).
    func deleteBox(_ id: String)
    /// The page's boxes (from the document) with the changes not yet in it on top.
    func apply(to boxes: [PageBox]) -> [PageBox]
    /// A box made here that the page document does not have yet.
    func isLocal(_ id: String) -> Bool
    /// An undo or redo of the page ran: what was last sent for a box is no longer what the document has.
    func pageUndone()
}

/// Geometry changes kept in memory for the page being shown. A change to a box stays only while the
/// page document still has the geometry it had when the change was made: someone else moving the
/// box wins.
final class LocalBoxGeometry: BoxGeometryStore {
    struct Override {
        var x: Double, y: Double, w: Double, z: Double
        var wide: Bool
        /// The page document's geometry when the change was made.
        var base: PageBox
    }

    let savesToServer = false
    var onFailure: ((String, String?) -> Void)?
    private(set) var overrides: [String: Override] = [:]
    private(set) var created: [PageBox] = []
    private(set) var deleted = Set<String>()
    /// Boxes as the page document has them, for `base` and for ids not made here.
    private var current: [String: PageBox] = [:]

    func createBox(x: Double, y: Double, width: Double, front: Double) -> String {
        let id = "local-" + UUID().uuidString.prefix(8).lowercased()
        create(id: id, x: x, y: y, width: width, front: front)
        return id
    }

    func create(id: String, x: Double, y: Double, width: Double, front: Double) {
        created.append(PageBox(id: id, x: x, y: y, w: width, z: front, wide: false))
    }

    func commit(_ id: String) {}

    /// The box as changed or made here, if it was.
    func shown(_ id: String) -> PageBox? {
        if let c = created.first(where: { $0.id == id }) { return c }
        guard let o = overrides[id] else { return nil }
        return PageBox(id: id, x: o.x, y: o.y, w: o.w, z: o.z, wide: o.wide)
    }

    /// The box as the page document has it, if it has it.
    func inDocument(_ id: String) -> PageBox? { current[id] }

    /// Take back what was changed here for a box.
    func revert(_ id: String) { overrides[id] = nil }

    /// A box hidden for deleting comes back.
    func restore(_ id: String) { deleted.remove(id) }

    /// Forget a box made here.
    func forget(_ id: String) {
        created.removeAll { $0.id == id }
        overrides[id] = nil
    }

    func moveBox(_ id: String, x: Double, y: Double) {
        change(id) { $0.x = x; $0.y = y }
    }

    func resizeBox(_ id: String, width: Double) {
        change(id) { $0.w = width; $0.wide = false }
    }

    func bringToFront(_ id: String, z: Double) {
        change(id) { $0.z = z }
    }

    func deleteBox(_ id: String) {
        if let i = created.firstIndex(where: { $0.id == id }) {
            created.remove(at: i)
        } else {
            deleted.insert(id)
        }
        overrides[id] = nil
    }

    private func change(_ id: String, _ edit: (inout Override) -> Void) {
        if let i = created.firstIndex(where: { $0.id == id }) {
            var o = Override(x: created[i].x, y: created[i].y, w: created[i].w, z: created[i].z, wide: created[i].wide, base: created[i])
            edit(&o)
            created[i] = PageBox(id: id, x: o.x, y: o.y, w: o.w, z: o.z, wide: o.wide)
            return
        }
        guard let base = current[id] else { return }
        var o = overrides[id] ?? Override(x: base.x, y: base.y, w: base.w, z: base.z, wide: base.wide, base: base)
        edit(&o)
        overrides[id] = o
    }

    /// The page's boxes (from the document) with the local changes on top, local boxes last.
    func apply(to boxes: [PageBox]) -> [PageBox] {
        current = Dictionary(boxes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // A box deleted here that the document has dropped: gone for good, unless an undo brings it back.
        deleted = deleted.filter { current[$0] != nil }
        // A box made here that the page document has now: what was changed since stays on top of it.
        for c in created {
            guard let doc = current[c.id] else { continue }
            if !same(doc, c) { overrides[c.id] = Override(x: c.x, y: c.y, w: c.w, z: c.z, wide: c.wide, base: doc) }
        }
        created.removeAll { current[$0.id] != nil }
        for (id, o) in overrides where current[id] == nil || !same(current[id]!, o.base) { overrides[id] = nil }
        var out: [PageBox] = []
        for box in boxes where !deleted.contains(box.id) {
            if let o = overrides[box.id] {
                out.append(PageBox(id: box.id, x: o.x, y: o.y, w: o.w, z: o.z, wide: o.wide))
            } else {
                out.append(box)
            }
        }
        return out + created
    }

    private func same(_ a: PageBox, _ b: PageBox) -> Bool {
        a.x == b.x && a.y == b.y && a.w == b.w && a.z == b.z && a.wide == b.wide
    }

    func isLocal(_ id: String) -> Bool { created.contains { $0.id == id } }

    func pageUndone() {}
}

/// Geometry changes sent to the server. The page shows them at once (`overlay`); the core's box
/// calls run in order with the edits on the page's edit queue (`PageEditHost.boxCall`), and after
/// each the host shows the page as it is, so the document soon says what the overlay does. A call
/// that fails takes its change back and says so (`onFailure`).
final class LiveBoxGeometry: BoxGeometryStore {
    let savesToServer = true
    var onFailure: ((String, String?) -> Void)?
    private let overlay = LocalBoxGeometry()
    private weak var host: PageEditHost?
    /// What was last sent for a box.
    private var sent: [String: (x: Double, y: Double, w: Double)] = [:]

    init(host: PageEditHost) { self.host = host }

    func createBox(x: Double, y: Double, width: Double, front: Double) -> String {
        let id = newBoxId()
        overlay.create(id: id, x: x, y: y, width: width, front: front)
        sent[id] = (x, y, width)
        run({ try $0.createBoxWithId(id: id, x: x, y: y, w: width, z: front) }, id: id) { [weak self] in self?.overlay.forget(id) }
        return id
    }

    func moveBox(_ id: String, x: Double, y: Double) { overlay.moveBox(id, x: x, y: y) }

    func resizeBox(_ id: String, width: Double) { overlay.resizeBox(id, width: width) }

    func commit(_ id: String) {
        guard let now = overlay.shown(id) else { return }
        let before = sent[id] ?? overlay.inDocument(id).map { (x: $0.x, y: $0.y, w: $0.w) } ?? (x: now.x, y: now.y, w: now.w)
        if now.x != before.x || now.y != before.y {
            run({ try $0.moveBox(id: id, x: now.x, y: now.y) }, id: id) { [weak self] in self?.overlay.revert(id) }
        }
        if now.w != before.w {
            run({ try $0.resizeBox(id: id, w: now.w) }, id: id) { [weak self] in self?.overlay.revert(id) }
        }
        sent[id] = (x: now.x, y: now.y, w: now.w)
    }

    func bringToFront(_ id: String, z: Double) {
        overlay.bringToFront(id, z: z)
        run({ _ = try $0.bringToFront(id: id) }, id: id) { [weak self] in self?.overlay.revert(id) }
    }

    func deleteBox(_ id: String) {
        overlay.deleteBox(id)
        sent[id] = nil
        // A box that has something in it, or is gone already, is not an error to show.
        run({ try $0.deleteBox(id: id) }, id: id, quiet: { error in
            switch error as? BoxError {
            case .NotEmpty?, .NoSuchBox?: return true
            default: return false
            }
        }) { [weak self] in self?.overlay.restore(id) }
    }

    func apply(to boxes: [PageBox]) -> [PageBox] { overlay.apply(to: boxes) }

    func isLocal(_ id: String) -> Bool { overlay.isLocal(id) }

    func pageUndone() { sent = [:] }

    private func run(_ call: @escaping (LivePage) throws -> Void, id: String,
                     quiet: @escaping (Error) -> Bool = { _ in false }, takeBack: @escaping () -> Void) {
        guard let host else { return }
        host.boxCall(call) { [weak self] error in
            guard let self, let error else { return }
            takeBack()
            self.onFailure?(id, quiet(error) ? nil : Self.message(error))
        }
    }

    static func message(_ error: Error) -> String {
        switch error as? BoxError {
        case .NoSuchBox?: return "That box was deleted by someone else."
        case .Closed?: return "Not connected to the page yet. Try again in a moment."
        case let .Invalid(message)?: return "Can\u{2019}t do that: \(message)"
        case .Exists?, .NotEmpty?: return "Couldn\u{2019}t change the box."
        case nil: return CoreBridge.message(error)
        }
    }
}
