// The native pen layer's model, free of UIKit so it is unit-tested on a Mac (Tests/NvInkTests):
// the page's strokes as the web sent them, the pen layer's own not-yet-confirmed changes
// (overlays), tiles for redrawing, and the small rules (who draws, zoom maths, colours).
import CoreGraphics
import Foundation

/// A stroke as the pen layer keeps it.
public struct StrokeEntry: Equatable {
    public let id: String
    public let blob: Data
    public let info: StrokeInfo

    public init?(id: String, blob: Data) {
        guard let info = InkEngine.info(blob), !info.isEmpty else { return nil }
        self.id = id
        self.blob = blob
        self.info = info
    }

    public var rect: CGRect { CGRect(x: info.minX, y: info.minY, width: info.maxX - info.minX, height: info.maxY - info.minY) }
}

/// A square of the page (TILE page px a side) that is redrawn as one.
public struct TileKey: Hashable {
    public let x: Int
    public let y: Int
    public static let size: Double = 1024

    public init(x: Int, y: Int) {
        self.x = x
        self.y = y
    }

    /// The tile a stroke is drawn in: the one holding its top-left corner (the tile doesn't clip).
    public static func of(_ info: StrokeInfo) -> TileKey {
        TileKey(x: Int((info.minX / size).rounded(.down)), y: Int((info.minY / size).rounded(.down)))
    }
}

/// The strokes the pen layer draws: the page's (from the web, the one source of truth) plus
/// overlays for changes made here that the web hasn't confirmed yet. Each overlay has a token,
/// sent with the change to the web; the web echoes the token with the update that carries the
/// change (or with an empty update when nothing changed), and the overlay goes at that moment, so
/// nothing blinks or doubles. Every mutation returns the tiles to redraw.
public final class InkStore {
    public private(set) var page: [String: StrokeEntry] = [:]
    private var overlayAdded: [String: [StrokeEntry]] = [:]
    private var overlayRemoved: [String: Set<String>] = [:]
    private var index: [TileKey: Set<String>] = [:]
    private var tileOf: [String: TileKey] = [:]

    public init() {}

    private func put(_ e: StrokeEntry) -> TileKey {
        let t = TileKey.of(e.info)
        index[t, default: []].insert(e.id)
        tileOf[e.id] = t
        return t
    }

    private func drop(_ id: String) -> TileKey? {
        guard let t = tileOf.removeValue(forKey: id) else { return nil }
        index[t]?.remove(id)
        if index[t]?.isEmpty == true { index[t] = nil }
        return t
    }

    /// Everything the web has, replacing what was there. Blobs that don't decode are skipped.
    @discardableResult
    public func replaceAll(_ items: [(String, Data)]) -> Set<TileKey> {
        var dirty = Set(index.keys)
        for id in page.keys { _ = drop(id) }
        page = [:]
        for (id, blob) in items {
            guard let e = StrokeEntry(id: id, blob: blob) else { continue }
            page[id] = e
            dirty.insert(put(e))
        }
        return dirty
    }

    /// A change on the page (from anyone), and the overlay it confirms (`ack`).
    @discardableResult
    public func apply(added: [(String, Data)], removed: [String], ack: String? = nil) -> Set<TileKey> {
        var dirty = Set<TileKey>()
        for id in removed where page.removeValue(forKey: id) != nil {
            if let t = drop(id) { dirty.insert(t) }
        }
        for (id, blob) in added {
            if page[id] != nil, let t = drop(id) { dirty.insert(t) }
            guard let e = StrokeEntry(id: id, blob: blob) else { page[id] = nil; continue }
            page[id] = e
            dirty.insert(put(e))
        }
        if let ack { dirty.formUnion(clearOverlay(ack)) }
        return dirty
    }

    /// Sets the overlay for `token`: page strokes it hides and strokes it shows (replacing any
    /// earlier overlay with that token, so an erase gesture can update its own as it goes).
    @discardableResult
    public func setOverlay(_ token: String, removed: Set<String>, added: [Data]) -> Set<TileKey> {
        var dirty = clearOverlay(token)
        overlayRemoved[token] = removed.isEmpty ? nil : removed
        for id in removed { if let t = tileOf[id] { dirty.insert(t) } }
        var entries: [StrokeEntry] = []
        for (i, blob) in added.enumerated() {
            guard let e = StrokeEntry(id: "\(token)#\(i)", blob: blob) else { continue }
            entries.append(e)
            dirty.insert(put(e))
        }
        overlayAdded[token] = entries.isEmpty ? nil : entries
        return dirty
    }

