import Foundation
import NotiveloCore

/// Creating, moving and resizing boxes of a canvas page (docs/PLAN_CANVAS.md: `boxes` map, box id →
/// { x, y, w, z, wide }). The core has no call that writes box geometry yet (see "apple → core" in
/// docs/rewrite/status/apple.md), so `LocalBoxGeometry` keeps the changes on this device only, over
/// what the page document says. When core lands `LivePage.createBox/moveBox/resizeBox/deleteBox`, a
/// second `BoxGeometryStore` sends them and the canvas stays as it is.
protocol BoxGeometryStore: AnyObject {
    /// Do changes reach the server?
    var savesToServer: Bool { get }
    /// A new box with its top-left at (x, y) (page points from the surface origin), `width` wide, in front.
    func createBox(x: Double, y: Double, width: Double, front: Double) -> String
    func moveBox(_ id: String, x: Double, y: Double)
    func resizeBox(_ id: String, width: Double)
    func bringToFront(_ id: String, z: Double)
    func deleteBox(_ id: String)
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
    private(set) var overrides: [String: Override] = [:]
    private(set) var created: [PageBox] = []
    private(set) var deleted = Set<String>()
    /// Boxes as the page document has them, for `base` and for ids not made here.
    private var current: [String: PageBox] = [:]

    func createBox(x: Double, y: Double, width: Double, front: Double) -> String {
        let id = "local-" + UUID().uuidString.prefix(8).lowercased()
        created.append(PageBox(id: id, x: x, y: y, w: width, z: front, wide: false))
        return id
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
}
