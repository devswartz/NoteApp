// The drawing page's model (docs/PLAN_INK.md, Stage 1): its strokes, its undo history and how it
// is saved on the device. It has no UIKit, so it is unit-tested on a Mac (Tests/NvInkTests). Stage 1
// keeps the page on the device only; Stage 2 puts the same strokes in the synced page doc.
import CoreGraphics
import Foundation

/// One undoable change: strokes added and strokes removed (with their blobs, so undo can put them back).
public struct DrawingOp {
    public var added: [(id: String, blob: Data)]
    public var removed: [(id: String, blob: Data)]

    public init(added: [(id: String, blob: Data)] = [], removed: [(id: String, blob: Data)] = []) {
        self.added = added
        self.removed = removed
    }

    public var isEmpty: Bool { added.isEmpty && removed.isEmpty }
    public var inverse: DrawingOp { DrawingOp(added: removed, removed: added) }
}

/// The page's strokes (drawn from `store`) and its undo and redo stacks. Every change returns the
/// tiles to redraw.
public final class DrawingDoc {
    public let store = InkStore()
    private var undoStack: [DrawingOp] = []
    private var redoStack: [DrawingOp] = []
    public var title = ""

    public init() {}

    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }
    public var strokeCount: Int { store.page.count }

    /// The z key for a new stroke: above every other.
    public var nextZ: String { ZKeys.after(store.page.values.map(\.info.z).max()) }

    public static func newID() -> String { UUID().uuidString.lowercased() }

    private func apply(_ op: DrawingOp) -> Set<TileKey> {
        store.apply(added: op.added.map { ($0.id, $0.blob) }, removed: op.removed.map { $0.id })
    }

    /// Applies a change and makes it the newest undo step.
    @discardableResult
    public func commit(_ op: DrawingOp) -> Set<TileKey> {
        guard !op.isEmpty else { return [] }
        record(op)
        return apply(op)
    }

    /// Makes an already-applied change the newest undo step (an erase gesture applies as it goes).
    public func record(_ op: DrawingOp) {
        guard !op.isEmpty else { return }
        undoStack.append(op)
        redoStack.removeAll()
    }

    /// Applies a change without recording it (an erase gesture, step by step).
    @discardableResult
    public func applyUnrecorded(_ op: DrawingOp) -> Set<TileKey> { apply(op) }

    @discardableResult
    public func undo() -> Set<TileKey>? {
        guard let op = undoStack.popLast() else { return nil }
        redoStack.append(op)
        return apply(op.inverse)
    }

    @discardableResult
    public func redo() -> Set<TileKey>? {
        guard let op = redoStack.popLast() else { return nil }
        undoStack.append(op)
        return apply(op)
    }

    /// Removes every stroke (undoable).
    @discardableResult
    public func clear() -> Set<TileKey> {
        commit(DrawingOp(removed: store.page.values.map { (id: $0.id, blob: $0.blob) }))
    }

    /// The lowest point of any ink (page px), for growing the page.
    public var inkBottom: Double { store.page.values.map(\.info.maxY).max() ?? 0 }

    // MARK: Saving

    /// "NVD1", then the title and every stroke, each as a u32 length and its bytes (little-endian).
    public func encoded() -> Data {
        var out = Data("NVD1".utf8)
        func u32(_ n: Int) { var v = UInt32(n).littleEndian; withUnsafeBytes(of: &v) { out.append(contentsOf: $0) } }
        func chunk(_ d: Data) { u32(d.count); out.append(d) }
        chunk(Data(title.utf8))
        let strokes = store.page.values.sorted(by: InkStore.order)
        u32(strokes.count)
        for e in strokes {
            chunk(Data(e.id.utf8))
            chunk(e.blob)
        }
        return out
    }

    /// A page from `encoded()`; nil when the data isn't one. Undo history isn't saved.
    public static func decode(_ d: Data) -> DrawingDoc? {
        let b = [UInt8](d)
        guard b.count >= 8, b[0..<4].elementsEqual(Array("NVD1".utf8)) else { return nil }
        var at = 4
        func u32() -> Int? {
            guard at + 4 <= b.count else { return nil }
            defer { at += 4 }
            return Int(b[at]) | Int(b[at + 1]) << 8 | Int(b[at + 2]) << 16 | Int(b[at + 3]) << 24
        }
        func chunk() -> Data? {
            guard let n = u32(), at + n <= b.count else { return nil }
            defer { at += n }
            return Data(b[at..<(at + n)])
        }
        guard let title = chunk(), let count = u32() else { return nil }
        var items: [(String, Data)] = []
        for _ in 0..<count {
            guard let id = chunk(), let blob = chunk() else { return nil }
            items.append((String(decoding: id, as: UTF8.self), blob))
        }
        let doc = DrawingDoc()
        doc.title = String(decoding: title, as: UTF8.self)
        doc.store.replaceAll(items)
        return doc
    }
}

/// The drawing page's fixed sizes and limits.
public enum DrawingPage {
    /// The paper's width in page px (endless height; PLAN_INK D4).
    public static let width: CGFloat = 1000
    public static let minHeight: CGFloat = 1400
    /// Room kept below the lowest ink, so there is always paper to write on.
    public static let roomBelow: CGFloat = 900
    public static let minZoom: CGFloat = 0.5
    public static let maxZoom: CGFloat = 4
    /// Lined paper: the gap between rules and where the first one is (page px).
    public static let ruleGap: CGFloat = 36
    public static let firstRule: CGFloat = 160
    /// Above this the ink is redrawn at this scale, not sharper (memory).
    public static let maxRenderScale: CGFloat = 6

    /// The page height for ink reaching `inkBottom`: never shorter than it was.
    public static func height(current: CGFloat, inkBottom: Double) -> CGFloat {
        max(current, minHeight, CGFloat(inkBottom) + roomBelow)
    }

    /// The zoom that fits the paper's width into `viewWidth`, within the zoom limits (at most 1:1).
    public static func fitZoom(viewWidth: CGFloat) -> CGFloat {
        guard viewWidth > 0 else { return 1 }
        return min(1, max(minZoom, (viewWidth - 32) / width))
    }

    /// The inset that centres content `content` wide in a view `view` wide.
    public static func centringInset(view: CGFloat, content: CGFloat) -> CGFloat { max(0, (view - content) / 2) }
}