    @discardableResult
    public func clearOverlay(_ token: String) -> Set<TileKey> {
        var dirty = Set<TileKey>()
        for e in overlayAdded.removeValue(forKey: token) ?? [] { if let t = drop(e.id) { dirty.insert(t) } }
        for id in overlayRemoved.removeValue(forKey: token) ?? [] { if let t = tileOf[id] { dirty.insert(t) } }
        return dirty
    }

    public var pendingTokens: Set<String> { Set(overlayAdded.keys).union(overlayRemoved.keys) }

    private var hidden: Set<String> { overlayRemoved.values.reduce(into: Set<String>()) { $0.formUnion($1) } }

    private func entry(_ id: String) -> StrokeEntry? {
        if let e = page[id] { return e }
        for list in overlayAdded.values { if let e = list.first(where: { $0.id == id }) { return e } }
        return nil
    }

    /// The strokes drawn in a tile, in drawing order (z key, then id).
    public func visible(in tile: TileKey) -> [StrokeEntry] {
        let h = hidden
        return (index[tile] ?? []).filter { !h.contains($0) }.compactMap(entry).sorted(by: InkStore.order)
    }

    /// Every stroke drawn, in drawing order: what the erasers look at.
    public func visible() -> [StrokeEntry] {
        let h = hidden
        var all = page.values.filter { !h.contains($0.id) }
        for list in overlayAdded.values { all.append(contentsOf: list) }
        return all.sorted(by: InkStore.order)
    }

    public var tiles: Set<TileKey> { Set(index.keys) }

    static func order(_ a: StrokeEntry, _ b: StrokeEntry) -> Bool {
        a.info.z != b.info.z ? a.info.z < b.info.z : a.id < b.id
    }

    /// Strokes in drawing order grouped into runs drawn as one shape: neighbouring pen strokes of
    /// one colour (opaque, so their union looks the same as drawing them one by one). A highlighter
    /// is see-through, so each one is its own run (overlapping highlighters darken, as on the web).
    public static func runs(_ entries: [StrokeEntry]) -> [[StrokeEntry]] {
        var out: [[StrokeEntry]] = []
        for e in entries {
            if !e.info.isHighlighter, let last = out.last?.last, !last.info.isHighlighter, last.info.color == e.info.color {
                out[out.count - 1].append(e)
            } else {
                out.append([e])
            }
        }
        return out
    }
}

/// The pen layer's rules.
public enum InkRules {
    /// Whether a touch draws: the Pencil always; a finger only with finger drawing on (palm rejection).
    public static func touchDraws(isPencil: Bool, fingerDrawing: Bool) -> Bool { isPencil || fingerDrawing }

    /// Scribble (handwriting into text fields) only while the Pencil can't draw: not in draw mode, and
    /// not in type mode when a Pencil touch switches to draw mode.
    public static func scribbleAllowed(toolActive: Bool, pencilSwitches: Bool = false) -> Bool { !toolActive && !pencilSwitches }

    /// Whether a touch starts ink: in draw mode as touchDraws says; in type mode only the Pencil, and
    /// only with the auto-switch on (it turns draw mode on). A finger never switches modes.
    public static func touchStartsInk(isPencil: Bool, toolActive: Bool, fingerDrawing: Bool, pencilSwitches: Bool) -> Bool {
        toolActive ? touchDraws(isPencil: isPencil, fingerDrawing: fingerDrawing) : isPencil && pencilSwitches
    }

    /// The colour a stroke is drawn in: in the dark theme near-black ink is drawn near-white, as
    /// on the web (src/ink/render.ts displayColor). 0xRRGGBBAA in and out.
    public static func displayColor(_ c: UInt32, dark: Bool) -> UInt32 {
        guard dark else { return c }
        let r = Double((c >> 24) & 255), g = Double((c >> 16) & 255), b = Double((c >> 8) & 255)
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.25 ? (0xE6E6E6 << 8) | (c & 255) : c
    }

    /// How far above the canvas the Pencil draws in draw mode (page px): the band beside the title.
    /// The same as INK_ABOVE in src/ink/render.ts, which draws it on the web.
    public static let maxAbove: CGFloat = 240

    public static let minZoom: CGFloat = 0.5
    public static let maxZoom: CGFloat = 4

    public static func clampZoom(_ z: CGFloat) -> CGFloat { min(maxZoom, max(minZoom, z)) }

    /// Where a scroll view must scroll after a pinch so the page stays where the fingers left it.
    /// Before: zoom z, content offset `offset`, the page's surface at `surface` in content
    /// coordinates (it doesn't move with zoom). The pinch scaled the picture by `scale` about
    /// `focalStart` (viewport coordinates) and moved it so that point is now at `focalEnd`.
    /// Afterwards a viewport point q shows what the picture showed there: page point
    /// P = (q + offset - surface) / z lands at surface + P * z * scale - newOffset = q'.
    public static func offsetAfterPinch(offset: CGPoint, surface: CGPoint, scale: CGFloat, focalStart: CGPoint, focalEnd: CGPoint) -> CGPoint {
        CGPoint(x: surface.x + scale * (offset.x - surface.x + focalStart.x) - focalEnd.x,
                y: surface.y + scale * (offset.y - surface.y + focalStart.y) - focalEnd.y)
    }
}

/// Finger gestures from raw touches (MultiTouchObserver): a tap with two or three fingers that
/// don't move and lift quickly, and a two-finger pinch once the fingers' distance changes enough.
public struct FingerGestures {
    public enum Event: Equatable {
        case none
        case pinchBegan(CGFloat)
        case pinchChanged(CGFloat)
    }

    public static let tapMaxDuration: TimeInterval = 0.4
    public static let tapSlop: CGFloat = 14
    /// A pinch starts when the fingers' distance changes by this share.
    public static let pinchThreshold: CGFloat = 0.06

    private var startTime: TimeInterval?
    private var maxCount = 0
    private var starts: [CGPoint] = []
    private var movedTooFar = false
    private var everPinched = false
    private var pinchStartDistance: CGFloat?
    public private(set) var pinching = false
    public private(set) var scale: CGFloat = 1

    public init() {}

    static func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }

    /// A finger went down; `points` are all fingers now down.
    public mutating func down(count: Int, points: [CGPoint], time: TimeInterval) {
        if startTime == nil { startTime = time }
        maxCount = max(maxCount, count)
        starts = points
        pinchStartDistance = points.count == 2 ? FingerGestures.distance(points[0], points[1]) : nil
    }

    public mutating func moved(points: [CGPoint], allowPinch: Bool) -> Event {
        if starts.count == points.count, zip(starts, points).contains(where: { FingerGestures.distance($0, $1) > FingerGestures.tapSlop }) {
            movedTooFar = true
        }
        guard points.count == 2 else { return .none }
        let d = FingerGestures.distance(points[0], points[1])
        guard d > 1 else { return .none }
        let d0 = pinchStartDistance ?? d
        pinchStartDistance = d0
        let s = d / d0
        if pinching {
            scale = s
            return .pinchChanged(s)
        }
        if allowPinch, abs(s - 1) > FingerGestures.pinchThreshold {
            pinching = true
            everPinched = true
            scale = s
            return .pinchBegan(s)
        }
        return .none
    }

    public mutating func endPinch() {
        pinching = false
        pinchStartDistance = nil
    }

    /// All fingers are up: the number of fingers of a tap (2 or 3), or nil. Starts afresh.
    public mutating func up(time: TimeInterval, cancelled: Bool) -> Int? {
        defer { self = FingerGestures() }
        guard !cancelled, let t0 = startTime, !movedTooFar, !everPinched, time - t0 <= FingerGestures.tapMaxDuration, (2...3).contains(maxCount) else { return nil }
        return maxCount
    }
}

/// The pen toolbar's state as the web sends it.
public struct InkToolState: Equatable {
    /// select, pen, highlighter, eraser, partialEraser
    public var tool: String = "select"
    public var color: UInt32 = 0x1F2328FF
    public var width: Float = 2.5
    public var fingerDrawing = false
    /// The pen tool draw mode uses (a Pencil touch in type mode switches to it).
    public var penTool = "pen"
    /// In type mode a Pencil touch turns draw mode on and draws.
    public var pencilSwitches = true
    public var eraserRadius: Float = 8
    public var dark = false
    /// The native layer draws finished ink (debug). Normally the web page does, and the native layer
    /// draws only the live stroke and holds finished ones until the web has painted them.
    public var nativeFinished = false

    public init() {}

    public init(_ d: [String: Any]) {
        if let t = d["tool"] as? String { tool = t }
        if let c = (d["color"] as? NSNumber)?.uint32Value { color = c }
        if let w = (d["width"] as? NSNumber)?.floatValue { width = w }
        if let f = d["fingerDrawing"] as? Bool { fingerDrawing = f }
        if let p = d["penTool"] as? String, ["pen", "highlighter", "eraser", "partialEraser"].contains(p) { penTool = p }
        if let a = d["pencilSwitches"] as? Bool { pencilSwitches = a }
        if let r = (d["eraserRadius"] as? NSNumber)?.floatValue { eraserRadius = r }
        if let k = d["dark"] as? Bool { dark = k }
        if let n = d["nativeFinished"] as? Bool { nativeFinished = n }
    }

    public var draws: Bool { tool == "pen" || tool == "highlighter" }
    public var erases: Bool { tool == "eraser" || tool == "partialEraser" }
    public var active: Bool { draws || erases }
    public var strokeTool: UInt8 { tool == "highlighter" ? InkToolID.highlighter : InkToolID.pen }
}

/// Plugin payloads: strokes travel as {id, data (base64)}.
public enum InkWire {
    public static func strokes(_ any: Any?) -> [(String, Data)] {
        guard let list = any as? [[String: Any]] else { return [] }
        return list.compactMap { d in
            guard let id = d["id"] as? String, let s = d["data"] as? String, let data = Data(base64Encoded: s) else { return nil }
            return (id, data)
        }
    }

    public static func rect(_ any: Any?) -> CGRect? {
        guard let d = any as? [String: Any], let x = (d["x"] as? NSNumber)?.doubleValue, let y = (d["y"] as? NSNumber)?.doubleValue,
              let w = (d["w"] as? NSNumber)?.doubleValue, let h = (d["h"] as? NSNumber)?.doubleValue else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }
}

/// Where the page is in the web view, as the web measures it (CSS px = points).
public struct InkLayout: Equatable {
    /// The page's scroller (its visible box) in web view coordinates.
    public var scroller: CGRect
    /// The canvas surface's top-left in the scroller's content coordinates (unaffected by zoom).
    public var surfaceOrigin: CGPoint
    /// The surface's size in page px.
    public var surfaceSize: CGSize
    public var zoom: CGFloat
    /// Web view areas over the page where the pen must not draw (the pen toolbar).
    public var exclusions: [CGRect]

    public init(scroller: CGRect, surfaceOrigin: CGPoint, surfaceSize: CGSize, zoom: CGFloat, exclusions: [CGRect] = []) {
        self.scroller = scroller
        self.surfaceOrigin = surfaceOrigin
        self.surfaceSize = surfaceSize
        self.zoom = zoom
        self.exclusions = exclusions
    }

    public init?(_ d: [String: Any]) {
        guard let s = InkWire.rect(d["scroller"]), let o = InkWire.rect(d["surface"]) else { return nil }
        scroller = s
        surfaceOrigin = o.origin
        surfaceSize = o.size
        zoom = CGFloat((d["zoom"] as? NSNumber)?.doubleValue ?? 1)
        exclusions = ((d["exclusions"] as? [Any]) ?? []).compactMap(InkWire.rect)
    }
}

/// Stroke geometry for Core Graphics.
public enum InkPaths {
    /// nv-ink path commands → CGPath (fill nonzero), as src/ink/render.ts builds a Path2D.
    public static func cgPath(_ ops: [Float]) -> CGPath {
        let p = CGMutablePath()
        var i = 0
        while i < ops.count {
            switch ops[i] {
            case InkOp.move where i + 2 < ops.count:
                p.move(to: CGPoint(x: CGFloat(ops[i + 1]), y: CGFloat(ops[i + 2])))
                i += 3
            case InkOp.line where i + 2 < ops.count:
                p.addLine(to: CGPoint(x: CGFloat(ops[i + 1]), y: CGFloat(ops[i + 2])))
                i += 3
            case InkOp.circle where i + 3 < ops.count:
                let r = CGFloat(ops[i + 3])
                p.addEllipse(in: CGRect(x: CGFloat(ops[i + 1]) - r, y: CGFloat(ops[i + 2]) - r, width: 2 * r, height: 2 * r))
                i += 4
            case InkOp.close:
                p.closeSubpath()
                i += 1
            default:
                i = ops.count
            }
        }
        return p
    }
}

/// Fractional z keys, as src/ink/strokes.ts makes them (zAfter): a new stroke goes on top.
public enum ZKeys {
    static let digits = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
    public static let first = "a0"

    /// The key after `z` (`first` after nothing). Always greater than `z` in string order.
    public static func after(_ z: String?) -> String {
        guard let z, !z.isEmpty else { return first }
        let chars = Array(z)
        let head = chars[0].unicodeScalars.first!.value
        let len = Int(head) - 0x61 + 1
        guard head >= 0x61, head <= 0x7A, chars.count == len + 1, chars.dropFirst().allSatisfy({ digits.contains($0) }) else { return z + "V" }
        var d = Array(chars.dropFirst())
        for i in stride(from: d.count - 1, through: 0, by: -1) {
            let v = digits.firstIndex(of: d[i])!
            if v < digits.count - 1 {
                d[i] = digits[v + 1]
                return String(chars[0]) + String(d)
            }
            d[i] = "0"
        }
        if head == 0x7A { return z + "V" }
        return String(UnicodeScalar(head + 1)!) + "1" + String(repeating: "0", count: len)
    }
}
